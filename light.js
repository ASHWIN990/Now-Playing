// Light page: controls a Philips WiZ bulb through server.py's /api/wiz bridge
// (browsers can't send the UDP packets WiZ bulbs listen for).
// Exposes window.Light = { probe(), start(), stop(), toggle(), onTrack(t), onLyricLine() }.
//
// The bulb is remembered by its MAC address, so if the router hands it a new
// IP the page finds it again. Slider ranges come from the bulb's own config
// (white range, minimum dimming, dim-to-warm curve).
'use strict';

(() => {
  const POLL_MS = 5000;
  const SEND_GAP_MS = 120;     // at most ~8 commands a second while dragging
  const FAILS_BEFORE_RESCAN = 2;

  const WHITES = [
    { label: 'Candle', temp: 2200 },
    { label: 'Warm', temp: 2700 },
    { label: 'Neutral', temp: 4000 },
    { label: 'Daylight', temp: 6500 },
  ];
  const COLOURS = [
    [255, 0, 0], [255, 90, 0], [255, 200, 0], [0, 255, 60],
    [0, 220, 255], [0, 40, 255], [140, 0, 255], [255, 0, 150],
  ];
  const GLOW_LEVELS = [10, 25, 50, 75, 100];

  // WiZ built-in scenes: id -> [name, preview colours]. Ids are the bulb's own.
  const SCENES = {
    6: ['Cozy', '#ffb26b', '#ff8a3c'],
    5: ['Fireplace', '#ff6a00', '#ffb300'],
    3: ['Sunset', '#ff7e39', '#ff4f8b', '#8e44ad'],
    1: ['Ocean', '#0077be', '#00c2c7'],
    16: ['Relax', '#ffcc80', '#ffe0b2'],
    15: ['Focus', '#e3f2fd', '#ffffff'],
    14: ['Night light', '#ff8f00', '#3e2723'],
    4: ['Party', '#ff0055', '#00e5ff', '#ffd400'],
    2: ['Romance', '#ff5e7e', '#c2185b'],
    7: ['Forest', '#2e7d32', '#9ccc65'],
    8: ['Pastel', '#ffb3c1', '#b3e5fc', '#dcedc8'],
    9: ['Wake-up', '#ffb74d', '#fff3e0'],
    10: ['Bedtime', '#ff9800', '#5d4037'],
    11: ['Warm white', '#ffb46b', '#ffd2a1'],
    12: ['Daylight', '#ffe4ce', '#fff6ee'],
    13: ['Cool white', '#e6eeff', '#ffffff'],
    17: ['True colours', '#ff1744', '#00e676', '#2979ff'],
    18: ['TV time', '#7e57c2', '#26c6da'],
    19: ['Plant growth', '#e040fb', '#ff4081'],
    20: ['Spring', '#aeea00', '#ffd1dc'],
    21: ['Summer', '#ffca28', '#ff7043', '#26c6da'],
    22: ['Fall', '#ff8f00', '#bf360c'],
    23: ['Deep dive', '#0d47a1', '#00838f'],
    24: ['Jungle', '#2e7d32', '#fdd835'],
    25: ['Mojito', '#c6ff00', '#69f0ae'],
    26: ['Club', '#d500f9', '#2962ff', '#ff1744'],
    27: ['Christmas', '#d50000', '#00c853'],
    28: ['Halloween', '#ff6d00', '#6a1b9a'],
    29: ['Candlelight', '#ff9100', '#ffcc80'],
    30: ['Golden white', '#ffd54f', '#fff8e1'],
    31: ['Pulse', '#ff4081', '#880e4f'],
    32: ['Steampunk', '#c77c02', '#8d6e63'],
    33: ['Diwali', '#ffd600', '#ff6d00', '#d500f9'],
    34: ['White', '#ffffff', '#f5f5f5'],
    35: ['Alarm', '#ff1744', '#ffffff'],
    36: ['Snowy sky', '#b3e5fc', '#ffffff'],
  };
  // Shown first; the rest appear under "More scenes".
  const FAVOURITE_SCENES = [6, 5, 3, 1, 16, 15, 14, 4];
  // Scenes that only use white LEDs (all a white-only bulb can play).
  const WHITE_SCENES = new Set([6, 9, 10, 11, 12, 13, 14, 29, 30, 34]);
  // Scenes that don't animate, so they have no speed setting.
  const STATIC_SCENES = new Set([11, 12, 13, 14, 15, 16, 34]);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const $ = (id) => document.getElementById(id);
  const DEFAULT_NAME = 'Light';

  let ip = store.get('wiz_ip') || '';
  let mac = store.get('wiz_mac') || '';
  let pilot = null;            // last known bulb state (getPilot result)
  let info = null;             // {system, model, user} from the bulb's config
  let caps = { rgb: true, tempMin: 2200, tempMax: 6500, dimMin: 10, curve: [] };
  let glow = store.get('wiz_glow') === '1';
  let tab = null;              // shown tab; null = follow the bulb's mode
  let running = false;
  let pollTimer = null;
  let lastSendAt = 0;
  let fails = 0;

  // ---------- bridge ----------
  async function api(path, body) {
    const res = await fetch('/api/wiz/' + path, body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  // Latest-wins sender: while one command is in flight, newer ones replace
  // each other, so dragging a slider never builds a backlog.
  let pending = null;
  let sending = false;
  const MODE_KEYS = ['temp', 'r', 'g', 'b', 'sceneId', 'speed'];   // colour, white and scene exclude each other
  function send(params) {
    const base = { ...(pending || {}) };
    if (MODE_KEYS.some((k) => k in params)) MODE_KEYS.forEach((k) => delete base[k]);
    pending = { ...base, ...params };
    if (!sending) flush();
  }
  async function flush() {
    sending = true;
    while (pending) {
      const params = pending;
      pending = null;
      lastSendAt = Date.now();
      try {
        await api('set', { ip, params });
        fails = 0;
        setStatus();
      } catch {
        setStatus("Can't reach the light");
      }
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    sending = false;
  }

  // ---------- colour helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Approximate RGB of a white at the given colour temperature (Kelvin).
  function kelvinRgb(k) {
    const t = k / 100;
    const c = (v) => clamp(Math.round(v), 0, 255);
    const r = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
    const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
    return [c(r), c(g), c(b)];
  }

  function hsvRgb(h, s) {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return [f(5), f(3), f(1)];
  }

  function rgbHs([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    return { h: Math.round((h * 60 + 360) % 360), s: max ? d / max : 0 };
  }

  const isScene = (p) => !!(p && p.sceneId);
  const isColour = (p) => !!(p && !p.sceneId && !p.temp && (p.r || p.g || p.b));

  function pilotRgb(p) {
    if (!p) return [255, 190, 120];
    if (isScene(p)) {
      const s = SCENES[p.sceneId];
      return s ? hexRgb(s[1]) : [255, 170, 90];
    }
    if (isColour(p)) return [p.r || 0, p.g || 0, p.b || 0];
    if (p.temp) return kelvinRgb(p.temp);
    return [255, 190, 120];
  }

  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Colour temperature for a brightness on the bulb's dim-to-warm curve
  // (linear between its points), kept inside the bulb's white range.
  function glowTemp(dim) {
    const pts = caps.curve.length ? caps.curve
      : [{ k: caps.tempMin, d: 1 }, { k: 2700, d: 50 }, { k: 4200, d: 100 }];
    let k = pts[pts.length - 1].k;
    if (dim <= pts[0].d) k = pts[0].k;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (dim >= a.d && dim <= b.d) {
        k = b.d === a.d ? b.k : a.k + (b.k - a.k) * (dim - a.d) / (b.d - a.d);
        break;
      }
    }
    return Math.round(clamp(k, caps.tempMin, caps.tempMax) / 50) * 50;
  }

  // ---------- bulb config ----------
  function applyInfo(i) {
    info = i;
    const model = i.model || {};
    const cct = (model.cctRange || []).map(Number).filter((n) => n > 0);
    const pwm = model.pwmRanges || [];
    let channels = 0;
    for (let n = 0; n + 1 < pwm.length; n += 2) if (+pwm[n + 1] > +pwm[n]) channels++;
    caps = {
      rgb: pwm.length ? channels >= 3 : true,
      tempMin: cct.length ? Math.min(...cct) : 2200,
      tempMax: cct.length ? Math.max(...cct) : 6500,
      dimMin: model.minDimLevel > 0 ? model.minDimLevel : 10,
      curve: ((i.user || {}).dim2WarmPoints || [])
        .map(([k, d]) => ({ k: +k, d: +d }))
        .filter((p) => p.k > 0 && p.d >= 0)
        .sort((a, b) => a.d - b.d),
    };
    if (i.system && i.system.mac) {
      mac = i.system.mac;
      store.set('wiz_mac', mac);
    }
    applyCaps();
    showName();
  }

  function applyCaps() {
    $('lt-dim').min = caps.dimMin;
    $('lt-temp').min = caps.tempMin;
    $('lt-temp').max = caps.tempMax;
    $('lt-temp').style.setProperty('--t-lo', `rgb(${kelvinRgb(caps.tempMin)})`);
    $('lt-temp').style.setProperty('--t-hi', `rgb(${kelvinRgb(caps.tempMax)})`);
    document.querySelector('[data-tab="colour"]').hidden = !caps.rgb;
    for (const tile of $('lt-scenes').children) {
      tile.hidden = !caps.rgb && !WHITE_SCENES.has(+tile.dataset.scene);
    }
    for (const b of $('lt-whites').children) {
      const t = +b.dataset.temp;
      b.hidden = t < caps.tempMin || t > caps.tempMax;
    }
  }

  async function loadInfo() {
    try {
      applyInfo(await api('info?ip=' + encodeURIComponent(ip)));
      renderInfo();
    } catch {}
  }

  function renderInfo() {
    if (!info) return;
    const sys = info.system || {};
    const m = (sys.mac || mac || '').match(/.{2}/g);
    const rows = [
      ['Model', sys.moduleName],
      ['Firmware', sys.fwVersion],
      ['IP address', ip],
      ['MAC', m && m.join(':').toUpperCase()],
      ['Signal', pilot && pilot.rssi ? pilot.rssi + ' dBm' : ''],
      ['Whites', `${caps.tempMin}–${caps.tempMax} K`],
      ['Colour', caps.rgb ? 'Yes' : 'No'],
    ].filter(([, v]) => v);
    $('lt-info-rows').replaceChildren(...rows.map(([k, v]) => {
      const row = document.createElement('div');
      const a = document.createElement('span');
      const b = document.createElement('span');
      a.textContent = k;
      b.textContent = v;
      row.append(a, b);
      return row;
    }));
  }

  // ---------- rendering ----------
  function modeTab(p) {
    if (syncActive()) return 'music';
    if (glow && p && p.temp && !isScene(p)) return 'glow';
    if (isScene(p)) return 'scenes';
    if (isColour(p)) return 'colour';
    return 'white';
  }

  function describe(p) {
    if (!p) return '';
    if (!p.state) return 'Off';
    const dim = (p.dimming || 100) + '%';
    if (syncActive()) return `Music sync · ${dim}`;
    if (isScene(p)) return `${(SCENES[p.sceneId] || ['Scene'])[0]} · ${dim}`;
    if (glow && p.temp) return `Warm glow · ${dim}`;
    if (isColour(p)) return `Colour · ${dim}`;
    if (p.temp) return `${p.temp} K · ${dim}`;
    return 'On · ' + dim;
  }

  function setStatus(msg) {
    $('lt-status').textContent = msg || describe(pilot);
    $('lt-status').classList.toggle('err', !!msg);
  }

  function showTab(name) {
    for (const b of $('lt-tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const p of document.querySelectorAll('.lt-pane')) p.hidden = p.dataset.pane !== name;
  }

  const notDragging = (el) => document.activeElement !== el;

  function render() {
    const page = $('light');
    const on = !!(pilot && pilot.state);
    const [r, g, b] = pilotRgb(pilot);
    const dim = pilot ? pilot.dimming || 100 : 100;
    page.style.setProperty('--lt-rgb', `${r}, ${g}, ${b}`);
    page.style.setProperty('--lt-level', on ? 0.25 + 0.75 * dim / 100 : 0);
    page.classList.toggle('on', on);
    $('lt-power').setAttribute('aria-pressed', String(on));

    if (pilot && notDragging($('lt-dim'))) $('lt-dim').value = dim;
    $('lt-dim-val').textContent = dim + '%';

    if (pilot && pilot.temp && notDragging($('lt-temp'))) $('lt-temp').value = pilot.temp;
    $('lt-temp-val').textContent = pilot && pilot.temp ? pilot.temp + ' K' : '–';

    if (isColour(pilot) && notDragging($('lt-hue')) && notDragging($('lt-sat'))) {
      const { h, s } = rgbHs([pilot.r, pilot.g, pilot.b]);
      $('lt-hue').value = h;
      $('lt-sat').value = Math.round(s * 100);
    }
    const hue = +$('lt-hue').value;
    $('lt-hue-val').textContent = hue + '°';
    $('lt-sat-val').textContent = $('lt-sat').value + '%';
    $('lt-sat').style.setProperty('--hue', `rgb(${hsvRgb(hue, 1)})`);

    const scene = isScene(pilot) ? pilot.sceneId : 0;
    for (const t of $('lt-scenes').children) t.classList.toggle('sel', +t.dataset.scene === scene);
    $('lt-speed-row').hidden = !scene || STATIC_SCENES.has(scene);
    if (pilot && pilot.speed && notDragging($('lt-speed'))) $('lt-speed').value = pilot.speed;
    $('lt-speed-val').textContent = $('lt-speed').value + '%';

    for (const c of $('lt-glow-levels').children) {
      c.classList.toggle('sel', glow && on && +c.dataset.level === dim);
    }

    $('lt-sync-album').checked = syncAlbum;
    $('lt-sync-lyrics').checked = syncLyricsOn;

    showTab(tab || modeTab(pilot));
    setStatus();
    renderInfo();
  }

  function showControls(show) {
    $('lt-controls').hidden = !show;
    $('lt-find').hidden = show;
  }

  // ---------- state polling (+ finding the bulb again if its IP changed) ----------
  async function refresh() {
    clearTimeout(pollTimer);
    if (!running || !ip) return;
    // Don't let a poll undo a change that's still on its way to the bulb.
    if (!sending && Date.now() - lastSendAt > 1500) {
      try {
        const p = await api('state?ip=' + encodeURIComponent(ip));
        if (p.mac && mac && p.mac !== mac) throw new Error('different bulb at this IP');
        if (p.mac && !mac) { mac = p.mac; store.set('wiz_mac', mac); }
        pilot = p;
        fails = 0;
        if (!info) loadInfo();
        render();
      } catch {
        fails++;
        setStatus("Can't reach the light");
        if (fails === FAILS_BEFORE_RESCAN && mac) relocate();
      }
    }
    if (running) pollTimer = setTimeout(refresh, POLL_MS);
  }

  async function relocate() {
    setStatus('Looking for the light…');
    try {
      const { bulbs } = await api('discover');
      const same = bulbs.find((b) => b.mac === mac);
      if (same && same.ip !== ip) {
        ip = same.ip;
        store.set('wiz_ip', ip);
        info = null;
        refresh();
        return;
      }
    } catch {}
    setStatus("Can't reach the light");
  }

  // ---------- finding bulbs ----------
  function useBulb(addr, bulbMac = '') {
    ip = addr;
    mac = bulbMac;
    info = null;
    pilot = null;
    store.set('wiz_ip', ip);
    store.set('wiz_mac', mac);
    showName();
    showControls(true);
    refresh();
  }

  async function discover() {
    showControls(false);
    const list = $('lt-found');
    $('lt-find-msg').textContent = 'Looking for WiZ lights…';
    list.replaceChildren();
    try {
      const { bulbs } = await api('discover');
      if (!bulbs.length) {
        $('lt-find-msg').textContent = 'No lights found. Is the phone on the same Wi-Fi? You can also type the light\'s IP address.';
        return;
      }
      if (bulbs.length === 1) return useBulb(bulbs[0].ip, bulbs[0].mac);
      $('lt-find-msg').textContent = 'Pick a light';
      list.replaceChildren(...bulbs.map((b) => {
        const btn = document.createElement('button');
        btn.className = 'lt-chip';
        btn.textContent = `${names()[b.mac] || b.ip}  ·  ${b.state ? 'on' : 'off'}`;
        btn.addEventListener('click', () => useBulb(b.ip, b.mac));
        return btn;
      }));
    } catch (e) {
      $('lt-find-msg').textContent = 'Search failed: ' + e.message;
    }
  }

  // ---------- name (tap to rename; saved per light, by MAC) ----------
  function names() {
    try { return JSON.parse(store.get('wiz_names') || '{}'); } catch { return {}; }
  }
  const nameKey = () => mac || ip;
  function showName() {
    const all = names();
    $('lt-name').textContent = all[nameKey()] || all[ip] || DEFAULT_NAME;
  }
  function editName() {
    $('lt-name').hidden = true;
    $('lt-name-form').hidden = false;
    const input = $('lt-name-input');
    input.value = names()[nameKey()] || names()[ip] || '';
    input.placeholder = DEFAULT_NAME;
    input.focus();
    input.select();
  }
  function saveName() {
    if ($('lt-name-form').hidden) return;
    const all = names();
    const v = $('lt-name-input').value.trim();
    delete all[ip];   // older versions keyed names by IP
    if (v) all[nameKey()] = v; else delete all[nameKey()];
    store.set('wiz_names', JSON.stringify(all));
    $('lt-name-form').hidden = true;
    $('lt-name').hidden = false;
    showName();
  }

  // ---------- music sync ----------
  // Album colours: the light takes the main colour of each song's album art.
  // Lyric pulses: a short brightness pulse on every new synced lyric line.
  // The light's state from before the sync is saved and put back when the
  // music pauses or stops, or when sync is switched off.
  let bridge = false;          // set by probe(): server.py is reachable
  let syncAlbum = store.get('wiz_sync_album') === '1';
  let syncLyricsOn = store.get('wiz_sync_lyrics') === '1';
  let music = null;            // { id, art, playing } from the player
  let albumRgb = null;         // colour picked from the current album art
  let albumFor = '';           // art URL albumRgb belongs to
  let lastPulse = 0;
  let pulseTimer = null;

  // The bulb fades between values on its own, so a pulse needs a big change
  // held for a moment to be visible.
  const PULSE_MS = 450;
  const PULSE_MIN_GAP_MS = 700;
  const PULSE_HUE_SHIFT = 45;

  const syncing = () => syncAlbum || syncLyricsOn;
  // True while the light shows the sync (a pre-sync state is saved).
  const syncActive = () => !!store.get('wiz_restore');

  // Save the light's current state once, before the sync first changes it.
  async function beginSync() {
    if (syncActive()) {
      if (!pilot) {   // after a reload: learn the current brightness
        try { pilot = await api('state?ip=' + encodeURIComponent(ip)); } catch {}
      }
      return true;
    }
    try {
      const p = await api('state?ip=' + encodeURIComponent(ip));
      store.set('wiz_restore', JSON.stringify(p));
      pilot = p;
      return true;
    } catch { return false; }
  }

  function restore() {
    let p;
    try { p = JSON.parse(store.get('wiz_restore') || 'null'); } catch {}
    store.del('wiz_restore');
    clearTimeout(pulseTimer);
    if (!p) return;
    let params;
    if (!p.state) params = { state: false };
    else if (p.sceneId) params = { sceneId: p.sceneId, state: true, dimming: p.dimming };
    else if (p.temp) params = { temp: p.temp, state: true, dimming: p.dimming };
    else params = { r: p.r, g: p.g, b: p.b, state: true, dimming: p.dimming };
    if (p.sceneId && p.speed) params.speed = p.speed;
    pilot = { ...p };
    send(params);
    if (running) render();
  }

  // Stop syncing. With restoreLight, put the light back as it was; without
  // (the user just picked something else), leave it as it is now.
  function stopSync(restoreLight) {
    if (!syncing() && !syncActive()) return;
    syncAlbum = syncLyricsOn = false;
    store.set('wiz_sync_album', '');
    store.set('wiz_sync_lyrics', '');
    if (restoreLight) restore();
    else { store.del('wiz_restore'); clearTimeout(pulseTimer); }
    if (running) render();
  }

  // Main colour of an image: a hue histogram weighted towards saturated,
  // bright pixels; null when the art is essentially grey or black.
  function albumColour(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const size = 32;
          const c = document.createElement('canvas');
          c.width = c.height = size;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, size, size);
          const d = ctx.getImageData(0, 0, size, size).data;
          const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
          let total = 0;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const max = Math.max(r, g, b);
            const s = max ? (max - Math.min(r, g, b)) / max : 0;
            const w = s * s * (max / 255);
            if (w < 0.02) continue;
            const bin = bins[Math.floor(rgbHs([r, g, b]).h / 15) % 24];
            bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
            total += w;
          }
          const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
          if (total < 15 || !best.w) return resolve(null);
          const { h, s } = rgbHs([best.r / best.w, best.g / best.w, best.b / best.w]);
          // Bulbs look washed out with pale colours, so keep it fairly saturated.
          resolve(hsvRgb(h, Math.max(s, 0.7)));
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // The base look while syncing: the album colour, or warm white for grey art.
  function syncBase() {
    if (syncAlbum && albumRgb) {
      const [r, g, b] = albumRgb;
      return { r, g, b };
    }
    if (syncAlbum) return { temp: 2700 };
    let p;
    try { p = JSON.parse(store.get('wiz_restore') || 'null'); } catch {}
    p = p && p.state ? p : pilot;
    if (p && p.temp) return { temp: p.temp };
    if (p && (p.r || p.g || p.b) && !p.sceneId) return { r: p.r, g: p.g, b: p.b };
    return { temp: 2700 };
  }

  async function applyBase() {
    const base = syncBase();
    pilot = { ...(pilot || {}), r: 0, g: 0, b: 0, temp: 0, sceneId: 0, ...base, state: true };
    send({ ...base, state: true });
    if (running) render();
  }

  async function updateSync() {
    if (!bridge || !ip || !syncing()) return;
    const playing = !!(music && music.playing);
    if (!playing) {
      if (syncActive()) restore();
      return;
    }
    if (syncAlbum && music.art && music.art !== albumFor) {
      albumFor = music.art;
      const rgb = await albumColour(music.art);
      if (albumFor !== music.art) return;          // the song changed meanwhile
      albumRgb = rgb;
      if (!(await beginSync())) return;
      applyBase();
      return;
    }
    if (!syncActive()) {
      if (!(await beginSync())) return;
      if (syncAlbum) applyBase();
    }
  }

  function pulse() {
    if (!bridge || !ip || !syncLyricsOn || !music || !music.playing) return;
    const now = Date.now();
    if (now - lastPulse < PULSE_MIN_GAP_MS) return;   // skipping through a song
    lastPulse = now;
    beginSync().then((ok) => {
      if (!ok) return;
      const base = syncBase();
      const dim = (pilot && pilot.dimming) || 100;
      // Brighten for the pulse; at high brightness dip deep instead.
      const peak = dim <= 50 ? Math.min(100, dim + 50) : Math.max(caps.dimMin, dim - 60);
      let flash;
      if ('r' in base) {
        const { h, s } = rgbHs([base.r, base.g, base.b]);
        const [r, g, b] = hsvRgb((h + PULSE_HUE_SHIFT) % 360, s);
        flash = { r, g, b };
      } else {
        // White: swing the temperature towards the other end of the range.
        const mid = (caps.tempMin + caps.tempMax) / 2;
        flash = { temp: base.temp < mid ? Math.min(caps.tempMax, base.temp + 2000) : Math.max(caps.tempMin, base.temp - 2000) };
      }
      send({ ...flash, dimming: peak, state: true });
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => send({ ...base, dimming: dim, state: true }), PULSE_MS);
    });
  }

  function setSync(kind, on) {
    if (kind === 'album') { syncAlbum = on; store.set('wiz_sync_album', on ? '1' : ''); }
    else { syncLyricsOn = on; store.set('wiz_sync_lyrics', on ? '1' : ''); }
    setGlow(false);
    if (!syncing()) {
      if (syncActive()) restore();
    } else {
      albumFor = '';                 // re-read the current album colour
      updateSync();
    }
    render();
  }

  // ---------- controls ----------
  function setLocal(params) {
    pilot = { ...(pilot || {}), ...params };
    render();
  }

  function setGlow(on) {
    glow = on;
    store.set('wiz_glow', on ? '1' : '');
  }

  function toggle() {
    const on = !(pilot && pilot.state);
    if (!on) stopSync(false);
    setLocal({ state: on });
    send({ state: on });
  }

  function setWhite(temp) {
    setGlow(false);
    stopSync(false);
    setLocal({ temp, sceneId: 0, r: 0, g: 0, b: 0, state: true });
    send({ temp, state: true });
  }

  function setColour([r, g, b]) {
    setGlow(false);
    stopSync(false);
    setLocal({ r, g, b, temp: 0, sceneId: 0, state: true });
    send({ r, g, b, state: true });
  }

  function setScene(id) {
    setGlow(false);
    stopSync(false);
    const speed = +$('lt-speed').value;
    const params = { sceneId: id, state: true };
    if (!STATIC_SCENES.has(id)) params.speed = speed;
    setLocal({ ...params, temp: 0 });
    send(params);
  }

  function setGlowLevel(dimming) {
    setGlow(true);
    stopSync(false);
    const temp = glowTemp(dimming);
    setLocal({ dimming, temp, sceneId: 0, r: 0, g: 0, b: 0, state: true });
    send({ dimming, temp, state: true });
  }

  function build() {
    $('lt-power').addEventListener('click', toggle);

    $('lt-name').addEventListener('click', editName);
    $('lt-name-form').addEventListener('submit', (e) => { e.preventDefault(); saveName(); });
    $('lt-name-input').addEventListener('blur', saveName);
    $('lt-status').addEventListener('click', () => {
      $('lt-info').hidden = !$('lt-info').hidden;
      if (!info) loadInfo();
    });

    for (const b of $('lt-tabs').children) {
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        showTab(tab);
      });
    }

    $('lt-dim').addEventListener('input', (e) => {
      const dimming = +e.target.value;
      if (glow && modeTab(pilot) === 'glow') return setGlowLevel(dimming);
      setLocal({ dimming, state: true });
      send({ dimming, state: true });
    });
    $('lt-temp').addEventListener('input', (e) => setWhite(+e.target.value));
    const colourInput = () => setColour(hsvRgb(+$('lt-hue').value, +$('lt-sat').value / 100));
    $('lt-hue').addEventListener('input', colourInput);
    $('lt-sat').addEventListener('input', colourInput);
    $('lt-speed').addEventListener('input', (e) => {
      if (!isScene(pilot)) return;
      const speed = +e.target.value;
      setLocal({ speed });
      send({ sceneId: pilot.sceneId, speed, state: true });
    });

    const swatch = (rgb, title, onClick) => {
      const b = document.createElement('button');
      b.className = 'lt-swatch';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.setProperty('--sw', `rgb(${rgb.join(',')})`);
      b.addEventListener('click', onClick);
      return b;
    };

    $('lt-whites').replaceChildren(...WHITES.map((w) => {
      const b = swatch(kelvinRgb(w.temp), w.label, () => setWhite(w.temp));
      b.classList.add('white');
      b.dataset.temp = w.temp;
      b.textContent = w.label;
      return b;
    }));
    $('lt-colours').replaceChildren(...COLOURS.map((rgb) => swatch(rgb, 'Colour', () => setColour(rgb))));

    const order = [...FAVOURITE_SCENES,
      ...Object.keys(SCENES).map(Number).filter((id) => !FAVOURITE_SCENES.includes(id))];
    $('lt-scenes').replaceChildren(...order.map((id) => {
      const [name, ...cols] = SCENES[id];
      const b = document.createElement('button');
      b.className = 'lt-scene' + (FAVOURITE_SCENES.includes(id) ? '' : ' extra');
      b.dataset.scene = id;
      const dot = document.createElement('i');
      dot.style.background = `linear-gradient(135deg, ${cols.join(', ')})`;
      const label = document.createElement('span');
      label.textContent = name;
      b.append(dot, label);
      b.addEventListener('click', () => setScene(id));
      return b;
    }));
    $('lt-more-scenes').addEventListener('click', () => {
      const all = $('lt-scenes').classList.toggle('all');
      $('lt-more-scenes').textContent = all ? 'Fewer scenes' : 'More scenes';
    });

    $('lt-glow-levels').replaceChildren(...GLOW_LEVELS.map((level) => {
      const b = document.createElement('button');
      b.className = 'lt-chip';
      b.dataset.level = level;
      b.textContent = level + '%';
      b.addEventListener('click', () => setGlowLevel(level));
      return b;
    }));

    $('lt-sync-album').addEventListener('change', (e) => setSync('album', e.target.checked));
    $('lt-sync-lyrics').addEventListener('change', (e) => setSync('lyrics', e.target.checked));

    $('lt-search').addEventListener('click', discover);
    $('lt-rescan').addEventListener('click', discover);
    $('lt-ip-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('lt-ip').value.trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) useBulb(v);
    });
    applyCaps();
  }

  let built = false;

  window.Light = {
    // Resolves true when this page is served by server.py (the bridge exists).
    async probe() {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const res = await fetch('/api/wiz/ping', { signal: ctl.signal });
        clearTimeout(t);
        bridge = res.ok && (await res.json()).ok === true;
      } catch { bridge = false; }
      return bridge;
    },
    // Called by the player on every poll: { id, art, playing } or null.
    onTrack(t) {
      const prev = music;
      music = t;
      const changed = !prev !== !t || (t && (t.id !== prev.id || t.playing !== prev.playing || t.art !== prev.art));
      if (changed) updateSync();
    },
    // Called by the player when a new synced lyric line starts.
    onLyricLine() { pulse(); },
    start() {
      if (!built) { build(); built = true; }
      showName();
      if (running) return;
      running = true;
      tab = null;
      if (ip) { showControls(true); render(); refresh(); }
      else discover();
    },
    stop() {
      running = false;
      clearTimeout(pollTimer);
    },
    toggle() { if (ip) toggle(); },
  };
})();
