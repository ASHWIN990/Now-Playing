#!/usr/bin/env python3
"""Now Playing server: serves the app's files plus a tiny bridge to Philips WiZ
lights. Browsers can't send UDP, and WiZ bulbs only speak JSON over UDP port
38899 on the local network, so the page talks to /api/wiz/* here instead.

  python server.py [--host 127.0.0.1] [--port 8080] [--dir .]

API (JSON):
  GET  /api/wiz/ping               -> {"ok": true}
  GET  /api/wiz/discover           -> {"bulbs": [{"ip", "mac", ...pilot}]}
  GET  /api/wiz/state?ip=IP        -> the bulb's getPilot result
  GET  /api/wiz/info?ip=IP         -> {system, model, user}: model, firmware, MAC,
                                      white range, minimum dimming, dim-to-warm curve
  POST /api/wiz/set {ip, params}   -> setPilot (state, dimming, temp, r, g, b, sceneId, speed)
"""
import argparse
import ipaddress
import json
import socket
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WIZ_PORT = 38899
SET_KEYS = {'state', 'dimming', 'temp', 'r', 'g', 'b', 'c', 'w', 'sceneId', 'speed'}


def local_ip():
    """This device's LAN address (no packet is actually sent)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
        except OSError:
            return None


def wiz_call(ip, method, params=None, tries=3, wait=0.5):
    """Send one command to a bulb and return its reply. UDP can drop packets,
    so resend a few times; WiZ commands are idempotent."""
    msg = json.dumps({'method': method, 'params': params or {}}).encode()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(wait)
        for _ in range(tries):
            s.sendto(msg, (ip, WIZ_PORT))
            try:
                while True:
                    data, addr = s.recvfrom(4096)
                    if addr[0] == ip:
                        return json.loads(data)
            except socket.timeout:
                continue
    raise TimeoutError(f'no reply from {ip}')


def wiz_discover(seconds=2.5):
    """Broadcast getPilot and collect every bulb that answers."""
    msg = json.dumps({'method': 'getPilot', 'params': {}}).encode()
    targets = {'255.255.255.255'}
    me = local_ip()
    if me:
        # Assume a /24 for the subnet broadcast; 255.255.255.255 covers the rest.
        targets.add(me.rsplit('.', 1)[0] + '.255')
    found = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.4)
        end = time.time() + seconds
        while time.time() < end:
            for t in targets:
                try:
                    s.sendto(msg, (t, WIZ_PORT))
                except OSError:
                    pass
            try:
                while True:
                    data, addr = s.recvfrom(4096)
                    try:
                        result = json.loads(data).get('result') or {}
                    except ValueError:
                        continue
                    found[addr[0]] = {'ip': addr[0], **result}
            except socket.timeout:
                pass
    return sorted(found.values(), key=lambda b: b['ip'])


def bulb_ip(value):
    """Only talk to addresses on a private network."""
    try:
        ip = ipaddress.ip_address(value or '')
    except ValueError:
        raise ValueError('bad ip')
    if ip.version != 4 or not ip.is_private:
        raise ValueError('ip must be a private IPv4 address')
    return str(ip)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/'):
            super().log_message(fmt, *args)

    def end_headers(self):
        # Always serve fresh files so app updates show up on reload.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def same_origin(self):
        """Refuse requests made by other websites open in the same browser."""
        if self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none'):
            return False
        origin = self.headers.get('Origin')
        return origin is None or urlparse(origin).netloc == self.headers.get('Host')

    def api(self, method):
        url = urlparse(self.path)
        if not url.path.startswith('/api/wiz/'):
            return False
        if not self.same_origin():
            self.send_json(403, {'error': 'cross-origin request refused'})
            return True
        route = url.path[len('/api/wiz/'):]
        try:
            if method == 'GET' and route == 'ping':
                self.send_json(200, {'ok': True})
            elif method == 'GET' and route == 'discover':
                self.send_json(200, {'bulbs': wiz_discover()})
            elif method == 'GET' and route == 'state':
                ip = bulb_ip(parse_qs(url.query).get('ip', [''])[0])
                self.send_json(200, wiz_call(ip, 'getPilot').get('result', {}))
            elif method == 'GET' and route == 'info':
                ip = bulb_ip(parse_qs(url.query).get('ip', [''])[0])
                info = {}
                for key, call in (('system', 'getSystemConfig'), ('model', 'getModelConfig'),
                                  ('user', 'getUserConfig')):
                    try:
                        info[key] = wiz_call(ip, call).get('result', {})
                    except TimeoutError:
                        info[key] = {}   # older firmware lacks some of these
                if not info['system']:
                    raise TimeoutError(f'no reply from {ip}')
                self.send_json(200, info)
            elif method == 'POST' and route == 'set':
                # Requiring a JSON content type forces a CORS preflight for
                # cross-site requests, which this server never approves.
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('expected application/json')
                length = min(int(self.headers.get('Content-Length') or 0), 4096)
                body = json.loads(self.rfile.read(length) or b'{}')
                ip = bulb_ip(body.get('ip'))
                params = {k: v for k, v in (body.get('params') or {}).items() if k in SET_KEYS}
                if not params:
                    raise ValueError('no params')
                reply = wiz_call(ip, 'setPilot', params)
                if 'error' in reply:
                    self.send_json(400, {'error': reply['error'].get('message', 'bulb error')})
                else:
                    self.send_json(200, reply.get('result', {}))
            else:
                self.send_json(404, {'error': 'not found'})
        except ValueError as e:
            self.send_json(400, {'error': str(e)})
        except (TimeoutError, OSError) as e:
            self.send_json(504, {'error': str(e)})
        return True

    def do_GET(self):
        if not self.api('GET'):
            super().do_GET()

    def do_POST(self):
        if not self.api('POST'):
            self.send_error(405)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--dir', default='.')
    a = ap.parse_args()
    server = ThreadingHTTPServer((a.host, a.port), partial(Handler, directory=a.dir))
    print(f'Serving {a.dir} on http://{a.host}:{a.port}/', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
