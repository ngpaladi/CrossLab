'use strict';

/**
 * Settings — small persistent preference bag in localStorage.
 * Loaded on every page, because the settings drawer lives in the layout.
 *
 * STORAGE IS SHARED WITH CRITLAB. Both tools are served from the same origin
 * (www.noahpaladino.com/CritLab and /CrossLab), so localStorage is one bag for
 * both. The blob key, the API-key slot and every key CritLab already defines
 * keep their CritLab names and meanings here: paste the intervals.icu key once
 * and both tools see it; set your mass or CP in one and the other agrees.
 *
 * Rules that keep that true:
 *   · only ADD keys to DEFAULTS, never change what an existing one means
 *   · CrossLab-only keys are prefixed `cx` so they are recognisable in a dump
 *   · `reset()` removes CrossLab's own keys and the rider numbers; it never
 *     touches the intervals.icu settings or CritLab-only preferences
 *   · unknown keys in the stored blob survive a round trip (all() merges the
 *     stored object over DEFAULTS, set() merges on top of that)
 */
const Settings = (() => {
  const KEY = 'cl-settings';

  // The intervals.icu key is deliberately NOT part of the settings blob.
  //
  // Keeping it in its own slot means it can be given its own lifetime (session
  // or persistent), purged on its own, and never ride along in a settings
  // export or a debug dump of `cl-settings`. There is no CrossLab server, so
  // this browser is the only place the key exists — which makes where exactly
  // it lives worth being deliberate about. Same slot as CritLab, on purpose.
  const ICU_KEY_STORE = 'cl-icu-key';

  const DEFAULTS = {
    // ── Shared with CritLab: identical names, identical meanings ──────────
    // intervals.icu (the key itself lives in ICU_KEY_STORE, not here)
    icuAthlete: '', icuAthleteName: '',
    icuKeyPersist: 'local',        // 'local' = remembered · 'session' = until the tab closes

    // weather
    wxAuto: true, wxRoughness: 0.1,

    // map
    osmBasemap: true,

    // recording habits — things only the rider knows
    startsOnStartLine: false,

    // rider + machine
    mass: 78,
    ftp: 250, cp: 250, wPrime: 20000,
    ftpUserSet: false, cpUserSet: false, wPrimeUserSet: false,

    // ── CrossLab only ─────────────────────────────────────────────────────
    cxRunSpeed: 3.5,       // m/s — below this inside a feature you are on foot
    cxStopSpeed: 1.0,      // m/s — below this you are stopped (bobble, crash, queue)
    cxSectorCount: 10,     // columns in the lap × sector heatmap
    cxSuggest: true,       // propose dismount zones from the mean lap
    cxBobbleSeconds: 2.5,  // an unplanned stop has to cost at least this to be listed
  };

  // Keys CrossLab's "Reset to defaults" is allowed to clear. Everything to do
  // with intervals.icu, and anything CritLab defines that CrossLab does not
  // use, is left exactly as it was.
  const RESETTABLE = [
    'mass', 'ftp', 'cp', 'wPrime', 'ftpUserSet', 'cpUserSet', 'wPrimeUserSet',
    'cxRunSpeed', 'cxStopSpeed', 'cxSectorCount', 'cxSuggest', 'cxBobbleSeconds',
  ];

  let cache = null;

  // Last resort for the key when storage is unavailable — a file:// page, an
  // opaque origin, private browsing with storage blocked. Session-lifetime
  // only, which is strictly less persistent than the storage it stands in for.
  let memKey = '';

  function store(kind) {
    try {
      const s = kind === 'session' ? sessionStorage : localStorage;
      if (!s) return null;
      // Presence is not availability: some contexts throw only on use.
      const probe = '__cl_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_) { return null; }
  }

  /** Read the key from wherever it was put. Session wins — it is the fresher one. */
  function getIcuKey() {
    try {
      const s = store('session'), l = store('local');
      const found = (s && s.getItem(ICU_KEY_STORE)) || (l && l.getItem(ICU_KEY_STORE)) || '';
      return found || memKey;
    } catch (_) { return memKey; }
  }

  /**
   * @param {string} key   the API key, or '' to forget it
   * @param {string} [persist] 'local' to remember across sessions, 'session' to
   *        drop it when the tab closes. Defaults to the saved preference.
   */
  function setIcuKey(key, persist) {
    const how = persist || get('icuKeyPersist') || 'local';
    memKey = key || '';
    try { const l = store('local'); if (l) l.removeItem(ICU_KEY_STORE); } catch (_) {}
    try { const s = store('session'); if (s) s.removeItem(ICU_KEY_STORE); } catch (_) {}
    if (!key) return;
    try {
      const target = store(how === 'session' ? 'session' : 'local');
      if (target) target.setItem(ICU_KEY_STORE, key);
    } catch (_) {}
  }

  function forgetIcuKey() { setIcuKey(''); }

  function all() {
    if (cache) return cache;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}

    // Migration carried over from CritLab: earlier builds kept the key inside
    // the settings blob. Move it to its own slot and scrub it on the way past.
    if (stored.icuKey) {
      const legacy = stored.icuKey;
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
      setIcuKey(legacy, cache.icuKeyPersist);
    } else {
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
    }
    return cache;
  }

  function get(k) {
    const s = all();
    return k === 'icuKey' ? getIcuKey() : s[k];
  }

  function set(patch) {
    const next = { ...patch };
    if ('icuKey' in next) {
      setIcuKey(next.icuKey, next.icuKeyPersist || get('icuKeyPersist'));
      delete next.icuKey;
    }
    cache = { ...all(), ...next };
    delete cache.icuKey;                       // never let it back into the blob
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
    if (next.icuKeyPersist) {
      const existing = getIcuKey();
      if (existing) setIcuKey(existing, next.icuKeyPersist);
    }
    return cache;
  }

  /** Put CrossLab's own preferences and the rider numbers back to defaults. */
  function reset() {
    const keep = { ...all() };
    for (const k of RESETTABLE) delete keep[k];
    cache = null;
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch (_) {}
    return all();
  }

  return { all, get, set, reset, DEFAULTS, RESETTABLE, getIcuKey, setIcuKey, forgetIcuKey, ICU_KEY_STORE, KEY };
})();

/**
 * RideStore — normalisation, derived series, and persistence.
 *
 * Rides arrive from three places (a FIT file, intervals.icu, a JSON export) in
 * three shapes, at irregular sample rates, with different holes in them. Every
 * one is flattened here into a single 1 Hz grid with the derived series the
 * analyser expects, so nothing downstream has to care where it came from.
 *
 * The raw ride shape and the IndexedDB schema are CritLab's exactly, in a
 * database of CrossLab's own. Same shape means a JSON export moves between the
 * two tools; a separate database means CritLab re-saving a ride can never
 * strip the course features CrossLab stores on it, and bumping a schema
 * version in one tool can never lock the other out.
 */
const RideStore = (() => {

  const DB_NAME = 'crosslab';
  const DB_VERSION = 1;
  const STORE = 'rides';

  // ── Normalisation ─────────────────────────────────────────────────────────

  /**
   * Resample a raw ride onto a uniform 1 Hz grid and compute derived series.
   *
   * Recording gaps (auto-pause, a dropped connection) are not interpolated
   * across: distance holds, speed and power go to zero, and the samples are
   * flagged so the analyser can exclude them.
   */
  function prepare(raw, cfg) {
    let src = raw.t.map(Number);
    let raw0 = 0, rawN = src.length;

    // A crop is applied here, before anything is derived, so that every
    // downstream number is computed on the race alone.
    if (raw.crop && isFinite(raw.crop.startT) && isFinite(raw.crop.endT)) {
      const t0abs = src[0];
      while (raw0 < src.length - 1 && src[raw0] - t0abs < raw.crop.startT) raw0++;
      rawN = raw0;
      while (rawN < src.length && src[rawN] - t0abs <= raw.crop.endT) rawN++;
      if (rawN - raw0 < 10) { raw0 = 0; rawN = src.length; }   // nonsense crop
      src = src.slice(raw0, rawN);
    }
    const clip = a => (Array.isArray(a) || ArrayBuffer.isView(a)) ? Array.prototype.slice.call(a, raw0, rawN) : a;

    const nSrc = src.length;
    if (nSrc < 10) throw new Error('This ride has too few samples to analyse.');

    const dt = 1;
    const t0 = src[0], t1 = src[nSrc - 1];
    const n = Math.floor((t1 - t0) / dt) + 1;
    if (n < 10) throw new Error('This ride is too short to analyse.');
    if (n > 200000) throw new Error('This ride is longer than CrossLab handles (>55 h).');

    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i * dt;

    // Which source samples bracket each grid point.
    const lo = new Int32Array(n), hi = new Int32Array(n);
    const frac = new Float64Array(n);
    const gap = new Uint8Array(n);
    {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const want = t0 + i * dt;
        while (s < nSrc - 2 && src[s + 1] <= want) s++;
        const a = s, b = Math.min(nSrc - 1, s + 1);
        lo[i] = a; hi[i] = b;
        const span = src[b] - src[a];
        frac[i] = span > 0 ? Math.min(1, Math.max(0, (want - src[a]) / span)) : 0;
        if (span > 3) gap[i] = 1;               // recording hole
      }
    }

    const resample = (series, { hold = false } = {}) => {
      if (!series) return null;
      const out = new Float64Array(n);
      let lastGood = 0;
      for (let i = 0; i < n; i++) {
        const a = series[lo[i]], b = series[hi[i]];
        let v;
        if (gap[i]) {
          v = hold ? (a != null && isFinite(a) ? a : lastGood) : 0;
        } else if (a == null && b == null) {
          v = lastGood;
        } else if (a == null) { v = b; }
        else if (b == null) { v = a; }
        else { v = a + (b - a) * frac[i]; }
        if (!isFinite(v)) v = lastGood;
        out[i] = v;
        lastGood = v;
      }
      return out;
    };

    const lat = raw.lat ? resampleGeo(clip(raw.lat), n, lo, hi, frac, gap) : null;
    const lon = raw.lon ? resampleGeo(clip(raw.lon), n, lo, hi, frac, gap) : null;
    const alt = resample(clip(raw.alt), { hold: true }) || new Float64Array(n);
    const hr = resample(clip(raw.hr), { hold: true });
    const cad = resample(clip(raw.cad));
    const temp = resample(clip(raw.temp), { hold: true });
    const watts = resample(clip(raw.watts)) || new Float64Array(n);

    let dist = resample(clip(raw.dist), { hold: true });
    let v = resample(clip(raw.v));

    if (!dist && !v) throw new Error('This ride has neither speed nor distance data.');

    if (!dist) {
      dist = new Float64Array(n);
      for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.max(0, v[i]) * dt;
    } else {
      for (let i = 1; i < n; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];
    }

    if (!v) {
      v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        v[i] = Math.max(0, (dist[i1] - dist[i0]) / ((i1 - i0) * dt));
      }
    }
    for (let i = 0; i < n; i++) {
      if (gap[i]) { v[i] = 0; watts[i] = 0; }
      if (!(v[i] >= 0)) v[i] = 0;
      if (!(watts[i] >= 0)) watts[i] = 0;
    }

    // Derived series. The moving threshold is low for cross: a rider shouldering
    // a bike up a run-up at 1.5 m/s is racing, not parked.
    const movingSpeed = cfg && cfg.movingSpeed != null ? cfg.movingSpeed : 0.8;
    const moving = new Uint8Array(n);
    for (let i = 0; i < n; i++) moving[i] = (v[i] > movingSpeed && !gap[i]) ? 1 : 0;

    const altS = Physics.smooth(alt, 9);
    const slope = Physics.gradientSeries(altS, dist, 20);
    const theta = new Float64Array(n);
    for (let i = 0; i < n; i++) theta[i] = Math.atan(slope[i]);

    const accel = Physics.derivative(Physics.smooth(v, 5), t);
    for (let i = 0; i < n; i++) {
      if (!isFinite(accel[i]) || Math.abs(accel[i]) > 6) accel[i] = 0;
    }

    const heading = Physics.headingSeries(lat, lon, n);

    // Device lap markers → grid indices.
    let lapIndices = null;
    if (Array.isArray(raw.lapTimes) && raw.lapTimes.length) {
      const set = new Set([0]);
      for (const lt of raw.lapTimes) {
        const idx = Math.round((lt - (src[0] - raw.t[0])) / dt);
        if (idx > 0 && idx < n) set.add(idx);
      }
      set.add(n - 1);
      lapIndices = Array.from(set).sort((a, b) => a - b);
      if (lapIndices.length < 4) lapIndices = null;
    }

    const hasCad = !!cad && cad.some(x => x > 0);

    return {
      id: raw.id, name: raw.name, source: raw.source, sourceId: raw.sourceId || null,
      startTime: raw.startTime ? raw.startTime + (src[0] - raw.t[0]) : null,
      sport: raw.sport || 'cycling', subSport: raw.subSport || null,
      n, dt, t,
      lat, lon, alt: altS, v, watts, hr, cad: hasCad ? cad : null, dist, temp,
      moving, gap, theta, slope, accel, heading,
      lapIndices,
      crop: raw.crop || null,
      croppedFrom: raw.t.length,
      ftp: raw.ftp || null, weightKg: raw.weightKg || null,
      cp: raw.cp || null, wPrime: raw.wPrime || null,
      totals: raw.totals || {},
      hasPower: watts.some(x => x > 0),
      hasHr: !!hr && hr.some(x => x > 0),
      hasCad,
      hasGps: !!lat,
    };
  }

  /** Lat/lon need their own resampler: nulls must not average toward zero. */
  function resampleGeo(series, n, lo, hi, frac, gap) {
    const out = new Float64Array(n);
    let last = null;
    for (let i = 0; i < n; i++) {
      const a = series[lo[i]], b = series[hi[i]];
      const aOk = a != null && isFinite(a) && a !== 0;
      const bOk = b != null && isFinite(b) && b !== 0;
      let v;
      if (gap[i]) v = aOk ? a : (last != null ? last : 0);
      else if (aOk && bOk) v = a + (b - a) * frac[i];
      else if (aOk) v = a;
      else if (bOk) v = b;
      else v = last != null ? last : 0;
      out[i] = v;
      if (v !== 0) last = v;
    }
    return out;
  }

  // ── JSON import ───────────────────────────────────────────────────────────

  /** Accept a CritLab/CrossLab export, an intervals.icu stream dump, or a Strava-ish blob. */
  function fromJson(json, filename) {
    if (json && json.t && (json.watts || json.v || json.dist)) {
      return {
        source: json.source || 'json',
        name: json.name || stripExt(filename),
        startTime: json.startTime || null,
        sport: json.sport || 'cycling', subSport: json.subSport || null,
        n: json.t.length,
        t: json.t, lat: json.lat || null, lon: json.lon || null,
        alt: json.alt || null, v: json.v || null, watts: json.watts || null,
        hr: json.hr || null, cad: json.cad || null, dist: json.dist || null,
        temp: json.temp || null, lapTimes: json.lapTimes || [],
        ftp: json.ftp || null, weightKg: json.weightKg || null,
        cp: json.cp || null, wPrime: json.wPrime || null,
        totals: json.totals || {},
        startAnchor: json.startAnchor || null,
        features: Array.isArray(json.features) ? json.features : [],
        crop: json.crop || null,
      };
    }

    const s = {};
    const take = (k, val) => {
      if (!k || !val) return;
      if (Array.isArray(val)) { s[k] = val; return; }
      const data = val.data || val.samples || val.values;
      if (!Array.isArray(data)) return;
      s[k] = data;
      if (Array.isArray(val.data2)) s[k + '__data2'] = val.data2;
    };

    if (Array.isArray(json)) {
      for (const x of json) take(x && x.type, x);
    } else if (json && typeof json === 'object') {
      const src = json.streams || json;
      for (const [k, val] of Object.entries(src)) take(k, val);
    }
    if (!s.time) throw new Error('Could not find a time stream in this JSON file.');

    return Intervals.toRide(
      {
        id: json.id || null,
        name: json.name || stripExt(filename),
        start: json.start_date_local || json.start_date || null,
        startUtc: json.start_date || null,
        type: json.type || 'Ride',
        ftp: json.icu_ftp || null, weight: json.icu_weight || null,
        cp: json.icu_pm_cp || null, wPrime: json.icu_pm_w_prime || null,
      },
      s
    );
  }

  function stripExt(name) {
    return String(name || 'Race').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Race';
  }

  // ── Persistence (IndexedDB) ───────────────────────────────────────────────

  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!self.indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('startTime', 'startTime');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open IndexedDB.'));
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  async function put(ride) {
    if (!ride.id) ride.id = makeId(ride);
    await tx('readwrite', s => s.put(stripForStorage(ride)));
    return ride.id;
  }

  async function list() {
    const rows = await tx('readonly', s => s.getAll());
    const all = Array.isArray(rows) ? rows : [];
    all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    return all;
  }

  async function get(id) { return tx('readonly', s => s.get(id)); }
  async function remove(id) { return tx('readwrite', s => s.delete(id)); }
  async function clear() { return tx('readwrite', s => s.clear()); }

  /**
   * Store the raw ride, not the derived arrays — prepare() is cheap to redo.
   * CritLab's keep-list plus `subSport` and `features`. CritLab will ignore
   * those two if it is ever handed this ride; nothing else differs.
   */
  function stripForStorage(ride) {
    const keep = [
      'id', 'name', 'source', 'sourceId', 'startTime', 'sport', 'subSport', 'n',
      't', 'lat', 'lon', 'alt', 'v', 'watts', 'hr', 'cad', 'dist', 'temp',
      'lapTimes', 'ftp', 'weightKg', 'cp', 'wPrime', 'totals', 'device', 'savedAt',
      'startAnchor', 'crop', 'features',
    ];
    const out = {};
    for (const k of keep) if (ride[k] !== undefined) out[k] = toPlain(ride[k]);
    out.savedAt = Date.now();
    return out;
  }

  function toPlain(x) {
    return ArrayBuffer.isView(x) ? Array.from(x) : x;
  }

  function makeId(ride) {
    if (ride.source === 'icu' && ride.sourceId) return 'icu-' + ride.sourceId;
    const stamp = ride.startTime || Math.floor(Date.now() / 1000);
    const slug = String(ride.name || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
    return [ride.source || 'file', stamp, slug].join('-').replace(/-+$/, '');
  }

  /** The ride as a JSON export that either tool can read back. */
  function exportJson(ride) {
    const out = stripForStorage(ride);
    delete out.savedAt;
    return out;
  }

  // ── Config assembly ───────────────────────────────────────────────────────

  /**
   * Merge saved settings with whatever the ride itself knows (intervals.icu
   * ships FTP, weight, CP and W′ per activity) into one analyser config.
   */
  function configFor(P, overrides) {
    const s = Settings.all();
    const o = overrides || {};
    const fromFile = (key, fileValue) => (s[key + 'UserSet'] ? null : fileValue);

    const ftp = pickNum(o.ftp, fromFile('ftp', P.ftp), s.ftp);
    const cp = pickNum(o.cp, fromFile('cp', P.cp), s.cp, ftp);

    return {
      mass: pickNum(o.mass, s.mass),
      ftp, cp,
      wPrime: pickNum(o.wPrime, fromFile('wPrime', P.wPrime), s.wPrime),
      fitnessSource: {
        ftp: s.ftpUserSet ? 'you' : (P.ftp ? 'file' : 'default'),
        cp: s.cpUserSet ? 'you' : (P.cp ? 'file' : 'default'),
        wPrime: s.wPrimeUserSet ? 'you' : (P.wPrime ? 'file' : 'default'),
      },

      startAnchor: o.startAnchor || null,
      startsOnStartLine: !!s.startsOnStartLine,
      features: Array.isArray(o.features) ? o.features : [],

      runSpeed: pickNum(o.runSpeed, s.cxRunSpeed),
      stopSpeed: pickNum(o.stopSpeed, s.cxStopSpeed),
      sectorCount: Math.round(pickNum(o.sectorCount, s.cxSectorCount)),
      suggest: o.suggest !== undefined ? !!o.suggest : s.cxSuggest !== false,
      bobbleSeconds: pickNum(o.bobbleSeconds, s.cxBobbleSeconds),

      // Fixed model constants — all in one place.
      lapRadius: 25, minLapMetres: 800,
      approachSeconds: 3, recoverSeconds: 30,
      movingSpeed: 0.8,
    };
  }

  function pickNum(...vals) {
    for (const v of vals) if (typeof v === 'number' && isFinite(v) && v !== 0) return v;
    for (const v of vals) if (typeof v === 'number' && isFinite(v)) return v;
    return 0;
  }

  return {
    prepare, fromJson, configFor, exportJson,
    put, list, get, remove, clear, makeId,
    DB_NAME, STORE,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RideStore, Settings };
}
