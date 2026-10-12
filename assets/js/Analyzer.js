'use strict';

/**
 * Analyzer.js — turns a prepared ride into a cyclocross race report.
 *
 * The question is simpler than CritLab's and harder to answer from a file:
 * *where did the lap time go?* A cross lap is a chain of things that each cost
 * seconds — a set of barriers, a run-up, a sand pit, a greasy off-camber — and
 * the file records none of them. It records speed, position, cadence and, if
 * you are lucky, power. So the rider places the features on the course once,
 * and the analyser does the rest: lines every lap up against a clean median
 * lap, times each feature on each lap, and ranks them by how much they cost
 * and how much of that cost was avoidable.
 *
 * Everything here assumes a circuit, like CritLab. The repetition is what
 * makes the analysis possible: one slow barrier is a bobble, the same barrier
 * slow on five of six laps is technique.
 */
const Analyzer = (() => {

  const R_EARTH = 6371000;

  /** The kinds of thing a rider can place on the course. */
  const FEATURE_TYPES = {
    barriers:  { label: 'Barriers',    short: 'Barr', dismount: true,  color: '#d95926' },
    runup:     { label: 'Run-up',      short: 'Run',  dismount: true,  color: '#c98500' },
    stairs:    { label: 'Stairs',      short: 'Stair',dismount: true,  color: '#b8860b' },
    sand:      { label: 'Sand',        short: 'Sand', dismount: false, color: '#d9b26f' },
    mud:       { label: 'Mud',         short: 'Mud',  dismount: false, color: '#8b6b3e' },
    offcamber: { label: 'Off-camber',  short: 'Off-c',dismount: false, color: '#d55181' },
    corner:    { label: 'Corner',      short: 'Turn', dismount: false, color: '#3987e5' },
    descent:   { label: 'Descent',     short: 'Desc', dismount: false, color: '#199e70' },
    pavement:  { label: 'Pavement',    short: 'Pave', dismount: false, color: '#8b949e' },
    pit:       { label: 'Pit lane',    short: 'Pit',  dismount: false, color: '#6da7ec' },
    custom:    { label: 'Section',     short: 'Sect', dismount: false, color: '#a78bfa' },
  };

  // ── Entry point ───────────────────────────────────────────────────────────

  /**
   * @param {Object} P    prepared ride (see RideStore.prepare)
   * @param {Object} cfg  rider + model configuration, including `features`
   * @returns {Object}    the full analysis
   */
  function run(P, cfg) {
    const laps = detectLaps(P, cfg);
    const meanLap = buildMeanLap(P, laps);
    const aligned = meanLap ? laps.map(l => alignLap(P, l, meanLap)) : null;

    const hq = hrQuality(P, laps, cfg);
    const features = resolveFeatures(P, meanLap, cfg.features || []);
    const featureRows = analyseFeatures(P, laps, aligned, meanLap, features, cfg, hq);
    const segments = buildSegments(meanLap, features);
    const bobbles = detectBobbles(P, laps, aligned, meanLap, features, cfg);
    const lapRows = summariseLaps(P, laps, aligned, meanLap, featureRows, segments, bobbles, cfg, hq);
    const grid = sectorGrid(P, laps, aligned, meanLap, cfg);
    const delta = deltaTraces(laps, aligned, meanLap, lapRows);
    const suggestions = cfg.suggest ? suggestFeatures(P, laps, aligned, meanLap, features, cfg) : [];
    const shape = raceShape(lapRows);
    const power = P.hasPower ? summarisePower(P, laps, aligned, meanLap, segments, cfg) : null;
    const effort = hq ? summariseEffort(P, laps, aligned, meanLap, featureRows, lapRows, grid, hq, cfg) : null;
    const summary = summarise(P, laps, lapRows, featureRows, bobbles, shape, cfg, hq);
    const findings = buildFindings(P, lapRows, featureRows, bobbles, grid, shape, summary, cfg, effort);

    return {
      cfg,
      laps: lapRows, lapBounds: laps, meanLap, aligned,
      features: featureRows, segments, bobbles, grid, delta, suggestions,
      shape, power, effort, hrQuality: hq, summary, findings,
      circuit: circuitFingerprint(P, meanLap),
    };
  }

  // ── Laps ──────────────────────────────────────────────────────────────────

  /**
   * Find circuit laps. Head-unit lap markers are used when they look like a
   * circuit; otherwise laps come from repeated passes of a start anchor,
   * gated on heading so a switchback cannot fire a false lap.
   *
   * Ported from CritLab, with two changes for cross: the anchor radius is
   * smaller, because course tape puts lanes 4 m apart, and device laps must
   * also start in the same *place* each time, because an auto-lap every 5 km
   * produces evenly sized laps that are not laps at all.
   *
   * @returns {Array<{i0:number, i1:number, source:string}>}
   */
  function detectLaps(P, cfg) {
    const whole = [{ i0: 0, i1: P.n - 1, source: 'none' }];
    if (!P.lat) return whole;

    if (cfg.startAnchor && isFinite(cfg.startAnchor.lat)) {
      const idx = nearestTrackIndex(P, cfg.startAnchor.lat, cfg.startAnchor.lon);
      if (idx >= 0) {
        const laps = lapsFromAnchor(P, idx, cfg);
        if (laps) { laps.forEach(l => { l.source = 'manual'; }); return laps; }
      }
    }

    const fromDevice = lapsFromMarkers(P, cfg);
    if (fromDevice) return fromDevice;

    for (const anchor of anchorCandidates(P)) {
      const laps = lapsFromAnchor(P, anchor, cfg);
      if (laps) return laps;
    }
    return whole;
  }

  /** Index of the moving track sample closest to a lat/lon, or -1. */
  function nearestTrackIndex(P, lat, lon) {
    if (!P.lat) return -1;
    const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < P.n; i++) {
      if (!P.moving[i] || (!P.lat[i] && !P.lon[i])) continue;
      const d = Math.hypot((P.lon[i] - lon) * mLon, (P.lat[i] - lat) * mLat);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD < 120 ? best : -1;
  }

  /** Anchor candidates, earliest first, so lap 1 begins where the rider began. */
  function anchorCandidates(P) {
    const out = [];
    let first = 0;
    while (first < P.n && (!P.moving[first] || (!P.lat[first] && !P.lon[first]))) first++;
    if (first >= P.n) return out;
    const limit = Math.floor(P.n * 0.6);
    const stride = Math.max(1, Math.round(3 / P.dt));
    for (let i = first; i < limit; i += stride) {
      if (!P.moving[i] || (!P.lat[i] && !P.lon[i])) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * Laps as repeated passes of one anchor point, gated on heading.
   * @returns {Array|null} the laps, or null if this anchor does not describe a circuit
   */
  function lapsFromAnchor(P, anchorIdx, cfg) {
    const la0 = P.lat[anchorIdx], lo0 = P.lon[anchorIdx], h0 = P.heading[anchorIdx];
    const mLat = 111320;
    const mLon = 111320 * Math.cos(la0 * Math.PI / 180);

    const radius = cfg.lapRadius || 25;
    const near = new Uint8Array(P.n);
    const dist2 = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      if (!P.lat[i] && !P.lon[i]) { dist2[i] = Infinity; continue; }
      const dx = (P.lon[i] - lo0) * mLon, dy = (P.lat[i] - la0) * mLat;
      const d = Math.hypot(dx, dy);
      dist2[i] = d;
      near[i] = (d < radius && angleDiff(P.heading[i], h0) < 1.22) ? 1 : 0;  // within 70°
    }

    const crossings = [];
    let i = 0;
    while (i < P.n) {
      if (!near[i]) { i++; continue; }
      let j = i, bestK = i, bestD = dist2[i];
      while (j < P.n && near[j]) { if (dist2[j] < bestD) { bestD = dist2[j]; bestK = j; } j++; }
      crossings.push(bestK);
      i = j;
    }

    const minLap = cfg.minLapMetres || 800;
    const kept = [];
    for (const k of crossings) {
      if (!kept.length || P.dist[k] - P.dist[kept[kept.length - 1]] > minLap) kept.push(k);
    }
    if (kept.length < 3) return null;

    const laps = [];
    for (let k = 0; k < kept.length - 1; k++) {
      laps.push({ i0: kept[k], i1: kept[k + 1], source: 'gps' });
    }

    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const med = median(lens);
    if (!(med > 0)) return null;
    const cv = Math.sqrt(Physics.mean(lens.map(x => (x - med) * (x - med)))) / med;
    if (cv > 0.22) return null;

    const good = laps.filter(l => {
      const d = P.dist[l.i1] - P.dist[l.i0];
      return d > 0.7 * med && d < 1.4 * med;
    });
    return good.length >= 2 ? good : null;
  }

  function lapsFromMarkers(P, cfg) {
    const marks = P.lapIndices;
    if (!marks || marks.length < 4) return null;
    const laps = [];
    for (let k = 0; k < marks.length - 1; k++) {
      if (marks[k + 1] - marks[k] > 20) laps.push({ i0: marks[k], i1: marks[k + 1], source: 'device' });
    }
    if (laps.length < 3) return null;
    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const med = median(lens);
    if (!(med > 300)) return null;
    const cv = Math.sqrt(Physics.mean(lens.map(x => (x - med) * (x - med)))) / med;
    if (cv > 0.15) return null;         // not a circuit — probably interval laps

    // Every lap has to start in the same place, or these are auto-laps by distance.
    const mLat = 111320, mLon = 111320 * Math.cos(P.lat[laps[0].i0] * Math.PI / 180);
    const r = (cfg.lapRadius || 25) * 2;
    for (let k = 1; k < laps.length; k++) {
      const a = laps[0].i0, b = laps[k].i0;
      const d = Math.hypot((P.lon[b] - P.lon[a]) * mLon, (P.lat[b] - P.lat[a]) * mLat);
      if (d > r) return null;
    }
    return laps.filter(l => {
      const d = P.dist[l.i1] - P.dist[l.i0];
      return d > 0.75 * med && d < 1.35 * med;
    });
  }

  // ── Race window ───────────────────────────────────────────────────────────

  /**
   * Find the race inside the recording.
   *
   * A cross file is rarely just the race. The standard day is: ride a lap or
   * two of the course to learn it, stand on the grid for ten minutes, race,
   * roll a cool-down lap. The pre-ride laps are the same course at two-thirds
   * pace, so they pass every geometric test for "a lap" and then sit at the
   * top of every worst-lap list. Two signals separate them from racing:
   *
   *   Pace — race laps cluster tightly; pre-ride and cool-down laps are much
   *   slower than the fastest half of the laps.
   *   Stops — staging is minutes of standing still between the pre-ride and
   *   the race. A race lap has no such hole in it.
   *
   * Boundaries land on lap crossings, so the race starts and ends at the line.
   * @returns {{found:boolean, i0:number, i1:number, keep:Array, dropped:Array,
   *            preRide:number, cooldown:number, stagingSeconds:number}}
   */
  function detectRaceWindow(P, laps, cfg) {
    const none = { found: false, i0: 0, i1: P.n - 1, keep: laps, dropped: [], preRide: 0, cooldown: 0, stagingSeconds: 0 };
    if (!laps || laps.length < 3 || laps[0].source === 'none') return none;

    const stopV = cfg.stopSpeed || 1;
    const info = laps.map((l, k) => {
      let stopped = 0, longest = 0, run = 0;
      for (let i = l.i0; i <= l.i1; i++) {
        if (P.v[i] < stopV) { stopped += P.dt; run += P.dt; if (run > longest) longest = run; }
        else run = 0;
      }
      // A long stand at the *start* of a lap is the grid: the pre-ride ended
      // at the line, the rider waited there, and the race began from the same
      // spot, so the anchor crossing lands inside the wait. Measure the lap
      // from when it actually started moving again, and remember where.
      let start = l.i0, lead = 0;
      {
        let i = l.i0;
        const limit = l.i0 + Math.round((l.i1 - l.i0) * 0.15);
        while (i < limit && P.v[i] < stopV) i++;
        if (i - l.i0 >= 45 / P.dt) { start = i; lead = (i - l.i0) * P.dt; }
        else {
          // The wait may begin a few seconds in (rolling to the grid, then standing).
          let j = l.i0, bestA = -1, bestLen = 0;
          while (j < limit) {
            if (P.v[j] < stopV) { let kEnd = j; while (kEnd < l.i1 && P.v[kEnd + 1] < stopV) kEnd++;
              if (kEnd - j + 1 > bestLen) { bestLen = kEnd - j + 1; bestA = kEnd + 1; } j = kEnd + 1; }
            else j++;
          }
          if (bestLen >= 45 / P.dt && bestA > 0) { start = bestA; lead = (bestA - l.i0) * P.dt; }
        }
      }
      const seconds = P.t[l.i1] - P.t[start];
      const movingLongest = lead ? longestStopAfter(P, start, l.i1, stopV) : longest;
      return { k, seconds, stopped, longestStop: movingLongest, start, lead };
    });
    const fast = info.map(x => x.seconds).sort((a, b) => a - b);
    const ref = median(fast.slice(0, Math.max(2, Math.ceil(fast.length / 2))));
    const isRace = x => x.seconds < ref * 1.18 && x.longestStop < 45;

    // Longest contiguous run of race-pace laps.
    let best = { a: -1, b: -1 }, a = -1;
    for (let k = 0; k <= info.length; k++) {
      const ok = k < info.length && isRace(info[k]);
      if (ok && a < 0) a = k;
      if (!ok && a >= 0) { if (k - a > best.b - best.a) best = { a, b: k }; a = -1; }
    }
    if (best.a < 0 || best.b - best.a < 2) return none;
    if (best.a === 0 && best.b === info.length) return none;    // the whole thing is the race already
    // The rider has said the recording starts on the line: nothing before the
    // first lap is ever a pre-ride, so a slow opening lap stays a race lap.
    if (cfg.startsOnStartLine && best.a > 0) return none;

    const keep = laps.slice(best.a, best.b);
    const dropped = laps.filter((_, k) => k < best.a || k >= best.b);
    let staging = info[best.a].lead;
    for (let k = 0; k < best.a; k++) staging += info[k].stopped;
    return {
      found: true, i0: info[best.a].start, i1: keep[keep.length - 1].i1, keep, dropped,
      preRide: best.a, cooldown: info.length - best.b, stagingSeconds: staging,
      info,
    };
  }

  function longestStopAfter(P, i0, i1, stopV) {
    let longest = 0, run = 0;
    for (let i = i0; i <= i1; i++) {
      if (P.v[i] < stopV) { run += P.dt; if (run > longest) longest = run; } else run = 0;
    }
    return longest;
  }

  // ── Mean lap ──────────────────────────────────────────────────────────────

  /**
   * Stack every lap onto a shared lap-distance grid and take the median
   * position at each point. Robust to the one lap you took through the pit,
   * and GPS noise falls as √n. Ported from CritLab; adds cadence, heart rate
   * and altitude medians because a cross lap's time goes where the cadence
   * reads zero.
   *
   * @returns {{n, step, lapLen, laps, s, lat, lon, x, y, v, watts, cad, hr,
   *            alt, heading}|null}
   */
  function buildMeanLap(P, laps) {
    if (!laps || laps.length < 2 || laps[0].source === 'none' || !P.lat) return null;

    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const lapLen = median(lens);
    if (!(lapLen > 300)) return null;

    const step = 2;
    const m = Math.max(100, Math.min(4000, Math.round(lapLen / step)));

    const keys = ['lat', 'lon', 'v', 'watts', 'cad', 'hr', 'alt'];
    const cols = {};
    for (const k of keys) { cols[k] = []; for (let j = 0; j < m; j++) cols[k].push([]); }

    for (const lap of laps) {
      const d0 = P.dist[lap.i0];
      const len = P.dist[lap.i1] - d0;
      if (!(len > 0)) continue;
      let i = lap.i0;
      for (let j = 0; j < m; j++) {
        const target = d0 + (j / m) * len;
        while (i < lap.i1 && P.dist[i + 1] < target) i++;
        const a = i, b = Math.min(lap.i1, i + 1);
        const span = P.dist[b] - P.dist[a];
        const f = span > 1e-9 ? (target - P.dist[a]) / span : 0;
        if (!P.lat[a] && !P.lat[b]) continue;
        const lerp = (arr) => arr ? arr[a] + (arr[b] - arr[a]) * f : NaN;
        cols.lat[j].push(lerp(P.lat));
        cols.lon[j].push(lerp(P.lon));
        cols.v[j].push(lerp(P.v));
        cols.watts[j].push(lerp(P.watts));
        cols.cad[j].push(P.cad ? lerp(P.cad) : NaN);
        cols.hr[j].push(P.hr ? lerp(P.hr) : NaN);
        cols.alt[j].push(lerp(P.alt));
      }
    }

    const out = { n: m, step, lapLen, laps: laps.length, s: new Float64Array(m) };
    for (const k of keys) out[k] = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      if (cols.lat[j].length < 2) return null;
      for (const k of keys) out[k][j] = median(cols[k][j]);
      out.s[j] = (j / m) * lapLen;
    }

    const lat0 = out.lat[0], mLat = 111320, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    out.x = new Float64Array(m); out.y = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      out.x[j] = (out.lon[j] - out.lon[0]) * mLon;
      out.y[j] = (out.lat[j] - lat0) * mLat;
    }

    const half = Math.max(1, Math.round(5 / step));
    out.heading = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const a = (j - half + m) % m, b = (j + half) % m;
      out.heading[j] = Math.atan2(out.x[b] - out.x[a], out.y[b] - out.y[a]);
    }
    // Gradient along the mean lap, from the median altitude, for classifying run-ups.
    out.grade = new Float64Array(m);
    const gh = Math.max(2, Math.round(12 / step));
    for (let j = 0; j < m; j++) {
      const a = (j - gh + m) % m, b = (j + gh) % m;
      out.grade[j] = (out.alt[b] - out.alt[a]) / (2 * gh * step);
    }
    return out;
  }

  /** Index of the mean-lap grid point nearest a lat/lon. */
  function nearestMeanIndex(ml, lat, lon) {
    const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    let best = -1, bestD = Infinity;
    for (let j = 0; j < ml.n; j++) {
      const d = Math.hypot((ml.lon[j] - lon) * mLon, (ml.lat[j] - lat) * mLat);
      if (d < bestD) { bestD = d; best = j; }
    }
    return { j: best, metres: bestD };
  }

  // ── Alignment ─────────────────────────────────────────────────────────────

  /**
   * Line one lap up against the mean lap, by geography rather than by lap
   * fraction.
   *
   * Matching by fraction (which is how the mean lap itself is built) is fine
   * for a corner that is 30 m long, and not fine for a set of barriers that is
   * 8 m long: a 2% difference in measured lap distance, which the pit lane or
   * a wide line produces routinely, moves a feature 60 m. So every sample is
   * instead snapped to the nearest mean-lap point within a window around its
   * expected position, moving forward only, with a penalty for pointing the
   * wrong way so a parallel lane 4 m away cannot steal it.
   *
   * The result is `tAt[j]`: seconds into the lap at which the rider passed
   * mean-lap point `j`. Everything else — feature times, sector times, the
   * delta trace — is a difference of two entries in that array, which is what
   * makes the "sectors sum to the lap" invariant hold by construction.
   */
  function alignLap(P, lap, ml, cfg) {
    const m = ml.n, i0 = lap.i0, i1 = lap.i1;
    const d0 = P.dist[i0], len = Math.max(1, P.dist[i1] - d0);
    const T = P.t[i1] - P.t[i0];
    const W = Math.max(8, Math.round(m * 0.08));
    const mLat = 111320, mLon = 111320 * Math.cos(ml.lat[0] * Math.PI / 180);
    const ACCEPT = 40 * 40, PENALTY = 50 * 50;

    const jOf = new Int32Array(i1 - i0 + 1);
    let last = 0, jumps = 0;
    for (let i = i0; i <= i1; i++) {
      if (!P.lat[i] && !P.lon[i]) { jOf[i - i0] = last; continue; }
      const guess = Math.round((P.dist[i] - d0) / len * m);
      const lo = Math.max(last, guess - W), hi = Math.min(m, Math.max(lo, guess + W));
      const slow = P.v[i] < 1.5;                     // heading is noise when walking
      // How far along the grid this second should have carried the rider.
      const adv = P.v[i] * P.dt / ml.step;
      let best = last, bestD = Infinity;
      for (let j = lo; j <= hi; j++) {
        const jj = j % m;
        const dx = (P.lon[i] - ml.lon[jj]) * mLon, dy = (P.lat[i] - ml.lat[jj]) * mLat;
        let d = dx * dx + dy * dy;
        if (!slow && angleDiff(P.heading[i], ml.heading[jj]) > Math.PI / 2) d += PENALTY;
        // Continuity: a candidate far ahead of where this second's speed could
        // have carried the rider is almost always a parallel lane further
        // round the course. Without this, a switchback block lets the match
        // leap a lane ahead and stay there until the real position catches
        // up — which showed up as every other lap "losing" 35 s in one place.
        const jump = ((j - last) - adv) * ml.step;
        d += jump * jump * 0.2;
        if (d < bestD) { bestD = d; best = j; }
      }
      if ((best - last) * ml.step > 3 * P.v[i] * P.dt + 15) jumps++;
      jOf[i - i0] = bestD < ACCEPT + PENALTY ? best : last;
      last = jOf[i - i0];
    }

    const tAt = new Float64Array(m + 1), idxAt = new Int32Array(m + 1);
    tAt[0] = 0; idxAt[0] = i0;
    let prevJ = 0, prevT = 0, prevI = i0;
    for (let i = i0 + 1; i <= i1; i++) {
      const j = jOf[i - i0], tt = P.t[i] - P.t[i0];
      if (j > prevJ) {
        for (let jj = prevJ + 1; jj <= j; jj++) {
          const f = (jj - prevJ) / (j - prevJ);
          tAt[jj] = prevT + (tt - prevT) * f;
          idxAt[jj] = f < 0.5 ? prevI : i;
        }
        prevJ = j; prevT = tt; prevI = i;
      }
    }
    for (let jj = prevJ + 1; jj <= m; jj++) { tAt[jj] = T; idxAt[jj] = i1; }
    tAt[m] = T;

    // Speed at each grid point, from the samples that were matched there.
    const vAt = new Float64Array(m);
    for (let j = 0; j < m; j++) vAt[j] = P.v[idxAt[j]];

    return { tAt, idxAt, vAt, T, i0, i1, jumps };
  }

  // ── Features ──────────────────────────────────────────────────────────────

  /**
   * Resolve the rider's placed features (stored as lat/lon, so they survive
   * re-analysis and moving the start line) onto the mean-lap grid.
   */
  function resolveFeatures(P, ml, features) {
    if (!ml) return [];
    const out = [];
    for (const f of features) {
      if (!f || !f.entry || !f.exit) continue;
      const a = nearestMeanIndex(ml, f.entry.lat, f.entry.lon);
      const b = nearestMeanIndex(ml, f.exit.lat, f.exit.lon);
      if (a.j < 0 || b.j < 0 || a.metres > 60 || b.metres > 60) {
        out.push({ ...f, j0: -1, j1: -1, offCourse: true });
        continue;
      }
      let j0 = a.j, j1 = b.j;
      if (j1 <= j0) {
        // Either the rider clicked the exit first, or the zone wraps the
        // start line. A wrap is a long span; a swap is a short one. Guess.
        const wrapLen = (j1 - j0 + ml.n) % ml.n, swapLen = j0 - j1;
        if (swapLen <= wrapLen) { const t = j0; j0 = j1; j1 = t; }
        else { out.push({ ...f, j0, j1, wraps: true }); continue; }
      }
      if (j1 === j0) j1 = Math.min(ml.n - 1, j0 + 1);
      out.push({ ...f, j0, j1, wraps: false });
    }
    // Overlaps are clamped so the lap is partitioned, not double-counted.
    out.sort((p, q) => p.j0 - q.j0);
    for (let k = 1; k < out.length; k++) {
      if (out[k].j0 < 0 || out[k - 1].j1 < 0 || out[k].wraps || out[k - 1].wraps) continue;
      if (out[k].j0 < out[k - 1].j1) out[k].j0 = Math.min(out[k - 1].j1, out[k].j1 - 1);
    }
    return out;
  }

  /** Per feature, per lap: what it cost and how it was ridden. */
  function analyseFeatures(P, laps, aligned, ml, features, cfg, hq) {
    if (!ml || !aligned) return [];
    const rows = [];
    for (const f of features) {
      const type = FEATURE_TYPES[f.type] || FEATURE_TYPES.custom;
      const row = {
        id: f.id, type: f.type, label: f.label || type.label, dismount: !!type.dismount,
        color: type.color, j0: f.j0, j1: f.j1, wraps: !!f.wraps, offCourse: !!f.offCourse,
        entry: f.entry, exit: f.exit,
        metres: f.j0 >= 0 ? ((f.j1 - f.j0 + ml.n) % ml.n) * ml.step : 0,
        sMid: f.j0 >= 0 ? ml.s[Math.floor(((f.j0 + ((f.j1 - f.j0 + ml.n) % ml.n) / 2) % ml.n))] : 0,
        lat: f.j0 >= 0 ? ml.lat[f.j0] : null, lon: f.j0 >= 0 ? ml.lon[f.j0] : null,
        perLap: [],
      };
      if (f.j0 >= 0 && !f.offCourse) {
        for (let k = 0; k < laps.length; k++) {
          row.perLap.push(featureInstance(P, laps[k], aligned[k], aligned[k + 1] || null, ml, f, k + 1, cfg, hq));
        }
      }
      summariseFeature(row, cfg);
      rows.push(row);
    }
    return rows;
  }

  function featureInstance(P, lap, al, alNext, ml, f, lapNo, cfg, hq) {
    const hrOk = i => hq && i >= 0 && i < P.n && hq.valid[i];
    let seconds, iIn, iOut;
    if (!f.wraps) {
      seconds = al.tAt[f.j1] - al.tAt[f.j0];
      iIn = al.idxAt[f.j0]; iOut = al.idxAt[f.j1];
    } else if (alNext) {
      seconds = (al.T - al.tAt[f.j0]) + alNext.tAt[f.j1];
      iIn = al.idxAt[f.j0]; iOut = alNext.idxAt[f.j1];
    } else {
      return { lap: lapNo, seconds: NaN, missing: true };
    }
    if (!(seconds >= 0) || iOut <= iIn) return { lap: lapNo, seconds: NaN, missing: true };

    const metres = ((f.j1 - f.j0 + ml.n) % ml.n) * ml.step;
    const A = Math.max(1, Math.round(cfg.approachSeconds || 3));
    const entryV = meanRange(P.v, iIn - A, iIn - 1);
    const exitV = meanRange(P.v, iOut + 1, iOut + A);
    let minV = Infinity, onFoot = 0, stopped = 0, noPedal = 0, kj = 0, hrS = 0, hrK = 0;
    for (let i = iIn; i <= iOut; i++) {
      if (P.v[i] < minV) minV = P.v[i];
      if (P.v[i] < cfg.runSpeed) onFoot += P.dt;
      if (P.v[i] < cfg.stopSpeed) stopped += P.dt;
      if (P.cad && P.cad[i] < 1) noPedal += P.dt;
      kj += P.watts[i] * P.dt / 1000;
      if (hrOk(i)) { hrS += P.hr[i]; hrK++; }
    }
    // What the feature does to the heart. The heart trails the legs by 15 to
    // 30 s, so the HR *inside* an 8 m barrier zone is the HR from the straight
    // before it: measure the response as the peak between the entry and
    // HR_WINDOW seconds after the exit, against the HR just before the entry,
    // and the settle as seconds from that peak back to within 2 bpm of it.
    let hrIn = NaN, hrPeak = NaN, hrRise = NaN, hrSettle = NaN, hrPeakLag = NaN;
    if (hq) {
      const a0 = Math.max(0, iIn - 5), a1 = iIn - 1;
      let s0 = 0, k0 = 0;
      for (let i = a0; i <= a1; i++) if (hrOk(i)) { s0 += P.hr[i]; k0++; }
      const w1 = Math.min(P.n - 1, iOut + HR_WINDOW);
      let pk = -1, ipk = -1, bad = 0;
      for (let i = iIn; i <= w1; i++) {
        if (!hrOk(i)) { bad++; continue; }
        if (P.hr[i] > pk) { pk = P.hr[i]; ipk = i; }
      }
      if (k0 >= 3 && ipk >= 0 && bad < (w1 - iIn + 1) * 0.2) {
        hrIn = s0 / k0; hrPeak = pk; hrRise = pk - hrIn; hrPeakLag = ipk - iOut;
        hrSettle = HR_SETTLE_CAP;
        for (let i = ipk; i <= Math.min(P.n - 1, ipk + HR_SETTLE_CAP); i++) {
          if (hrOk(i) && P.hr[i] <= hrIn + 2) { hrSettle = i - ipk; break; }
        }
      }
    }
    // Recovery: seconds after the exit until speed is back to 90% of the approach.
    let recover = NaN;
    if (entryV > 2) {
      const cap = Math.round(cfg.recoverSeconds || 30);
      recover = cap;
      for (let i = iOut + 1; i <= Math.min(P.n - 1, iOut + cap); i++) {
        if (P.v[i] >= 0.9 * entryV) { recover = i - iOut; break; }
      }
    }
    return {
      lap: lapNo, seconds, metres, iIn, iOut,
      entryV, exitV, minV: isFinite(minV) ? minV : NaN,
      avgV: seconds > 0 ? metres / seconds : NaN,
      onFoot, stopped, noPedal: P.cad ? noPedal : NaN, recover,
      // What the feature cost against simply riding through at approach speed.
      cost: entryV > 1 ? seconds - metres / entryV : NaN,
      kj, avgW: P.hasPower ? kj * 1000 / Math.max(1, seconds) : NaN,
      avgHr: hrK ? hrS / hrK : NaN,
      hrIn, hrPeak, hrRise, hrSettle, hrPeakLag,
    };
  }

  function summariseFeature(row, cfg) {
    const ok = row.perLap.filter(x => isFinite(x.seconds));
    const secs = ok.map(x => x.seconds);
    row.n = ok.length;
    if (!ok.length) {
      Object.assign(row, { best: NaN, median: NaN, worst: NaN, sd: NaN, cv: NaN,
        lostVsBest: 0, lostVsMedian: 0, medianCost: NaN, total: 0, bestLap: null, worstLap: null,
        medianEntryV: NaN, medianExitV: NaN, medianMinV: NaN, medianOnFoot: NaN, medianRecover: NaN,
        medianStopped: NaN, totalStopped: 0, medianW: NaN, medianHr: NaN,
        medianHrIn: NaN, medianHrPeak: NaN, medianHrRise: NaN, medianHrSettle: NaN, medianHrPeakLag: NaN, hrN: 0,
        badLaps: [], verdict: 'few' });
      return;
    }
    const best = Math.min(...secs), worst = Math.max(...secs);
    const med = median(secs);
    row.best = best; row.worst = worst; row.median = med;
    row.bestLap = ok[secs.indexOf(best)].lap;
    row.worstLap = ok[secs.indexOf(worst)].lap;
    row.sd = stdev(secs); row.cv = med > 0 ? row.sd / med : NaN;
    row.total = secs.reduce((a, b) => a + b, 0);
    row.lostVsBest = secs.reduce((a, b) => a + (b - best), 0);
    row.lostVsMedian = secs.reduce((a, b) => a + Math.max(0, b - med), 0);
    row.medianCost = median(ok.map(x => x.cost));
    row.medianEntryV = median(ok.map(x => x.entryV));
    row.medianExitV = median(ok.map(x => x.exitV));
    row.medianMinV = median(ok.map(x => x.minV));
    row.medianOnFoot = median(ok.map(x => x.onFoot));
    row.medianRecover = median(ok.map(x => x.recover));
    row.medianStopped = median(ok.map(x => x.stopped));
    row.totalStopped = ok.reduce((a, x) => a + x.stopped, 0);
    row.medianW = median(ok.map(x => x.avgW));
    row.medianHr = median(ok.map(x => x.avgHr).filter(isFinite));
    const hrOk = ok.filter(x => isFinite(x.hrRise));
    row.hrN = hrOk.length;
    row.medianHrIn = hrOk.length ? median(hrOk.map(x => x.hrIn)) : NaN;
    row.medianHrPeak = hrOk.length ? median(hrOk.map(x => x.hrPeak)) : NaN;
    row.medianHrRise = hrOk.length ? median(hrOk.map(x => x.hrRise)) : NaN;
    row.medianHrSettle = hrOk.length ? median(hrOk.map(x => x.hrSettle)) : NaN;
    row.medianHrPeakLag = hrOk.length ? median(hrOk.map(x => x.hrPeakLag)) : NaN;
    // Which laps were the slow ones. "Erratic" and "one bad lap" are different
    // problems: the first is technique that has not settled, the second is an
    // incident.
    const tol = Math.max(1.5, 0.12 * best);
    row.badLaps = ok.filter(x => x.seconds > best + tol).map(x => ({ lap: x.lap, over: x.seconds - best }));
    row.verdict = row.n < 3 ? 'few'
      : row.badLaps.length === 0 ? 'steady'
      : row.badLaps.length <= Math.floor(row.n / 2) ? 'some-bad-laps'
      : 'erratic';
  }

  /**
   * Partition the lap into alternating riding / feature segments, so every
   * second of every lap is accounted for exactly once.
   */
  function buildSegments(ml, features) {
    if (!ml) return [];
    const bounds = [];
    for (const f of features) {
      if (f.j0 < 0 || f.wraps || f.offCourse) continue;
      bounds.push({ j0: f.j0, j1: f.j1, feature: f });
    }
    bounds.sort((a, b) => a.j0 - b.j0);
    const segs = [];
    let cursor = 0;
    for (const b of bounds) {
      if (b.j0 > cursor) segs.push({ j0: cursor, j1: b.j0, kind: 'riding', feature: null });
      segs.push({ j0: b.j0, j1: b.j1, kind: 'feature', feature: b.feature });
      cursor = b.j1;
    }
    if (cursor < ml.n) segs.push({ j0: cursor, j1: ml.n, kind: 'riding', feature: null });
    return segs;
  }

  // ── Bobbles: time lost where no feature was placed ────────────────────────

  /**
   * An unplanned stop: speed below the stop threshold, outside any placed
   * feature, for long enough to matter. A crash, a foot down in a rut, a
   * queue behind someone else's crash, a dropped chain. Reported with where
   * and how much, because "lap 4 was slow" is less useful than "lap 4 was
   * 11 s slow at 1.8 km and the rest of the lap was fine".
   */
  function detectBobbles(P, laps, aligned, ml, features, cfg) {
    if (!ml || !aligned) return [];
    const inFeature = new Uint8Array(ml.n);
    const marginJ = Math.round(8 / ml.step);
    for (const f of features) {
      if (f.j0 < 0) continue;
      const span = (f.j1 - f.j0 + ml.n) % ml.n;
      for (let d = -marginJ; d <= span + marginJ; d++) inFeature[((f.j0 + d) % ml.n + ml.n) % ml.n] = 1;
    }
    const out = [];
    for (let k = 0; k < laps.length; k++) {
      const lap = laps[k], al = aligned[k];
      // Map sample → grid j by inverting idxAt (monotone).
      let j = 0;
      let i = lap.i0;
      while (i <= lap.i1) {
        while (j < ml.n - 1 && al.idxAt[j + 1] <= i) j++;
        if (P.v[i] < cfg.stopSpeed && !inFeature[j] && !P.gap[i]) {
          // Episode: from when speed fell below running pace until it is back above it.
          let a = i; while (a > lap.i0 && P.v[a - 1] < cfg.runSpeed) a--;
          let b = i; while (b < lap.i1 && P.v[b + 1] < cfg.runSpeed) b++;
          const seconds = (b - a + 1) * P.dt;
          const metres = P.dist[b] - P.dist[a];
          const ref = Math.max(2, meanRange(P.v, a - 10, a - 1));
          const cost = seconds - metres / ref;
          if (cost >= cfg.bobbleSeconds) {
            out.push({
              lap: k + 1, i0: a, i1: b, seconds, cost,
              s: ml.s[j], j, lat: P.lat[i], lon: P.lon[i],
              stopped: countBelow(P.v, a, b, cfg.stopSpeed) * P.dt,
            });
          }
          i = b + 1;
          continue;
        }
        i++;
      }
    }
    out.sort((p, q) => q.cost - p.cost);
    return out;
  }

  // ── Laps ──────────────────────────────────────────────────────────────────

  function summariseLaps(P, laps, aligned, ml, featureRows, segments, bobbles, cfg, hq) {
    const rows = [];
    const bestT = aligned ? Math.min(...aligned.map(a => a.T)) : NaN;
    for (let k = 0; k < laps.length; k++) {
      const lap = laps[k];
      const i0 = lap.i0, i1 = lap.i1;
      const seconds = P.t[i1] - P.t[i0];
      const metres = P.dist[i1] - P.dist[i0];
      let onFoot = 0, stopped = 0, kj = 0, hrS = 0, hrK = 0, hrMax = 0, noPedal = 0;
      for (let i = i0; i <= i1; i++) {
        if (P.v[i] < cfg.runSpeed) onFoot += P.dt;
        if (P.v[i] < cfg.stopSpeed) stopped += P.dt;
        if (P.cad && P.cad[i] < 1 && P.moving[i]) noPedal += P.dt;
        kj += P.watts[i] * P.dt / 1000;
        if (hq && hq.valid[i]) { hrS += P.hr[i]; hrK++; if (P.hr[i] > hrMax) hrMax = P.hr[i]; }
      }
      // A lap's HR only counts when most of the lap was actually read.
      const hrShare = hrK / Math.max(1, i1 - i0 + 1);
      const hrLap = hrK > 0 && hrShare >= 0.8;
      let featureSeconds = 0, featureCost = 0;
      for (const f of featureRows) {
        const inst = f.perLap[k];
        if (inst && isFinite(inst.seconds) && !f.wraps) {
          featureSeconds += inst.seconds;
          if (isFinite(inst.cost)) featureCost += Math.max(0, inst.cost);
        }
      }
      const bobbleCost = bobbles.filter(b => b.lap === k + 1).reduce((a, b) => a + b.cost, 0);
      rows.push({
        lap: k + 1, i0, i1, seconds, metres, source: lap.source,
        deltaBest: isFinite(bestT) ? seconds - bestT : NaN,
        avgV: seconds > 0 ? metres / seconds : NaN,
        featureSeconds, ridingSeconds: seconds - featureSeconds, featureCost,
        onFoot, stopped, noPedal: P.cad ? noPedal : NaN,
        bobbleCost, bobbles: bobbles.filter(b => b.lap === k + 1).length,
        kj, avgW: P.hasPower ? kj * 1000 / Math.max(1, seconds) : NaN,
        np: P.hasPower ? Physics.normalizedPower(P.watts.subarray(i0, i1 + 1), P.dt) : NaN,
        avgHr: hrLap ? hrS / hrK : NaN, maxHr: hrLap ? hrMax : NaN, hrShare,
        // Metres per heartbeat: the one fitness proxy that needs no power meter.
        metresPerBeat: hrLap && seconds > 0 ? (metres / seconds) * 60 / (hrS / hrK) : NaN,
      });
    }
    return rows;
  }

  /**
   * Lap × sector heatmap. Equal-distance sectors along the mean lap; each cell
   * is that lap's time in the sector against your own median for it. A column
   * that is red all the way down is a place you are slow every lap; a row that
   * is red all the way across is a lap that went wrong.
   */
  function sectorGrid(P, laps, aligned, ml, cfg) {
    if (!ml || !aligned || laps.length < 2) return null;
    const N = Math.max(4, Math.min(24, cfg.sectorCount || 10));
    const edges = [];
    for (let k = 0; k <= N; k++) edges.push(Math.round(k / N * ml.n));
    const labels = [], ranges = [];
    for (let k = 0; k < N; k++) {
      const s0 = ml.s[edges[k]], s1 = k === N - 1 ? ml.lapLen : ml.s[edges[k + 1]];
      ranges.push([s0, s1]);
      labels.push(fmtKm(s0) + '–' + fmtKm(s1));
    }
    const grid = aligned.map((al, k) => ({
      lap: k + 1,
      cells: ranges.map((r, c) => {
        const seconds = al.tAt[edges[c + 1]] - al.tAt[edges[c]];
        return { seconds, label: labels[c], s0: r[0], s1: r[1] };
      }),
    }));
    const totals = [];
    for (let c = 0; c < N; c++) {
      const col = grid.map(g => g.cells[c].seconds);
      const med = median(col), best = Math.min(...col);
      for (const g of grid) {
        g.cells[c].delta = g.cells[c].seconds - med;
        g.cells[c].vsBest = g.cells[c].seconds - best;
      }
      // "Worst" = the lap's worst sector relative to its own median — how often is it this one?
      totals.push({ label: labels[c], median: med, best, sd: stdev(col),
        lost: col.reduce((a, b) => a + (b - best), 0), lapsWorst: 0, s0: ranges[c][0], s1: ranges[c][1] });
    }
    for (const g of grid) {
      let worst = -1, wv = -Infinity;
      g.cells.forEach((cell, c) => { if (cell.delta > wv) { wv = cell.delta; worst = c; } });
      if (worst >= 0 && wv > 0.5) totals[worst].lapsWorst++;
    }
    return { labels, grid, totals, edges, n: N };
  }

  /** Time gained or lost against your best lap, along the lap. */
  function deltaTraces(laps, aligned, ml, lapRows) {
    if (!ml || !aligned || aligned.length < 2) return null;
    let bestK = 0;
    for (let k = 1; k < aligned.length; k++) if (aligned[k].T < aligned[bestK].T) bestK = k;
    const ref = aligned[bestK].tAt;
    const traces = aligned.map((al, k) => {
      const d = new Float64Array(ml.n + 1);
      for (let j = 0; j <= ml.n; j++) d[j] = al.tAt[j] - ref[j];
      return { lap: k + 1, delta: d, final: al.T - aligned[bestK].T };
    });
    return { bestLap: bestK + 1, traces, s: ml.s };
  }

  // ── Suggestions ───────────────────────────────────────────────────────────

  /**
   * Places on the mean lap where the median speed drops to running pace for
   * several metres in a row, and no feature has been placed. Offered, never
   * applied: the rider knows whether that was a set of barriers or a corner
   * everybody walks because it is a bog.
   */
  function suggestFeatures(P, laps, aligned, ml, features, cfg) {
    if (!ml || !aligned || laps.length < 2) return [];
    const covered = new Uint8Array(ml.n);
    for (const f of features) {
      if (f.j0 < 0) continue;
      const span = (f.j1 - f.j0 + ml.n) % ml.n;
      for (let d = -5; d <= span + 5; d++) covered[((f.j0 + d) % ml.n + ml.n) % ml.n] = 1;
    }
    // Median speed per grid point from the alignment (not the fraction-matched
    // mean lap), since that is what the feature timing will use too.
    const medV = new Float64Array(ml.n);
    for (let j = 0; j < ml.n; j++) medV[j] = median(aligned.map(a => a.vAt[j]));
    const slow = new Uint8Array(ml.n);
    for (let j = 0; j < ml.n; j++) slow[j] = (medV[j] < cfg.runSpeed && !covered[j]) ? 1 : 0;

    const out = [];
    const minJ = Math.max(4, Math.round(8 / ml.step));
    let j = 0;
    while (j < ml.n) {
      if (!slow[j]) { j++; continue; }
      let k = j; while (k < ml.n - 1 && slow[k + 1]) k++;
      if (k - j + 1 >= minJ && j > minJ && k < ml.n - 1 - minJ) {
        // Pad by a few metres each side so the approach is inside the zone.
        const pad = Math.round(6 / ml.step);
        const j0 = Math.max(0, j - pad), j1 = Math.min(ml.n - 1, k + pad);
        let g = 0; for (let q = j; q <= k; q++) g += ml.grade[q]; g /= (k - j + 1);
        const noCad = P.cad ? median(aligned.map(a => {
          let z = 0, c = 0;
          for (let q = j; q <= k; q++) { const i = a.idxAt[q]; if (P.cad[i] < 1) z++; c++; }
          return c ? z / c : 0;
        })) : NaN;
        const metres = (k - j + 1) * ml.step;
        const type = g > 0.05 ? 'runup' : (metres <= 40 ? 'barriers' : 'custom');
        out.push({
          type, j0, j1, metres, grade: g, noCadShare: noCad,
          medianV: median(Array.from(medV.subarray(j, k + 1))),
          s: ml.s[j0],
          entry: { lat: ml.lat[j0], lon: ml.lon[j0] },
          exit: { lat: ml.lat[j1], lon: ml.lon[j1] },
        });
      }
      j = k + 1;
    }
    return out;
  }

  // ── Race shape and power ──────────────────────────────────────────────────

  /** Did you fade, hold or build — and was it the engine or the features? */
  function raceShape(rows) {
    if (!rows || rows.length < 3) return { kind: 'unknown', laps: rows ? rows.length : 0 };
    const t = rows.map(r => r.seconds);
    const med = median(t), sd = stdev(t);
    const half = Math.floor(rows.length / 2);
    const first = Physics.mean(t.slice(0, half)), last = Physics.mean(t.slice(rows.length - half));
    const drift = last - first;
    const pct = med > 0 ? drift / med : 0;
    const kind = pct > 0.025 ? 'faded' : pct < -0.025 ? 'built' : 'held';

    // Where the drift came from.
    const fFirst = Physics.mean(rows.slice(0, half).map(r => r.featureSeconds));
    const fLast = Physics.mean(rows.slice(rows.length - half).map(r => r.featureSeconds));
    const featureDrift = fLast - fFirst;
    const ridingDrift = drift - featureDrift;

    let outlier = null;
    for (const r of rows) {
      const z = sd > 0 ? (r.seconds - med) / sd : 0;
      if (r.seconds - med > Math.max(8, 2 * sd) && (!outlier || r.seconds > outlier.seconds)) outlier = r;
    }
    const best = rows.reduce((a, r) => (r.seconds < a.seconds ? r : a), rows[0]);
    const lastRow = rows[rows.length - 1];
    return {
      kind, drift, pct, featureDrift, ridingDrift, median: med, sd,
      bestLap: best.lap, bestSeconds: best.seconds,
      outlierLap: outlier ? outlier.lap : null, outlierSeconds: outlier ? outlier.seconds - med : 0,
      lastLapDelta: lastRow.seconds - med,
      laps: rows.length,
    };
  }

  function summarisePower(P, laps, aligned, ml, segments, cfg) {
    const i0 = laps[0].i0, i1 = laps[laps.length - 1].i1;
    const w = P.watts.subarray(i0, i1 + 1);
    const load = Physics.loadMetrics(w, cfg.ftp, P.dt);
    const wbal = Physics.wPrimeBalance(P.watts, cfg.cp, cfg.wPrime, P.dt);
    // Riding power vs feature power: the meter reads zero while you carry the bike.
    let rideS = 0, rideK = 0, featS = 0, featK = 0;
    if (ml && aligned) {
      for (let k = 0; k < laps.length; k++) {
        const al = aligned[k];
        for (const seg of segments) {
          const a = al.idxAt[seg.j0], b = seg.j1 >= ml.n ? al.i1 : al.idxAt[seg.j1];
          for (let i = a; i < b; i++) {
            if (seg.kind === 'feature') { featS += P.watts[i]; featK++; } else { rideS += P.watts[i]; rideK++; }
          }
        }
      }
    }
    return {
      avg: load.avg, np: load.np, kj: load.kj, intensity: load.intensity, tss: load.tss,
      ridingAvg: rideK ? rideS / rideK : NaN, featureAvg: featK ? featS / featK : NaN,
      wbal, wbalMinPct: cfg.wPrime > 0 ? wbal.minBal / cfg.wPrime * 100 : NaN,
    };
  }

  // ── Heart rate ────────────────────────────────────────────────────────────

  const HR_LAG = 15;          // s the heart trails the legs, for attributing HR to riding vs running
  const HR_WINDOW = 40;       // s after a feature's exit in which its HR peak is looked for
  const HR_SETTLE_CAP = 90;   // s — a settle longer than this is reported as "did not settle"

  /**
   * Per-sample mask of believable heart rate. A strap that has not wetted, or
   * has lost contact, reads low and flat; a racer's heart does not sit at
   * 60% of its maximum for a minute while riding at race pace. Suspect
   * samples are those below a floor set from the race's own maximum while
   * the rider is moving faster than running pace; a minute that is mostly
   * suspect is thrown out, and the hole is widened to the nearest samples
   * that look right again.
   */
  function hrQuality(P, laps, cfg) {
    if (!P.hasHr) return null;
    const n = P.n;
    const i0 = laps[0].i0, i1 = laps[laps.length - 1].i1;
    let mx = 0;
    for (let i = i0; i <= i1; i++) if (P.hr[i] > mx) mx = P.hr[i];
    const floor = Math.max(90, 0.62 * mx);
    const susp = new Uint8Array(n);
    for (let i = 0; i < n; i++) susp[i] = (P.hr[i] <= 30 || (P.hr[i] < floor && P.v[i] > cfg.runSpeed)) ? 1 : 0;
    const valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) valid[i] = P.hr[i] > 30 ? 1 : 0;
    // Any 60 s window that is 80% suspect is a dropout.
    const W = Math.round(60 / P.dt), need = Math.ceil(W * 0.8);
    let run = 0;
    for (let i = 0; i < n; i++) {
      run += susp[i];
      if (i >= W) run -= susp[i - W];
      if (i >= W - 1 && run >= need) for (let k = i - W + 1; k <= i; k++) valid[k] = 0;
    }
    // Widen each hole while the reading is still below the floor.
    for (let i = 0; i < n; i++) {
      if (valid[i] || (i > 0 && !valid[i - 1])) continue;
      for (let k = i - 1; k >= 0 && P.hr[k] < floor; k--) valid[k] = 0;
    }
    for (let i = n - 1; i >= 0; i--) {
      if (valid[i] || (i < n - 1 && !valid[i + 1])) continue;
      for (let k = i + 1; k < n && P.hr[k] < floor; k++) valid[k] = 0;
    }
    const spans = [];
    for (let i = 0; i < n; i++) {
      if (valid[i]) continue;
      let k = i; while (k + 1 < n && !valid[k + 1]) k++;
      if ((k - i + 1) * P.dt >= 20) spans.push({ i0: i, i1: k, seconds: (k - i + 1) * P.dt, t0: P.t[i], t1: P.t[k] });
      i = k;
    }
    let s = 0, c = 0, m = 0, total = 0;
    for (let i = i0; i <= i1; i++) { total++; if (valid[i]) { s += P.hr[i]; c++; if (P.hr[i] > m) m = P.hr[i]; } }
    // Only the holes inside the race are reported; an easy pre-ride at 110
    // bpm looks like a dry strap to this test and is nobody's business.
    const inRace = spans
      .map(x => ({ i0: Math.max(x.i0, i0), i1: Math.min(x.i1, i1) }))
      .filter(x => x.i1 >= x.i0 && (x.i1 - x.i0 + 1) * P.dt >= 20)
      .map(x => ({ ...x, seconds: (x.i1 - x.i0 + 1) * P.dt, t0: P.t[x.i0], t1: P.t[x.i1] }));
    return {
      valid, spans: inRace, floor,
      avgHr: c ? s / c : NaN, maxHr: m || NaN,
      validShare: total ? c / total : 0,
      invalidSeconds: inRace.reduce((a, x) => a + x.seconds, 0),
    };
  }

  /**
   * Everything the heart says about the race, read only through the dropout
   * mask. Threshold and max come from the rider numbers when they are set,
   * else max from the race itself and threshold stays unknown — a percentage
   * of max is honest, an invented LTHR is not.
   */
  function summariseEffort(P, laps, aligned, ml, featureRows, lapRows, grid, hq, cfg) {
    const i0 = laps[0].i0, i1 = laps[laps.length - 1].i1;
    const V = hq.valid;
    const maxHr = cfg.maxHr > 0 ? cfg.maxHr : hq.maxHr;
    const maxSource = cfg.maxHr > 0 ? (cfg.fitnessSource && cfg.fitnessSource.maxHr) || 'you' : 'race';
    const lthr = cfg.lthr > 0 ? cfg.lthr : NaN;

    let aboveLthr = 0, above90 = 0, validS = 0;
    for (let i = i0; i <= i1; i++) {
      if (!V[i]) continue;
      validS += P.dt;
      if (isFinite(lthr) && P.hr[i] >= lthr) aboveLthr += P.dt;
      if (P.hr[i] >= 0.9 * maxHr) above90 += P.dt;
    }

    // Zones: the file's own boundaries when it has them, else nothing — a
    // zone chart built on a guessed threshold would just be decoration.
    let zones = null;
    const bounds = Array.isArray(cfg.hrZones) && cfg.hrZones.length >= 3 ? cfg.hrZones : null;
    if (bounds) {
      const secs = new Array(bounds.length).fill(0);
      for (let i = i0; i <= i1; i++) {
        if (!V[i]) continue;
        let z = bounds.findIndex(b => P.hr[i] < b);
        if (z < 0) z = bounds.length - 1;
        secs[z] += P.dt;
      }
      zones = bounds.map((b, k) => ({ zone: k + 1, lo: k ? bounds[k - 1] : 0, hi: b, seconds: secs[k], share: validS ? secs[k] / validS : 0 }));
    }

    // Lap by lap, and the first-half/second-half decoupling of speed from HR.
    const hrLaps = lapRows.filter(r => isFinite(r.metresPerBeat));
    let decoupling = NaN, mpbFirst = NaN, mpbLast = NaN, hrFirst = NaN, hrLast = NaN, vFirst = NaN, vLast = NaN;
    if (hrLaps.length >= 4) {
      const half = Math.floor(hrLaps.length / 2);
      const a = hrLaps.slice(0, half), b = hrLaps.slice(hrLaps.length - half);
      mpbFirst = Physics.mean(a.map(r => r.metresPerBeat)); mpbLast = Physics.mean(b.map(r => r.metresPerBeat));
      hrFirst = Physics.mean(a.map(r => r.avgHr)); hrLast = Physics.mean(b.map(r => r.avgHr));
      vFirst = Physics.mean(a.map(r => r.avgV)); vLast = Physics.mean(b.map(r => r.avgV));
      decoupling = mpbFirst > 0 ? (mpbFirst - mpbLast) / mpbFirst : NaN;
    }

    // The start: how fast the heart was driven to the ceiling, and whether
    // the first stretch of lap 1 was quicker than the same stretch later.
    let start = null;
    {
      const S0 = Math.min(P.n - 1, i0 + Math.round(90 / P.dt));
      let ok = 0; for (let i = i0; i <= S0; i++) if (V[i]) ok++;
      // Only with an unbroken reading from the line: a hole before the heart
      // reached its ceiling makes "time to 95%" the time to the end of the hole.
      if (ok >= (S0 - i0 + 1) * 0.98 && lapRows.length >= 3) {
        let to90 = NaN, to95 = NaN, broken = false;
        for (let i = i0; i <= i1; i++) {
          if (!V[i]) { broken = true; break; }
          if (!isFinite(to90) && P.hr[i] >= 0.9 * maxHr) to90 = P.t[i] - P.t[i0];
          if (P.hr[i] >= 0.95 * maxHr) { to95 = P.t[i] - P.t[i0]; break; }
        }
        if (broken) to95 = NaN;
        const i60 = Math.min(i1, i0 + Math.round(60 / P.dt));
        let firstSector = NaN, medianSector = NaN;
        if (grid && grid.grid && grid.grid.length >= 3) {
          const col0 = grid.grid.map(row => row.cells[0]).filter(c => c && isFinite(c.seconds));
          if (col0.length >= 3) { firstSector = col0[0].seconds; medianSector = median(col0.map(c => c.seconds)); }
        }
        if (isFinite(to95)) start = { to90, to95, hrAt60: V[i60] ? P.hr[i60] : NaN, hrStart: V[i0] ? P.hr[i0] : NaN,
          firstSector, medianSector, firstSectorDelta: firstSector - medianSector, sectorLabel: grid && grid.labels ? grid.labels[0] : '' };
      }
    }

    // HR while on foot against HR while riding, with the heart's lag applied
    // so the beats are charged to the legs that caused them.
    let footS = 0, footK = 0, rideS = 0, rideK = 0;
    const lag = Math.round(HR_LAG / P.dt);
    for (let i = i0; i + lag <= i1; i++) {
      const h = i + lag;
      if (!V[h]) continue;
      if (P.v[i] < cfg.runSpeed) { footS += P.hr[h]; footK++; } else { rideS += P.hr[h]; rideK++; }
    }

    // Recovery after the line: the drop in the first minute after the race,
    // if the recording went on that long.
    let finish = null;
    {
      const e = i1 + Math.round(60 / P.dt);
      if (e < P.n && V[i1] && V[e]) finish = { hrEnd: P.hr[i1], hrPlus60: P.hr[e], drop: P.hr[i1] - P.hr[e] };
    }

    // HR along the lap, per lap and the median — on the mean-lap grid, not
    // lag-shifted, because *where* the heart peaks on the course is the point.
    let hrAlong = null, perLap = [];
    if (ml && aligned) {
      perLap = aligned.map(al => {
        const o = new Float64Array(ml.n);
        for (let j = 0; j < ml.n; j++) { const i = al.idxAt[j]; o[j] = i >= 0 && V[i] ? P.hr[i] : NaN; }
        return o;
      });
      hrAlong = new Float64Array(ml.n);
      for (let j = 0; j < ml.n; j++) {
        const vals = perLap.map(a => a[j]).filter(isFinite);
        hrAlong[j] = vals.length ? median(vals) : NaN;
      }
    }

    const placed = featureRows.filter(f => f.j0 >= 0 && !f.offCourse && f.hrN >= 2);
    const spiky = placed.filter(f => isFinite(f.medianHrRise)).sort((a, b) => b.medianHrRise - a.medianHrRise)[0] || null;

    return {
      avgHr: hq.avgHr, maxHrRace: hq.maxHr, maxHr, maxSource, lthr, restHr: cfg.restHr || NaN, floor: hq.floor,
      pctMax: maxHr > 0 ? hq.avgHr / maxHr : NaN,
      aboveLthr, above90, validSeconds: validS, validShare: hq.validShare, dropouts: hq.spans, invalidSeconds: hq.invalidSeconds,
      zones,
      hrLaps: hrLaps.length, decoupling, mpbFirst, mpbLast, hrFirst, hrLast, vFirst, vLast, hrDrift: hrLast - hrFirst,
      metresPerBeat: hrLaps.length ? median(hrLaps.map(r => r.metresPerBeat)) : NaN,
      start,
      footHr: footK >= 30 ? footS / footK : NaN, rideHr: rideK >= 60 ? rideS / rideK : NaN,
      finish,
      hrAlong, perLap,
      spikiest: spiky ? spiky.id : null,
    };
  }

  // ── Summary and findings ──────────────────────────────────────────────────

  function summarise(P, laps, rows, featureRows, bobbles, shape, cfg, hq) {
    const real = laps[0] && laps[0].source !== 'none';
    const i0 = real ? laps[0].i0 : 0, i1 = real ? laps[laps.length - 1].i1 : P.n - 1;
    const seconds = P.t[i1] - P.t[i0];
    const metres = P.dist[i1] - P.dist[i0];
    const onFoot = rows.reduce((a, r) => a + r.onFoot, 0);
    const stopped = rows.reduce((a, r) => a + r.stopped, 0);
    const featureSeconds = rows.reduce((a, r) => a + r.featureSeconds, 0);
    const lostVsBest = featureRows.reduce((a, f) => a + (f.lostVsBest || 0), 0);
    const bobbleCost = bobbles.reduce((a, b) => a + b.cost, 0);
    const placed = featureRows.filter(f => f.j0 >= 0 && !f.offCourse);
    const top = placed.slice().sort((a, b) => (b.lostVsBest || 0) - (a.lostVsBest || 0))[0] || null;
    const costly = placed.slice().sort((a, b) => (b.medianCost || 0) - (a.medianCost || 0))[0] || null;
    return {
      laps: real ? laps.length : 0, lapSource: real ? laps[0].source : 'none',
      seconds, metres, avgV: seconds > 0 ? metres / seconds : NaN,
      bestLap: shape.bestLap || null, bestLapSeconds: shape.bestSeconds || NaN,
      medianLap: shape.median || NaN,
      onFoot, stopped, featureSeconds,
      featureShare: seconds > 0 ? featureSeconds / seconds : NaN,
      lostVsBest, bobbleCost, bobbles: bobbles.length,
      features: placed.length,
      topFeature: top ? top.label : null, topFeatureLost: top ? top.lostVsBest : 0,
      costliest: costly ? costly.label : null, costliestSeconds: costly ? costly.medianCost : NaN,
      hasPower: P.hasPower, hasHr: P.hasHr, hasCad: P.hasCad,
      avgHr: hq ? hq.avgHr : NaN, maxHr: hq ? hq.maxHr : NaN,
      metresPerBeat: hq ? median(rows.map(r => r.metresPerBeat).filter(isFinite)) : NaN,
      kj: P.hasPower ? rows.reduce((a, r) => a + r.kj, 0) : NaN,
    };
  }

  /**
   * Findings are ranked by seconds, and every one names a lap or a place.
   * "You are slow at the barriers" is an opinion; "the barriers cost you 4.1 s
   * more across the race than if you had done them all like lap 2" is a fact
   * the rider can go and practise.
   */
  function buildFindings(P, rows, featureRows, bobbles, grid, shape, S, cfg, E) {
    const out = [];
    const bpm = x => Math.round(x) + ' bpm';
    const clock = x => { x = Math.round(x); return Math.floor(x / 60) + ':' + String(x % 60).padStart(2, '0'); };
    const placed = featureRows.filter(f => f.j0 >= 0 && !f.offCourse && f.n >= 2);
    const sec = x => (isFinite(x) ? (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(1)) : '—') + ' s';
    const kmh = v => (v * 3.6).toFixed(1) + ' km/h';

    if (S.laps < 2) {
      out.push({ kind: 'laps', severity: 'warn', seconds: 0,
        title: 'No laps found',
        body: 'CrossLab needs at least two laps of the same circuit. If the recording includes the ride to the venue, trim it; if the course does not close on itself, this tool cannot help.' });
      return out;
    }
    if (!placed.length) {
      out.push({ kind: 'features', severity: 'info', seconds: 0,
        title: 'No features placed yet',
        body: 'Open the Course tab and mark where the barriers, run-ups and sand are. Until then the only thing CrossLab can rank is the lap × sector grid below.' });
    }

    // 1. Time left on the table at a feature.
    const byLost = placed.filter(f => f.lostVsBest > 1).sort((a, b) => b.lostVsBest - a.lostVsBest);
    for (const f of byLost.slice(0, 2)) {
      const bad = f.badLaps || [];
      const lapList = bad.map(b => b.lap).join(', ').replace(/, (\d+)$/, ' and $1');
      const how = f.verdict === 'some-bad-laps'
        ? (bad.length === 1 ? 'That is one lap: lap ' : 'That is ' + bad.length + ' laps: laps ') + lapList +
          (bad.length === 1 ? ' took ' : ' were ') + bad.map(b => sec(b.over)).join(' and ') +
          (bad.length === 1 ? ' longer than' : ' over') + ' your best of ' + sec(f.best) + ' on lap ' + f.bestLap +
          '; the other ' + (f.n - bad.length) + ' were within ' + sec(Math.max(1.5, 0.12 * f.best)) + ' of it.'
        : f.verdict === 'erratic'
          ? 'Every lap was different (' + sec(f.best) + ' to ' + sec(f.worst) + '), which points at execution rather than fitness.'
          : 'Best ' + sec(f.best) + ' on lap ' + f.bestLap + ', worst ' + sec(f.worst) + ' on lap ' + f.worstLap + '.';
      out.push({ kind: 'feature', severity: f.lostVsBest > 5 ? 'serious' : 'warn', seconds: f.lostVsBest, feature: f.id,
        title: f.label + ': ' + sec(f.lostVsBest) + ' left on the table',
        body: 'Across ' + f.n + ' laps you spent ' + sec(f.lostVsBest) + ' more here than if every pass had matched your best. ' + how });
    }

    // 2. The feature that costs the most every lap, regardless of consistency.
    const byCost = placed.filter(f => isFinite(f.medianCost) && f.medianCost > 2).sort((a, b) => b.medianCost - a.medianCost);
    if (byCost.length) {
      const f = byCost[0];
      const share = S.medianLap > 0 ? Math.round(f.median / S.medianLap * 100) : null;
      out.push({ kind: 'cost', severity: 'info', seconds: f.medianCost * f.n, feature: f.id,
        title: f.label + ' costs ' + sec(f.medianCost) + ' a lap',
        body: 'A typical pass takes ' + sec(f.median) + ' for ' + Math.round(f.metres) + ' m' +
          (share != null ? ' (' + share + '% of the lap)' : '') + '. Riding that stretch at your approach speed of ' +
          kmh(f.medianEntryV) + ' would take ' + sec(f.metres / Math.max(0.5, f.medianEntryV)) +
          '. That difference is the price of the feature; the only way to cut it is technique.' });
    }

    // 3. Slow remounts.
    for (const f of placed.filter(x => x.dismount)) {
      if (!(f.medianEntryV > 2) || !isFinite(f.medianExitV)) continue;
      const ratio = f.medianExitV / f.medianEntryV;
      if (ratio < 0.6 && f.medianRecover >= 8) {
        out.push({ kind: 'remount', severity: 'warn', seconds: f.medianRecover * f.n * 0.3, feature: f.id,
          title: 'You leave the ' + f.label.toLowerCase() + ' slowly',
          body: 'Three seconds after the exit you are doing ' + kmh(f.medianExitV) + ' against ' + kmh(f.medianEntryV) +
            ' on the way in, and it takes ' + sec(f.medianRecover) + ' to get back to approach speed. A remount that lands pedalling, and a gear chosen before the dismount, are the usual fixes.' });
      }
    }

    // 4. Stops inside a feature.
    for (const f of placed) {
      if (f.totalStopped > 3) {
        out.push({ kind: 'stopped', severity: 'warn', seconds: f.totalStopped, feature: f.id,
          title: 'Stood still ' + sec(f.totalStopped) + ' at the ' + f.label.toLowerCase(),
          body: 'Speed under ' + kmh(cfg.stopSpeed) + ' inside this zone on ' +
            f.perLap.filter(x => x.stopped > 0.5).length + ' of ' + f.n + ' laps. That is a foot down, a fumbled remount, or traffic.' });
      }
    }

    // 5. Bobbles.
    if (bobbles.length) {
      const b = bobbles[0];
      out.push({ kind: 'bobble', severity: S.bobbleCost > 10 ? 'serious' : 'warn', seconds: S.bobbleCost,
        title: bobbles.length + (bobbles.length === 1 ? ' unplanned stop' : ' unplanned stops') + ', ' + sec(S.bobbleCost) + ' lost',
        body: 'Places you came almost to a halt with no feature marked there. The worst was lap ' + b.lap + ' at ' +
          fmtKm(b.s) + ' km into the lap, ' + sec(b.cost) + '. They are drawn on the course map; if one of them is a feature you have not placed yet, place it and it stops counting as a bobble.' });
    }

    // 6. Fade, and where it came from — and what the heart was doing while it happened.
    if (shape.kind === 'faded' && shape.drift > 3) {
      const fShare = shape.drift > 0 ? Math.max(0, Math.min(1, shape.featureDrift / shape.drift)) : 0;
      let heart = '';
      if (E && isFinite(E.hrDrift)) {
        heart = E.hrDrift >= -2
          ? ' Heart rate held at ' + bpm(E.hrLast) + ' through the second half against ' + bpm(E.hrFirst) + ' in the first: the engine was still at the limit while the speed fell, which is fatigue, and the fix is fitness.'
          : ' Heart rate fell too, from ' + bpm(E.hrFirst) + ' to ' + bpm(E.hrLast) + ': the heart had room left, so it was not the engine that gave out — legs, grip or the head.';
      }
      out.push({ kind: 'fade', severity: shape.pct > 0.06 ? 'serious' : 'info', seconds: shape.drift * shape.laps / 2,
        title: 'You faded by ' + sec(shape.drift) + ' a lap',
        body: 'The second half of the race averaged ' + sec(shape.drift) + ' a lap slower than the first. ' +
          (placed.length
            ? Math.round(fShare * 100) + '% of that came from the features and ' + Math.round((1 - fShare) * 100) + '% from the riding between them' +
              (fShare > 0.6 ? ' — the technique went before the legs did.' : fShare < 0.3 ? ' — the legs went, the technique held.' : '.')
            : 'Place the features to see whether it was the legs or the technique.') + heart });
    } else if (shape.kind === 'built' && shape.drift < -3) {
      out.push({ kind: 'fade', severity: 'info', seconds: 0,
        title: 'You got faster as it went on',
        body: 'The second half averaged ' + sec(-shape.drift) + ' a lap quicker than the first. Either the start was too cautious or the course dried out.' });
    }
    if (shape.outlierLap) {
      out.push({ kind: 'outlier', severity: 'info', seconds: shape.outlierSeconds,
        title: 'Lap ' + shape.outlierLap + ' was the one that went wrong',
        body: sec(shape.outlierSeconds) + ' slower than your median lap. Check the Laps grid for which sector, and the bobble list for why.' });
    }

    // 7. A sector that is your worst more often than chance.
    if (grid && grid.grid.length >= 4) {
      const worst = grid.totals.slice().sort((a, b) => b.lapsWorst - a.lapsWorst)[0];
      if (worst && worst.lapsWorst >= Math.ceil(grid.grid.length * 0.5) && worst.lapsWorst >= 3) {
        out.push({ kind: 'sector', severity: 'info', seconds: worst.lost,
          title: 'Sector ' + worst.label + ' km is where laps go wrong',
          body: 'It was your worst sector, against your own median, on ' + worst.lapsWorst + ' of ' + grid.grid.length +
            ' laps, and ' + sec(worst.lost) + ' slower in total than your best pass through it. If there is no feature marked there, there probably should be.' });
      }
    }

    // 8. What the heart says. These rank by seconds like everything else;
    //    the ones with no seconds attached sit at the bottom as context.
    if (E) {
      const drop = E.dropouts.filter(d => d.seconds >= 60);
      if (drop.length && E.invalidSeconds >= 60) {
        const d = drop.slice().sort((a, b) => b.seconds - a.seconds)[0];
        const lapsHit = rows.filter(r => !isFinite(r.avgHr)).map(r => r.lap);
        out.push({ kind: 'hr-dropout', severity: 'warn', seconds: 0,
          title: 'Heart-rate strap was not reading for ' + clock(E.invalidSeconds),
          body: 'From ' + clock(d.t0) + ' to ' + clock(d.t1) + ' the strap read under ' + bpm(E.floor) + ' while you were riding at race pace, which is not a heart rate, it is a dry strap. ' +
            (lapsHit.length ? 'Lap' + (lapsHit.length > 1 ? 's ' : ' ') + lapsHit.join(', ').replace(/, (\d+)$/, ' and $1') + ' therefore ' + (lapsHit.length > 1 ? 'have' : 'has') + ' no heart-rate figures; ' : '') +
            'every HR number on this page uses only the samples that look real.' });
      }
      const spiky = featureRows.find(f => f.id === E.spikiest);
      if (spiky && spiky.medianHrRise >= 5) {
        const settled = spiky.medianHrSettle < HR_SETTLE_CAP;
        out.push({ kind: 'hr-feature', severity: 'info', seconds: 0, feature: spiky.id,
          title: spiky.label + ' lifts your heart rate ' + Math.round(spiky.medianHrRise) + ' bpm',
          body: 'Into it at ' + bpm(spiky.medianHrIn) + ', peaking at ' + bpm(spiky.medianHrPeak) +
            (spiky.medianHrPeakLag > 0 ? ' about ' + Math.round(spiky.medianHrPeakLag) + ' s after the exit' : ' before the exit') + ', ' +
            (settled ? 'and ' + Math.round(spiky.medianHrSettle) + ' s to come back down.' : 'and it did not come back down before the next effort.') +
            ' That bill is paid in the sector after the ' + spiky.label.toLowerCase() + ': if that sector is where your laps go wrong, this is why.' });
      }
      if (isFinite(E.decoupling) && E.hrLaps >= 4 && Math.abs(E.decoupling) >= 0.03) {
        const pct = Math.round(Math.abs(E.decoupling) * 100);
        out.push({ kind: 'hr-decoupling', severity: E.decoupling > 0.06 ? 'warn' : 'info', seconds: 0,
          title: E.decoupling > 0 ? 'Decoupled ' + pct + '%: each heartbeat bought less ground as the race went on' : 'Each heartbeat bought ' + pct + '% more ground in the second half',
          body: 'First half: ' + E.mpbFirst.toFixed(2) + ' m per beat at ' + bpm(E.hrFirst) + '. Second half: ' + E.mpbLast.toFixed(2) + ' m per beat at ' + bpm(E.hrLast) + '. ' +
            (E.decoupling > 0
              ? 'The same speed cost more beats, or the same beats bought less speed — the aerobic ceiling for a race this long. Longer threshold work moves it; so does not spending the first lap at ' + (E.start && isFinite(E.start.hrAt60) ? bpm(E.start.hrAt60) : 'the ceiling') + '.'
              : 'You were more economical late than early, which usually means the start was harder than the race needed.') });
      }
      if (E.start && isFinite(E.start.to95) && E.start.to95 <= 120) {
        const d = E.start.firstSectorDelta;
        out.push({ kind: 'hr-start', severity: 'info', seconds: 0,
          title: 'To 95% of max in ' + clock(E.start.to95),
          body: 'From ' + bpm(E.start.hrStart) + ' on the line to ' + Math.round(0.95 * E.maxHr) + ' bpm in ' + clock(E.start.to95) + '.' +
            (isFinite(d) ? ' The first sector of lap 1 (' + E.start.sectorLabel + ' km) took ' + sec(E.start.firstSector) + ', ' + (d < -0.5 ? sec(-d) + ' quicker than' : d > 0.5 ? sec(d) + ' slower than' : 'the same as') + ' your median for it.' : '') +
            ' A cross start is a sprint by design; the question is only whether you paid for it on lap 2.' });
      }
      if (E.finish && isFinite(E.finish.drop)) {
        out.push({ kind: 'hr-finish', severity: 'info', seconds: 0,
          title: 'Heart rate fell ' + Math.round(E.finish.drop) + ' bpm in the minute after the line',
          body: bpm(E.finish.hrEnd) + ' at the finish, ' + bpm(E.finish.hrPlus60) + ' a minute later. A bigger drop week on week is fitness arriving; a smaller one on the same course is fatigue you brought to the race.' });
      }
    }

    out.sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
    return out;
  }

  // ── Circuits ──────────────────────────────────────────────────────────────

  /** Centroid plus lap length — robust enough to say "same course" across weeks. */
  function circuitFingerprint(P, ml) {
    if (!P.lat || !ml) return null;
    let lat = 0, lon = 0;
    for (let j = 0; j < ml.n; j++) { lat += ml.lat[j]; lon += ml.lon[j]; }
    return { lat: lat / ml.n, lon: lon / ml.n, lapLen: ml.lapLen };
  }

  function sameCircuit(a, b) {
    if (!a || !b) return false;
    const mLat = 111320, mLon = 111320 * Math.cos(a.lat * Math.PI / 180);
    const apart = Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * mLat);
    const lenRatio = a.lapLen > 0 && b.lapLen > 0
      ? Math.abs(a.lapLen - b.lapLen) / Math.max(a.lapLen, b.lapLen) : 1;
    return apart < 300 && lenRatio < 0.15;
  }

  function groupByCircuit(rows) {
    const groups = [];
    for (const r of rows) {
      const hit = groups.find(g => sameCircuit(g.fingerprint, r.circuit));
      if (hit) hit.races.push(r);
      else groups.push({ fingerprint: r.circuit, races: [r] });
    }
    groups.sort((a, b) => b.races.length - a.races.length);
    return groups;
  }

  /** Reduce an analysis to the row shown in the Compare tab. */
  function compareRow(ride, A) {
    const s = A.summary;
    return {
      id: ride.id, name: ride.name,
      date: ride.startTime ? new Date(ride.startTime * 1000) : null,
      laps: s.laps, seconds: s.seconds, bestLap: s.bestLapSeconds, medianLap: s.medianLap,
      avgV: s.avgV, onFoot: s.onFoot, stopped: s.stopped,
      featureShare: s.featureShare, lostVsBest: s.lostVsBest, bobbleCost: s.bobbleCost,
      avgW: A.power ? A.power.avg : NaN, avgHr: s.avgHr, metresPerBeat: s.metresPerBeat,
      decoupling: A.effort ? A.effort.decoupling : NaN,
      shape: A.shape, circuit: A.circuit,
      features: A.features.filter(f => f.j0 >= 0).map(f => ({ label: f.label, type: f.type, median: f.median, best: f.best, cost: f.medianCost, lost: f.lostVsBest })),
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function median(a) {
    const x = Array.from(a).filter(isFinite).sort((p, q) => p - q);
    if (!x.length) return NaN;
    const m = Math.floor(x.length / 2);
    return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
  }

  function stdev(a) {
    const x = Array.from(a).filter(isFinite);
    if (x.length < 2) return 0;
    const mu = Physics.mean(x);
    return Math.sqrt(Physics.mean(x.map(v => (v - mu) * (v - mu))));
  }

  function meanRange(a, i0, i1) {
    let s = 0, k = 0;
    for (let i = Math.max(0, i0); i <= Math.min(a.length - 1, i1); i++) if (isFinite(a[i])) { s += a[i]; k++; }
    return k ? s / k : NaN;
  }

  function countBelow(a, i0, i1, thr) {
    let k = 0;
    for (let i = Math.max(0, i0); i <= Math.min(a.length - 1, i1); i++) if (a[i] < thr) k++;
    return k;
  }

  function fmtKm(m) { return (m / 1000).toFixed(2).replace(/0$/, ''); }

  /** Smallest absolute difference between two bearings, in radians. */
  function angleDiff(a, b) { return Math.abs(angleDelta(a, b)); }

  /** Signed difference b − a wrapped to (−π, π]. */
  function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    return d;
  }

  return {
    run, FEATURE_TYPES, hrQuality, summariseEffort,
    detectLaps, lapsFromAnchor, anchorCandidates, nearestTrackIndex, detectRaceWindow, buildMeanLap, nearestMeanIndex,
    alignLap, resolveFeatures, analyseFeatures, buildSegments, detectBobbles, sectorGrid,
    deltaTraces, suggestFeatures, raceShape, summarise, buildFindings,
    circuitFingerprint, sameCircuit, groupByCircuit, compareRow,
    angleDelta, median, stdev, R_EARTH,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Analyzer;
