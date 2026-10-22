// Now Playing — shows the current Spotify track using the Web API.
// Auth: Authorization Code with PKCE (no client secret, runs fully in the browser).
'use strict';

const SCOPES = 'user-read-currently-playing user-read-playback-state';
const POLL_MS = 3000;
// Client ID of the user's Spotify developer app (public; no secret needed with PKCE).
const DEFAULT_CLIENT_ID = 'c63c46b7f118408aa242c93d13cb32ac';
// Normalise so /index.html and / both use the same registered redirect URI.
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

const $ = (id) => document.getElementById(id);

// ---------- storage (wrapped: localStorage can throw in some WebViews) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- PKCE helpers ----------
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256base64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startLogin() {
  const clientId = store.get('client_id');
  const verifier = randomString(64);
  const state = randomString(16);
  store.set('pkce_verifier', verifier);
  store.set('pkce_state', state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await sha256base64url(verifier),
    state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: store.get('client_id'), ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'token request failed');
  store.set('access_token', data.access_token);
  store.set('expires_at', String(Date.now() + (data.expires_in - 60) * 1000));
  // Spotify may rotate the refresh token; keep the old one if it doesn't.
  if (data.refresh_token) store.set('refresh_token', data.refresh_token);
}

async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);

  if (q.get('error')) throw new Error('Spotify login: ' + q.get('error'));
  if (q.get('state') !== store.get('pkce_state')) throw new Error('Login state mismatch, try again');

  await tokenRequest({
    grant_type: 'authorization_code',
    code: q.get('code'),
    redirect_uri: REDIRECT_URI,
    code_verifier: store.get('pkce_verifier'),
  });
  store.del('pkce_verifier');
  store.del('pkce_state');
}

let refreshing = null;
async function getToken() {
  if (Number(store.get('expires_at')) > Date.now()) return store.get('access_token');
  // Collapse concurrent refreshes into one request.
  refreshing ??= tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: store.get('refresh_token'),
  }).finally(() => { refreshing = null; });
  await refreshing;
  return store.get('access_token');
}

function logout() {
  ['access_token', 'refresh_token', 'expires_at'].forEach(store.del);
}

// ---------- Spotify API ----------
async function fetchPlayback() {
  const res = await fetch(
    'https://api.spotify.com/v1/me/player?additional_types=track,episode',
    { headers: { Authorization: 'Bearer ' + (await getToken()) } },
  );
  if (res.status === 204) return null;            // no active device
  if (res.status === 401) {                        // token revoked/expired early
    store.set('expires_at', '0');
    throw new Error('auth');
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After') || 5);
    throw Object.assign(new Error('rate limited'), { retryAfter: wait * 1000 });
  }
  if (!res.ok) {
    // Surface Spotify's reason (e.g. a 403 for a user not added to a development-mode app).
    // The development-mode 403 comes back as plain text, other errors as JSON.
    let reason = '';
    try {
      const body = await res.text();
      try { reason = JSON.parse(body).error?.message || ''; } catch { reason = body.trim(); }
    } catch {}
    throw new Error('Spotify API ' + res.status + (reason ? ': ' + reason : ''));
  }
  return res.json();
}

// ---------- rendering ----------
let current = null;        // last playback payload
let fetchedAt = 0;         // when it was fetched (for local progress interpolation)
let shownArt = '';

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function render(p) {
  current = p;
  fetchedAt = Date.now();
  const item = p && p.item;
  autoPage(!!(item && p.is_playing));

  if (!item) {
    $('title').textContent = 'Nothing playing';
    $('artist').textContent = p ? 'Spotify is open but idle' : 'Start playing on any device';
    $('album').textContent = '';
    $('status').textContent = '';
    $('device').textContent = '';
    setArt('');
    loadLyrics(null);
    tick();
    return;
  }

  const isEpisode = item.type === 'episode';
  $('title').textContent = item.name;
  $('artist').textContent = isEpisode
    ? item.show.name
    : item.artists.map((a) => a.name).join(', ');
  $('album').textContent = isEpisode ? '' : item.album.name;

  const status = $('status');
  status.textContent = p.is_playing ? 'Now playing' : 'Paused';
  status.classList.toggle('paused', !p.is_playing);

  $('device').textContent = p.device ? '▶ ' + p.device.name : '';

  const images = isEpisode ? item.images : item.album.images;
  setArt(images && images.length ? images[0].url : '');
  loadLyrics(isEpisode ? null : item);
  document.title = item.name + ' · ' + $('artist').textContent;
  tick();
}

function setArt(url) {
  if (url === shownArt) return;
  shownArt = url;
  const art = $('art');
  const backdrop = $('backdrop');
  art.classList.remove('on');
  backdrop.classList.remove('on');
  $('art-empty').hidden = !!url;
  if (!url) return;

  const img = new Image();
  img.onload = () => {
    if (shownArt !== url) return;   // a newer track arrived meanwhile
    art.src = url;
    art.classList.add('on');
    backdrop.style.backgroundImage = `url("${url}")`;
    backdrop.classList.add('on');
  };
  img.src = url;
}

// Progress bar runs locally between polls so it moves smoothly.
function tick() {
  const item = current && current.item;
  if (!item) {
    $('bar-fill').style.width = '0';
    $('pos').textContent = '0:00';
    $('dur').textContent = '0:00';
    return;
  }
  let pos = current.progress_ms || 0;
  if (current.is_playing) pos += Date.now() - fetchedAt;
  pos = Math.min(pos, item.duration_ms);
  syncLyrics(pos);
  $('bar-fill').style.width = (pos / item.duration_ms) * 100 + '%';
  $('pos').textContent = fmt(pos);
  $('dur').textContent = fmt(item.duration_ms);
}

// ---------- lyrics (LRCLIB: free, keyless, CORS-enabled) ----------
let lyricsFor = null;      // track id the lyrics panel currently belongs to
let lyricLines = [];       // [{ t: ms, text }] when synced, else []
let lyricIndex = -1;
// The lyrics view shows only when the user wants it (long press) AND the
// current track has lyrics; otherwise the normal player view is shown.
let lyricsWanted = !!store.get('lyrics_on');
let lyricsReady = false;

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: (Number(m[1]) * 60 + Number(m[2])) * 1000, text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

// LRCLIB rate-limits per IP, and its 429 responses carry no CORS headers, so
// the browser reports them as network errors. Send one request at a time,
// spaced out, and back off on any failure. Requests for tracks that are no
// longer wanted (skipped) are dropped instead of retried.
const LRCLIB_GAP_MS = 1500;
const LRCLIB_MAX_BACKOFF_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lrclibChain = Promise.resolve();
let lrclibNextAt = 0;

function lrclib(path, params, wanted) {
  const url = 'https://lrclib.net/api/' + path + '?' + new URLSearchParams(params);
  const run = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!wanted()) throw new Error('cancelled');
      const wait = lrclibNextAt - Date.now();
      if (wait > 0) await sleep(wait);
      if (!wanted()) throw new Error('cancelled');
      lrclibNextAt = Date.now() + LRCLIB_GAP_MS;
      let res = null;
      try { res = await fetch(url); } catch {}   // CORS-less 429 lands here
      if (res && res.status !== 429) return res;
      const retryAfter = res ? Number(res.headers.get('Retry-After') || 1) : 1;
      lrclibNextAt = Date.now()
        + Math.min(LRCLIB_MAX_BACKOFF_MS, retryAfter * 1000 * 2 ** attempt)
        + Math.random() * 500;
    }
    throw new Error('lyrics rate limited');
  };
  const p = lrclibChain.then(run, run);
  lrclibChain = p.catch(() => {});
  return p;
}

// "Song - Remastered 2011", "Song (feat. X)", "Song (From "Film")" -> "Song"
function cleanTitle(name) {
  return name
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')
    .trim() || name;
}

// One search request per track; a second one with a cleaned title only if
// the first finds nothing within 3 s of the track's duration.
async function fetchLyrics(item, wanted) {
  const durationS = item.duration_ms / 1000;
  const artist = item.artists[0].name;
  const pick = (hits) => hits
    .filter((h) => Math.abs(h.duration - durationS) <= 3)
    .sort((a, b) => !!b.syncedLyrics - !!a.syncedLyrics || !!b.plainLyrics - !!a.plainLyrics)[0] || null;

  const search = async (title) => {
    const res = await lrclib('search', { track_name: title, artist_name: artist }, wanted);
    if (!res.ok) throw new Error('lyrics ' + res.status);
    return pick(await res.json());
  };
  const hit = await search(item.name);
  const clean = cleanTitle(item.name);
  return hit || (clean !== item.name ? search(clean) : null);
}

// Normalised result: { kind: 'synced' | 'plain' | 'instrumental' | 'none', lrc?, text? }
function toLyricsResult(data) {
  if (!data) return { kind: 'none' };
  if (data.instrumental) return { kind: 'instrumental' };
  if (data.syncedLyrics) return { kind: 'synced', lrc: data.syncedLyrics };
  if (data.plainLyrics) return { kind: 'plain', text: data.plainLyrics };
  return { kind: 'none' };
}

// Cache results per track (persisted, most recent 150) so repeats are instant
// and don't hit LRCLIB; share in-flight requests between prefetch and display.
const LYRICS_CACHE_MAX = 150;
const lyricsCache = new Map();
try {
  for (const [k, v] of JSON.parse(store.get('lyrics_cache') || '[]')) lyricsCache.set(k, v);
} catch {}
let cacheSaveTimer = null;
function cacheLyrics(id, result) {
  lyricsCache.delete(id);
  lyricsCache.set(id, result);
  while (lyricsCache.size > LYRICS_CACHE_MAX) lyricsCache.delete(lyricsCache.keys().next().value);
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => store.set('lyrics_cache', JSON.stringify([...lyricsCache])), 1000);
}

const lyricsInFlight = new Map();
let prefetchId = null;
const isWanted = (id) => () => id === lyricsFor || id === prefetchId;

function getLyrics(item) {
  const id = item.id || item.uri;
  if (lyricsCache.has(id)) return Promise.resolve(lyricsCache.get(id));
  if (!lyricsInFlight.has(id)) {
    lyricsInFlight.set(id, fetchLyrics(item, isWanted(id))
      .then((data) => { const r = toLyricsResult(data); cacheLyrics(id, r); return r; })
      .finally(() => lyricsInFlight.delete(id)));
  }
  return lyricsInFlight.get(id);
}

// Look up the next queued track's lyrics ahead of time (once per track).
let prefetchedAfter = null;
async function prefetchNextLyrics(currentId) {
  if (prefetchedAfter === currentId) return;
  prefetchedAfter = currentId;
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/queue', {
      headers: { Authorization: 'Bearer ' + (await getToken()) },
    });
    if (!res.ok) return;
    const next = (await res.json()).queue?.find((t) => t && t.type === 'track');
    if (next && !lyricsCache.has(next.id)) {
      prefetchId = next.id;
      await getLyrics(next);
    }
  } catch {}
}

function showLyricsMessage(msg) {
  lyricLines = [];
  lyricIndex = -1;
  lyricsReady = false;
  const box = $('lyrics');
  box.replaceChildren();
  const p = document.createElement('p');
  p.className = 'lyrics-msg';
  p.textContent = msg;
  box.append(p);
  updateLyricsView();
}

function showLyricLines(lines, synced) {
  lyricLines = synced ? lines : [];
  lyricIndex = -1;
  const box = $('lyrics');
  box.replaceChildren(...lines.map((l) => {
    const p = document.createElement('p');
    p.className = 'lyric' + (synced ? '' : ' plain');
    p.textContent = l.text || '♪';
    return p;
  }));
  box.scrollTop = 0;
  lyricsReady = true;
  updateLyricsView();
}

function showLyricsResult(r) {
  if (r.kind === 'synced') showLyricLines(parseLrc(r.lrc), true);
  else if (r.kind === 'plain') showLyricLines(r.text.split('\n').map((text) => ({ text })), false);
  else if (r.kind === 'instrumental') showLyricsMessage('♪ Instrumental ♪');
  else showLyricsMessage('No lyrics found');
}

let lyricsRetry = null;
async function loadLyrics(item) {
  const id = item ? item.id || item.uri : null;
  if (id === lyricsFor) return;
  lyricsFor = id;
  clearTimeout(lyricsRetry);
  if (!item) return showLyricsMessage('');

  if (!lyricsCache.has(id)) showLyricsMessage('Loading lyrics…');
  try {
    const r = await getLyrics(item);
    if (lyricsFor !== id) return;              // track changed while loading
    showLyricsResult(r);
    prefetchNextLyrics(id);
  } catch {
    if (lyricsFor === id) {
      showLyricsMessage('Lyrics unavailable');
      // Backoff already happened inside lrclib(); try once more a bit later.
      lyricsRetry = setTimeout(() => { if (lyricsFor === id) { lyricsFor = null; loadLyrics(item); } }, 20000);
    }
  }
}

// Highlight the line for the current position and keep it centred.
function syncLyrics(pos) {
  if (!lyricLines.length) return;
  let i = -1;
  while (i + 1 < lyricLines.length && lyricLines[i + 1].t <= pos) i++;
  if (i === lyricIndex) return;
  const box = $('lyrics');
  const els = box.children;
  if (els[lyricIndex]) els[lyricIndex].classList.remove('active');
  lyricIndex = i;
  const el = els[i];
  if (!el) return;
  el.classList.add('active');
  if (!box.hidden) {
    box.scrollTo({
      top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2,
      behavior: 'smooth',
    });
  }
}

function updateLyricsView() {
  const on = lyricsWanted && lyricsReady;
  const wasOn = document.body.classList.contains('lyrics-on');
  document.body.classList.toggle('lyrics-on', on);
  $('lyrics').hidden = !on;
  // Re-centre immediately when the panel becomes visible.
  if (on && !wasOn) { lyricIndex = -1; tick(); }
}

function setLyricsWanted(on) {
  lyricsWanted = on;
  store.set('lyrics_on', on ? '1' : '');
  updateLyricsView();
}

// ---------- polling loop ----------
let pollTimer = null;

async function poll() {
  clearTimeout(pollTimer);
  let next = POLL_MS;
  try {
    render(await fetchPlayback());
    hideToast();
  } catch (e) {
    if (e.message === 'auth') {
      try { await getToken(); next = 0; }
      catch { logout(); return showView(); }
    } else if (e.retryAfter) {
      next = e.retryAfter;
    } else if (/refresh_token|invalid_grant/i.test(e.message)) {
      logout();
      return showView();
    } else {
      showToast(navigator.onLine ? e.message : 'Offline — retrying…');
      next = POLL_MS * 2;
    }
  }
  // Poll slowly while the page is hidden.
  if (document.hidden) next = Math.max(next, 15000);
  pollTimer = setTimeout(poll, next);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !($('player').hidden && $('clock').hidden)) poll();
});

// ---------- UI plumbing ----------
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('toast').hidden = true; }

function showView() {
  const hasClient = !!store.get('client_id');
  const hasToken = !!store.get('refresh_token');
  $('setup').hidden = hasClient;
  $('login').hidden = !hasClient || hasToken;
  const ready = hasClient && hasToken;
  if (!ready) {
    $('player').hidden = true;
    $('clock').hidden = true;
    Clock.stop();
    Weather.stop();
  } else {
    showPage(page, false);
    poll();
    keepAwake();
  }
}

// Keep the screen on while the monitor is visible (if supported).
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) keepAwake();
});

// ---------- background modes ----------
// black: plain black · blur: blurred album art · grey: black + greyscale
const MODES = ['black', 'blur', 'grey'];
const MODE_LABELS = { black: 'Black', blur: 'Album blur', grey: 'Greyscale' };

function applyMode(mode) {
  if (!MODES.includes(mode)) mode = 'black';
  MODES.forEach((m) => document.body.classList.toggle('mode-' + m, m === mode));
  store.set('bg_mode', mode);
  return mode;
}

function cycleMode() {
  const cur = store.get('bg_mode') || 'black';
  const next = applyMode(MODES[(MODES.indexOf(cur) + 1) % MODES.length]);
  showToast(MODE_LABELS[next]);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 1200);
}

applyMode(store.get('bg_mode'));

function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else el.requestFullscreen?.().catch(() => {});
}

// ---------- pages: now playing <-> clock ----------
const PAGES = ['player', 'clock'];
let page = PAGES.includes(store.get('page')) ? store.get('page') : 'player';
let pagerTimer = null;

function showPage(name, announce = true) {
  page = name;
  store.set('page', name);
  $('player').hidden = name !== 'player';
  $('clock').hidden = name !== 'clock';
  if (name === 'clock') { Clock.start(); Weather.start(); }
  else { Clock.stop(); Weather.stop(); }

  // Page dots, briefly.
  const pager = $('pager');
  [...pager.children].forEach((d, i) => d.classList.toggle('on', PAGES[i] === name));
  if (announce) {
    pager.hidden = false;
    pager.classList.add('show');
    clearTimeout(pagerTimer);
    pagerTimer = setTimeout(() => pager.classList.remove('show'), 1500);
  }
}

function nextPage(dir) {
  const i = PAGES.indexOf(page);
  showPage(PAGES[(i + dir + PAGES.length) % PAGES.length]);
  // A manual switch wins over the automatic one; restart the idle wait.
  autoSwitched = false;
  if (idleSince !== null) idleSince = Date.now();
}

// Automatic page switching: after IDLE_TO_CLOCK_MS without playback, show the
// clock; when playback resumes, return to Now Playing — but only if it was the
// app (not the user) that switched to the clock.
const IDLE_TO_CLOCK_MS = 20000;
let idleSince = null;      // when playback stopped, or null while playing
let autoSwitched = false;  // the clock is showing because of autoPage()

function autoPage(playing) {
  if (playing) {
    idleSince = null;
    if (autoSwitched && page === 'clock') showPage('player');
    autoSwitched = false;
    return;
  }
  if (idleSince === null) idleSince = Date.now();
  if (page === 'player' && Date.now() - idleSince >= IDLE_TO_CLOCK_MS) {
    showPage('clock');
    autoSwitched = true;
  }
}

let clockStyle = Clock.setStyle(store.get('clock_style'));

function cycleClockStyle() {
  const i = Clock.STYLES.indexOf(clockStyle);
  clockStyle = Clock.setStyle(Clock.STYLES[(i + 1) % Clock.STYLES.length]);
  store.set('clock_style', clockStyle);
  showToast(Clock.LABELS[clockStyle]);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 1200);
}

// ---------- gestures ----------
// Single tap: fullscreen. Double tap: page-specific (background mode on the
// player, clock style on the clock). Long press: page-specific (lyrics on the
// player). Horizontal swipe: switch page.
const DOUBLE_TAP_MS = 300;
const LONG_PRESS_MS = 550;
const SWIPE_MIN_PX = 60;
const MOVE_CANCEL_PX = 12;

function addGestures(target, { onDoubleTap, onLongPress }) {
  let tapTimer = null;
  let pressTimer = null;
  let suppressClick = false;
  let start = null;

  target.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    if (onLongPress) {
      pressTimer = setTimeout(() => { suppressClick = true; onLongPress(); }, LONG_PRESS_MS);
    }
  });
  target.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_CANCEL_PX) {
      clearTimeout(pressTimer);
    }
  });
  target.addEventListener('pointerup', (e) => {
    clearTimeout(pressTimer);
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      suppressClick = true;
      nextPage(dx < 0 ? 1 : -1);
    }
  });
  ['pointercancel', 'pointerleave'].forEach((ev) =>
    target.addEventListener(ev, () => { clearTimeout(pressTimer); start = null; }));
  target.addEventListener('contextmenu', (e) => e.preventDefault());

  target.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
      onDoubleTap();
    } else {
      tapTimer = setTimeout(() => { tapTimer = null; toggleFullscreen(); }, DOUBLE_TAP_MS);
    }
  });
}

function toggleLyrics() {
  const on = !lyricsWanted;
  setLyricsWanted(on);
  showToast(!on ? 'Lyrics off' : lyricsReady ? 'Lyrics' : 'Lyrics on · none for this track yet');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 1200);
}

addGestures($('player'), { onDoubleTap: cycleMode, onLongPress: toggleLyrics });
// Clock colours: colourful (default) or greyscale, toggled with a long press.
function applyClockColor(mono) {
  $('clock').classList.toggle('mono', mono);
  store.set('clock_mono', mono ? '1' : '');
}
function toggleClockColor() {
  const mono = !$('clock').classList.contains('mono');
  applyClockColor(mono);
  showToast(mono ? 'Greyscale' : 'Colourful');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 1200);
}
applyClockColor(!!store.get('clock_mono'));

addGestures($('clock'), { onDoubleTap: cycleClockStyle, onLongPress: toggleClockColor });

// Keyboard: ←/→ switch page.
document.addEventListener('keydown', (e) => {
  if ($('player').hidden && $('clock').hidden) return;   // setup/login screens
  if (e.key === 'ArrowRight') nextPage(1);
  else if (e.key === 'ArrowLeft') nextPage(-1);
  else return;
  e.preventDefault();
});

$('redirect-uri').textContent = REDIRECT_URI;

$('save-client').addEventListener('click', () => {
  const id = $('client-id').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) return showToast('That doesn\'t look like a Client ID (32 hex characters)');
  store.set('client_id', id);
  startLogin();
});
$('connect').addEventListener('click', startLogin);
$('reset').addEventListener('click', () => {
  store.del('client_id');
  logout();
  showView();
});

if (!store.get('client_id')) store.set('client_id', DEFAULT_CLIENT_ID);

// Hide the cursor after 3 s without pointer movement; show it again on move.
const CURSOR_IDLE_MS = 3000;
let cursorTimer = null;
function wakeCursor() {
  document.body.classList.remove('cursor-idle');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('cursor-idle'), CURSOR_IDLE_MS);
}
['mousemove', 'pointermove', 'keydown'].forEach((ev) => document.addEventListener(ev, wakeCursor));
wakeCursor();

setInterval(tick, 250);

(async () => {
  try {
    await handleRedirect();
  } catch (e) {
    showToast(e.message);
  }
  showView();
})();
