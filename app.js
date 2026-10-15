// Now Playing — shows the current Spotify track using the Web API.
// Auth: Authorization Code with PKCE (no client secret, runs fully in the browser).
'use strict';

const SCOPES = 'user-read-currently-playing user-read-playback-state';
const POLL_MS = 3000;
// Client ID of the user's Spotify developer app (public; no secret needed with PKCE).
const DEFAULT_CLIENT_ID = 'c63c46b7f118408aa242c93d13cb32ac';
const REDIRECT_URI = location.origin + location.pathname;

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
  if (!res.ok) throw new Error('Spotify API ' + res.status);
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

  if (!item) {
    $('title').textContent = 'Nothing playing';
    $('artist').textContent = p ? 'Spotify is open but idle' : 'Start playing on any device';
    $('album').textContent = '';
    $('status').textContent = '';
    $('device').textContent = '';
    setArt('');
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
  $('bar-fill').style.width = (pos / item.duration_ms) * 100 + '%';
  $('pos').textContent = fmt(pos);
  $('dur').textContent = fmt(item.duration_ms);
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
  if (!document.hidden && !$('player').hidden) poll();
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
  $('player').hidden = !(hasClient && hasToken);
  if (hasClient && hasToken) {
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

// Single tap: fullscreen. Double tap: cycle background mode.
const DOUBLE_TAP_MS = 300;
let tapTimer = null;
$('player').addEventListener('click', () => {
  if (tapTimer) {
    clearTimeout(tapTimer);
    tapTimer = null;
    cycleMode();
  } else {
    tapTimer = setTimeout(() => { tapTimer = null; toggleFullscreen(); }, DOUBLE_TAP_MS);
  }
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

setInterval(tick, 500);

(async () => {
  try {
    await handleRedirect();
  } catch (e) {
    showToast(e.message);
  }
  showView();
})();
