#!/data/data/com.termux/files/usr/bin/bash
# One-time setup: install Python and start the Now Playing server (app files +
# WiZ light bridge, server.py) on 127.0.0.1:8080.
export DEBIAN_FRONTEND=noninteractive
yes | pkg update -y -o Dpkg::Options::=--force-confnew
pkg install -y python

cat > ~/start-spotify-monitor.sh <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null
cd /sdcard/spotify-monitor
exec python server.py --host 127.0.0.1 --port 8080 --dir .
EOS
chmod +x ~/start-spotify-monitor.sh

# Start the server automatically whenever Termux opens.
# (Older installs ran "http.server 8080"; replace that line and stop the old server.)
sed -i '/start-spotify-monitor/d' ~/.bashrc 2>/dev/null
echo 'pgrep -f "server.py" >/dev/null || (nohup ~/start-spotify-monitor.sh >~/sm.log 2>&1 &)' >> ~/.bashrc
pkill -f "http.server 8080" 2>/dev/null

pgrep -f "server.py" >/dev/null || (nohup ~/start-spotify-monitor.sh >~/sm.log 2>&1 &)
sleep 2
echo "Server running at http://127.0.0.1:8080/"
