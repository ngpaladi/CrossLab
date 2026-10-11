'use strict';

/**
 * app.js — UI state and orchestration.
 *
 * Owns the loaded races, the feature picker, the rail controls, tab switching
 * and rendering. All the actual thinking lives in Analyzer; this file binds it
 * to the DOM and keeps the two sidebars honest.
 */
(() => {

  const $ = id => document.getElementById(id);

  const state = {
    races: [],            // { id, raw, P, A, wx, wxError, osm, osmError, compare, win }
    currentId: null,
    featureMetric: 'lost',
    cmpMetric: 'bestLap',
    activeFeature: null,  // feature id selected in the Features tab
    traceLap: null,       // lap highlighted on the Trace tab, or null for all
    replay: { idx: 0, timer: null },
    busy: false,
    picking: null,        // null | { what: 'start' } | { what: 'feature', type, entry }
    icu: { activities: [], skipped: [], filters: { race: true, gps: true, cross: false, tags: new Set() }, search: '' },
  };

  // Rail controls: id suffix → formatter. Keys match Settings.
  const RAIL = {
    mass:            { fmt: v => v.toFixed(1) + ' kg' },
    ftp:             { fmt: v => Math.round(v) + ' W' },
    cp:              { fmt: v => Math.round(v) + ' W' },
    wPrime:          { fmt: v => (v / 1000).toFixed(1) + ' kJ' },
    cxRunSpeed:      { fmt: v => (v * 3.6).toFixed(1) + ' km/h' },
    cxStopSpeed:     { fmt: v => (v * 3.6).toFixed(1) + ' km/h' },
    cxBobbleSeconds: { fmt: v => v.toFixed(1) + ' s' },
    cxSectorCount:   { fmt: v => String(Math.round(v)) },
  };

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    bindRail();
    bindTabs();
    bindLoaders();
    bindCourseTools();
    bindReplay();
    bindWindow();
    syncRailFromSettings();
    initDates();
    fillFeatureTypes();

    try {
      const stored = await RideStore.list();
      for (const raw of stored) addRace(raw, { silent: true });
    } catch (err) {
      console.warn('Could not read stored races:', err);
    }

    renderRaceList();
    if (state.races.length) {
      await select(state.races[0].id);
    } else {
      renderEmpty();
    }
  }

  // ── Race lifecycle ────────────────────────────────────────────────────────

  function addRace(raw, { silent = false } = {}) {
    if (!raw.id) raw.id = RideStore.makeId(raw);
    if (!Array.isArray(raw.features)) raw.features = [];
    const existing = state.races.findIndex(r => r.id === raw.id);
    const entry = { id: raw.id, raw, P: null, A: null, wx: null, wxError: null,
      osm: null, osmError: null, compare: false, win: null };
    if (existing >= 0) state.races[existing] = entry; else state.races.push(entry);
    state.races.sort((a, b) => (b.raw.startTime || 0) - (a.raw.startTime || 0));
    if (!silent) renderRaceList();
    return entry;
  }

  async function loadRaw(raw, opts = {}) {
    const { persist = true } = opts;
    setBusy(true, 'Preparing…');
    try {
      const entry = addRace(raw);
      entry.P = RideStore.prepare(raw);
      if (!entry.P.hasGps) throw new Error('No GPS in this file — CrossLab needs a track to find the laps and the features on them.');
      if (persist) {
        try { await RideStore.put(raw); } catch (err) { console.warn('Could not save race:', err); }
      }
      renderRaceList();
      await select(entry.id);
    } catch (err) {
      if (!opts.quiet) alert(String(err.message || err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function select(id) {
    state.currentId = id;
    stopReplay();
    state.replay.idx = 0;
    state.activeFeature = null;
    state.traceLap = null;
    state.picking = null;
    const entry = current();
    if (!entry) { renderEmpty(); return; }

    if (!entry.P) entry.P = RideStore.prepare(entry.raw);
    renderRaceList();
    await Promise.all([ensureWeather(entry), ensureOsm(entry)]);
    recompute();
  }

  function current() {
    return state.races.find(r => r.id === state.currentId) || null;
  }

  async function ensureWeather(entry, { force = false } = {}) {
    if (!force && (entry.wx || entry.wxError)) return;
    if (!Settings.get('wxAuto') && !force) return;
    const P = entry.P;
    if (!P.hasGps || !P.startTime) {
      entry.wxError = !P.hasGps ? 'no GPS in this file' : 'no start timestamp in this file';
      return;
    }
    const mid = Math.floor(P.n / 2);
    setBusy(true, 'Fetching weather…');
    try {
      entry.wx = await Weather.fetchFor({
        lat: P.lat[mid], lon: P.lon[mid],
        startUnix: P.startTime - 36 * 3600, endUnix: P.startTime + P.t[P.n - 1],
      });
      entry.wxError = null;
    } catch (err) {
      entry.wx = null;
      entry.wxError = String(err.message || err);
    } finally {
      setBusy(false);
    }
  }

  async function ensureOsm(entry, { force = false } = {}) {
    if (!force && (entry.osm || entry.osmError)) return;
    if (!Settings.get('osmBasemap')) return;
    const P = entry.P;
    if (!P.hasGps) { entry.osmError = 'no GPS'; return; }
    try {
      entry.osm = await Osm.fetchFor(Osm.boundsOf(P));
      entry.osmError = null;
    } catch (err) {
      entry.osm = null;
      entry.osmError = String(err.message || err);
    }
  }

  function basemap(entry) {
    return Settings.get('osmBasemap') ? entry.osm : null;
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  function analyse(entry) {
    const P = entry.P;
    const cfg = RideStore.configFor(P, {
      startAnchor: entry.raw.startAnchor || null,
      features: entry.raw.features || [],
    });
    entry.A = Analyzer.run(P, cfg);
    // Race window: only worth offering when nothing is cropped yet.
    entry.win = entry.raw.crop ? null : Analyzer.detectRaceWindow(P, entry.A.lapBounds, cfg);
    return entry.A;
  }

  let recomputeTimer = null;
  function recomputeSoon() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recompute, 120);
  }

  function recompute() {
    const entry = current();
    if (!entry || !entry.P) { renderEmpty(); return; }
    try {
      analyse(entry);
    } catch (err) {
      console.error(err);
      alert('Analysis failed: ' + (err.message || err));
      return;
    }
    renderAll();
  }

  async function applyCrop(entry, win) {
    // The window is only ever detected on an uncropped ride, so P.t is
    // relative to the start of the recording — which is what crop expects.
    const P = entry.P;
    entry.raw.crop = { startT: P.t[win.i0], endT: P.t[win.i1] };
    entry.P = RideStore.prepare(entry.raw);
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  async function uncrop(entry) {
    entry.raw.crop = null;
    entry.P = RideStore.prepare(entry.raw);
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  // ── Rail ──────────────────────────────────────────────────────────────────

  function bindRail() {
    for (const [key, spec] of Object.entries(RAIL)) {
      const input = $('in-' + key), val = $('v-' + key);
      if (!input) continue;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        val.textContent = spec.fmt(v);
        const patch = { [key]: v };
        if (key === 'ftp' || key === 'cp' || key === 'wPrime') patch[key + 'UserSet'] = true;
        Settings.set(patch);
        if (key === 'ftp' || key === 'cp' || key === 'wPrime') $('fitness-reset').style.display = '';
        recomputeSoon();
      });
    }
    $('fitness-reset').addEventListener('click', () => {
      Settings.set({ ftpUserSet: false, cpUserSet: false, wPrimeUserSet: false });
      $('fitness-reset').style.display = 'none';
      recompute();
    });
    $('reset-settings').addEventListener('click', () => {
      Settings.reset();
      syncRailFromSettings();
      recompute();
    });
    $('wx-refresh').addEventListener('click', async () => {
      const entry = current();
      if (!entry) return;
      await ensureWeather(entry, { force: true });
      renderConditions();
    });
    $('export-json').addEventListener('click', () => {
      const entry = current();
      if (!entry) return;
      const blob = new Blob([JSON.stringify(RideStore.exportJson(entry.raw))], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (entry.raw.name || 'race').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('uncrop').addEventListener('click', () => { const e = current(); if (e) uncrop(e); });
  }

  function syncRailFromSettings() {
    const s = Settings.all();
    for (const [key, spec] of Object.entries(RAIL)) {
      const input = $('in-' + key), val = $('v-' + key);
      if (!input || s[key] == null) continue;
      input.value = s[key];
      val.textContent = spec.fmt(Number(s[key]));
    }
  }

  function syncFitnessRail(entry) {
    if (!entry || !entry.A) return;
    const cfg = entry.A.cfg;
    const put = (key, v) => { const i = $('in-' + key); if (!i) return; i.value = v; $('v-' + key).textContent = RAIL[key].fmt(v); };
    put('ftp', cfg.ftp); put('cp', cfg.cp); put('wPrime', cfg.wPrime);
    const src = cfg.fitnessSource;
    const word = { you: 'yours', file: 'from the activity', default: 'default' };
    $('src-ftp').textContent = '· ' + word[src.ftp];
    $('src-cp').textContent = '· ' + word[src.cp];
    $('src-wPrime').textContent = '· ' + word[src.wPrime];
    $('fitness-reset').style.display = (src.ftp === 'you' || src.cp === 'you' || src.wPrime === 'you') ? '' : 'none';
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  function bindTabs() {
    $('tabbar').addEventListener('click', e => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      document.querySelectorAll('#tabbar .tab').forEach(t => t.classList.toggle('active', t === btn));
      document.querySelectorAll('#panels .panel').forEach(p => p.classList.toggle('active', p.dataset.panelId === btn.dataset.tab));
      if (btn.dataset.tab !== 'replay') stopReplay();
      renderActivePanel();
    });
    document.querySelectorAll('.mobile-tab').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.mobile-tab').forEach(t => t.classList.toggle('active', t === b));
      $('app-wrap').dataset.panel = b.dataset.mpanel;
      if (b.dataset.mpanel === 'analysis') renderActivePanel();
    }));
    document.querySelectorAll('[data-fm]').forEach(b => b.addEventListener('click', () => {
      state.featureMetric = b.dataset.fm;
      document.querySelectorAll('[data-fm]').forEach(x => x.classList.toggle('active', x === b));
      renderActivePanel();
    }));
    document.querySelectorAll('[data-cmp]').forEach(b => b.addEventListener('click', () => {
      state.cmpMetric = b.dataset.cmp;
      document.querySelectorAll('[data-cmp]').forEach(x => x.classList.toggle('active', x === b));
      renderActivePanel();
    }));
  }

  function activeTab() {
    const t = document.querySelector('#tabbar .tab.active');
    return t ? t.dataset.tab : 'overview';
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  function bindLoaders() {
    const dz = $('dropzone'), fi = $('file-input');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('is-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('is-over'); handleFiles(e.dataTransfer.files); });
    fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });

    $('demo-btn').addEventListener('click', () => loadRaw(Demo.build()));
    $('icu-open-settings').addEventListener('click', () => window.dispatchEvent(new CustomEvent('crosslab:open-settings')));
    $('icu-fetch').addEventListener('click', fetchIcuList);
    $('icu-range-90').addEventListener('click', () => { initDates(90); fetchIcuList(); });
    $('icu-range-season').addEventListener('click', () => {
      // The cross season runs September to February; pick the one we are in or just finished.
      const now = new Date();
      const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
      $('icu-from').value = y + '-08-15';
      $('icu-to').value = now.toISOString().slice(0, 10);
      fetchIcuList();
    });
    $('icu-search').addEventListener('input', () => { state.icu.search = $('icu-search').value; renderIcuResults(); });
    $('icu-id-load').addEventListener('click', loadIcuById);
    $('icu-id').addEventListener('keydown', e => { if (e.key === 'Enter') loadIcuById(); });
  }

  async function handleFiles(files) {
    for (const f of Array.from(files || [])) {
      try {
        if (/\.fit$/i.test(f.name)) {
          const buf = await f.arrayBuffer();
          await loadRaw(Fit.parse(buf, f.name));
        } else if (/\.json$/i.test(f.name)) {
          const json = JSON.parse(await f.text());
          await loadRaw(RideStore.fromJson(json, f.name));
        } else {
          alert('Not a .fit or .json file: ' + f.name);
        }
      } catch (err) {
        console.error(err);
      }
    }
  }

  function initDates(days = 45) {
    const to = new Date(), from = new Date(Date.now() - days * 86400000);
    $('icu-from').value = from.toISOString().slice(0, 10);
    $('icu-to').value = to.toISOString().slice(0, 10);
  }

  async function fetchIcuList() {
    const key = Settings.get('icuKey');
    const out = $('icu-results');
    if (!key) {
      out.innerHTML = '<div class="status status-warn">Add an intervals.icu API key first (the Key button above).</div>';
      return;
    }
    out.innerHTML = '<div class="status status-info">Fetching activities…</div>';
    try {
      const list = await Intervals.listActivities({
        key, athleteId: Settings.get('icuAthlete') || '0',
        oldest: $('icu-from').value, newest: $('icu-to').value,
      });
      state.icu.skipped = list.filter(a => !a.type || a.apiBlocked);
      state.icu.activities = list.filter(a => Intervals.isRide(a) && !a.apiBlocked);
      state.icu.filters.tags = new Set();
      $('icu-filters').style.display = '';
      renderIcuChips();
      renderIcuResults();
    } catch (err) {
      out.innerHTML = '<div class="status status-err">' + Charts.esc(err.message || err) + '</div>';
    }
  }

  function renderIcuChips() {
    const wrap = $('icu-chips');
    wrap.innerHTML = '';
    const acts = state.icu.activities;
    const defs = [
      { key: 'race', label: 'races', n: acts.filter(a => a.isRace).length },
      { key: 'cross', label: 'looks like cross', n: acts.filter(a => Intervals.looksCross(a)).length },
      { key: 'gps', label: 'with GPS', n: acts.filter(a => a.hasGpsStream).length },
    ];
    for (const d of defs) {
      const b = document.createElement('button');
      b.className = 'chip' + (state.icu.filters[d.key] ? ' on' : '');
      b.innerHTML = Charts.esc(d.label) + '<span class="chip-count">' + d.n + '</span>';
      b.addEventListener('click', () => { state.icu.filters[d.key] = !state.icu.filters[d.key]; renderIcuChips(); renderIcuResults(); });
      wrap.appendChild(b);
    }
    for (const { tag, count } of Intervals.tagsIn(acts).slice(0, 8)) {
      const b = document.createElement('button');
      b.className = 'chip' + (state.icu.filters.tags.has(tag) ? ' on' : '');
      b.innerHTML = Charts.esc(tag) + '<span class="chip-count">' + count + '</span>';
      b.addEventListener('click', () => {
        const t = state.icu.filters.tags;
        if (t.has(tag)) t.delete(tag); else t.add(tag);
        renderIcuChips(); renderIcuResults();
      });
      wrap.appendChild(b);
    }
  }

  function filteredIcu() {
    const f = state.icu.filters, q = state.icu.search.trim().toLowerCase();
    return state.icu.activities.filter(a => {
      if (f.race && !a.isRace) return false;
      if (f.cross && !Intervals.looksCross(a)) return false;
      if (f.gps && !a.hasGpsStream) return false;
      if (f.tags.size && !(a.tags || []).some(t => f.tags.has(t))) return false;
      if (q && !String(a.name).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderIcuResults() {
    const out = $('icu-results');
    const key = Settings.get('icuKey');
    const rides = filteredIcu();
    const total = state.icu.activities.length;
    if (!total) { out.innerHTML = '<div class="status status-warn">No rides in that window.</div>'; return; }
    if (!rides.length) {
      out.innerHTML = '<div class="status status-warn">Nothing matches. Loosen the filters above — ' + total + ' rides were found.</div>';
      return;
    }
    out.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'hint';
    head.style.margin = '2px 0 6px';
    head.textContent = rides.length + ' of ' + total + ' rides';
    out.appendChild(head);

    const skipped = state.icu.skipped || [];
    if (skipped.length) {
      const warn = document.createElement('div');
      warn.className = 'status status-warn';
      warn.style.marginBottom = '6px';
      const strava = skipped.filter(a => a.apiBlocked);
      const dates = skipped.map(a => (a.start || '').slice(0, 10)).join(', ');
      warn.innerHTML = strava.length
        ? '<b>' + strava.length + ' activit' + (strava.length === 1 ? 'y' : 'ies') + ' came from Strava</b> (' + dates +
          ') and cannot be read through the intervals.icu API. Upload the .fit to intervals.icu directly, or drag it into CrossLab.'
        : skipped.length + ' entr' + (skipped.length === 1 ? 'y' : 'ies') + ' on intervals.icu ' + (skipped.length === 1 ? 'has' : 'have') +
          ' no activity type — usually an incomplete sync. ' + dates + '.';
      out.appendChild(warn);
    }

    for (const a of rides) {
      const row = document.createElement('div');
      row.className = 'ride-item';
      const warn = [];
      if (!a.hasGpsStream) warn.push('no GPS');
      if (!a.hasPowerStream && !a.hasPower) warn.push('no power');
      row.innerHTML =
        '<span class="ride-swatch"></span>' +
        '<span class="ride-body"><span class="ride-name">' +
        (a.isRace ? '<span class="ride-badge">race</span>' : '') +
        (Intervals.looksCross(a) ? '<span class="ride-badge">cx</span>' : '') +
        Charts.esc(a.name) + '</span>' +
        '<span class="ride-meta">' + (a.start || '').slice(0, 10) + ' · ' +
        Charts.fmtClock(a.movingTime || 0) + ' · ' + (a.distance ? (a.distance / 1000).toFixed(1) + ' km' : '') +
        (warn.length ? ' · <span class="ride-warn">' + warn.join(', ') + '</span>' : '') +
        '</span></span>';
      row.addEventListener('click', async () => {
        const note = document.createElement('div');
        note.className = 'status status-info';
        note.textContent = 'Downloading streams…';
        out.replaceChildren(note);
        try {
          await loadRaw(await Intervals.loadRide(a.id, key), { quiet: true });
          note.className = 'status status-ok';
          note.textContent = 'Loaded “' + a.name + '”.';
        } catch (err) {
          note.className = 'status status-err';
          note.textContent = String(err.message || err);
        }
      });
      out.appendChild(row);
    }
  }

  function parseActivityRef(input) {
    const s = String(input || '').trim();
    const m = s.match(/activities\/(i?\d+)/) || s.match(/^(i?\d+)$/);
    return m ? m[1] : null;
  }

  async function loadIcuById() {
    const id = parseActivityRef($('icu-id').value);
    const st = $('icu-id-status');
    const key = Settings.get('icuKey');
    if (!key) { st.innerHTML = '<div class="status status-warn">Add an API key first.</div>'; return; }
    if (!id) { st.innerHTML = '<div class="status status-err">That does not look like an activity ID or URL.</div>'; return; }
    st.innerHTML = '<div class="status status-info">Downloading…</div>';
    try {
      await loadRaw(await Intervals.loadRide(id, key), { quiet: true });
      st.innerHTML = '<div class="status status-ok">Loaded.</div>';
    } catch (err) {
      st.innerHTML = '<div class="status status-err">' + Charts.esc(err.message || err) + '</div>';
    }
  }

  async function refreshFromIcu(entry, btn) {
    const key = Settings.get('icuKey');
    if (!key) { alert('Add an intervals.icu API key first.'); return; }
    btn.disabled = true;
    try {
      const fresh = await Intervals.loadRide(entry.raw.sourceId, key);
      fresh.id = entry.raw.id;
      fresh.features = entry.raw.features || [];
      if (entry.raw.startAnchor) fresh.startAnchor = entry.raw.startAnchor;
      entry.raw = fresh;
      entry.P = null; entry.A = null; entry.wx = null; entry.wxError = null;
      await RideStore.put(fresh);
      await select(entry.id);
    } catch (err) {
      alert(String(err.message || err));
    } finally {
      btn.disabled = false;
    }
  }

  // ── Course tools: feature placement and the start line ────────────────────

  function fillFeatureTypes() {
    const sel = $('feature-type');
    sel.innerHTML = Object.entries(Analyzer.FEATURE_TYPES)
      .map(([k, t]) => '<option value="' + k + '">' + Charts.esc(t.label) + '</option>').join('');
  }

  function bindCourseTools() {
    $('add-feature').addEventListener('click', () => {
      const entry = current();
      if (!entry || !entry.A || !entry.A.meanLap) { alert('Place features once laps have been found.'); return; }
      state.picking = state.picking && state.picking.what === 'feature'
        ? null : { what: 'feature', type: $('feature-type').value, entry: null };
      renderCoursePanel();
    });
    $('pick-start').addEventListener('click', () => {
      const entry = current();
      if (!entry || !entry.P || !entry.P.hasGps) return;
      state.picking = state.picking && state.picking.what === 'start' ? null : { what: 'start' };
      renderCoursePanel();
    });
    $('reset-start').addEventListener('click', async () => {
      const entry = current();
      if (!entry) return;
      entry.raw.startAnchor = null;
      state.picking = null;
      try { await RideStore.put(entry.raw); } catch (_) {}
      recompute();
    });
    $('copy-features').addEventListener('click', () => copyFeaturesPrompt());
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.picking) { state.picking = null; renderCoursePanel(); }
    });
  }

  async function onMapPick(entry, hit) {
    const pk = state.picking;
    if (!pk) return;
    if (pk.what === 'start') {
      entry.raw.startAnchor = { lat: hit.lat, lon: hit.lon };
      state.picking = null;
      try { await RideStore.put(entry.raw); } catch (_) {}
      recompute();
      const A = entry.A;
      if (A && A.lapBounds && A.lapBounds[0] && A.lapBounds[0].source !== 'manual') {
        alert('That point does not work as a start/finish line — the ride does not pass it often enough, or the laps it produces are inconsistent. Try a point on the main course that you crossed every lap.');
        entry.raw.startAnchor = null;
        try { await RideStore.put(entry.raw); } catch (_) {}
        recompute();
      }
      return;
    }
    if (pk.what === 'feature') {
      if (hit.j < 0) { alert('Click on the course itself (the coloured line).'); return; }
      if (!pk.entry) { pk.entry = { j: hit.j, lat: hit.lat, lon: hit.lon }; renderCoursePanel(); return; }
      const type = Analyzer.FEATURE_TYPES[pk.type] || Analyzer.FEATURE_TYPES.custom;
      const n = (entry.raw.features || []).filter(f => f.type === pk.type).length;
      const f = {
        id: 'f-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: pk.type, label: type.label + (n ? ' ' + (n + 1) : ''),
        entry: { lat: pk.entry.lat, lon: pk.entry.lon },
        exit: { lat: hit.lat, lon: hit.lon },
      };
      entry.raw.features = (entry.raw.features || []).concat([f]);
      state.picking = null;
      state.activeFeature = f.id;
      try { await RideStore.put(entry.raw); } catch (_) {}
      recompute();
    }
  }

  async function addSuggested(entry, sg) {
    const type = Analyzer.FEATURE_TYPES[sg.type] || Analyzer.FEATURE_TYPES.custom;
    const n = (entry.raw.features || []).filter(f => f.type === sg.type).length;
    entry.raw.features = (entry.raw.features || []).concat([{
      id: 'f-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: sg.type, label: type.label + (n ? ' ' + (n + 1) : ''),
      entry: { ...sg.entry }, exit: { ...sg.exit },
    }]);
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  async function updateFeature(entry, id, patch) {
    const f = (entry.raw.features || []).find(x => x.id === id);
    if (!f) return;
    Object.assign(f, patch);
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  async function nudgeFeature(entry, id, end, metres) {
    // Move one end of a feature along the mean lap by a few metres.
    const A = entry.A, ml = A && A.meanLap;
    const f = (entry.raw.features || []).find(x => x.id === id);
    if (!f || !ml) return;
    const cur = Analyzer.nearestMeanIndex(ml, f[end].lat, f[end].lon).j;
    const j = ((cur + Math.round(metres / ml.step)) % ml.n + ml.n) % ml.n;
    f[end] = { lat: ml.lat[j], lon: ml.lon[j] };
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  async function removeFeature(entry, id) {
    entry.raw.features = (entry.raw.features || []).filter(x => x.id !== id);
    if (state.activeFeature === id) state.activeFeature = null;
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  /** Other loaded races on the same course that have features to copy. */
  function featureDonors(entry) {
    if (!entry.A || !entry.A.circuit) return [];
    return state.races.filter(r => r !== entry && r.raw.features && r.raw.features.length)
      .map(r => {
        if (!r.A) { try { if (!r.P) r.P = RideStore.prepare(r.raw); analyse(r); } catch (_) { return null; } }
        return r.A && Analyzer.sameCircuit(entry.A.circuit, r.A.circuit) ? r : null;
      }).filter(Boolean);
  }

  async function copyFeaturesPrompt() {
    const entry = current();
    if (!entry) return;
    const donors = featureDonors(entry);
    if (!donors.length) return;
    const names = donors.map((d, i) => (i + 1) + '. ' + d.raw.name + ' (' + d.raw.features.length + ' features)').join('\n');
    const pick = donors.length === 1 ? '1' : prompt('Copy features from which race?\n' + names, '1');
    const d = donors[parseInt(pick, 10) - 1];
    if (!d) return;
    entry.raw.features = (entry.raw.features || []).concat(d.raw.features.map(f => ({
      ...f, id: 'f-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      entry: { ...f.entry }, exit: { ...f.exit },
    })));
    try { await RideStore.put(entry.raw); } catch (_) {}
    recompute();
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  function bindReplay() {
    $('rp-play').addEventListener('click', () => state.replay.timer ? stopReplay() : startReplay());
    $('rp-scrub').addEventListener('input', () => {
      const entry = current();
      if (!entry || !entry.P) return;
      state.replay.idx = Math.round(parseInt($('rp-scrub').value, 10) / 1000 * (entry.P.n - 1));
      drawReplay();
    });
  }

  function startReplay() {
    const entry = current();
    if (!entry || !entry.P) return;
    $('rp-play').textContent = '❚❚ Pause';
    const speed = parseInt($('rp-speed').value, 10);
    state.replay.timer = setInterval(() => {
      state.replay.idx = Math.min(entry.P.n - 1, state.replay.idx + speed / 10);
      if (state.replay.idx >= entry.P.n - 1) stopReplay();
      drawReplay();
    }, 100);
  }

  function stopReplay() {
    if (state.replay.timer) clearInterval(state.replay.timer);
    state.replay.timer = null;
    const b = $('rp-play');
    if (b) b.textContent = '▶ Play';
  }

  function drawReplay() {
    const entry = current();
    if (!entry || !entry.A) return;
    const P = entry.P, A = entry.A;
    const idx = Math.max(0, Math.min(P.n - 1, Math.round(state.replay.idx)));
    Charts.replayFrame($('rp-map'), $('rp-strip'), P, A, idx, { osm: basemap(entry), height: 360 });
    $('rp-scrub').value = Math.round(idx / (P.n - 1) * 1000);
    $('rp-clock').textContent = Charts.fmtClock(P.t[idx]);
    const lap = A.laps.find(l => idx >= l.i0 && idx <= l.i1);
    const ml = A.meanLap;
    let where = '';
    if (lap && ml && A.aligned) {
      const al = A.aligned[lap.lap - 1];
      let j = 0; while (j < ml.n - 1 && al.idxAt[j + 1] <= idx) j++;
      const f = A.features.find(ff => ff.j0 >= 0 && j >= ff.j0 && j <= ff.j1);
      where = Charts.fmtKm(ml.s[j]) + ' km into lap ' + lap.lap + (f ? ' · ' + f.label : '');
    }
    $('rp-sub').textContent = where;
    $('rp-stats').innerHTML =
      stat((P.v[idx] * 3.6).toFixed(1), 'km/h', 'speed') +
      (P.hasPower ? stat(Math.round(P.watts[idx]), 'W', 'power') : '') +
      (P.hasHr ? stat(Math.round(P.hr[idx]), 'bpm', 'heart rate') : '') +
      (P.hasCad ? stat(Math.round(P.cad[idx]), 'rpm', 'cadence') : '') +
      (lap ? stat(Charts.fmtClock(P.t[idx] - P.t[lap.i0]), '', 'into the lap') : '');
  }

  // ── Window events ─────────────────────────────────────────────────────────

  function bindWindow() {
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(renderActivePanel, 120); });
    window.addEventListener('crosslab:settings', async e => {
      const d = e.detail || {};
      if (d.cleared) { state.races = []; state.currentId = null; renderRaceList(); renderEmpty(); return; }
      if (d.osm) { const entry = current(); if (entry) { entry.osm = null; entry.osmError = null; await ensureOsm(entry); } }
      recompute();
    });
  }

  function setBusy(on, msg) {
    state.busy = on;
    const o = $('busy-overlay');
    if (!o) return;
    o.hidden = !on;
    if (msg) $('busy-msg').textContent = msg;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderEmpty() {
    $('stat-row').innerHTML = '';
    $('findings').innerHTML = '<p class="hint">Load a race from a .fit file, from intervals.icu, or try the sample race. ' +
      'Then open the Course tab and mark where the barriers, run-ups and sand are.</p>';
    $('findings-sub').textContent = '';
    $('crop-prompt').innerHTML = '';
    $('race-readout').textContent = '—';
    $('wx-readout').textContent = 'No race loaded.';
  }

  function renderRaceList() {
    const list = $('race-list');
    $('race-count').textContent = state.races.length ? state.races.length + ' loaded' : '';
    if (!state.races.length) { list.innerHTML = '<div class="list-empty">No races yet</div>'; return; }
    list.innerHTML = '';
    for (const r of state.races) {
      const row = document.createElement('div');
      row.className = 'ride-item' + (r.id === state.currentId ? ' active' : '');
      const secs = r.P ? r.P.t[r.P.n - 1] : (r.raw.totals && r.raw.totals.elapsed) || 0;
      const date = r.raw.startTime ? new Date(r.raw.startTime * 1000).toISOString().slice(0, 10) : '—';
      const nf = (r.raw.features || []).length;
      row.innerHTML =
        '<span class="ride-swatch"></span>' +
        '<span class="ride-body"><span class="ride-name">' + Charts.esc(r.raw.name) + '</span>' +
        '<span class="ride-meta">' + date + ' · ' + Charts.fmtClock(secs) + ' · ' + Charts.esc(sourceLabel(r.raw.source)) +
        (nf ? ' · ' + nf + ' feature' + (nf === 1 ? '' : 's') : '') + '</span></span>';

      const cmp = document.createElement('input');
      cmp.type = 'checkbox'; cmp.className = 'ride-cmp'; cmp.checked = r.compare; cmp.title = 'Include in Compare';
      cmp.addEventListener('click', e => e.stopPropagation());
      cmp.addEventListener('change', () => { r.compare = cmp.checked; if (activeTab() === 'compare') renderActivePanel(); });

      if (r.raw.source === 'icu' && r.raw.sourceId) {
        const ref = document.createElement('button');
        ref.className = 'ride-refresh'; ref.innerHTML = '↻'; ref.title = 'Re-download this activity from intervals.icu';
        ref.addEventListener('click', e => { e.stopPropagation(); refreshFromIcu(r, ref); });
        row.appendChild(ref);
      }
      const del = document.createElement('button');
      del.className = 'ride-del'; del.innerHTML = '&times;'; del.title = 'Remove';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        try { await RideStore.remove(r.id); } catch (_) {}
        state.races = state.races.filter(x => x !== r);
        if (state.currentId === r.id) {
          state.currentId = state.races.length ? state.races[0].id : null;
          if (state.currentId) await select(state.currentId); else renderEmpty();
        }
        renderRaceList();
      });
      row.appendChild(cmp);
      row.appendChild(del);
      row.addEventListener('click', () => select(r.id));
      list.appendChild(row);
    }
  }

  function sourceLabel(s) {
    return { fit: '.fit', icu: 'intervals.icu', json: 'json', demo: 'sample' }[s] || s || 'file';
  }

  function renderAll() {
    const entry = current();
    renderCropPrompt();
    syncFitnessRail(entry);
    renderConditions();
    renderRaceReadout();
    renderStats();
    renderFindings();
    renderRaceList();
    renderActivePanel();
  }

  function renderCropPrompt() {
    const entry = current();
    const box = $('crop-prompt');
    if (!entry || !entry.A) { box.innerHTML = ''; return; }
    const P = entry.P;
    if (entry.raw.crop) {
      const dropped = P.croppedFrom - P.n;
      box.innerHTML =
        '<div class="crop-prompt crop-active"><div class="crop-prompt-title">Trimmed to the race</div>' +
        '<p>' + Charts.fmtClock(dropped) + ' of the recording is excluded — pre-ride, staging and cool-down. ' +
        'Every number here is measured on the racing alone.</p>' +
        '<div class="btn-row"><button class="btn btn-sm" id="crop-undo">Back to the full recording</button></div></div>';
      $('crop-undo').addEventListener('click', () => uncrop(entry));
      $('uncrop').style.display = '';
      return;
    }
    $('uncrop').style.display = 'none';
    const win = entry.win;
    if (!win || !win.found) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<div class="crop-prompt"><div class="crop-prompt-title">This file contains more than the race</div>' +
      '<p>' + win.keep.length + ' laps look like racing. ' +
      (win.preRide ? win.preRide + ' slower lap' + (win.preRide === 1 ? '' : 's') + ' before it (pre-ride' +
        (win.stagingSeconds > 60 ? ', then ' + Charts.fmtClock(win.stagingSeconds) + ' standing still on the grid' : '') + ')' : '') +
      (win.preRide && win.cooldown ? ' and ' : '') +
      (win.cooldown ? win.cooldown + ' slower lap' + (win.cooldown === 1 ? '' : 's') + ' after it (cool-down)' : '') +
      '. Trimming them keeps the pre-ride out of your worst-lap list and the fade analysis.</p>' +
      '<div class="chart-wrap"><canvas class="chart" id="crop-chart"></canvas></div>' +
      '<div class="btn-row" style="margin-top:8px"><button class="btn btn-sm btn-primary" id="crop-apply">Trim to the race</button>' +
      '<button class="btn btn-sm" id="crop-skip">Keep everything</button></div></div>';
    Charts.cropTimeline($('crop-chart'), P, win, { height: 110 });
    $('crop-apply').addEventListener('click', () => applyCrop(entry, win));
    $('crop-skip').addEventListener('click', () => { entry.win = null; box.innerHTML = ''; });
  }

  function renderConditions() {
    const entry = current();
    const el = $('wx-readout');
    if (!entry || !entry.P) { el.textContent = 'No race loaded.'; return; }
    if (!entry.wx) {
      el.className = 'status status-info';
      el.textContent = entry.wxError ? 'No weather: ' + entry.wxError
        : (Settings.get('wxAuto') ? 'No weather for this race.' : 'Weather fetching is off (settings).');
      return;
    }
    const P = entry.P;
    const s = Weather.summarise(entry.wx, P.startTime, P.startTime + P.t[P.n - 1]);
    // Rain in the 24 h before the start is what made the course what it was.
    let before = 0, k = 0;
    for (let t = P.startTime - 24 * 3600; t < P.startTime; t += 3600) {
      const h = Weather.at(entry.wx, t);
      if (h && isFinite(h.precip)) { before += h.precip; k++; }
    }
    const bits = [];
    if (s && isFinite(s.temp)) bits.push(s.temp.toFixed(0) + ' °C');
    if (s && isFinite(s.windSpeed)) bits.push('wind ' + s.windSpeed.toFixed(1) + ' m/s ' + Weather.compass(s.windDir));
    if (s && isFinite(s.precip)) bits.push((s.precip > 0.1 ? s.precip.toFixed(1) + ' mm' : 'dry') + ' during the race');
    if (k) bits.push(before.toFixed(1) + ' mm in the 24 h before');
    el.className = 'status status-info';
    el.textContent = bits.join(' · ') || 'Weather fetched.';
  }

  function renderRaceReadout() {
    const entry = current();
    if (!entry || !entry.A) return;
    const P = entry.P, S = entry.A.summary;
    const bits = [];
    bits.push(Charts.esc(entry.raw.name));
    if (entry.raw.startTime) bits.push(new Date(entry.raw.startTime * 1000).toLocaleString());
    bits.push((P.dist[P.n - 1] / 1000).toFixed(1) + ' km · ' + Charts.fmtClock(P.t[P.n - 1]));
    bits.push([P.hasPower ? 'power' : null, P.hasHr ? 'HR' : null, P.hasCad ? 'cadence' : null].filter(Boolean).join(', ') || 'speed and GPS only');
    if (P.subSport === 'cyclocross') bits.push('recorded as cyclocross');
    if (entry.A.circuit) bits.push('lap ' + (entry.A.circuit.lapLen / 1000).toFixed(2) + ' km');
    $('race-readout').innerHTML = bits.join('<br>');
  }

  function stat(val, unit, lbl, sub) {
    return '<div class="stat"><div class="stat-val">' + val + (unit ? '<span class="unit">' + unit + '</span>' : '') +
      '</div><div class="stat-label">' + lbl + '</div>' + (sub ? '<div class="stat-sub">' + sub + '</div>' : '') + '</div>';
  }

  function renderStats() {
    const entry = current();
    if (!entry || !entry.A) return;
    const S = entry.A.summary, sh = entry.A.shape;
    const out = [];
    out.push(stat(S.laps || '—', '', 'laps', S.lapSource === 'manual' ? 'from your start line' : S.lapSource === 'device' ? 'from lap presses' : S.lapSource === 'gps' ? 'detected from GPS' : 'none found'));
    out.push(stat(Charts.fmtClock(S.bestLapSeconds), '', 'best lap', S.bestLap ? 'lap ' + S.bestLap : ''));
    out.push(stat(Charts.fmtClock(S.medianLap), '', 'median lap', sh.kind === 'faded' ? 'faded ' + sh.drift.toFixed(0) + ' s/lap' : sh.kind === 'built' ? 'built ' + (-sh.drift).toFixed(0) + ' s/lap' : 'held'));
    out.push(stat(S.lostVsBest.toFixed(0), 's', 'left on the table', S.features ? 'across ' + S.features + ' feature' + (S.features === 1 ? '' : 's') : 'no features placed'));
    out.push(stat(Charts.fmtClock(S.onFoot), '', 'on foot', S.seconds ? Math.round(S.onFoot / S.seconds * 100) + '% of the race' : ''));
    out.push(stat(S.bobbleCost.toFixed(0), 's', 'unplanned stops', S.bobbles ? S.bobbles + ' of them' : 'none'));
    if (S.hasPower && entry.A.power) out.push(stat(Math.round(entry.A.power.avg), 'W', 'average power', 'NP ' + Math.round(entry.A.power.np) + ' W'));
    if (S.hasHr) out.push(stat(Math.round(S.avgHr), 'bpm', 'average HR'));
    $('stat-row').innerHTML = out.join('');
  }

  function renderFindings() {
    const entry = current();
    if (!entry || !entry.A) return;
    const F = entry.A.findings;
    const color = { serious: 'var(--st-critical)', warn: 'var(--st-warn)', info: 'var(--accent)' };
    $('findings').innerHTML = F.length
      ? F.map(o =>
          '<div class="finding"' + (o.feature ? ' data-feature="' + o.feature + '"' : '') + '>' +
          '<span class="finding-mark" style="background:' + (color[o.severity] || color.info) + '"></span>' +
          '<div><div class="finding-title">' + Charts.esc(o.title) + '</div>' +
          '<div class="hint finding-body">' + Charts.esc(o.body) + '</div></div></div>'
        ).join('')
      : '<p class="hint">Nothing stood out in this race.</p>';
    $('findings-sub').textContent = entry.raw.startTime ? new Date(entry.raw.startTime * 1000).toLocaleString() : '';
    document.querySelectorAll('#findings .finding[data-feature]').forEach(el => {
      el.style.cursor = 'pointer';
      el.title = 'Open this feature';
      el.addEventListener('click', () => { state.activeFeature = el.dataset.feature; switchTab('features'); });
    });
  }

  function switchTab(name) {
    const btn = document.querySelector('#tabbar .tab[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  function key(color, text, shape) {
    return '<span class="legend-item"><span class="legend-key' + (shape ? ' ' + shape : '') + '" style="background:' + color +
      (shape === 'dash' ? ';color:' + color : '') + '"></span>' + Charts.esc(text) + '</span>';
  }

  function lapLegend(A) {
    return A.laps.map(l => key(Charts.lapColor(l.lap), 'lap ' + l.lap + (A.delta && l.lap === A.delta.bestLap ? ' (best, dashed)' : ''), 'line')).join('');
  }

  function deltaLegend(canvas) {
    const sc = canvas._clScale || { halfSpan: 2 };
    return '<span class="legend-item">' +
      Charts.deltaLegendStops(sc.halfSpan).map(s => '<span class="legend-key" style="background:' + s.color + '" title="' + s.d.toFixed(1) + ' s"></span>').join('') +
      ' faster ← vs your median → slower (±' + sc.halfSpan.toFixed(0) + ' s)</span>';
  }

  function renderActivePanel() {
    const entry = current();
    if (!entry || !entry.A) return;
    const P = entry.P, A = entry.A;

    switch (activeTab()) {
      case 'overview':
        Charts.deltaTrace($('ov-delta'), A, { height: 280 });
        $('ov-legend').innerHTML = lapLegend(A);
        $('overview-name').textContent = A.delta ? 'measured against lap ' + A.delta.bestLap : '';
        break;

      case 'course':
        renderCoursePanel();
        break;

      case 'features': {
        Charts.featureBars($('feature-bars'), A, state.featureMetric);
        const placed = A.features.filter(f => f.j0 >= 0 && !f.offCourse);
        if (!state.activeFeature && placed.length) state.activeFeature = placed.slice().sort((a, b) => b.lostVsBest - a.lostVsBest)[0].id;
        const f = placed.find(x => x.id === state.activeFeature);
        Charts.featureLaps($('feature-laps'), A, state.activeFeature, { height: 200 });
        $('feature-detail-title').textContent = f ? f.label + ', lap by lap' : 'Lap by lap';
        $('feature-detail-sub').textContent = f ? 'bars coloured by seconds over your best pass' : '';
        $('feature-legend').innerHTML = placed.map(f => key(f.color, f.label)).join('');
        renderFeatureTable(A);
        break;
      }

      case 'laps':
        Charts.lapBars($('lap-bars'), A);
        $('lapbars-legend').innerHTML = '<span class="legend-item">solid = riding · faded = inside features · dotted line = best lap</span>';
        $('lap-source').textContent = A.summary.lapSource === 'device' ? 'from lap-button presses'
          : A.summary.lapSource === 'gps' ? 'detected from GPS' : A.summary.lapSource === 'manual' ? 'from your start line' : 'no laps found';
        Charts.sectorHeatmap($('heatmap'), A);
        $('heat-legend').innerHTML = deltaLegend($('heatmap'));
        renderLapTable(A);
        break;

      case 'trace': {
        const seg = $('trace-laps');
        seg.innerHTML = '<button data-lap="all"' + (state.traceLap ? '' : ' class="active"') + '>All</button>' +
          A.laps.map(l => '<button data-lap="' + l.lap + '"' + (state.traceLap === l.lap ? ' class="active"' : '') +
            ' style="color:' + Charts.lapColor(l.lap) + '">' + l.lap + '</button>').join('');
        seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
          state.traceLap = b.dataset.lap === 'all' ? null : parseInt(b.dataset.lap, 10);
          renderActivePanel();
        }));
        Charts.deltaTrace($('tr-delta'), A, { height: 320, onlyLap: state.traceLap });
        Charts.speedTrace($('tr-speed'), A, { height: 240, onlyLap: state.traceLap, runSpeed: A.cfg.runSpeed });
        $('tr-legend').innerHTML = lapLegend(A);
        break;
      }

      case 'power':
        renderPowerPanel(P, A);
        break;

      case 'replay':
        drawReplay();
        break;

      case 'compare':
        renderCompare();
        break;
    }
  }

  function renderCoursePanel() {
    const entry = current();
    if (!entry || !entry.A) return;
    const P = entry.P, A = entry.A;
    const pk = state.picking;

    Charts.courseMap($('map-main'), P, A, {
      height: 440,
      osm: basemap(entry),
      onPick: pk ? hit => onMapPick(entry, hit) : null,
      pending: pk && pk.what === 'feature' ? pk.entry : null,
      activeFeature: state.activeFeature,
    });

    $('add-feature').textContent = pk && pk.what === 'feature' ? 'Cancel placing' : 'Place a feature';
    $('pick-start').textContent = pk && pk.what === 'start' ? 'Cancel' : (entry.raw.startAnchor ? 'Move start/finish line' : 'Set start/finish line');
    $('reset-start').style.display = entry.raw.startAnchor ? '' : 'none';
    const donors = featureDonors(entry);
    $('copy-features').style.display = donors.length ? '' : 'none';
    if (donors.length) $('copy-features').textContent = 'Copy features from ' + (donors.length === 1 ? '“' + Charts.shorten(donors[0].raw.name, 28) + '”' : 'another race');

    const hint = $('pick-hint');
    if (pk && pk.what === 'start') {
      hint.style.display = '';
      hint.textContent = 'Click the point on the course where the start/finish line is. Laps and sectors are measured from there.';
    } else if (pk && pk.what === 'feature') {
      hint.style.display = '';
      const t = Analyzer.FEATURE_TYPES[pk.type].label;
      hint.textContent = pk.entry
        ? 'Now click where the ' + t.toLowerCase() + ' zone ends — where you are back up to speed. Esc to cancel.'
        : 'Click where the ' + t.toLowerCase() + ' zone starts — a few metres before you brake for it. Esc to cancel.';
    } else {
      hint.style.display = 'none';
    }

    // Legend.
    const medV = Charts.medianSpeedAlong(A);
    let lg = '';
    if (medV) {
      const sorted = Array.from(medV).filter(isFinite).sort((a, b) => a - b);
      const lo = Physics.percentile(sorted, 0.05), hi = Physics.percentile(sorted, 0.95);
      lg += '<span class="legend-item">' + [0, 0.25, 0.5, 0.75, 1].map(f =>
        '<span class="legend-key" style="background:' + Charts.speedColor(lo + (hi - lo) * f, lo, hi) + '"></span>').join('') +
        ' ' + (lo * 3.6).toFixed(0) + ' → ' + (hi * 3.6).toFixed(0) + ' km/h, median over laps</span>';
    }
    lg += key('#fab219', 'unplanned stop (×)') + key(Charts.INK.text, 'start/finish', 'line');
    if (A.suggestions.length) lg += key(Charts.INK.surface2, '? suggested dismount zone');
    $('map-legend').innerHTML = lg;
    $('map-sub').textContent = A.meanLap
      ? 'median lap of ' + A.laps.length + ' · ' + (A.meanLap.lapLen / 1000).toFixed(2) + ' km' +
        (A.lapBounds[0].source === 'manual' ? ' · start line placed by you' : '')
      : 'no laps found — the whole track is shown';

    renderFeatureList(entry, A);
    renderSuggestions(entry, A);
    renderBobbles(A);
  }

  function renderFeatureList(entry, A) {
    const el = $('feature-list');
    const feats = A.features;
    $('feature-count').textContent = feats.length ? feats.length + ' placed' : '';
    if (!feats.length) {
      el.innerHTML = '<div class="table-empty">No features yet. Pick a type above and click <b>Place a feature</b>, or accept a suggestion below.</div>';
      return;
    }
    const rows = feats.map((f, k) => {
      const t = Analyzer.FEATURE_TYPES[f.type] || Analyzer.FEATURE_TYPES.custom;
      const typeSel = '<select data-fid="' + f.id + '" data-act="type" style="width:auto">' +
        Object.entries(Analyzer.FEATURE_TYPES).map(([key, tt]) => '<option value="' + key + '"' + (key === f.type ? ' selected' : '') + '>' + Charts.esc(tt.label) + '</option>').join('') + '</select>';
      const nudge = end => '<span class="nudge"><button class="btn btn-sm" data-fid="' + f.id + '" data-act="nudge" data-end="' + end + '" data-m="-6" title="6 m earlier">−</button>' +
        '<button class="btn btn-sm" data-fid="' + f.id + '" data-act="nudge" data-end="' + end + '" data-m="6" title="6 m later">+</button></span>';
      const status = f.offCourse ? '<span class="tag tag-warm">off the course</span>' : f.wraps ? '<span class="tag tag-mid">crosses the line</span>' : '';
      return '<tr' + (f.id === state.activeFeature ? ' class="active"' : '') + '>' +
        '<td><span class="pin-key" style="background:' + f.color + '">' + (k + 1) + '</span></td>' +
        '<td><input type="text" value="' + Charts.esc(f.label) + '" data-fid="' + f.id + '" data-act="label" style="width:130px"></td>' +
        '<td>' + typeSel + '</td>' +
        '<td class="dim">' + (f.j0 >= 0 ? Charts.fmtKm(A.meanLap.s[f.j0]) + ' km' : '—') + ' ' + nudge('entry') + '</td>' +
        '<td class="dim">' + (f.j0 >= 0 ? Math.round(f.metres) + ' m' : '—') + ' ' + nudge('exit') + '</td>' +
        '<td>' + (isFinite(f.median) ? f.median.toFixed(1) + ' s' : '—') + '</td>' +
        '<td>' + (isFinite(f.lostVsBest) ? f.lostVsBest.toFixed(1) + ' s' : '—') + '</td>' +
        '<td>' + status + '</td>' +
        '<td><button class="btn btn-sm" data-fid="' + f.id + '" data-act="remove" title="Remove">&times;</button></td></tr>';
    }).join('');
    el.innerHTML = '<table class="data"><thead><tr><th></th><th>Name</th><th>Type</th><th>Entry</th><th>Length</th><th>Typical</th><th>On the table</th><th></th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    el.querySelectorAll('[data-act="label"]').forEach(i => i.addEventListener('change', () => updateFeature(entry, i.dataset.fid, { label: i.value.trim() || 'Feature' })));
    el.querySelectorAll('[data-act="type"]').forEach(s => s.addEventListener('change', () => updateFeature(entry, s.dataset.fid, { type: s.value })));
    el.querySelectorAll('[data-act="nudge"]').forEach(b => b.addEventListener('click', () => nudgeFeature(entry, b.dataset.fid, b.dataset.end, parseFloat(b.dataset.m))));
    el.querySelectorAll('[data-act="remove"]').forEach(b => b.addEventListener('click', () => removeFeature(entry, b.dataset.fid)));
    el.querySelectorAll('tbody tr').forEach((tr, k) => tr.addEventListener('click', e => {
      if (e.target.closest('button,input,select')) return;
      state.activeFeature = feats[k].id;
      renderCoursePanel();
    }));
  }

  function renderSuggestions(entry, A) {
    const card = $('suggest-card');
    const sg = A.suggestions || [];
    if (!sg.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    $('suggest-list').innerHTML = '<table class="data"><thead><tr><th>Where</th><th>Looks like</th><th>Length</th><th>Typical speed</th><th>Gradient</th><th>No pedalling</th><th></th></tr></thead><tbody>' +
      sg.map((s, k) =>
        '<tr><td>' + Charts.fmtKm(s.s) + ' km into the lap</td>' +
        '<td>' + Charts.esc(Analyzer.FEATURE_TYPES[s.type].label) + '</td>' +
        '<td>' + Math.round(s.metres) + ' m</td>' +
        '<td>' + (s.medianV * 3.6).toFixed(1) + ' km/h</td>' +
        '<td>' + (s.grade * 100).toFixed(0) + '%</td>' +
        '<td>' + (isFinite(s.noCadShare) ? Math.round(s.noCadShare * 100) + '%' : '—') + '</td>' +
        '<td><button class="btn btn-sm btn-primary" data-k="' + k + '">Add</button></td></tr>').join('') +
      '</tbody></table>';
    $('suggest-list').querySelectorAll('button').forEach(b => b.addEventListener('click', () => addSuggested(entry, sg[parseInt(b.dataset.k, 10)])));
  }

  function renderBobbles(A) {
    const el = $('bobble-list');
    const B = A.bobbles || [];
    $('bobble-sub').textContent = B.length ? B.length + ' · ' + A.summary.bobbleCost.toFixed(0) + ' s in total' : 'none found';
    if (!B.length) { el.innerHTML = '<div class="table-empty">No unplanned stops outside the placed features.</div>'; return; }
    el.innerHTML = '<table class="data"><thead><tr><th>Lap</th><th>Where</th><th>Cost</th><th>Stopped</th><th>Episode</th></tr></thead><tbody>' +
      B.map(b => '<tr><td>' + b.lap + '</td><td>' + Charts.fmtKm(b.s) + ' km into the lap</td><td>' + b.cost.toFixed(1) + ' s</td>' +
        '<td>' + b.stopped.toFixed(0) + ' s</td><td class="dim">' + b.seconds.toFixed(0) + ' s below running pace</td></tr>').join('') +
      '</tbody></table>';
  }

  function renderFeatureTable(A) {
    const feats = A.features.filter(f => f.j0 >= 0 && !f.offCourse && f.n > 0);
    const el = $('feature-table');
    if (!feats.length) { el.innerHTML = '<div class="table-empty">No features placed.</div>'; return; }
    const kmh = v => isFinite(v) ? (v * 3.6).toFixed(1) : '—';
    el.innerHTML = '<table class="data"><thead><tr><th>Feature</th><th>Length</th><th>Typical</th><th>Best</th><th>Worst</th><th>Spread</th><th>On the table</th><th>Cost / pass</th><th>Approach km/h</th><th>Exit km/h</th><th>Recover</th><th>On foot</th>' +
      (A.summary.hasPower ? '<th>Power</th>' : '') + (A.summary.hasHr ? '<th>HR</th>' : '') + '<th>Verdict</th></tr></thead><tbody>' +
      feats.map(f => '<tr' + (f.id === state.activeFeature ? ' class="active"' : '') + ' data-fid="' + f.id + '">' +
        '<td><span class="pin-key" style="background:' + f.color + '"></span> ' + Charts.esc(f.label) + '</td>' +
        '<td class="dim">' + Math.round(f.metres) + ' m</td>' +
        '<td>' + f.median.toFixed(1) + ' s</td>' +
        '<td>' + f.best.toFixed(1) + ' s <span class="dim">L' + f.bestLap + '</span></td>' +
        '<td>' + f.worst.toFixed(1) + ' s <span class="dim">L' + f.worstLap + '</span></td>' +
        '<td>±' + f.sd.toFixed(1) + ' s</td>' +
        '<td>' + f.lostVsBest.toFixed(1) + ' s</td>' +
        '<td>' + (isFinite(f.medianCost) ? f.medianCost.toFixed(1) + ' s' : '—') + '</td>' +
        '<td>' + kmh(f.medianEntryV) + '</td><td>' + kmh(f.medianExitV) + '</td>' +
        '<td>' + (isFinite(f.medianRecover) ? f.medianRecover.toFixed(0) + ' s' : '—') + '</td>' +
        '<td>' + f.medianOnFoot.toFixed(1) + ' s</td>' +
        (A.summary.hasPower ? '<td>' + (isFinite(f.medianW) ? Math.round(f.medianW) + ' W' : '—') + '</td>' : '') +
        (A.summary.hasHr ? '<td>' + (isFinite(f.medianHr) ? Math.round(f.medianHr) : '—') + '</td>' : '') +
        '<td>' + verdictTag(f) + '</td></tr>').join('') +
      '</tbody></table>';
    el.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => { state.activeFeature = tr.dataset.fid; renderActivePanel(); }));
  }

  function verdictTag(f) {
    const map = {
      steady: ['tag-cool', 'steady'],
      'some-bad-laps': ['tag-warm', (f.badLaps || []).length + ' bad lap' + ((f.badLaps || []).length === 1 ? '' : 's')],
      erratic: ['tag-warm', 'erratic'],
      few: ['tag-mid', 'too few laps'],
    };
    const [cls, text] = map[f.verdict] || map.few;
    return '<span class="tag ' + cls + '">' + text + '</span>';
  }

  function renderLapTable(A) {
    const el = $('lap-table');
    const rows = A.laps;
    if (!rows.length) { el.innerHTML = '<div class="table-empty">No laps.</div>'; return; }
    el.innerHTML = '<table class="data"><thead><tr><th>Lap</th><th>Time</th><th>vs best</th><th>Riding</th><th>Features</th><th>On foot</th><th>Stopped</th><th>Stops</th><th>Speed</th>' +
      (A.summary.hasPower ? '<th>Power</th><th>NP</th>' : '') + (A.summary.hasHr ? '<th>HR</th><th>Max HR</th>' : '') + '</tr></thead><tbody>' +
      rows.map(r => '<tr><td><span class="pin-key" style="background:' + Charts.lapColor(r.lap) + '">' + r.lap + '</span></td>' +
        '<td>' + Charts.fmtClock(r.seconds) + '</td>' +
        '<td>' + (r.deltaBest > 0.4 ? '+' + r.deltaBest.toFixed(0) + ' s' : '<span class="tag tag-cool">best</span>') + '</td>' +
        '<td>' + Charts.fmtClock(r.ridingSeconds) + '</td><td>' + Charts.fmtClock(r.featureSeconds) + '</td>' +
        '<td>' + r.onFoot.toFixed(0) + ' s</td><td>' + r.stopped.toFixed(0) + ' s</td>' +
        '<td>' + (r.bobbles ? r.bobbles + ' (' + r.bobbleCost.toFixed(0) + ' s)' : '—') + '</td>' +
        '<td>' + (r.avgV * 3.6).toFixed(1) + ' km/h</td>' +
        (A.summary.hasPower ? '<td>' + Math.round(r.avgW) + ' W</td><td>' + Math.round(r.np) + ' W</td>' : '') +
        (A.summary.hasHr ? '<td>' + (isFinite(r.avgHr) ? Math.round(r.avgHr) : '—') + '</td><td>' + (isFinite(r.maxHr) ? Math.round(r.maxHr) : '—') + '</td>' : '') +
        '</tr>').join('') + '</tbody></table>';
  }

  function renderPowerPanel(P, A) {
    const st = $('power-stats');
    if (!P.hasPower && !P.hasHr) {
      st.innerHTML = '';
      $('power-table').innerHTML = '<div class="table-empty">No power or heart-rate data in this ride.</div>';
      Charts.wbalChart($('wbal'), P, A, { height: 200 });
      $('wbal-sub').textContent = ''; $('wbal-legend').innerHTML = '';
      return;
    }
    const pw = A.power;
    const out = [];
    if (pw) {
      out.push(stat(Math.round(pw.avg), 'W', 'average', 'NP ' + Math.round(pw.np) + ' W'));
      out.push(stat(Math.round(pw.ridingAvg), 'W', 'while riding', 'outside features'));
      if (isFinite(pw.featureAvg)) out.push(stat(Math.round(pw.featureAvg), 'W', 'inside features', 'meter reads zero on foot'));
      out.push(stat(pw.kj.toFixed(0), 'kJ', 'work'));
      out.push(stat(Math.round(pw.wbalMinPct), '%', "W′ at its lowest", 'of ' + (A.cfg.wPrime / 1000).toFixed(1) + ' kJ'));
      out.push(stat(pw.tss.toFixed(0), '', 'TSS', 'IF ' + pw.intensity.toFixed(2)));
    }
    if (P.hasHr) {
      const i0 = A.lapBounds[0].i0, i1 = A.lapBounds[A.lapBounds.length - 1].i1;
      let mx = 0; for (let i = i0; i <= i1; i++) if (P.hr[i] > mx) mx = P.hr[i];
      out.push(stat(Math.round(A.summary.avgHr), 'bpm', 'average HR', 'max ' + Math.round(mx)));
    }
    st.innerHTML = out.join('');
    Charts.wbalChart($('wbal'), P, A, { height: 220 });
    $('wbal-sub').textContent = pw ? 'CP ' + Math.round(A.cfg.cp) + ' W · W′ ' + (A.cfg.wPrime / 1000).toFixed(1) + ' kJ · τ ' + Math.round(pw.wbal.tau) + ' s' : '';
    $('wbal-legend').innerHTML = pw ? key(Charts.SERIES.wbal.color, "W′ balance", 'line') + '<span class="legend-item">vertical lines = lap starts</span>' : '';
    // Table reuses the lap table columns most relevant here.
    $('power-table').innerHTML = '<table class="data"><thead><tr><th>Lap</th><th>Time</th>' +
      (P.hasPower ? '<th>Avg power</th><th>NP</th><th>kJ</th>' : '') + (P.hasHr ? '<th>Avg HR</th><th>Max HR</th>' : '') + (P.hasCad ? '<th>No pedalling</th>' : '') + '</tr></thead><tbody>' +
      A.laps.map(r => '<tr><td><span class="pin-key" style="background:' + Charts.lapColor(r.lap) + '">' + r.lap + '</span></td><td>' + Charts.fmtClock(r.seconds) + '</td>' +
        (P.hasPower ? '<td>' + Math.round(r.avgW) + ' W</td><td>' + Math.round(r.np) + ' W</td><td>' + r.kj.toFixed(0) + '</td>' : '') +
        (P.hasHr ? '<td>' + (isFinite(r.avgHr) ? Math.round(r.avgHr) : '—') + '</td><td>' + (isFinite(r.maxHr) ? Math.round(r.maxHr) : '—') + '</td>' : '') +
        (P.hasCad ? '<td>' + r.noPedal.toFixed(0) + ' s</td>' : '') + '</tr>').join('') + '</tbody></table>';
  }

  // ── Compare ───────────────────────────────────────────────────────────────

  function renderCompare() {
    const picked = state.races.filter(r => r.compare);
    const rows = [];
    for (const r of picked) {
      try {
        if (!r.P) r.P = RideStore.prepare(r.raw);
        if (!r.A || r === current()) analyse(r);
        rows.push(Analyzer.compareRow(r.raw, r.A));
      } catch (err) { console.warn('compare: skipped', r.id, err); }
    }
    Charts.compareBars($('cmp-bars'), rows, state.cmpMetric);
    const el = $('cmp-table');
    if (!rows.length) { el.innerHTML = '<div class="table-empty">Tick races in the sidebar to compare them.</div>'; $('cmp-circuits').innerHTML = ''; return; }
    el.innerHTML = '<table class="data"><thead><tr><th>Race</th><th>Date</th><th>Laps</th><th>Best lap</th><th>Median lap</th><th>Speed</th><th>On foot</th><th>On the table</th><th>Stops</th><th>Power</th><th>HR</th><th>Shape</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + Charts.esc(r.name) + '</td><td class="dim">' + (r.date ? r.date.toISOString().slice(0, 10) : '—') + '</td>' +
        '<td>' + r.laps + '</td><td>' + Charts.fmtClock(r.bestLap) + '</td><td>' + Charts.fmtClock(r.medianLap) + '</td>' +
        '<td>' + (r.avgV * 3.6).toFixed(1) + ' km/h</td><td>' + r.onFoot.toFixed(0) + ' s</td><td>' + r.lostVsBest.toFixed(0) + ' s</td>' +
        '<td>' + r.bobbleCost.toFixed(0) + ' s</td><td>' + (isFinite(r.avgW) ? Math.round(r.avgW) + ' W' : '—') + '</td>' +
        '<td>' + (isFinite(r.avgHr) ? Math.round(r.avgHr) : '—') + '</td><td>' + Charts.esc(r.shape.kind || '—') + '</td></tr>').join('') +
      '</tbody></table>';
    renderCircuitGroups(rows);
  }

  /** Races on the same course, feature by feature. */
  function renderCircuitGroups(rows) {
    const groups = Analyzer.groupByCircuit(rows).filter(g => g.races.length >= 2);
    const el = $('cmp-circuits');
    if (!groups.length) { el.innerHTML = ''; return; }
    el.innerHTML = groups.map(g => {
      const labels = [];
      for (const r of g.races) for (const f of r.features) if (!labels.includes(f.label)) labels.push(f.label);
      if (!labels.length) return '';
      const head = '<tr><th>Feature</th>' + g.races.map(r => '<th>' + Charts.esc(Charts.shorten(r.name, 22)) + '<br><span class="dim">' + (r.date ? r.date.toISOString().slice(0, 10) : '') + '</span></th>').join('') + '</tr>';
      const body = labels.map(l => '<tr><td>' + Charts.esc(l) + '</td>' + g.races.map(r => {
        const f = r.features.find(x => x.label === l);
        return '<td>' + (f ? f.median.toFixed(1) + ' s <span class="dim">best ' + f.best.toFixed(1) + '</span>' : '—') + '</td>';
      }).join('') + '</tr>').join('');
      return '<div class="card"><div class="card-head"><span class="card-title">Same course, ' + g.races.length + ' races</span>' +
        '<span class="card-sub">lap ' + (g.fingerprint.lapLen / 1000).toFixed(2) + ' km · typical time through each feature, matched by name</span></div>' +
        '<div class="table-scroll"><table class="data"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></div>';
    }).join('');
  }

  // ── Go ────────────────────────────────────────────────────────────────────

  boot().catch(err => { console.error(err); alert('CrossLab failed to start: ' + (err.message || err)); });
})();
