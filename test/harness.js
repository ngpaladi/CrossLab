'use strict';

/**
 * Headless tests. Loads the real browser modules into a shared context (they
 * are plain scripts, not ES modules) and exercises the whole chain on the
 * synthetic race: Demo → prepare → analyse, asserting that the planted truths
 * come back out.
 *
 *   node test/harness.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'assets', 'js');

const sandbox = {
  console,
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k),
      key: i => Array.from(m.keys())[i],
      get length() { return m.size; },
    };
  })(),
  sessionStorage: null,
  self: {},
  indexedDB: null,
  fetch: () => Promise.reject(new Error('network disabled in tests')),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  Math, JSON, Date, Number, String, Array, Object, Boolean, Error, Map, Set,
  Float64Array, Int32Array, Uint8Array, ArrayBuffer, DataView, isFinite, parseFloat, parseInt,
  URLSearchParams,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const MODULES = ['Fit.js', 'Intervals.js', 'Weather.js', 'Osm.js', 'Physics.js', 'Analyzer.js', 'RideStore.js', 'Demo.js'];
const NAMES = ['Fit', 'Intervals', 'Weather', 'Osm', 'Physics', 'Analyzer', 'RideStore', 'Settings', 'Demo'];

vm.runInContext(
  MODULES.map(f => fs.readFileSync(path.join(JS, f), 'utf8')).join('\n;\n') +
  '\n;\n' + NAMES.map(n => 'globalThis.' + n + ' = ' + n + ';').join('\n'),
  sandbox,
  { filename: 'crosslab-bundle.js' }
);

const { Fit, Intervals, Physics, Analyzer, RideStore, Settings, Demo } = sandbox;

// ── tiny test runner ────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function near(name, got, want, tol, unit = '') {
  const ok = isFinite(got) && Math.abs(got - want) <= tol;
  check(name, ok, 'got ' + fmt(got) + unit + ', want ' + fmt(want) + '±' + fmt(tol) + unit);
}
function fmt(x) { return typeof x === 'number' ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : String(x); }
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ── 1. Settings: shared with CritLab ────────────────────────────────────────

section('Settings (shared storage with CritLab)');

check('settings blob key is cl-settings', Settings.KEY === 'cl-settings');
check('API key slot is cl-icu-key', Settings.ICU_KEY_STORE === 'cl-icu-key');
// A key CritLab wrote, that CrossLab does not know about, must survive a round trip.
sandbox.localStorage.setItem('cl-settings', JSON.stringify({ mass: 81, crr: 0.0042, cleanAirPct: 0.9, icuAthlete: 'i123' }));
Settings.set({ cxRunSpeed: 3.2 });
const blob = JSON.parse(sandbox.localStorage.getItem('cl-settings'));
check('CritLab-only keys survive a CrossLab write', blob.crr === 0.0042 && blob.cleanAirPct === 0.9, JSON.stringify({ crr: blob.crr, cleanAirPct: blob.cleanAirPct }));
check('shared rider mass is read from the shared blob', Settings.get('mass') === 81);
check('CrossLab key written', blob.cxRunSpeed === 3.2);
Settings.setIcuKey('abc123', 'local');
check('key goes to its own slot, not the blob', sandbox.localStorage.getItem('cl-icu-key') === 'abc123' && !('icuKey' in JSON.parse(sandbox.localStorage.getItem('cl-settings'))));
Settings.reset();
const after = JSON.parse(sandbox.localStorage.getItem('cl-settings'));
check('reset leaves intervals.icu and CritLab-only settings alone', after.icuAthlete === 'i123' && after.crr === 0.0042 && after.cxRunSpeed === undefined, JSON.stringify(after));
check('reset leaves the API key alone', Settings.getIcuKey() === 'abc123');
check('ride database is CrossLab\'s own, with CritLab\'s store name', RideStore.DB_NAME === 'crosslab' && RideStore.STORE === 'rides');

// ── 2. The synthetic race ───────────────────────────────────────────────────

section('Synthetic race → prepare');

const raw = Demo.build();
check('demo builds', raw.n > 2000 && raw.lat.length === raw.n, raw.n + ' samples');
check('demo carries pre-placed features', raw.features.length === 3);
check('demo is labelled cyclocross', raw.subSport === 'cyclocross');

const P = RideStore.prepare(raw);
check('prepared on a 1 Hz grid', P.n === Math.floor(raw.t[raw.n - 1]) + 1 && P.dt === 1);
check('has GPS, power, HR, cadence', P.hasGps && P.hasPower && P.hasHr && P.hasCad);

// FIT round trip through the decoder's own shape is CritLab's job; here we
// check the JSON export path, which is how a race moves between the tools.
const json = RideStore.exportJson(raw);
const back = RideStore.fromJson(JSON.parse(JSON.stringify(json)), 'x.json');
check('JSON export keeps the features', back.features.length === 3 && back.features[0].entry.lat === raw.features[0].entry.lat);
check('JSON export keeps the discipline', back.subSport === 'cyclocross');
check('JSON export round-trips the samples', back.t.length === raw.n && back.cad.length === raw.n);

// ── 3. Analysis ─────────────────────────────────────────────────────────────

section('Analysis');

const cfg = RideStore.configFor(P, { features: raw.features });
const A = Analyzer.run(P, cfg);
const T = raw.truth;

check('laps found from GPS', A.summary.laps === T.laps && A.summary.lapSource === 'gps', A.summary.laps + ' laps (' + A.summary.lapSource + ')');
near('mean-lap length matches the simulated course', A.meanLap.lapLen, T.lapLength, T.lapLength * 0.01, ' m');

// Alignment invariants: every lap's sectors and segments sum to the lap time.
let sumsOk = true;
A.grid.grid.forEach((g, k) => {
  const s = g.cells.reduce((a, c) => a + c.seconds, 0);
  if (Math.abs(s - A.aligned[k].T) > 1e-6) sumsOk = false;
});
check('sector times sum to the lap time on every lap', sumsOk);
let segOk = true;
for (const al of A.aligned) {
  const s = A.segments.reduce((a, sg) => a + (al.tAt[sg.j1] - al.tAt[sg.j0]), 0);
  if (Math.abs(s - al.T) > 1e-6) segOk = false;
}
check('riding + feature segments sum to the lap time', segOk);
let monotone = true;
for (const al of A.aligned) for (let j = 1; j < al.tAt.length; j++) if (al.tAt[j] < al.tAt[j - 1]) monotone = false;
check('aligned lap times are monotone', monotone);

// Features resolve where they were planted.
const byType = Object.fromEntries(A.features.map(f => [f.type, f]));
// Lap 1 starts where the recording did, 100 m before the line, so positions
// along the detected lap are the planted ones shifted by that lead-in.
const alongLap = s => (s + T.leadIn) % T.lapLength;
for (const [type, zone] of [['barriers', T.zones.barriers], ['runup', T.zones.runup], ['sand', T.zones.sand]]) {
  const f = byType[type];
  check(type + ' resolved onto the course', f && f.j0 >= 0 && !f.offCourse);
  if (f) near(type + ' entry lands at the planted position', A.meanLap.s[f.j0], alongLap(zone.entry - 6), 12, ' m');
}

// The planted truths come back out.
const barriers = byType.barriers, sand = byType.sand, runup = byType.runup;
check('barrier fumbles on laps ' + T.fumbleLaps.join(' and ') + ' are the slow passes',
  barriers.badLaps.map(b => b.lap).sort().join(',') === T.fumbleLaps.slice().sort().join(','),
  'bad laps: ' + barriers.badLaps.map(b => b.lap).join(','));
check('sand bog on lap ' + T.bogLap + ' is the slow pass', sand.worstLap === T.bogLap && sand.badLaps.length === 1, 'worst lap ' + sand.worstLap);
check('run-up is steady (slow every lap, not erratic)', runup.verdict === 'steady', runup.verdict);
check('run-up is the costliest feature per pass', A.summary.costliest === runup.label, A.summary.costliest);
check('sand has the most time on the table', A.summary.topFeature === sand.label, A.summary.topFeature);
near('barriers: time left on the table ≈ 2 fumbles', barriers.lostVsBest, 5.5, 2.5, ' s');

check('exactly one unplanned stop', A.bobbles.length === 1, A.bobbles.length + ' found');
if (A.bobbles.length) {
  check('the unplanned stop is on lap ' + T.bobbleLap, A.bobbles[0].lap === T.bobbleLap, 'lap ' + A.bobbles[0].lap);
  near('the unplanned stop is in the off-camber', A.bobbles[0].s, alongLap(T.offcamber.s + 40), 90, ' m');
  near('its cost is about the planted 8 s', A.bobbles[0].cost, 8, 2.5, ' s');
}

check('race faded', A.shape.kind === 'faded' && A.shape.drift > 5, A.shape.kind + ' ' + A.shape.drift.toFixed(1) + ' s');
check('fade came from the riding, not the features', A.shape.ridingDrift > A.shape.featureDrift * 2);
check('best lap is an early one', A.summary.bestLap <= 2, 'lap ' + A.summary.bestLap);
check('delta trace ends where the lap deltas say', A.delta.traces.every((tr, k) => Math.abs(tr.final - A.laps[k].deltaBest) < 1e-6));

check('findings are ranked and name the features',
  A.findings.length >= 4 && A.findings.some(f => /left on the table/.test(f.title)) && A.findings.some(f => /unplanned stop/.test(f.title)),
  A.findings.map(f => f.title).join(' | '));
check('no suggestion overlaps a placed feature', A.suggestions.every(s => !A.features.some(f => s.j0 <= f.j1 && s.j1 >= f.j0)));

check('power summary present', A.power && A.power.avg > 100 && A.power.ridingAvg > A.power.featureAvg, A.power && Math.round(A.power.ridingAvg) + ' W riding vs ' + Math.round(A.power.featureAvg) + ' W in features');

// Without features, suggestions should find the dismount zones.
const A0 = Analyzer.run(P, RideStore.configFor(P, { features: [] }));
check('with no features placed, the dismount zones are suggested', A0.suggestions.length >= 2,
  A0.suggestions.map(s => s.type + '@' + s.s.toFixed(0)).join(' '));
check('a suggestion lands on the barriers', A0.suggestions.some(s => Math.abs(s.s - alongLap(T.zones.barriers.entry)) < 25));
check('a suggestion lands on the run-up and is typed as one', A0.suggestions.some(s => s.type === 'runup' && Math.abs(s.s - alongLap(T.zones.runup.entry)) < 30));
check('with no features, every lap is riding time', A0.laps.every(r => r.featureSeconds === 0 && Math.abs(r.ridingSeconds - r.seconds) < 1e-9));

// ── 3b. Heart rate ──────────────────────────────────────────────────────────

section('Heart rate');

{
  const E = A.effort, H = A.hrQuality;
  check('effort summary present with HR', !!E && isFinite(E.avgHr) && E.maxHrRace > E.avgHr, E && Math.round(E.avgHr) + ' avg, ' + E.maxHrRace + ' max');
  check('clean strap: no dropouts in the race', H.spans.length === 0 && H.validShare > 0.99, H.spans.length + ' spans, share ' + H.validShare.toFixed(3));
  check('every lap has HR and metres per beat', A.laps.every(r => isFinite(r.avgHr) && isFinite(r.metresPerBeat) && r.metresPerBeat > 0.5 && r.metresPerBeat < 5));
  check('decoupling computed over all laps', E.hrLaps === T.laps && isFinite(E.decoupling), E.hrLaps + ' laps, ' + (E.decoupling * 100).toFixed(1) + '%');
  check('fade with HR drifting up decouples', E.decoupling > 0.03 && E.hrDrift > 0, (E.decoupling * 100).toFixed(1) + '% · HR drift ' + E.hrDrift.toFixed(1));
  const dismounts = A.features.filter(f => f.dismount);
  check('dismount features lift HR', dismounts.every(f => f.hrN >= T.laps - 1 && f.medianHrRise > 0), dismounts.map(f => f.label + ' +' + f.medianHrRise.toFixed(1)).join(', '));
  check('HR peaks at or after the exit, never inside the approach', dismounts.every(f => f.medianHrPeakLag >= -2));
  check('the longer run lifts HR more than the hop', A.features.find(f => f.type === 'runup').medianHrRise > A.features.find(f => f.type === 'barriers').medianHrRise);
  check('on foot costs more beats than riding', E.footHr > E.rideHr, Math.round(E.footHr) + ' vs ' + Math.round(E.rideHr));
  check('HR along the lap is complete', E.hrAlong && Array.from(E.hrAlong).every(isFinite) && E.perLap.length === T.laps);
  check('HR along the lap peaks near a feature', (() => {
    let jm = 0; for (let j = 1; j < E.hrAlong.length; j++) if (E.hrAlong[j] > E.hrAlong[jm]) jm = j;
    const s = jm * A.meanLap.step;
    return A.features.some(f => s >= A.meanLap.s[f.j0] - 20 && s <= A.meanLap.s[f.j1] + 60);
  })());
  check('fade finding explains the heart', A.findings.some(f => f.kind === 'fade' && /Heart rate/.test(f.body)));
  check('no start finding without a fast start', !A.findings.some(f => f.kind === 'hr-start') || E.start, '');
  check('no dropout finding on a clean strap', !A.findings.some(f => f.kind === 'hr-dropout'));
  check('threshold unknown stays unknown', !(A.cfg.lthr > 0) && !isFinite(E.lthr) && E.maxSource === 'race', 'maxHr ' + E.maxHr + ' from ' + E.maxSource);
}

// The common cross case: HR strap and cadence, no power meter.
{
  const rawHrOnly = { ...raw, watts: null };
  const Ph = RideStore.prepare(rawHrOnly);
  const Ah = Analyzer.run(Ph, RideStore.configFor(Ph, { features: raw.features }));
  check('HR-only ride: effort present, power absent', !!Ah.effort && Ah.power === null && !Ph.hasPower);
  check('HR-only ride: same decoupling as with power', Math.abs(Ah.effort.decoupling - A.effort.decoupling) < 1e-9);
  check('HR-only ride: HR findings present', Ah.findings.some(f => /^hr-/.test(f.kind) || (f.kind === 'fade' && /Heart rate/.test(f.body))));
}

// A dry strap for the first seven minutes: flat 95 bpm while racing.
{
  const rawDry = { ...raw, hr: raw.hr.map((h, i) => (raw.t[i] < 420 ? 95 + (i % 3) : h)) };
  const Pd = RideStore.prepare(rawDry);
  const Ad = Analyzer.run(Pd, RideStore.configFor(Pd, { features: raw.features }));
  const Hd = Ad.hrQuality;
  check('dropout detected', Hd.spans.length >= 1 && Hd.invalidSeconds >= 300 && Hd.invalidSeconds <= 440, Hd.invalidSeconds + ' s invalid, spans ' + Hd.spans.map(x => x.t0 + '-' + x.t1).join(' '));
  check('lap 1 has no HR, later laps do', !isFinite(Ad.laps[0].avgHr) && isFinite(Ad.laps[T.laps - 1].avgHr));
  check('average HR ignores the dropout', Ad.effort.avgHr > A.effort.avgHr - 1, Math.round(Ad.effort.avgHr) + ' vs clean ' + Math.round(A.effort.avgHr));
  check('dropout finding names the laps', Ad.findings.some(f => f.kind === 'hr-dropout' && /Lap 1/.test(f.body)), (Ad.findings.find(f => f.kind === 'hr-dropout') || {}).body);
  check('no start analysis through a dropout', !Ad.effort.start);
}

// Rider numbers: a user-set threshold and max flow through.
{
  Settings.set({ cxLthr: 172, cxLthrUserSet: true, cxMaxHr: 200, cxMaxHrUserSet: true });
  const cfgU = RideStore.configFor(P, { features: raw.features });
  const Au = Analyzer.run(P, cfgU);
  check('user-set LTHR and max are used', cfgU.lthr === 172 && cfgU.maxHr === 200 && cfgU.fitnessSource.lthr === 'you' && Au.effort.aboveLthr > 0 && Au.effort.maxSource === 'you');
  Settings.set({ cxLthrUserSet: false, cxMaxHrUserSet: false });
  const PF = RideStore.prepare({ ...raw, lthr: 168, maxHr: 195, hrZones: [120, 140, 155, 168, 180, 190, 210] });
  const cfgF = RideStore.configFor(PF, { features: raw.features });
  const Af = Analyzer.run(PF, cfgF);
  check('file LTHR, max and zones are used', cfgF.lthr === 168 && cfgF.maxHr === 195 && Af.effort.zones && Af.effort.zones.length === 7 && Math.abs(Af.effort.zones.reduce((a, z) => a + z.seconds, 0) - Af.effort.validSeconds) < 1e-6);
  check('HR rider numbers survive export', (() => { const st = RideStore.exportJson({ ...raw, lthr: 168, maxHr: 195, hrZones: [1, 2, 3] }); return st.lthr === 168 && st.maxHr === 195 && st.hrZones.length === 3; })());
}

// ── 4. No power meter ───────────────────────────────────────────────────────

section('Without a power meter');

const rawNoPower = { ...raw, watts: null, cad: null, hr: null };
const P2 = RideStore.prepare(rawNoPower);
check('prepares without watts, cadence or HR', !P2.hasPower && !P2.hasCad && !P2.hasHr);
const A2 = Analyzer.run(P2, RideStore.configFor(P2, { features: raw.features }));
check('same laps without power', A2.summary.laps === T.laps);
check('same feature verdicts without power', A2.features.find(f => f.type === 'barriers').badLaps.length === 2);
check('no power summary', A2.power === null);
check('findings still produced', A2.findings.length >= 3);

// ── 5. Pre-ride + race + cool-down ─────────────────────────────────────────

section('Race window');

// Build a recording that is: two slow laps, a 6-minute stand on the grid, the race, one slow lap.
{
  const L = raw.n;
  const slow = (arr, f) => arr.map(x => x * f);
  const stretch = (lapRaw) => lapRaw;
  // Take the first two real laps as a template and slow them down by resampling time.
  const i0 = A.lapBounds[0].i0, i1 = A.lapBounds[1].i1;
  const tmplT = raw.t.slice(i0, i1 + 1), tmplLat = raw.lat.slice(i0, i1 + 1), tmplLon = raw.lon.slice(i0, i1 + 1);
  const tmplD = raw.dist.slice(i0, i1 + 1), tmplAlt = raw.alt.slice(i0, i1 + 1);
  const n2 = tmplT.length;
  const t = [], lat = [], lon = [], dist = [], v = [], alt = [], watts = [];
  let tt = 0, dd = 0;
  // Pre-ride at 65% pace: same geometry, 1.54× the time per sample.
  for (let i = 0; i < n2; i++) {
    const dtS = i ? (tmplT[i] - tmplT[i - 1]) * 1.54 : 0;
    const dD = i ? tmplD[i] - tmplD[i - 1] : 0;
    tt += dtS; dd += dD;
    t.push(Math.round(tt)); lat.push(tmplLat[i]); lon.push(tmplLon[i]); dist.push(dd); v.push(dtS ? dD / dtS : 0); alt.push(tmplAlt[i]); watts.push(120);
  }
  // Staging: 6 minutes stationary at the last point.
  for (let k = 0; k < 360; k++) { tt += 1; t.push(Math.round(tt)); lat.push(lat[lat.length - 1]); lon.push(lon[lon.length - 1]); dist.push(dd); v.push(0); alt.push(alt[alt.length - 1]); watts.push(0); }
  // The race itself.
  const tOff = tt, dOff = dd;
  for (let i = 0; i < raw.n; i++) { t.push(Math.round(tOff + raw.t[i] + 1)); lat.push(raw.lat[i]); lon.push(raw.lon[i]); dist.push(dOff + raw.dist[i]); v.push(raw.v[i]); alt.push(raw.alt[i]); watts.push(raw.watts[i]); }
  tt = t[t.length - 1]; dd = dist[dist.length - 1];
  // Cool-down lap at 60%.
  const c0 = A.lapBounds[0].i0, c1 = A.lapBounds[0].i1;
  for (let i = c0; i <= c1; i++) {
    const dtS = i > c0 ? (raw.t[i] - raw.t[i - 1]) * 1.67 : 1;
    const dD = i > c0 ? raw.dist[i] - raw.dist[i - 1] : 0;
    tt += dtS; dd += dD;
    t.push(Math.round(tt)); lat.push(raw.lat[i]); lon.push(raw.lon[i]); dist.push(dd); v.push(dD / dtS); alt.push(raw.alt[i]); watts.push(100);
  }
  const big = { ...raw, id: 'demo-with-preride', n: t.length, t, lat, lon, dist, v, alt, watts, cad: null, hr: null, features: raw.features };
  const Pb = RideStore.prepare(big);
  const cfgb = RideStore.configFor(Pb, { features: raw.features });
  const lapsB = Analyzer.detectLaps(Pb, cfgb);
  check('laps found across pre-ride, race and cool-down', lapsB.length >= T.laps + 2, lapsB.length + ' laps');
  const win = Analyzer.detectRaceWindow(Pb, lapsB, cfgb);
  check('race window found', win.found);
  check('race window keeps the race laps', win.found && win.keep.length === T.laps, win.found && win.keep.length + ' kept');
  check('pre-ride laps dropped', win.found && win.preRide >= 2, 'preRide ' + win.preRide);
  check('cool-down lap dropped', win.found && win.cooldown >= 1, 'cooldown ' + win.cooldown);
  check('staging time reported', win.found && win.stagingSeconds >= 300, win.stagingSeconds + ' s');
  // "I start recording on the start line" forbids trimming the front.
  const winLine = Analyzer.detectRaceWindow(Pb, lapsB, { ...cfgb, startsOnStartLine: true });
  check('with "starts on the line" set, no pre-ride is proposed', !winLine.found);
  // Apply the crop the way the app does and check the analysis matches the clean race.
  big.crop = { startT: Pb.t[win.i0], endT: Pb.t[win.i1] };
  const Pc = RideStore.prepare(big);
  const Ac = Analyzer.run(Pc, RideStore.configFor(Pc, { features: raw.features }));
  check('cropped analysis has the race laps', Ac.summary.laps === T.laps, Ac.summary.laps + ' laps');
  near('cropped best lap matches the clean race', Ac.summary.bestLapSeconds, A.summary.bestLapSeconds, 2, ' s');
}

// ── 6. Intervals.icu stream shapes ──────────────────────────────────────────

section('intervals.icu');

const streams = { time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], latlng: [42.1, 42.1, 42.1, 42.1, 42.1, 42.1, 42.1, 42.1, 42.1, 42.1, 42.1, 42.1], latlng__data2: [-71.1, -71.1, -71.1, -71.1, -71.1, -71.1, -71.1, -71.1, -71.1, -71.1, -71.1, -71.1], distance: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], velocity_smooth: new Array(12).fill(5) };
const ride = Intervals.toRide({ id: 'i1', name: 'CX', start: '2026-10-10T10:00:00', type: 'Ride' }, streams);
check('a ride without watts is accepted', ride.watts === null && ride.lat.length === 12);
check('parallel lat/lon arrays are paired', ride.lon[0] === -71.1);
check('"looks like cross" matches names and tags',
  Intervals.looksCross({ name: 'Lexington Cyclocross - Saturday' }) && Intervals.looksCross({ name: 'Race', tags: ['cx'] }) && !Intervals.looksCross({ name: 'Crossfit' }) && !Intervals.looksCross({ name: 'Gravel' }));

// ── summary ─────────────────────────────────────────────────────────────────

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
