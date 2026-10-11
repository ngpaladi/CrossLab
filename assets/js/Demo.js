'use strict';

/**
 * Demo.js — a synthetic cyclocross race, generated rather than recorded.
 *
 * A 2.5 km course in a park: a paved start straight, a block of switchbacks,
 * a set of barriers, a long grass drag, a run-up, a descent, a sand pit, an
 * off-camber traverse. Seven laps at a pace that fades from lap three. Three
 * things are planted on purpose, so the analyser has a truth to recover:
 *
 *   · the barriers are fumbled on laps 3 and 6 (a stopped remount)
 *   · the sand bogs down on lap 5
 *   · an unplanned stop on lap 4 in the off-camber, where no feature is placed
 *
 * The run-up is slow *every* lap, which is a different kind of finding: it is
 * not inconsistency, it is the price of the feature.
 *
 * It ships with the barriers, run-up and sand already placed, so the sample
 * shows a finished analysis the moment it loads. Like CritLab's demo, this is
 * also the test fixture: `test/harness.js` asserts the planted losses come
 * back out, so keep it physically plausible if you change it.
 */
const Demo = (() => {

  const ORIGIN = { lat: 42.3905, lon: -71.1280 };
  const SCALE = 1.4;                       // waypoint metres → course metres
  const LAPS = 7;
  const MASS = 80;                         // rider + bike
  const CP = 285, W_PRIME = 19000;

  // The course, as waypoints in metres (x east, y north). Corners are rounded
  // when the path is built. The start/finish line is at (0,0) heading north,
  // halfway along the paved straight.
  const WAYPOINTS = [
    [0, -40], [0, 180],                     // start straight (pavement)
    [120, 180], [120, 120], [136, 120], [136, 180], [152, 180], [152, 120],   // switchbacks
    [240, 120],                             // barriers on this straight
    [240, -30],                             // long grass drag
    [150, -30], [150, -110],
    [60, -110],                             // run-up on this straight (west)
    [60, -170],                             // descent
    [180, -170],                            // sand pit on this straight (east)
    [180, -240],
    [-60, -240],                            // off-camber on this straight (west)
    [-60, -120], [-20, -120], [-20, -40],
  ];

  // Surface and feature zones, as a predicate on (x, y) in *unscaled* metres,
  // evaluated against the straight they sit on.
  const ZONES = {
    pavement:  p => Math.abs(p.x) < 1 && p.y > -40 && p.y < 180,
    barriers:  p => Math.abs(p.y - 120) < 1 && p.x > 190 && p.x < 210,     // planks at x≈200
    runup:     p => Math.abs(p.y + 110) < 1 && p.x < 140 && p.x > 95,      // climbs westward
    descent:   p => Math.abs(p.x - 60) < 1 && p.y < -110 && p.y > -170,
    sand:      p => Math.abs(p.y + 170) < 1 && p.x > 90 && p.x < 145,
    offcamber: p => Math.abs(p.y + 240) < 1 && p.x < 60 && p.x > -20,
  };

  /** Deterministic PRNG so the sample race is the same every time. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Course geometry ───────────────────────────────────────────────────────

  /** Sample the course at ~1 m spacing with rounded corners. */
  function buildPath() {
    const W = WAYPOINTS.map(([x, y]) => ({ x: x * SCALE, y: y * SCALE }));
    const n = W.length;
    const pts = [];
    const push = (x, y, curv, zone) => pts.push({ x, y, curv, zone, ux: x / SCALE, uy: y / SCALE });

    const zoneAt = (ux, uy) => {
      const p = { x: ux, y: uy };
      for (const [k, f] of Object.entries(ZONES)) if (f(p)) return k;
      return 'grass';
    };

    for (let k = 0; k < n; k++) {
      const a = W[k], b = W[(k + 1) % n], c = W[(k + 2) % n];
      // Straight from a (after its corner) to b (before its corner).
      const ab = { x: b.x - a.x, y: b.y - a.y }, bc = { x: c.x - b.x, y: c.y - b.y };
      const lab = Math.hypot(ab.x, ab.y), lbc = Math.hypot(bc.x, bc.y);
      const prev = W[(k - 1 + n) % n];
      const lpa = Math.hypot(a.x - prev.x, a.y - prev.y);
      const rIn = cornerRadius(lpa, lab), rOut = cornerRadius(lab, lbc);
      const u = { x: ab.x / lab, y: ab.y / lab };
      const s0 = rIn, s1 = lab - rOut;
      const len = Math.max(0, s1 - s0);
      const m = Math.max(1, Math.round(len));
      for (let i = 0; i < m; i++) {
        const s = s0 + (len * i) / m;
        const x = a.x + u.x * s, y = a.y + u.y * s;
        push(x, y, 0, zoneAt(x / SCALE, y / SCALE));
      }
      // Corner at b: arc of radius rOut turning from direction ab to bc.
      const cross = u.x * (bc.y / lbc) - u.y * (bc.x / lbc);
      const dot = u.x * (bc.x / lbc) + u.y * (bc.y / lbc);
      const turn = Math.atan2(cross, dot);            // +ve = left
      const arcLen = Math.abs(turn) * rOut;
      const ma = Math.max(2, Math.round(arcLen));
      const p0 = { x: b.x - u.x * rOut, y: b.y - u.y * rOut };
      const nrm = turn > 0 ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
      const cx = p0.x + nrm.x * rOut, cy = p0.y + nrm.y * rOut;
      const th0 = Math.atan2(p0.y - cy, p0.x - cx);
      for (let i = 0; i < ma; i++) {
        const th = th0 + turn * (i / ma);
        const x = cx + Math.cos(th) * rOut, y = cy + Math.sin(th) * rOut;
        push(x, y, (turn > 0 ? 1 : -1) / rOut, zoneAt(b.x / SCALE, b.y / SCALE) === 'grass' ? 'grass' : zoneAt(x / SCALE, y / SCALE));
      }
    }

    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      pts[i].s = s; pts[i].ds = d;
      pts[i].heading = Math.atan2(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      s += d;
    }
    // Rotate so index 0 is the start/finish line at (0,0) heading north.
    let k0 = 0, best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x, pts[i].y);
      if (d < best && Math.abs(pts[i].heading) < 0.3) { best = d; k0 = i; }
    }
    const rot = pts.slice(k0).concat(pts.slice(0, k0));
    let ss = 0;
    for (const p of rot) { p.s = ss; ss += p.ds; }
    return { pts: rot, length: s };
  }

  function cornerRadius(l1, l2) {
    // Hairpins between tight switchback lanes get a tight radius; open corners more.
    return Math.max(3, Math.min(10 * SCALE, Math.min(l1, l2) * 0.35));
  }

  /** Target speed by zone, corner-limited, with braking zones reaching back. */
  function speedProfile(path) {
    const { pts } = path;
    const n = pts.length;
    const base = {
      pavement: 9.2, grass: 6.6, descent: 7.4, offcamber: 4.3, sand: 3.9,
      barriers: 3.1, runup: 2.3,
    };
    const lim = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(pts[i].curv);
      const corner = k > 1e-6 ? Math.sqrt(3.0 / k) : Infinity;
      lim[i] = Math.min(base[pts[i].zone] || 6.5, corner);
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        const j = (k + 1) % n;
        const cap = Math.sqrt(lim[j] * lim[j] + 2 * 2.5 * pts[k].ds);
        if (cap < lim[k]) lim[k] = cap;
      }
    }
    return lim;
  }

  // ── Simulation ────────────────────────────────────────────────────────────

  function build() {
    const path = buildPath();
    const lim = speedProfile(path);
    const L = path.length;
    const rand = rng(20261010);

    const t = [], lat = [], lon = [], alt = [], v = [], watts = [], dist = [], cad = [], hr = [];
    const mLat = 111320, mLon = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);

    const CRR = { pavement: 0.006, grass: 0.022, descent: 0.02, offcamber: 0.03, sand: 0.09 };
    const elevAt = p => {
      // Run-up climbs 5.4 m westward from ux=140 to 95; descent drops 4.8 m from uy=-110 to -170.
      if (p.zone === 'runup') return 100 + 5.4 * (140 - p.ux) / 45;
      if (Math.abs(p.uy + 110) < 1 && p.ux <= 95 && p.ux > 60) return 105.4;
      if (p.zone === 'descent') return 105.4 - 4.8 * (-110 - p.uy) / 60;
      if (p.uy <= -170 + 1 && p.ux > 60 && p.ux < 180 && Math.abs(p.uy + 170) < 1) return 100.6 - 0.6 * (p.ux - 60) / 120;
      return 100;
    };

    // Planted events.
    const fumbleLaps = new Set([3, 6]);          // stopped remount after the planks
    const bogLap = 5;                            // stuck in the sand
    const bobbleLap = 4;                         // foot down in the off-camber

    // Start 100 m before the line, from a standing start. Negative `s` is the
    // lead-in, so lap 1 is the first full lap from the line.
    let s = -100, speed = 0.5, prevSpeed = 0.5, elapsed = 0;
    let heart = 118;
    const finishS = L * LAPS + 30;
    let stopUntil = -1, stopSpeed = 0.3;
    const fired = new Set();              // one planted stop per lap per zone
    const trip = (key, cond, secs, vStop) => {
      if (!cond || fired.has(key)) return;
      fired.add(key); stopUntil = elapsed + secs; stopSpeed = vStop;
    };
    let guard = 0;

    while (s < finishS && guard++ < 20000) {
      const lap = Math.floor(s / L) + 1;
      const sLap = ((s % L) + L) % L;
      let pi = Math.min(path.pts.length - 1, Math.max(0, Math.round(sLap)));
      while (pi > 0 && path.pts[pi].s > sLap) pi--;
      while (pi < path.pts.length - 1 && path.pts[pi + 1].s <= sLap) pi++;
      const p = path.pts[pi];
      const onFoot = p.zone === 'barriers' || p.zone === 'runup';

      // Pace: a sprint off the line, then a fade from lap 3.
      let pace = 1 - 0.013 * Math.max(0, lap - 2);
      if (s < 120) pace = 1.18;                                   // start sprint
      pace *= 0.985 + 0.03 * rand();
      let target = onFoot ? lim[pi] * (0.96 + 0.08 * rand()) : lim[pi] * pace;

      // Planted stops.
      if (elapsed < stopUntil) target = stopSpeed;
      else {
        trip('b' + lap, fumbleLaps.has(lap) && p.zone === 'barriers' && p.ux >= 205, 2.5, 0.3);
        trip('s' + lap, lap === bogLap && p.zone === 'sand' && p.ux >= 118, 6, 0.5);
        trip('o' + lap, lap === bobbleLap && p.zone === 'offcamber' && p.ux <= 30, 8, 0.2);
      }

      const grade = (() => {
        const q = path.pts[(pi + 3) % path.pts.length];
        return (elevAt(q) - elevAt(p)) / Math.max(1, (q.s - p.s + L) % L);
      })();
      const crr = CRR[p.zone] || 0.022;
      const hold = speed * (MASS * 9.81 * (crr + grade) + 0.5 * 1.2 * 0.40 * speed * speed);

      let w = 0;
      if (onFoot || elapsed < stopUntil) {
        speed = speed > target ? Math.max(target, speed - 2.5) : Math.min(target, speed + 1.2);
        w = 0;
      } else if (speed < target) {
        const budget = speed > target * 0.93 ? 330 : 520;
        const spare = Math.max(0, budget - hold) * 0.97 / Math.max(1, speed);
        const aMax = Math.min(2.5, spare / (MASS + 1.5));
        speed = Math.min(target, speed + aMax);
        w = Math.min(680, hold + (speed - prevSpeed) * MASS * speed) * (0.92 + 0.16 * rand());
      } else {
        speed = Math.max(target, Math.sqrt(Math.max(0, speed * speed - 2 * 2.5 * Math.max(0.5, speed))));
        w = speed > target * 1.05 ? 0 : hold * 0.6 * (0.9 + 0.2 * rand());
      }
      w = Math.max(0, w);
      prevSpeed = speed;

      // Heart rate chases load with a long time constant; drifts up with laps.
      const hrTarget = 150 + 0.085 * Math.min(w, 500) + 1.6 * lap + (onFoot ? 12 : 0);
      heart += (Math.min(190, hrTarget) - heart) / 22;

      t.push(elapsed);
      dist.push(s);
      v.push(speed);
      watts.push(Math.round(w));
      cad.push(w > 40 && speed > 2 ? Math.round(78 + 10 * rand()) : 0);
      hr.push(Math.round(heart));
      alt.push(elevAt(p) + 0.3 * (rand() - 0.5));
      lat.push(ORIGIN.lat + p.y / mLat + jitter(rand));
      lon.push(ORIGIN.lon + p.x / mLon + jitter(rand));

      s += speed;
      elapsed += 1;
    }

    // Coast down after the line.
    for (let k = 0; k < 20; k++) {
      const decay = Math.max(0, 5 - k * 0.3);
      t.push(elapsed++);
      dist.push(s += decay);
      v.push(decay);
      watts.push(0); cad.push(0); hr.push(Math.round(heart -= 0.8));
      alt.push(100);
      lat.push(lat[lat.length - 1]);
      lon.push(lon[lon.length - 1]);
    }

    // Pre-placed features, as lat/lon on the course — exactly what the rider
    // would have clicked.
    const at = (zone, edge) => {
      const idx = path.pts.map((p, i) => [p, i]).filter(([p]) => p.zone === zone).map(([, i]) => i);
      const i = edge === 'entry' ? idx[0] : idx[idx.length - 1];
      const pad = edge === 'entry' ? -6 : 6;
      const q = path.pts[(i + pad + path.pts.length) % path.pts.length];
      return { lat: ORIGIN.lat + q.y / mLat, lon: ORIGIN.lon + q.x / mLon, s: q.s };
    };
    const features = [
      { id: 'f-barriers', type: 'barriers', label: 'Barriers', entry: at('barriers', 'entry'), exit: at('barriers', 'exit') },
      { id: 'f-runup', type: 'runup', label: 'Run-up', entry: at('runup', 'entry'), exit: at('runup', 'exit') },
      { id: 'f-sand', type: 'sand', label: 'Sand pit', entry: at('sand', 'entry'), exit: at('sand', 'exit') },
    ];

    return {
      id: 'demo-sample-cx',
      source: 'demo',
      name: 'Sample cross race (synthetic)',
      startTime: null,
      sport: 'cycling', subSport: 'cyclocross',
      n: t.length,
      t, lat, lon, alt, v, watts, dist, cad, hr,
      temp: null,
      lapTimes: [],
      ftp: 265, weightKg: 72, cp: CP, wPrime: W_PRIME,
      totals: {},
      features,
      truth: {
        laps: LAPS, lapLength: L, leadIn: 100,   // recording starts 100 m before the line
        fumbleLaps: [...fumbleLaps], bogLap, bobbleLap,
        offcamber: at('offcamber', 'entry'),
        zones: Object.fromEntries(Object.keys(ZONES).map(z => [z, { entry: at(z, 'entry').s, exit: at(z, 'exit').s }])),
      },
    };
  }

  function jitter(rand) { return (rand() - 0.5) * 2.2e-5; }   // ~±1.2 m of GPS noise

  return { build, buildPath, speedProfile, ORIGIN };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Demo;
