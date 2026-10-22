// Clock page: several modern clock faces drawn into #clock-face.
// Exposes window.Clock = { STYLES, LABELS, setStyle(name), start(), stop() }.
'use strict';

(() => {
  const STYLES = ['digital', 'stacked', 'analog', 'rings', 'dots'];
  const LABELS = {
    digital: 'Digital',
    stacked: 'Stacked',
    analog: 'Analog',
    rings: 'Rings',
    dots: 'Dot matrix',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Follow the device's 12/24-hour preference.
  const HOUR12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;

  const pad = (n) => String(n).padStart(2, '0');

  function parts(d) {
    let h = d.getHours();
    const ampm = h < 12 ? 'AM' : 'PM';
    if (HOUR12) h = h % 12 || 12;
    return {
      h: HOUR12 ? String(h) : pad(h),
      hh: pad(h),
      m: pad(d.getMinutes()),
      s: pad(d.getSeconds()),
      ampm: HOUR12 ? ampm : '',
    };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ---------- faces: each has build(root) and update(date, secondChanged) ----------

  const digital = {
    build(root) {
      const w = el('div', 'cf-digital');
      this.hm = el('span', 'cf-hm');
      const side = el('span', 'cf-side');
      this.sec = el('span', 'cf-sec');
      this.ampm = el('span', 'cf-ampm');
      side.append(this.ampm, this.sec);
      w.append(this.hm, side);
      root.append(w);
    },
    update(d) {
      const p = parts(d);
      this.hm.textContent = p.h + ':' + p.m;
      this.sec.textContent = p.s;
      this.ampm.textContent = p.ampm;
    },
  };

  const stacked = {
    build(root) {
      const w = el('div', 'cf-stacked');
      this.h = el('div', 'cf-st-h');
      this.m = el('div', 'cf-st-m');
      w.append(this.h, this.m);
      root.append(w);
    },
    update(d) {
      const p = parts(d);
      this.h.textContent = p.hh;
      this.m.textContent = p.m;
    },
  };

  const analog = {
    smooth: true,
    build(root) {
      const s = svg('svg', { viewBox: '0 0 200 200', class: 'cf-analog' });
      s.append(svg('circle', { cx: 100, cy: 100, r: 96, class: 'cf-an-face' }));
      for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        s.append(svg('line', {
          x1: 100, y1: major ? 10 : 8, x2: 100, y2: major ? 22 : 13,
          class: major ? 'cf-an-tick major' : 'cf-an-tick',
          transform: `rotate(${i * 6} 100 100)`,
        }));
      }
      this.hour = svg('line', { x1: 100, y1: 108, x2: 100, y2: 52, class: 'cf-an-hour' });
      this.min = svg('line', { x1: 100, y1: 112, x2: 100, y2: 26, class: 'cf-an-min' });
      this.sec = svg('line', { x1: 100, y1: 120, x2: 100, y2: 18, class: 'cf-an-sec' });
      s.append(this.hour, this.min, this.sec,
        svg('circle', { cx: 100, cy: 100, r: 4, class: 'cf-an-hub' }));
      root.append(s);
    },
    update(d) {
      const sec = d.getSeconds() + d.getMilliseconds() / 1000;
      const min = d.getMinutes() + sec / 60;
      const hr = (d.getHours() % 12) + min / 60;
      this.hour.setAttribute('transform', `rotate(${hr * 30} 100 100)`);
      this.min.setAttribute('transform', `rotate(${min * 6} 100 100)`);
      this.sec.setAttribute('transform', `rotate(${sec * 6} 100 100)`);
    },
  };

  const rings = {
    smooth: true,
    build(root) {
      const s = svg('svg', { viewBox: '0 0 200 200', class: 'cf-rings' });
      // Outer to inner: seconds, minutes, hours.
      const spec = [['sec', 92], ['min', 78], ['hour', 64]];
      this.arcs = {};
      for (const [k, r] of spec) {
        const c = 2 * Math.PI * r;
        s.append(svg('circle', { cx: 100, cy: 100, r, class: 'cf-ring-track' }));
        const arc = svg('circle', {
          cx: 100, cy: 100, r, class: 'cf-ring cf-ring-' + k,
          'stroke-dasharray': `0 ${c}`, transform: 'rotate(-90 100 100)',
        });
        this.arcs[k] = { arc, c };
        s.append(arc);
      }
      const w = el('div', 'cf-rings-wrap');
      this.label = el('div', 'cf-rings-time');
      w.append(s, this.label);
      root.append(w);
    },
    update(d) {
      const sec = d.getSeconds() + d.getMilliseconds() / 1000;
      const min = d.getMinutes() + sec / 60;
      const hr = (d.getHours() % 12) + min / 60;
      const set = (k, frac) => {
        const { arc, c } = this.arcs[k];
        arc.setAttribute('stroke-dasharray', `${frac * c} ${c}`);
      };
      set('sec', sec / 60);
      set('min', min / 60);
      set('hour', hr / 12);
      const p = parts(d);
      this.label.textContent = p.h + ':' + p.m;
    },
  };

  // 5x7 dot-matrix glyphs, one string per row ('1' = lit).
  const GLYPHS = {
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ':': ['0', '0', '1', '0', '1', '0', '0'],
  };

  const dots = {
    build(root) {
      this.w = el('div', 'cf-dots');
      root.append(this.w);
      this.shown = '';
    },
    update(d) {
      const p = parts(d);
      const text = p.hh + ':' + p.m;
      // Blink the colon every other second.
      this.w.classList.toggle('blink-off', d.getSeconds() % 2 === 1);
      if (text === this.shown) return;
      this.shown = text;
      this.w.replaceChildren(...[...text].map((ch) => {
        const rows = GLYPHS[ch];
        const g = el('div', 'cf-glyph' + (ch === ':' ? ' colon' : ''));
        g.style.gridTemplateColumns = `repeat(${rows[0].length}, 1fr)`;
        for (const row of rows) for (const bit of row) g.append(el('i', bit === '1' ? 'on' : ''));
        return g;
      }));
    },
  };

  const FACES = { digital, stacked, analog, rings, dots };

  // ---------- driver ----------
  let style = 'digital';
  let running = false;
  let raf = 0;
  let lastSecond = -1;
  let lastDate = '';

  function render() {
    const root = document.getElementById('clock-face');
    root.className = 'clock-face style-' + style;
    root.replaceChildren();
    FACES[style].build(root);
    lastSecond = -1;
  }

  function frame() {
    if (!running) return;
    const d = new Date();
    const face = FACES[style];
    const sec = d.getSeconds();
    if (face.smooth || sec !== lastSecond) face.update(d);
    if (sec !== lastSecond) {
      lastSecond = sec;
      const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      if (date !== lastDate) {
        lastDate = date;
        document.getElementById('clock-date').textContent = date;
      }
    }
    // Smooth faces animate every frame; the others only need ~4 checks a second.
    raf = FACES[style].smooth
      ? requestAnimationFrame(frame)
      : setTimeout(() => requestAnimationFrame(frame), 250);
  }

  window.Clock = {
    STYLES,
    LABELS,
    setStyle(name) {
      style = STYLES.includes(name) ? name : 'digital';
      render();
      return style;
    },
    start() {
      if (running) return;
      running = true;
      lastDate = '';
      frame();
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(raf);
    },
  };
})();
