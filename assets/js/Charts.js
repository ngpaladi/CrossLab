'use strict';

/**
 * Charts.js — canvas chart primitives and the views CrossLab draws.
 *
 * Conventions, carried over from CritLab and held to here:
 *   · one value axis per chart — never two y-scales
 *   · colour follows the entity: a feature keeps its colour everywhere, a lap
 *     keeps its colour everywhere, so filtering never repaints a series
 *   · time lost uses a diverging ramp around zero, because zero means
 *     something: exactly your own median, or exactly your best lap
 *   · grid and axes stay recessive; labels are selective, never per-point
 *   · every plotted chart carries a hover layer
 */
const Charts = (() => {

  const SERIES = {
    speed: { color: '#c98500', label: 'Speed' },
    watts: { color: '#d95926', label: 'Power' },
    wbal:  { color: '#199e70', label: "W′ balance" },
    hr:    { color: '#d55181', label: 'Heart rate' },
    cad:   { color: '#3987e5', label: 'Cadence' },
  };

  // Lap colours: an ordinal palette, assigned by lap number and never cycled
  // within a race (a 12-lap race wraps, and the legend says so).
  const LAPS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#a78bfa', '#6da7ec', '#e66767', '#8b949e', '#d9b26f'];
  const lapColor = lap => LAPS[(lap - 1) % LAPS.length];

  const INK = {
    text: '#e6edf3',
    muted: '#8b949e',
    grid: '#2c313a',
    axis: '#3a424d',
    surface: '#161b22',
    surface2: '#21262d',
  };

  const DIVERGE = { cool: '#6da7ec', mid: '#4a4a47', warm: '#e66767' };

  // ── OKLab colour interpolation ────────────────────────────────────────────

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.min(255, Math.max(0, v * 255)));
  }
  function hexToOklab(hex) {
    const h = hex.replace('#', '');
    const r = srgbToLinear(parseInt(h.slice(0, 2), 16));
    const g = srgbToLinear(parseInt(h.slice(2, 4), 16));
    const b = srgbToLinear(parseInt(h.slice(4, 6), 16));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }
  function oklabToCss([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    const r = linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const bb = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    return 'rgb(' + r + ',' + g + ',' + bb + ')';
  }

  const _cool = hexToOklab(DIVERGE.cool);
  const _mid = hexToOklab(DIVERGE.mid);
  const _warm = hexToOklab(DIVERGE.warm);

  /**
   * Seconds lost or gained → colour. Zero is the neutral midpoint; warm is
   * slower (time lost), cool is faster. `halfSpan` is the number of seconds
   * at which the ramp saturates.
   */
  function deltaColor(d, halfSpan) {
    if (!isFinite(d)) return '#3d444d';
    const span = Math.max(0.25, halfSpan);
    const f = Math.max(-1, Math.min(1, d / span));
    const pole = f < 0 ? _cool : _warm;
    const k = Math.abs(f);
    return oklabToCss(_mid.map((c, i) => c + (pole[i] - c) * k));
  }

  /**
   * Speed → colour for the course map. Sequential, warm at the slow end,
   * because on this map slow is what you are looking for.
   */
  function speedColor(v, lo, hi) {
    if (!isFinite(v)) return '#3d444d';
    const f = Math.max(0, Math.min(1, (v - lo) / Math.max(0.1, hi - lo)));
    // warm → mid → cool, through OKLab so the steps look even
    if (f < 0.5) { const k = f / 0.5; return oklabToCss(_warm.map((c, i) => c + (_mid[i] - c) * k)); }
    const k = (f - 0.5) / 0.5;
    return oklabToCss(_mid.map((c, i) => c + (_cool[i] - c) * k));
  }

  /** Legend swatches for the delta ramp. */
  function deltaLegendStops(halfSpan) {
    const s = Math.max(0.25, halfSpan);
    return [-s, -s / 2, 0, s / 2, s].map(d => ({ d, color: deltaColor(d, s) }));
  }

  /** Midpoint zero, arm length from the spread of the values (percentiles). */
  function deltaScale(values) {
    const v = values.filter(isFinite).map(Math.abs).sort((a, b) => a - b);
    if (!v.length) return { halfSpan: 2 };
    const i = Math.max(0, Math.min(v.length - 1, 0.9 * (v.length - 1)));
    const lo = Math.floor(i), hi = Math.ceil(i);
    const p90 = lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
    return { halfSpan: Math.max(1, p90) };
  }

  // ── Canvas plumbing ───────────────────────────────────────────────────────

  function setup(canvas, cssHeight) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(120, rect.width || canvas.parentElement.clientWidth || 600);
    const h = cssHeight || parseInt(canvas.dataset.h || '260', 10);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function box(w, h, pad) {
    const p = { l: 46, r: 12, t: 12, b: 26, ...pad };
    return { ...p, x0: p.l, x1: w - p.r, y0: p.t, y1: h - p.b, w: w - p.l - p.r, h: h - p.t - p.b };
  }

  function scale(d0, d1, r0, r1) {
    const span = d1 - d0 || 1;
    const f = x => r0 + ((x - d0) / span) * (r1 - r0);
    f.invert = y => d0 + ((y - r0) / (r1 - r0 || 1)) * span;
    f.domain = [d0, d1];
    return f;
  }

  function ticks(lo, hi, count = 5) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return out;
  }

  function gridY(g, b, y, vals, fmt) {
    g.save();
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of vals) {
      const yy = Math.round(y(v)) + 0.5;
      if (yy < b.y0 - 1 || yy > b.y1 + 1) continue;
      g.strokeStyle = v === 0 ? INK.axis : INK.grid;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(b.x0, yy); g.lineTo(b.x1, yy); g.stroke();
      g.fillStyle = INK.muted;
      g.fillText(fmt ? fmt(v) : String(v), b.x0 - 6, yy);
    }
    g.restore();
  }

  function axisX(g, b, x, vals, fmt) {
    g.save();
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.strokeStyle = INK.axis;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(b.x0, b.y1 + 0.5); g.lineTo(b.x1, b.y1 + 0.5); g.stroke();
    for (const v of vals) {
      const xx = Math.round(x(v)) + 0.5;
      if (xx < b.x0 - 1 || xx > b.x1 + 1) continue;
      g.strokeStyle = INK.grid;
      g.beginPath(); g.moveTo(xx, b.y0); g.lineTo(xx, b.y1); g.stroke();
      g.fillStyle = INK.muted;
      g.fillText(fmt ? fmt(v) : String(v), xx, b.y1 + 5);
    }
    g.restore();
  }

  function line(g, b, xs, ys, x, y, color, opts = {}) {
    g.save();
    g.beginPath();
    g.rect(b.x0, b.y0 - 2, b.w, b.h + 4);
    g.clip();
    g.strokeStyle = color;
    g.lineWidth = opts.width || 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (opts.alpha != null) g.globalAlpha = opts.alpha;
    if (opts.dash) g.setLineDash(opts.dash);
    g.beginPath();
    let started = false;
    const stride = Math.max(1, Math.floor(xs.length / (b.w * 2)));
    for (let i = 0; i < xs.length; i += stride) {
      const v = ys[i];
      if (!isFinite(v)) { started = false; continue; }
      const px = x(xs[i]), py = y(v);
      if (!started) { g.moveTo(px, py); started = true; } else { g.lineTo(px, py); }
    }
    g.stroke();
    g.restore();
  }

  function label(g, text, px, py, color, align = 'left') {
    g.save();
    g.font = '600 11px system-ui, -apple-system, sans-serif';
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = INK.surface;
    g.strokeText(text, px, py);
    g.fillStyle = color;
    g.fillText(text, px, py);
    g.restore();
  }

  /** Shade the feature zones along a lap-distance x axis, with their names. */
  function shadeFeatures(g, b, x, A, opts = {}) {
    const feats = (A.features || []).filter(f => f.j0 >= 0 && !f.offCourse && !f.wraps);
    const ml = A.meanLap;
    if (!ml) return;
    g.save();
    g.beginPath(); g.rect(b.x0, b.y0, b.w, b.h); g.clip();
    for (const f of feats) {
      const x0 = x(ml.s[f.j0]), x1 = x(f.j1 >= ml.n ? ml.lapLen : ml.s[f.j1]);
      g.fillStyle = f.color;
      g.globalAlpha = 0.13;
      g.fillRect(x0, b.y0, Math.max(2, x1 - x0), b.h);
      g.globalAlpha = 1;
      if (opts.labels !== false && x1 - x0 > 8) {
        g.save();
        g.font = '600 10px system-ui, -apple-system, sans-serif';
        g.fillStyle = f.color;
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.translate(x0 + 3, b.y0 + 3);
        // Let the name overflow a narrow band: a barrier zone is 8 m wide and
        // still deserves its name, not "Ba…".
        g.fillText(shorten(f.label, Math.max(9, Math.floor((x1 - x0 + 40) / 5.5))), 0, 0);
        g.restore();
      }
    }
    g.restore();
  }

  // ── Hover layer ───────────────────────────────────────────────────────────

  function tooltipFor(canvas) {
    const wrap = canvas.closest('.chart-wrap') || canvas.parentElement;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    let tip = wrap.querySelector(':scope > .tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tooltip';
      wrap.appendChild(tip);
    }
    return { wrap, tip };
  }

  function onHover(canvas, handler) {
    const { wrap, tip } = tooltipFor(canvas);
    if (canvas._clHover) canvas.removeEventListener('pointermove', canvas._clHover);
    if (canvas._clLeave) canvas.removeEventListener('pointerleave', canvas._clLeave);

    const move = ev => {
      const r = canvas.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const html = handler(px, py);
      if (!html) { tip.style.display = 'none'; return; }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let lx = px + 14, ly = py - th - 10;
      if (lx + tw > wrap.clientWidth - 4) lx = px - tw - 14;
      if (ly < 2) ly = py + 16;
      tip.style.left = Math.max(2, lx) + 'px';
      tip.style.top = Math.max(2, ly) + 'px';
    };
    const leave = () => {
      tip.style.display = 'none';
      if (canvas._clOnLeave) canvas._clOnLeave();
    };

    canvas._clHover = move;
    canvas._clLeave = leave;
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
  }

  function ttRows(title, rows) {
    return '<div class="tt-title">' + esc(title) + '</div>' +
      rows.filter(Boolean).map(r =>
        '<div class="tt-row">' +
        (r.color ? '<span class="tt-key" style="background:' + r.color + '"></span>' : '') +
        '<span class="tt-name">' + esc(r.name) + '</span><span>' + esc(r.value) + '</span></div>'
      ).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ── Map projection and basemap ────────────────────────────────────────────

  function projector(P, w, h, pad, i0 = 0, i1 = null) {
    const end = i1 == null ? P.n - 1 : i1;
    let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
    for (let i = i0; i <= end; i++) {
      const la = P.lat[i], lo = P.lon[i];
      if (!la && !lo) continue;
      if (la < mnLat) mnLat = la; if (la > mxLat) mxLat = la;
      if (lo < mnLon) mnLon = lo; if (lo > mxLon) mxLon = lo;
    }
    if (!isFinite(mnLat)) return null;
    const ar = Math.cos(((mnLat + mxLat) / 2) * Math.PI / 180);
    const sw = Math.max(1e-9, (mxLon - mnLon) * ar), sh = Math.max(1e-9, mxLat - mnLat);
    const s = Math.min((w - 2 * pad) / sw, (h - 2 * pad) / sh);
    const ox = (w - sw * s) / 2, oy = (h - sh * s) / 2;
    const f = i => [ox + (P.lon[i] - mnLon) * ar * s, h - (oy + (P.lat[i] - mnLat) * s)];
    f.point = (la, lo) => [ox + (lo - mnLon) * ar * s, h - (oy + (la - mnLat) * s)];
    f.metresPerPx = 1 / (s / 111320);
    return f;
  }

  const BASEMAP = {
    water:      '#152532',
    park:       '#17251c',
    building:   '#1b212a',
    buildingEdge: '#242c37',
    road: {
      major:  { color: '#39424f', width: 5 },
      medium: { color: '#333b47', width: 3.5 },
      minor:  { color: '#2b323c', width: 2.2 },
      path:   { color: '#272d36', width: 1.4, dash: [4, 3] },
    },
  };

  function drawBasemap(g, b, pr, osm) {
    if (!osm) return;
    g.save();
    g.beginPath();
    g.rect(b.x0, b.y0, b.w, b.h);
    g.clip();
    const poly = pts => {
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pr.point(pts[i][0], pts[i][1]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    };
    for (const pts of (osm.water || [])) { poly(pts); g.closePath(); g.fillStyle = BASEMAP.water; g.fill(); }
    for (const a of (osm.areas || [])) {
      if (a.kind !== 'park' && a.kind !== 'pitch' && a.kind !== 'track' && a.kind !== 'wood') continue;
      poly(a.pts); g.closePath(); g.fillStyle = BASEMAP.park; g.fill();
    }
    for (const pts of (osm.buildings || [])) {
      poly(pts); g.closePath();
      g.fillStyle = BASEMAP.building; g.fill();
      g.strokeStyle = BASEMAP.buildingEdge; g.lineWidth = 1; g.stroke();
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const cls of ['path', 'minor', 'medium', 'major']) {
      const style = BASEMAP.road[cls];
      g.strokeStyle = style.color;
      g.lineWidth = style.width;
      g.setLineDash(style.dash || []);
      for (const r of (osm.roads || [])) {
        if (r.cls !== cls) continue;
        poly(r.pts);
        g.stroke();
      }
    }
    g.setLineDash([]);
    g.restore();
  }

  function drawAttribution(g, w, h, text) {
    g.save();
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const pad = 4;
    const tw = g.measureText(text).width;
    g.fillStyle = 'rgba(13,17,23,.72)';
    g.fillRect(2, h - 15, tw + pad * 2, 14);
    g.fillStyle = INK.muted;
    g.fillText(text, 2 + pad, h - 3);
    g.restore();
  }

  // ── 1. Course map ─────────────────────────────────────────────────────────

  /** Median speed along the mean lap, from the aligned laps. */
  function medianSpeedAlong(A) {
    const ml = A.meanLap;
    if (!ml || !A.aligned) return null;
    const out = new Float64Array(ml.n);
    for (let j = 0; j < ml.n; j++) out[j] = Analyzer.median(A.aligned.map(a => a.vAt[j]));
    return out;
  }

  /**
   * The course, coloured by how fast you typically were at each point, with
   * the placed features, the bobbles and the start line drawn on it. Also the
   * picker: in placing mode a click returns the nearest mean-lap point.
   */
  function courseMap(canvas, P, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 440);
    if (!P.lat) { emptyState(g, w, h, 'No GPS data in this ride'); return null; }
    const pr = projector(P, w, h, 28);
    if (!pr) { emptyState(g, w, h, 'No usable GPS points'); return null; }
    const ml = A.meanLap;

    if (opts.osm) drawBasemap(g, { x0: 0, y0: 0, w, h, x1: w, y1: h }, pr, opts.osm);

    // Ghost of every recorded metre, so the pit lane and the warm-up show.
    g.save();
    g.strokeStyle = '#262c35';
    g.lineWidth = 6;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (let i = 0; i < P.n; i++) {
      if (!P.lat[i] && !P.lon[i]) { started = false; continue; }
      const [px, py] = pr(i);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();
    g.restore();

    const medV = medianSpeedAlong(A);
    let vLo = 1, vHi = 8;
    if (medV) {
      const sorted = Array.from(medV).filter(isFinite).sort((a, b) => a - b);
      vLo = Physics.percentile(sorted, 0.05); vHi = Physics.percentile(sorted, 0.95);
    }

    if (ml && medV) {
      g.lineWidth = 4.5;
      g.lineCap = 'round';
      for (let j = 1; j <= ml.n; j++) {
        const a = pr.point(ml.lat[j - 1], ml.lon[j - 1]);
        const c = pr.point(ml.lat[j % ml.n], ml.lon[j % ml.n]);
        g.strokeStyle = speedColor(medV[j - 1], vLo, vHi);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); g.stroke();
      }
    } else {
      g.lineWidth = 3;
      for (let i = 1; i < P.n; i++) {
        if ((!P.lat[i] && !P.lon[i]) || !P.moving[i]) continue;
        const a = pr(i - 1), c = pr(i);
        g.strokeStyle = speedColor(P.v[i], vLo, vHi);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); g.stroke();
      }
    }

    // One lap highlighted on top, when asked.
    if (opts.highlightLap && A.lapBounds && A.lapBounds[opts.highlightLap - 1]) {
      const lb = A.lapBounds[opts.highlightLap - 1];
      g.save();
      g.strokeStyle = lapColor(opts.highlightLap);
      g.lineWidth = 2;
      g.globalAlpha = 0.9;
      g.beginPath();
      let st = false;
      for (let i = lb.i0; i <= lb.i1; i++) {
        if (!P.lat[i] && !P.lon[i]) { st = false; continue; }
        const [px, py] = pr(i);
        if (!st) { g.moveTo(px, py); st = true; } else g.lineTo(px, py);
      }
      g.stroke();
      g.restore();
    }

    // Feature zones: a bright band under the course for the span, a numbered
    // pin at the entry.
    const feats = (A.features || []).filter(f => f.j0 >= 0 && !f.offCourse);
    if (ml) {
      feats.forEach((f, k) => {
        g.save();
        g.strokeStyle = f.color;
        g.lineWidth = 11;
        g.globalAlpha = 0.28;
        g.lineCap = 'butt'; g.lineJoin = 'round';
        g.beginPath();
        const span = (f.j1 - f.j0 + ml.n) % ml.n;
        for (let d = 0; d <= span; d++) {
          const j = (f.j0 + d) % ml.n;
          const [px, py] = pr.point(ml.lat[j], ml.lon[j]);
          if (d === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.stroke();
        g.restore();
      });
      feats.forEach((f, k) => {
        const [px, py] = pr.point(ml.lat[f.j0], ml.lon[f.j0]);
        pin(g, px, py, f.color, String(k + 1), opts.activeFeature === f.id);
      });

      // Suggestions, dashed and numbered with letters.
      (opts.showSuggestions !== false ? (A.suggestions || []) : []).forEach((sg, k) => {
        g.save();
        g.strokeStyle = INK.text;
        g.lineWidth = 2;
        g.setLineDash([4, 4]);
        g.globalAlpha = 0.8;
        g.beginPath();
        for (let j = sg.j0; j <= sg.j1; j++) {
          const [px, py] = pr.point(ml.lat[j], ml.lon[j]);
          if (j === sg.j0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.stroke();
        g.restore();
        const [px, py] = pr.point(ml.lat[sg.j0], ml.lon[sg.j0]);
        pin(g, px, py, INK.surface2, '?' , false, INK.text);
      });

      // Bobbles.
      for (const b of (A.bobbles || [])) {
        const [px, py] = pr.point(b.lat, b.lon);
        g.save();
        g.strokeStyle = '#fab219';
        g.lineWidth = 2.2;
        g.lineCap = 'round';
        const r = 5;
        g.beginPath(); g.moveTo(px - r, py - r); g.lineTo(px + r, py + r); g.stroke();
        g.beginPath(); g.moveTo(px + r, py - r); g.lineTo(px - r, py + r); g.stroke();
        g.restore();
      }

      // Pending entry point while placing.
      if (opts.pending && opts.pending.j >= 0) {
        const [px, py] = pr.point(ml.lat[opts.pending.j], ml.lon[opts.pending.j]);
        g.save();
        g.strokeStyle = '#fab219'; g.fillStyle = 'rgba(250,178,25,.35)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(px, py, 8, 0, 7); g.fill(); g.stroke();
        g.restore();
      }
    }

    // Start/finish line across the course.
    if (A.lapBounds && A.lapBounds[0] && A.lapBounds[0].source !== 'none') {
      const i0 = A.lapBounds[0].i0;
      const [px, py] = pr(i0);
      const manual = A.lapBounds[0].source === 'manual';
      const hd = P.heading[i0];
      const nx = Math.cos(hd), ny = Math.sin(hd);
      const L = 12;
      g.save();
      g.strokeStyle = manual ? '#fab219' : INK.text;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(px - nx * L, py - ny * L); g.lineTo(px + nx * L, py + ny * L); g.stroke();
      g.restore();
    }

    if (opts.osm) drawAttribution(g, w, h, opts.osm.attribution || '© OpenStreetMap contributors');

    // Click-to-place: returns the nearest mean-lap grid point.
    if (canvas._clPick) canvas.removeEventListener('click', canvas._clPick);
    if (opts.onPick) {
      canvas.style.cursor = 'crosshair';
      canvas._clPick = ev => {
        const r = canvas.getBoundingClientRect();
        const px = ev.clientX - r.left, py = ev.clientY - r.top;
        const hit = nearestOnMap(P, A, pr, px, py, 30);
        if (hit) opts.onPick(hit);
      };
      canvas.addEventListener('click', canvas._clPick);
    } else {
      canvas._clPick = null;
      canvas.style.cursor = '';
    }

    onHover(canvas, (px, py) => {
      const hit = nearestOnMap(P, A, pr, px, py, 16);
      if (!hit) return null;
      if (opts.onIndex) opts.onIndex(hit);
      const rows = [];
      if (hit.j >= 0 && medV) {
        rows.push({ color: speedColor(medV[hit.j], vLo, vHi), name: 'Typical speed here', value: (medV[hit.j] * 3.6).toFixed(1) + ' km/h' });
        const f = feats.find(ff => inSpan(ff, hit.j, ml.n));
        if (f) rows.push({ color: f.color, name: 'Feature', value: f.label });
        const near = (A.bobbles || []).filter(b => Math.abs(b.j - hit.j) < 8);
        if (near.length) rows.push({ color: '#fab219', name: 'Unplanned stop', value: 'lap ' + near[0].lap + ', ' + near[0].cost.toFixed(1) + ' s' });
        if (ml.grade) rows.push({ name: 'Gradient', value: (ml.grade[hit.j] * 100).toFixed(0) + '%' });
      } else if (hit.i >= 0) {
        rows.push({ name: 'Speed', value: (P.v[hit.i] * 3.6).toFixed(1) + ' km/h' });
      }
      return ttRows(hit.j >= 0 ? fmtKm(ml.s[hit.j]) + ' km into the lap' : fmtClock(P.t[hit.i]), rows);
    });

    return pr;
  }

  function inSpan(f, j, m) {
    const span = (f.j1 - f.j0 + m) % m;
    return ((j - f.j0 + m) % m) <= span;
  }

  /** Nearest mean-lap point (preferred) or raw track point to a pixel. */
  function nearestOnMap(P, A, pr, px, py, radius) {
    const ml = A.meanLap;
    let best = -1, bestD = radius;
    if (ml) {
      for (let j = 0; j < ml.n; j++) {
        const [ax, ay] = pr.point(ml.lat[j], ml.lon[j]);
        const d = Math.hypot(ax - px, ay - py);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) return { j: best, i: -1, lat: ml.lat[best], lon: ml.lon[best], s: ml.s[best] };
    }
    let bi = -1; bestD = radius;
    for (let i = 0; i < P.n; i += 2) {
      if (!P.lat[i] && !P.lon[i]) continue;
      const [ax, ay] = pr(i);
      const d = Math.hypot(ax - px, ay - py);
      if (d < bestD) { bestD = d; bi = i; }
    }
    return bi >= 0 ? { j: -1, i: bi, lat: P.lat[bi], lon: P.lon[bi], s: NaN } : null;
  }

  function pin(g, px, py, color, text, active, textColor) {
    g.save();
    g.fillStyle = color;
    g.strokeStyle = active ? INK.text : INK.surface;
    g.lineWidth = active ? 2.5 : 1.5;
    g.beginPath(); g.arc(px, py, 9, 0, 7); g.fill(); g.stroke();
    g.fillStyle = textColor || '#0b0f14';
    g.font = '700 10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, px, py + 0.5);
    g.restore();
  }

  // ── 2. Delta trace ────────────────────────────────────────────────────────

  /**
   * Seconds behind (or ahead of) your best lap, along the lap, one line per
   * lap. Where a line steps up is exactly where that lap lost time. Flat
   * means you matched the best lap there; sloping gently up means you were a
   * little slower everywhere; a vertical jump is a feature or a bobble.
   */
  function deltaTrace(canvas, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 300);
    const D = A.delta, ml = A.meanLap;
    if (!D || !ml) { emptyState(g, w, h, 'Needs at least two detected laps'); return; }
    const b = box(w, h, { l: 48, r: 14, t: 14, b: 26 });
    const x = scale(0, ml.lapLen, b.x0, b.x1);
    let lo = 0, hi = 1;
    for (const tr of D.traces) for (let j = 0; j <= ml.n; j++) {
      const v = tr.delta[j];
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const pad = (hi - lo) * 0.08;
    const y = scale(hi + pad, lo - pad, b.y0, b.y1);

    shadeFeatures(g, b, x, A);
    gridY(g, b, y, ticks(lo, hi, 6), v => (v > 0 ? '+' : '') + v.toFixed(0) + ' s');
    axisX(g, b, x, ticks(0, ml.lapLen, 6), v => fmtKm(v) + ' km');

    const xs = new Float64Array(ml.n + 1);
    for (let j = 0; j <= ml.n; j++) xs[j] = j < ml.n ? ml.s[j] : ml.lapLen;
    const only = opts.onlyLap || null;
    for (const tr of D.traces) {
      const dim = only && tr.lap !== only;
      line(g, b, xs, tr.delta, x, y, lapColor(tr.lap), {
        width: tr.lap === D.bestLap ? 1.5 : 2, alpha: dim ? 0.18 : 1,
        dash: tr.lap === D.bestLap ? [5, 4] : null,
      });
    }
    // End labels for the final delta of each lap, de-overlapped.
    const ends = D.traces.map(tr => ({ lap: tr.lap, y: y(tr.final), v: tr.final }))
      .sort((p, q) => p.y - q.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 11) ends[k].y = ends[k - 1].y + 11;
    for (const e of ends) {
      if (only && e.lap !== only) continue;
      label(g, 'L' + e.lap + ' ' + (e.v >= 0 ? '+' : '') + e.v.toFixed(0), b.x1 - 4, e.y, lapColor(e.lap), 'right');
    }

    const base = g.getImageData(0, 0, canvas.width, canvas.height);
    canvas._clOnLeave = () => g.putImageData(base, 0, 0);
    onHover(canvas, (px, py) => {
      if (px < b.x0 || px > b.x1) return null;
      const s = x.invert(px);
      const j = Math.max(0, Math.min(ml.n, Math.round(s / ml.step)));
      g.putImageData(base, 0, 0);
      g.save();
      g.strokeStyle = INK.muted; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(px) + 0.5, b.y0); g.lineTo(Math.round(px) + 0.5, b.y1); g.stroke();
      g.restore();
      const f = (A.features || []).find(ff => ff.j0 >= 0 && !ff.wraps && j >= ff.j0 && j <= ff.j1);
      const rows = D.traces.map(tr => ({ color: lapColor(tr.lap), name: 'Lap ' + tr.lap + (tr.lap === D.bestLap ? ' (best)' : ''),
        value: (tr.delta[j] >= 0 ? '+' : '') + tr.delta[j].toFixed(1) + ' s' }));
      if (f) rows.unshift({ color: f.color, name: 'Feature', value: f.label });
      return ttRows(fmtKm(s) + ' km into the lap', rows);
    });
  }

  // ── 3. Speed trace ────────────────────────────────────────────────────────

  /** Speed along the lap: every lap thin, the median bold. */
  function speedTrace(canvas, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 240);
    const ml = A.meanLap;
    if (!ml || !A.aligned) { emptyState(g, w, h, 'Needs at least two detected laps'); return; }
    const b = box(w, h, { l: 48, r: 14, t: 14, b: 26 });
    const x = scale(0, ml.lapLen, b.x0, b.x1);
    const medV = medianSpeedAlong(A);
    let hi = 1;
    for (const al of A.aligned) for (let j = 0; j < ml.n; j++) if (al.vAt[j] > hi) hi = al.vAt[j];
    hi *= 3.6;
    const y = scale(hi * 1.06, 0, b.y0, b.y1);

    shadeFeatures(g, b, x, A);
    gridY(g, b, y, ticks(0, hi, 5), v => v.toFixed(0) + ' km/h');
    axisX(g, b, x, ticks(0, ml.lapLen, 6), v => fmtKm(v) + ' km');

    // Running-pace line, so "on foot" is visible.
    if (opts.runSpeed) {
      const yy = Math.round(y(opts.runSpeed * 3.6)) + 0.5;
      g.save(); g.strokeStyle = INK.muted; g.setLineDash([2, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(b.x0, yy); g.lineTo(b.x1, yy); g.stroke(); g.restore();
      label(g, 'running pace', b.x1 - 4, yy - 7, INK.muted, 'right');
    }

    const kmh = arr => { const o = new Float64Array(arr.length); for (let j = 0; j < arr.length; j++) o[j] = arr[j] * 3.6; return o; };
    const only = opts.onlyLap || null;
    A.aligned.forEach((al, k) => {
      const lap = k + 1;
      const dim = only && lap !== only;
      line(g, b, ml.s, kmh(Physics.smooth(al.vAt, 3)), x, y, lapColor(lap), { width: only === lap ? 2 : 1, alpha: dim ? 0.12 : (only ? 1 : 0.45) });
    });
    if (!only) line(g, b, ml.s, kmh(Physics.smooth(medV, 3)), x, y, INK.text, { width: 2 });

    const base = g.getImageData(0, 0, canvas.width, canvas.height);
    canvas._clOnLeave = () => g.putImageData(base, 0, 0);
    onHover(canvas, (px, py) => {
      if (px < b.x0 || px > b.x1) return null;
      const s = x.invert(px);
      const j = Math.max(0, Math.min(ml.n - 1, Math.round(s / ml.step)));
      g.putImageData(base, 0, 0);
      g.save();
      g.strokeStyle = INK.muted; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(px) + 0.5, b.y0); g.lineTo(Math.round(px) + 0.5, b.y1); g.stroke();
      g.restore();
      const rows = [{ color: INK.text, name: 'Median', value: (medV[j] * 3.6).toFixed(1) + ' km/h' }];
      A.aligned.forEach((al, k) => rows.push({ color: lapColor(k + 1), name: 'Lap ' + (k + 1), value: (al.vAt[j] * 3.6).toFixed(1) + ' km/h' }));
      return ttRows(fmtKm(s) + ' km into the lap', rows);
    });
  }

  // ── 4. Lap bars ───────────────────────────────────────────────────────────

  /** One bar per lap: riding time and feature time, stacked, with the delta to the best lap. */
  function lapBars(canvas, A, opts = {}) {
    const laps = A.laps || [];
    const h = Math.max(110, 22 + laps.length * 24 + 24);
    const { g, w } = setup(canvas, h);
    if (!laps.length) { emptyState(g, w, h, 'No laps detected'); return; }

    const padL = 46, padR = 70, padT = 18, padB = 22;
    const maxT = Math.max(...laps.map(l => l.seconds)) * 1.02;
    const x = scale(0, maxT, padL, w - padR);
    const bh = (h - padT - padB) / laps.length;
    const best = Math.min(...laps.map(l => l.seconds));

    g.save();
    g.strokeStyle = INK.grid; g.lineWidth = 1;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.fillStyle = INK.muted; g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of ticks(0, maxT, 5)) {
      const xx = Math.round(x(v)) + 0.5;
      g.beginPath(); g.moveTo(xx, padT); g.lineTo(xx, h - padB); g.stroke();
      g.fillText(fmtClock(v), xx, h - padB + 4);
    }
    // Best-lap marker.
    const xb = Math.round(x(best)) + 0.5;
    g.strokeStyle = INK.text; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(xb, padT - 4); g.lineTo(xb, h - padB); g.stroke();
    g.restore();

    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < laps.length; i++) {
      const l = laps[i];
      const cy = padT + bh * (i + 0.5);
      g.save();
      g.fillStyle = INK.muted; g.textAlign = 'right';
      g.fillText(String(l.lap), padL - 8, cy);
      g.restore();
      const hh = bh * 0.56;
      const ride = Math.max(0, l.ridingSeconds), feat = Math.max(0, l.featureSeconds);
      g.fillStyle = lapColor(l.lap);
      roundRect(g, padL, cy - hh / 2, Math.max(1, x(ride) - padL), hh, feat > 0 ? 0 : 4, true);
      g.fill();
      if (feat > 0) {
        g.save();
        g.fillStyle = lapColor(l.lap);
        g.globalAlpha = 0.45;
        roundRect(g, x(ride), cy - hh / 2, Math.max(1, x(ride + feat) - x(ride)), hh, 4, true);
        g.fill();
        g.restore();
      }
      const d = l.seconds - best;
      label(g, fmtClock(l.seconds) + (d > 0.4 ? '  +' + d.toFixed(0) : ''), x(l.seconds) + 6, cy, d > 0.4 ? INK.text : lapColor(l.lap));
    }

    onHover(canvas, (px, py) => {
      const i = Math.floor((py - padT) / bh);
      if (i < 0 || i >= laps.length) return null;
      const l = laps[i];
      return ttRows('Lap ' + l.lap, [
        { color: lapColor(l.lap), name: 'Lap time', value: fmtClock(l.seconds) + (l.deltaBest > 0 ? ' (+' + l.deltaBest.toFixed(0) + ' s)' : ' (best)') },
        { name: 'Riding', value: fmtClock(l.ridingSeconds) },
        { name: 'In features', value: fmtClock(l.featureSeconds) },
        { name: 'On foot', value: l.onFoot.toFixed(0) + ' s' },
        { name: 'Stopped', value: l.stopped.toFixed(0) + ' s' },
        l.bobbles ? { color: '#fab219', name: 'Unplanned stops', value: l.bobbles + ' (' + l.bobbleCost.toFixed(0) + ' s)' } : null,
        isFinite(l.avgW) ? { color: SERIES.watts.color, name: 'Average power', value: Math.round(l.avgW) + ' W' } : null,
        isFinite(l.avgHr) ? { color: SERIES.hr.color, name: 'Average HR', value: Math.round(l.avgHr) + ' bpm' } : null,
      ]);
    });
  }

  // ── 5. Lap × sector heatmap ───────────────────────────────────────────────

  function sectorHeatmap(canvas, A, opts = {}) {
    const S = A.grid;
    const rows = S ? S.grid.length : 0;
    const cols = S ? S.labels.length : 0;
    const h = Math.max(120, 34 + rows * 22 + 30);
    const { g, w } = setup(canvas, h);
    if (!S || !rows || !cols) { emptyState(g, w, h, 'Needs at least two detected laps'); return; }

    const padL = 62, padR = 12, padT = 30, padB = 28;
    const cw = (w - padL - padR) / cols;
    const ch = (h - padT - padB) / rows;

    const cells = [];
    for (const row of S.grid) for (const c of row.cells) cells.push(c.delta);
    const sc = deltaScale(cells);
    const col = d => deltaColor(d, sc.halfSpan);
    canvas._clScale = sc;

    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    g.save();
    g.fillStyle = INK.muted; g.textAlign = 'center';
    for (let c = 0; c < cols; c++) g.fillText(shorten(S.labels[c], Math.floor(cw / 5.5)), padL + cw * (c + 0.5), padT - 12);
    g.restore();

    for (let r = 0; r < rows; r++) {
      g.save();
      g.fillStyle = INK.muted; g.textAlign = 'right';
      g.fillText('Lap ' + S.grid[r].lap, padL - 8, padT + ch * (r + 0.5));
      g.restore();
      for (let c = 0; c < cols; c++) {
        const cell = S.grid[r].cells[c];
        const x0 = padL + cw * c + 1, y0 = padT + ch * r + 1;
        g.fillStyle = isFinite(cell.delta) ? col(cell.delta) : INK.surface2;
        roundRect(g, x0, y0, Math.max(1, cw - 2), Math.max(1, ch - 2), 3);
        g.fill();
        if (cw > 40 && Math.abs(cell.delta) >= 1) {
          label(g, (cell.delta > 0 ? '+' : '') + cell.delta.toFixed(0), x0 + (cw - 2) / 2, y0 + (ch - 2) / 2, INK.text, 'center');
        }
      }
    }

    // Totals strip: median seconds, and how often this sector was the lap's worst.
    g.save();
    g.fillStyle = INK.muted; g.textAlign = 'right';
    g.fillText('median', padL - 8, padT + ch * rows + 12);
    g.restore();
    for (let c = 0; c < cols; c++) {
      const tot = S.totals[c];
      const x0 = padL + cw * c + 1;
      g.fillStyle = INK.surface2;
      roundRect(g, x0, padT + ch * rows + 5, Math.max(1, cw - 2), 16, 3);
      g.fill();
      if (cw > 34) label(g, fmtClock(tot.median) + (tot.lapsWorst ? ' ·' + tot.lapsWorst : ''), x0 + (cw - 2) / 2, padT + ch * rows + 13, tot.lapsWorst >= rows / 2 ? DIVERGE.warm : INK.text, 'center');
    }

    onHover(canvas, (px, py) => {
      const c = Math.floor((px - padL) / cw);
      if (c < 0 || c >= cols) return null;
      const r = Math.floor((py - padT) / ch);
      if (py > padT + ch * rows && py < padT + ch * rows + 24) {
        const tot = S.totals[c];
        return ttRows(tot.label + ' km — every lap', [
          { name: 'Median time', value: fmtClock(tot.median) },
          { name: 'Best', value: fmtClock(tot.best) },
          { name: 'Lap-to-lap spread', value: '±' + tot.sd.toFixed(1) + ' s' },
          { name: 'Your worst sector on', value: tot.lapsWorst + ' of ' + rows + ' laps' },
          { name: 'Lost vs best pass', value: tot.lost.toFixed(0) + ' s' },
        ]);
      }
      if (r < 0 || r >= rows) return null;
      const cell = S.grid[r].cells[c];
      return ttRows('Lap ' + S.grid[r].lap + ' · ' + cell.label + ' km', [
        { color: col(cell.delta), name: 'vs your median', value: (cell.delta >= 0 ? '+' : '') + cell.delta.toFixed(1) + ' s' },
        { name: 'vs your best', value: '+' + cell.vsBest.toFixed(1) + ' s' },
        { name: 'Time', value: fmtClock(cell.seconds) },
      ]);
    });
  }

  // ── 6. Feature bars ───────────────────────────────────────────────────────

  function featureBars(canvas, A, metric, opts = {}) {
    const feats = (A.features || []).filter(f => f.j0 >= 0 && !f.offCourse && f.n > 0);
    const h = Math.max(110, 24 + feats.length * 30 + 22);
    const { g, w } = setup(canvas, h);
    if (!feats.length) { emptyState(g, w, h, 'Place features on the Course tab to see what each one costs'); return; }

    const spec = {
      lost:   { get: f => f.lostVsBest,  unit: ' s', title: 'Time left on the table (sum over laps of each pass minus your best pass)', dec: 1 },
      cost:   { get: f => f.medianCost,  unit: ' s', title: 'What a typical pass costs against riding through at approach speed', dec: 1 },
      median: { get: f => f.median,      unit: ' s', title: 'Typical time through the feature', dec: 1 },
      foot:   { get: f => f.medianOnFoot, unit: ' s', title: 'Typical seconds below running pace inside the feature', dec: 1 },
      spread: { get: f => f.sd,          unit: ' s', title: 'Lap-to-lap spread (standard deviation)', dec: 1 },
    }[metric] || { get: f => f.lostVsBest, unit: ' s', title: 'Time left on the table', dec: 1 };

    const vals = feats.map(spec.get);
    const vMax = Math.max(0.5, ...vals.filter(isFinite)) * 1.25;
    const padL = Math.min(170, Math.max(90, w * 0.26)), padR = 14, padT = 22, padB = 20;
    const x = scale(0, vMax, padL, w - padR);
    const bh = (h - padT - padB) / feats.length;

    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    feats.forEach((f, i) => {
      const cy = padT + bh * (i + 0.5);
      g.save();
      g.fillStyle = INK.text; g.textAlign = 'right';
      g.fillText(shorten((i + 1) + '. ' + f.label, Math.floor((padL - 12) / 6)), padL - 8, cy - 6);
      g.fillStyle = INK.muted; g.font = '10px system-ui, -apple-system, sans-serif';
      g.fillText(Math.round(f.metres) + ' m · ' + f.n + ' laps', padL - 8, cy + 7);
      g.restore();
      const v = spec.get(f);
      if (!isFinite(v)) return;
      g.fillStyle = f.color;
      const bw = Math.max(2, x(Math.max(0, v)) - padL);
      roundRect(g, padL, cy - bh * 0.24, bw, bh * 0.48, 4, true);
      g.fill();
      label(g, v.toFixed(spec.dec) + spec.unit, padL + bw + 6, cy, INK.text);
    });

    g.save();
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(shorten(spec.title, Math.floor((w - padL) / 5.5)), padL, 5);
    g.restore();

    onHover(canvas, (px, py) => {
      const i = Math.floor((py - padT) / bh);
      if (i < 0 || i >= feats.length) return null;
      const f = feats[i];
      return ttRows(f.label, [
        { color: f.color, name: 'Typical pass', value: f.median.toFixed(1) + ' s' },
        { name: 'Best / worst', value: f.best.toFixed(1) + ' s (L' + f.bestLap + ') / ' + f.worst.toFixed(1) + ' s (L' + f.worstLap + ')' },
        { name: 'Left on the table', value: f.lostVsBest.toFixed(1) + ' s' },
        { name: 'Cost per pass', value: isFinite(f.medianCost) ? f.medianCost.toFixed(1) + ' s' : '—' },
        { name: 'Approach → exit', value: (f.medianEntryV * 3.6).toFixed(1) + ' → ' + (f.medianExitV * 3.6).toFixed(1) + ' km/h' },
        f.dismount ? { name: 'On foot', value: f.medianOnFoot.toFixed(1) + ' s of ' + f.median.toFixed(1) + ' s' } : null,
      ]);
    });
  }

  // ── 7. One feature, lap by lap ────────────────────────────────────────────

  function featureLaps(canvas, A, featureId, opts = {}) {
    const f = (A.features || []).find(x => x.id === featureId);
    const { g, w, h } = setup(canvas, opts.height || 200);
    if (!f || !f.perLap.length) { emptyState(g, w, h, 'Pick a feature in the table'); return; }
    const ok = f.perLap.filter(x => isFinite(x.seconds));
    if (!ok.length) { emptyState(g, w, h, 'This feature was never crossed cleanly'); return; }
    const b = box(w, h, { l: 46, r: 14, t: 16, b: 26 });
    const n = f.perLap.length;
    const hi = Math.max(...ok.map(x => x.seconds)) * 1.12;
    const y = scale(hi, 0, b.y0, b.y1);
    const bw = b.w / n;
    gridY(g, b, y, ticks(0, hi, 4), v => v.toFixed(0) + ' s');

    // Best-pass line.
    const yb = Math.round(y(f.best)) + 0.5;
    g.save(); g.strokeStyle = INK.text; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(b.x0, yb); g.lineTo(b.x1, yb); g.stroke(); g.restore();
    label(g, 'best ' + f.best.toFixed(1) + ' s', b.x1 - 4, yb - 8, INK.muted, 'right');

    const sc = { halfSpan: Math.max(1, (f.worst - f.best)) };
    g.font = '10px system-ui, -apple-system, sans-serif';
    f.perLap.forEach((inst, k) => {
      const cx = b.x0 + bw * (k + 0.5);
      g.save(); g.fillStyle = INK.muted; g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('L' + inst.lap, cx, b.y1 + 5); g.restore();
      if (!isFinite(inst.seconds)) return;
      const top = y(inst.seconds);
      g.fillStyle = deltaColor(inst.seconds - f.best, sc.halfSpan);
      roundRect(g, cx - bw * 0.3, top, bw * 0.6, b.y1 - top, 3);
      g.fill();
      if (bw > 30) label(g, inst.seconds.toFixed(1), cx, top - 8, INK.text, 'center');
    });

    onHover(canvas, (px, py) => {
      const k = Math.floor((px - b.x0) / bw);
      if (k < 0 || k >= n) return null;
      const inst = f.perLap[k];
      if (!isFinite(inst.seconds)) return ttRows('Lap ' + inst.lap, [{ name: 'Not crossed', value: '—' }]);
      return ttRows(f.label + ' · lap ' + inst.lap, [
        { name: 'Time', value: inst.seconds.toFixed(1) + ' s (+' + (inst.seconds - f.best).toFixed(1) + ' vs best)' },
        { name: 'Approach speed', value: (inst.entryV * 3.6).toFixed(1) + ' km/h' },
        { name: 'Slowest point', value: (inst.minV * 3.6).toFixed(1) + ' km/h' },
        { name: 'Exit speed (3 s after)', value: (inst.exitV * 3.6).toFixed(1) + ' km/h' },
        { name: 'Back to approach speed in', value: isFinite(inst.recover) ? inst.recover + ' s' : '—' },
        { name: 'On foot / stopped', value: inst.onFoot.toFixed(0) + ' s / ' + inst.stopped.toFixed(0) + ' s' },
        isFinite(inst.avgW) ? { color: SERIES.watts.color, name: 'Average power', value: Math.round(inst.avgW) + ' W' } : null,
        isFinite(inst.avgHr) ? { color: SERIES.hr.color, name: 'Heart rate', value: Math.round(inst.avgHr) + ' bpm' } : null,
      ]);
    });
  }

  // ── 8. W′ balance (power meter only) ──────────────────────────────────────

  function wbalChart(canvas, P, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 220);
    if (!A.power) { emptyState(g, w, h, 'No power data in this ride'); return; }
    const b = box(w, h, { l: 46, r: 14, b: 26 });
    const x = scale(0, P.t[P.n - 1] || 1, b.x0, b.x1);
    const wp = A.cfg.wPrime;
    const y = scale(wp / 1000 * 1.04, 0, b.y0, b.y1);
    const bal = A.power.wbal.bal;

    // Lap boundaries.
    g.save();
    g.strokeStyle = INK.grid; g.lineWidth = 1;
    for (const l of A.laps) { const xx = Math.round(x(P.t[l.i0])) + 0.5; g.beginPath(); g.moveTo(xx, b.y0); g.lineTo(xx, b.y1); g.stroke(); }
    g.restore();
    gridY(g, b, y, ticks(0, wp / 1000, 4), v => v.toFixed(0) + ' kJ');
    axisX(g, b, x, ticks(0, P.t[P.n - 1], 6), v => fmtClock(v));

    const kj = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) kj[i] = bal[i] / 1000;
    line(g, b, P.t, kj, x, y, SERIES.wbal.color, { width: 2 });

    const base = g.getImageData(0, 0, canvas.width, canvas.height);
    canvas._clOnLeave = () => g.putImageData(base, 0, 0);
    onHover(canvas, (px, py) => {
      if (px < b.x0 || px > b.x1) return null;
      const i = Math.max(0, Math.min(P.n - 1, Math.round(x.invert(px))));
      g.putImageData(base, 0, 0);
      g.save(); g.strokeStyle = INK.muted; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(px) + 0.5, b.y0); g.lineTo(Math.round(px) + 0.5, b.y1); g.stroke(); g.restore();
      const lap = A.laps.find(l => i >= l.i0 && i <= l.i1);
      return ttRows(fmtClock(P.t[i]) + (lap ? ' · lap ' + lap.lap : ''), [
        { color: SERIES.wbal.color, name: "W′ left", value: (bal[i] / 1000).toFixed(1) + ' kJ (' + Math.round(bal[i] / wp * 100) + '%)' },
        { color: SERIES.watts.color, name: 'Power', value: Math.round(P.watts[i]) + ' W' },
        { name: 'Speed', value: (P.v[i] * 3.6).toFixed(1) + ' km/h' },
      ]);
    });
  }

  // ── 9. Compare ────────────────────────────────────────────────────────────

  function compareBars(canvas, rows, metric, opts = {}) {
    const h = Math.max(120, 26 + rows.length * 30 + 22);
    const { g, w } = setup(canvas, h);
    if (!rows.length) { emptyState(g, w, h, 'Tick two or more races in the sidebar'); return; }

    const spec = {
      bestLap:   { get: r => r.bestLap,   fmt: fmtClock, title: 'Best lap' },
      medianLap: { get: r => r.medianLap, fmt: fmtClock, title: 'Median lap' },
      lost:      { get: r => r.lostVsBest, fmt: v => v.toFixed(0) + ' s', title: 'Time left on the table at features' },
      foot:      { get: r => r.onFoot,    fmt: v => v.toFixed(0) + ' s', title: 'Time on foot, whole race' },
      bobble:    { get: r => r.bobbleCost, fmt: v => v.toFixed(0) + ' s', title: 'Lost to unplanned stops' },
      speed:     { get: r => r.avgV * 3.6, fmt: v => v.toFixed(1) + ' km/h', title: 'Average speed' },
    }[metric] || { get: r => r.bestLap, fmt: fmtClock, title: 'Best lap' };

    const vals = rows.map(spec.get);
    const vMax = Math.max(0.001, ...vals.filter(isFinite)) * 1.2;
    const padL = Math.min(180, Math.max(90, w * 0.28)), padR = 14, padT = 22, padB = 20;
    const x = scale(0, vMax, padL, w - padR);
    const bh = (h - padT - padB) / rows.length;

    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cy = padT + bh * (i + 0.5);
      g.save();
      g.fillStyle = INK.muted; g.textAlign = 'right';
      g.fillText(shorten(r.name, Math.floor((padL - 12) / 6)), padL - 8, cy - 6);
      g.font = '10px system-ui, -apple-system, sans-serif';
      g.fillText(r.date ? r.date.toISOString().slice(0, 10) : '', padL - 8, cy + 7);
      g.restore();
      const v = spec.get(r);
      if (!isFinite(v)) continue;
      g.fillStyle = SERIES.speed.color;
      const bw = Math.max(2, x(v) - padL);
      roundRect(g, padL, cy - bh * 0.24, bw, bh * 0.48, 4, true);
      g.fill();
      label(g, spec.fmt(v), padL + bw + 6, cy, INK.text);
    }
    g.save();
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(spec.title, padL, 5);
    g.restore();

    onHover(canvas, (px, py) => {
      const i = Math.floor((py - padT) / bh);
      if (i < 0 || i >= rows.length) return null;
      const r = rows[i];
      return ttRows(r.name, [
        { name: 'Laps', value: String(r.laps) },
        { name: 'Best / median lap', value: fmtClock(r.bestLap) + ' / ' + fmtClock(r.medianLap) },
        { name: 'On foot', value: r.onFoot.toFixed(0) + ' s' },
        { name: 'Left on the table', value: r.lostVsBest.toFixed(0) + ' s' },
        { name: 'Unplanned stops', value: r.bobbleCost.toFixed(0) + ' s' },
        isFinite(r.avgW) ? { color: SERIES.watts.color, name: 'Average power', value: Math.round(r.avgW) + ' W' } : null,
      ]);
    });
  }

  // ── 10. Replay ────────────────────────────────────────────────────────────

  /** A dot on the course with a fading tail, and a speed strip with a cursor. */
  function replayFrame(mapCanvas, stripCanvas, P, A, idx, opts = {}) {
    const ml = A.meanLap;
    // Map.
    {
      const { g, w, h } = setup(mapCanvas, opts.height || 360);
      if (!P.lat) { emptyState(g, w, h, 'No GPS data'); }
      else {
        const pr = projector(P, w, h, 24);
        if (opts.osm) drawBasemap(g, { x0: 0, y0: 0, w, h, x1: w, y1: h }, pr, opts.osm);
        g.save();
        g.strokeStyle = '#2b323c'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        let st = false;
        for (let i = 0; i < P.n; i++) {
          if (!P.lat[i] && !P.lon[i]) { st = false; continue; }
          const [px, py] = pr(i);
          if (!st) { g.moveTo(px, py); st = true; } else g.lineTo(px, py);
        }
        g.stroke();
        g.restore();
        if (ml) {
          for (const f of (A.features || []).filter(f => f.j0 >= 0 && !f.offCourse)) {
            g.save(); g.strokeStyle = f.color; g.lineWidth = 9; g.globalAlpha = 0.28; g.beginPath();
            const span = (f.j1 - f.j0 + ml.n) % ml.n;
            for (let d = 0; d <= span; d++) { const j = (f.j0 + d) % ml.n; const [px, py] = pr.point(ml.lat[j], ml.lon[j]); if (d === 0) g.moveTo(px, py); else g.lineTo(px, py); }
            g.stroke(); g.restore();
          }
        }
        // Tail: the last 60 s, coloured by speed.
        const sorted = Array.from(P.v).filter(x => x > 0).sort((a, b) => a - b);
        const vLo = Physics.percentile(sorted, 0.05), vHi = Physics.percentile(sorted, 0.95);
        g.lineWidth = 4; g.lineCap = 'round';
        for (let i = Math.max(1, idx - 60); i <= idx; i++) {
          if ((!P.lat[i] && !P.lon[i]) || (!P.lat[i - 1] && !P.lon[i - 1])) continue;
          const a = pr(i - 1), c = pr(i);
          g.strokeStyle = speedColor(P.v[i], vLo, vHi);
          g.globalAlpha = 0.35 + 0.65 * (i - (idx - 60)) / 60;
          g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); g.stroke();
        }
        g.globalAlpha = 1;
        const [px, py] = pr(idx);
        g.save();
        g.fillStyle = INK.text; g.strokeStyle = INK.surface; g.lineWidth = 2;
        g.beginPath(); g.arc(px, py, 6, 0, 7); g.fill(); g.stroke();
        g.restore();
        if (opts.osm) drawAttribution(g, w, h, opts.osm.attribution || '© OpenStreetMap contributors');
      }
    }
    // Strip: speed over the whole race, cursor at idx.
    {
      const { g, w, h } = setup(stripCanvas, 150);
      const b = box(w, h, { l: 46, r: 12, t: 10, b: 22 });
      const x = scale(0, P.t[P.n - 1] || 1, b.x0, b.x1);
      let hi = 1; for (let i = 0; i < P.n; i++) if (P.v[i] > hi) hi = P.v[i];
      const y = scale(hi * 3.6 * 1.05, 0, b.y0, b.y1);
      g.save(); g.strokeStyle = INK.grid;
      for (const l of A.laps) { const xx = Math.round(x(P.t[l.i0])) + 0.5; g.beginPath(); g.moveTo(xx, b.y0); g.lineTo(xx, b.y1); g.stroke(); }
      g.restore();
      gridY(g, b, y, ticks(0, hi * 3.6, 3), v => v.toFixed(0));
      axisX(g, b, x, ticks(0, P.t[P.n - 1], 6), fmtClock);
      const kmh = new Float64Array(P.n); for (let i = 0; i < P.n; i++) kmh[i] = P.v[i] * 3.6;
      line(g, b, P.t, Physics.smooth(kmh, 5), x, y, SERIES.speed.color, { width: 1.5 });
      const xx = Math.round(x(P.t[idx])) + 0.5;
      g.save(); g.strokeStyle = INK.text; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(xx, b.y0); g.lineTo(xx, b.y1); g.stroke(); g.restore();
    }
  }

  // ── 11. Crop timeline ─────────────────────────────────────────────────────

  /** Speed over the whole recording with the proposed race window shaded. */
  function cropTimeline(canvas, P, win, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 120);
    const b = box(w, h, { l: 40, r: 10, t: 8, b: 20 });
    const x = scale(0, P.t[P.n - 1] || 1, b.x0, b.x1);
    let hi = 1; for (let i = 0; i < P.n; i++) if (P.v[i] > hi) hi = P.v[i];
    const y = scale(hi * 3.6 * 1.05, 0, b.y0, b.y1);
    if (win && win.found) {
      g.save(); g.fillStyle = 'rgba(57,135,229,.16)';
      g.fillRect(x(P.t[win.i0]), b.y0, x(P.t[win.i1]) - x(P.t[win.i0]), b.h);
      g.restore();
      for (const l of win.dropped) {
        g.save(); g.fillStyle = 'rgba(230,103,103,.12)';
        g.fillRect(x(P.t[l.i0]), b.y0, x(P.t[l.i1]) - x(P.t[l.i0]), b.h);
        g.restore();
      }
    }
    gridY(g, b, y, ticks(0, hi * 3.6, 3), v => v.toFixed(0));
    axisX(g, b, x, ticks(0, P.t[P.n - 1], 6), fmtClock);
    const kmh = new Float64Array(P.n); for (let i = 0; i < P.n; i++) kmh[i] = P.v[i] * 3.6;
    line(g, b, P.t, Physics.smooth(kmh, 9), x, y, SERIES.speed.color, { width: 1.5 });
    if (win && win.found) {
      label(g, 'race', x(P.t[win.i0]) + 4, b.y0 + 8, INK.text);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function roundRect(g, x, y, w, h, r, endOnly = false) {
    const rr = Math.min(r, h / 2, w);
    g.beginPath();
    if (endOnly) {
      g.moveTo(x, y);
      g.lineTo(x + w - rr, y);
      g.quadraticCurveTo(x + w, y, x + w, y + rr);
      g.lineTo(x + w, y + h - rr);
      g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      g.lineTo(x, y + h);
    } else {
      g.moveTo(x + rr, y);
      g.lineTo(x + w - rr, y);
      g.quadraticCurveTo(x + w, y, x + w, y + rr);
      g.lineTo(x + w, y + h - rr);
      g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      g.lineTo(x + rr, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - rr);
      g.lineTo(x, y + rr);
      g.quadraticCurveTo(x, y, x + rr, y);
    }
    g.closePath();
  }

  function emptyState(g, w, h, msg) {
    g.save();
    g.fillStyle = INK.muted;
    g.font = '12px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(msg, w / 2, h / 2);
    g.restore();
  }

  function shorten(s, max) {
    s = String(s);
    return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
  }

  function fmtClock(sec) {
    if (!isFinite(sec)) return '—';
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
             : m + ':' + String(ss).padStart(2, '0');
  }
  function fmtKm(m) { return isFinite(m) ? (m / 1000).toFixed(2) : '—'; }
  function fmt2(x) { return isFinite(x) ? x.toFixed(2) : '—'; }
  function fmtPct(x) { return isFinite(x) ? Math.round(x) + '%' : '—'; }

  return {
    SERIES, INK, DIVERGE, LAPS, lapColor,
    deltaColor, deltaLegendStops, deltaScale, speedColor,
    setup, box, scale, ticks, line, label, onHover, ttRows, projector,
    courseMap, deltaTrace, speedTrace, lapBars, sectorHeatmap, featureBars, featureLaps,
    wbalChart, compareBars, replayFrame, cropTimeline,
    drawBasemap, drawAttribution, BASEMAP, medianSpeedAlong,
    fmtClock, fmtKm, fmt2, fmtPct, esc, shorten,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Charts;
