// Weather line for the clock page, from Open-Meteo (free, keyless, CORS-enabled).
// Location: browser geolocation, falling back to an approximate IP lookup.
// Exposes window.Weather = { start(), stop() }.
'use strict';

(() => {
  const REFRESH_MS = 15 * 60 * 1000;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // WMO weather codes -> [label, icon]
  function describe(code, isDay) {
    if (code === 0) return ['Clear', isDay ? 'sun' : 'moon'];
    if (code === 1) return ['Mainly clear', isDay ? 'sun' : 'moon'];
    if (code === 2) return ['Partly cloudy', 'partly'];
    if (code === 3) return ['Overcast', 'cloud'];
    if (code === 45 || code === 48) return ['Fog', 'fog'];
    if (code >= 51 && code <= 57) return ['Drizzle', 'rain'];
    if (code >= 61 && code <= 67) return ['Rain', 'rain'];
    if (code >= 71 && code <= 77) return ['Snow', 'snow'];
    if (code >= 80 && code <= 82) return ['Showers', 'rain'];
    if (code === 85 || code === 86) return ['Snow showers', 'snow'];
    if (code >= 95) return ['Thunderstorm', 'storm'];
    return ['', 'cloud'];
  }

  // Minimal line icons on a 24x24 grid.
  const CLOUD = 'M7 18h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z';
  const ICONS = {
    sun: ['M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
      'M12 1.5v2.5M12 20v2.5M1.5 12H4M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8'],
    moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z'],
    partly: ['M8 4.5v1.5M3.5 9H5M4.8 5.8l1 1M12.2 5.8l-1 1', 'M11 9.2A3.6 3.6 0 0 0 5.2 11', CLOUD],
    cloud: [CLOUD],
    fog: ['M4 9h16M3 13h18M5 17h14'],
    rain: [CLOUD.replace('18h', '15h').replace('0 0 7 18z', '0 0 7 15z'), 'M8 18l-1 3M12 18l-1 3M16 18l-1 3'],
    snow: [CLOUD.replace('18h', '15h').replace('0 0 7 18z', '0 0 7 15z'), 'M8 19h.01M12 21h.01M16 19h.01'],
    storm: [CLOUD.replace('18h', '15h').replace('0 0 7 18z', '0 0 7 15z'), 'M12.5 15l-2 3.5h3l-2 3.5'],
  };

  function icon(name) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'wx-icon');
    s.setAttribute('data-icon', name);
    for (const d of ICONS[name] || ICONS.cloud) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  }

  // ---------- location (cached) ----------
  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?' +
        new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: 'en' }));
      const d = await res.json();
      return d.city || d.locality || d.principalSubdivision || '';
    } catch { return ''; }
  }

  function browserPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p.coords),
        reject,
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 6 * 3600 * 1000 },
      );
    });
  }

  // Approximate (city-level) location from the IP address; two keyless
  // providers so one being down or rate-limited isn't fatal.
  async function ipPosition() {
    const providers = ['https://get.geojs.io/v1/ip/geo.json', 'https://ipwho.is/'];
    for (const url of providers) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const d = await res.json();
        const latitude = parseFloat(d.latitude);
        const longitude = parseFloat(d.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          return { latitude, longitude, city: d.city || '' };
        }
      } catch {}
    }
    throw new Error('ip lookup failed');
  }

  async function getLocation() {
    try {
      const saved = JSON.parse(store.get('wx_location') || 'null');
      if (saved && typeof saved.lat === 'number') return saved;
    } catch {}

    let loc;
    try {
      const c = await browserPosition();
      loc = { lat: c.latitude, lon: c.longitude };
      loc.city = await reverseGeocode(loc.lat, loc.lon);
    } catch {
      const c = await ipPosition();
      loc = { lat: c.latitude, lon: c.longitude, city: c.city };
    }
    // ~1 km precision is plenty for weather and keeps the request vague.
    loc.lat = Math.round(loc.lat * 100) / 100;
    loc.lon = Math.round(loc.lon * 100) / 100;
    store.set('wx_location', JSON.stringify(loc));
    return loc;
  }

  // ---------- weather ----------
  async function fetchWeather(loc) {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: loc.lat,
      longitude: loc.lon,
      current: 'temperature_2m,weather_code,is_day',
      daily: 'temperature_2m_max,temperature_2m_min',
      forecast_days: 1,
      timezone: 'auto',
      temperature_unit: 'celsius',
    }));
    if (!res.ok) throw new Error('weather ' + res.status);
    const d = await res.json();
    return {
      temp: Math.round(d.current.temperature_2m),
      code: d.current.weather_code,
      isDay: d.current.is_day === 1,
      hi: Math.round(d.daily.temperature_2m_max[0]),
      lo: Math.round(d.daily.temperature_2m_min[0]),
      city: loc.city,
      unit: 'C',
      at: Date.now(),
    };
  }

  function render(w) {
    const box = document.getElementById('clock-weather');
    if (!w) { box.hidden = true; return; }
    const [label, iconName] = describe(w.code, w.isDay);
    const span = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    const parts = [icon(iconName), span('wx-temp', w.temp + '°C')];
    if (label) parts.push(span('wx-label', label));
    parts.push(span('wx-range', `H ${w.hi}°  L ${w.lo}°`));
    if (w.city) parts.push(span('wx-city', w.city));
    box.replaceChildren(...parts);
    box.hidden = false;
  }

  // Saved weather; entries from before the switch to Celsius-only (no unit)
  // are ignored so an old Fahrenheit reading is never shown with a "C".
  function cachedWeather() {
    try {
      const w = JSON.parse(store.get('wx_last') || 'null');
      return w && w.unit === 'C' ? w : null;
    } catch { return null; }
  }

  let timer = null;
  let running = false;

  async function refresh() {
    clearTimeout(timer);
    if (!running) return;
    let next = REFRESH_MS;
    try {
      const cached = cachedWeather();
      if (cached && Date.now() - cached.at < REFRESH_MS) {
        render(cached);
        next = REFRESH_MS - (Date.now() - cached.at);
      } else {
        const w = await fetchWeather(await getLocation());
        store.set('wx_last', JSON.stringify(w));
        render(w);
      }
    } catch {
      // Keep showing the last known weather; try again in a few minutes.
      render(cachedWeather());
      next = 5 * 60 * 1000;
    }
    if (running) timer = setTimeout(refresh, next);
  }

  window.Weather = {
    start() {
      if (running) return;
      running = true;
      refresh();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
})();
