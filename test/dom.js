'use strict';

/**
 * DOM smoke test. Builds the site with Jekyll, loads the generated index.html
 * into jsdom with a recording canvas stub, then drives the UI the way a user
 * would: load the sample race, visit every tab, place a feature by clicking
 * the course map, accept a suggestion, poke the rail, trim and untrim.
 *
 * The point is not pixel fidelity — it is that every code path the app takes
 * actually runs.
 *
 *   node test/dom.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'crosslab-site-'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

section('Jekyll build');
try {
  execFileSync('jekyll', ['build', '--destination', SITE], { cwd: ROOT, stdio: 'pipe' });
  check('site builds', fs.existsSync(path.join(SITE, 'index.html')));
  check('about page builds', fs.existsSync(path.join(SITE, 'about.html')));
} catch (err) {
  check('site builds', false, String(err.stderr || err.message).slice(0, 300));
  process.exit(1);
}

/** Records every 2D call so the tests can prove a chart actually drew. */
function makeContext() {
  const calls = { fill: 0, stroke: 0, fillText: 0, fillRect: 0, arc: 0, lineTo: 0 };
  const noop = () => {};
  return {
    calls, canvas: null,
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: () => calls.lineTo++,
    arc: () => calls.arc++,
    quadraticCurveTo: noop, rect: noop, clip: noop,
    fill: () => calls.fill++,
    stroke: () => calls.stroke++,
    fillRect: () => calls.fillRect++,
    strokeRect: noop,
    fillText: () => calls.fillText++,
    strokeText: noop,
    setLineDash: noop, getLineDash: () => [],
    measureText: t => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    putImageData: noop, drawImage: noop,
  };
}

section('Boot');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => errors.push(e.message + '\n' + (e.stack || '')));
virtualConsole.on('error', (...a) => errors.push(a.map(String).join(' ')));

const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
  .replace(/(src|href)="\/CrossLab\//g, '$1="');
const baseUrl = require('url').pathToFileURL(path.join(SITE, 'index.html')).href;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: baseUrl,
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () {
      if (!this._ctx) { this._ctx = makeContext(); this._ctx.canvas = this; }
      return this._ctx;
    };
    window.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 440, width: 900, height: 440 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 900, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 160, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 60, configurable: true });
    window.devicePixelRatio = 2;
    window.alert = msg => errors.push('alert(): ' + msg);
    window.confirm = () => true;
    window.prompt = () => '1';
    window.fetch = () => Promise.reject(new Error('network disabled'));
    window.URL.createObjectURL = () => 'blob:x';
    window.URL.revokeObjectURL = () => {};
  },
});

const { window } = dom;
const { document } = window;
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G = name => window.eval(name);

(async () => {
  await new Promise(resolve => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  await sleep(300);

  check('no errors on boot', errors.length === 0, errors.join(' | ').slice(0, 400));
  check('modules present', ['Fit', 'Intervals', 'Physics', 'Analyzer', 'Charts', 'RideStore', 'Settings', 'Demo'].every(n => { try { return !!G(n); } catch (_) { return false; } }));
  check('empty state rendered', /Load a race/.test($('findings').textContent));

  section('Sample race');
  $('demo-btn').click();
  await sleep(800);
  check('no errors loading the sample', errors.length === 0, errors.join(' | ').slice(0, 400));
  check('stat tiles rendered', $('stat-row').children.length >= 6, $('stat-row').children.length + ' tiles');
  check('findings rendered', document.querySelectorAll('#findings .finding').length >= 4);
  check('race listed', document.querySelectorAll('#race-list .ride-item').length === 1);
  check('overview delta trace drew', $('ov-delta').getContext('2d').calls.stroke > 5);

  section('Tabs');
  const tabs = ['course', 'features', 'laps', 'trace', 'effort', 'replay', 'compare', 'overview'];
  for (const t of tabs) {
    const before = errors.length;
    document.querySelector('#tabbar .tab[data-tab="' + t + '"]').click();
    await sleep(150);
    check('tab ' + t + ' renders without errors', errors.length === before, errors.slice(before).join(' | ').slice(0, 300));
  }
  check('course map drew', $('map-main').getContext('2d').calls.stroke > 20);
  check('HR trace drew', $('hr-trace').getContext('2d').calls.stroke > 5);
  check('effort tiles rendered', $('effort-stats').children.length >= 5, $('effort-stats').children.length + ' tiles');
  check('feature HR table rendered', document.querySelectorAll('#hr-feature-table tbody tr').length === 3);
  check('W′ card shown with power', $('wbal-card').style.display !== 'none');
  check('no NaN on the effort tab', !/NaN/.test($('effort-stats').textContent + $('effort-table').textContent + $('hr-feature-table').textContent));
  check('heatmap drew', $('heatmap').getContext('2d').calls.fill > 20);
  check('feature bars drew', $('feature-bars').getContext('2d').calls.fill >= 3);
  check('feature table has three rows', document.querySelectorAll('#feature-table tbody tr').length === 3);
  check('lap table has seven rows', document.querySelectorAll('#lap-table tbody tr').length === 7);
  check('bobble listed', document.querySelectorAll('#bobble-list tbody tr').length === 1);

  section('Placing a feature');
  document.querySelector('#tabbar .tab[data-tab="course"]').click();
  await sleep(100);
  $('feature-type').value = 'offcamber';
  $('add-feature').click();
  await sleep(50);
  check('placing mode hint shown', $('pick-hint').style.display !== 'none' && /starts/.test($('pick-hint').textContent));
  // Click two points on the map: find pixel positions of two mean-lap points.
  const map = $('map-main');
  const click = (x, y) => map.dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
  // The course spans the canvas; probe a grid of points until two land on it.
  const placedBefore = document.querySelectorAll('#feature-list tbody tr').length;
  let clicks = 0;
  outer: for (let x = 40; x < 860 && clicks < 2; x += 40) {
    for (let y = 40; y < 400 && clicks < 2; y += 40) {
      const stateBefore = $('pick-hint').textContent;
      click(x, y);
      await sleep(30);
      if ($('pick-hint').textContent !== stateBefore || $('pick-hint').style.display === 'none') { clicks++; if (clicks === 2) break outer; }
    }
  }
  await sleep(300);
  const placedAfter = document.querySelectorAll('#feature-list tbody tr').length;
  check('feature placed by two clicks', placedAfter === placedBefore + 1, placedBefore + ' → ' + placedAfter);
  check('no errors placing', errors.length === 0, errors.join(' | ').slice(0, 300));

  // Rename, nudge, remove the new one.
  const rows = document.querySelectorAll('#feature-list tbody tr');
  const last = rows[rows.length - 1];
  const nameInput = last.querySelector('input[data-act="label"]');
  nameInput.value = 'Greasy bit';
  nameInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(200);
  check('feature renamed', Array.from(document.querySelectorAll('#feature-list input[data-act="label"]')).some(i => i.value === 'Greasy bit'));
  document.querySelector('#feature-list [data-act="nudge"][data-end="exit"][data-m="2"]').click();
  await sleep(200);
  const removeBtns = document.querySelectorAll('#feature-list [data-act="remove"]');
  removeBtns[removeBtns.length - 1].click();
  await sleep(200);
  check('feature removed', document.querySelectorAll('#feature-list tbody tr').length === placedBefore);

  section('Suggestions');
  // Remove all features, then accept a suggestion.
  while (document.querySelectorAll('#feature-list [data-act="remove"]').length) {
    document.querySelector('#feature-list [data-act="remove"]').click();
    await sleep(120);
  }
  check('no features left', document.querySelectorAll('#feature-list tbody tr').length === 0);
  check('suggestions appear', $('suggest-card').style.display !== 'none' && document.querySelectorAll('#suggest-list button').length >= 2);
  document.querySelector('#suggest-list button[data-act="show"]').click();
  await sleep(100);
  check('suggestion zooms the map', $('map-main')._clView && $('map-main')._clView.k > 1, JSON.stringify($('map-main')._clView));
  document.querySelector('#suggest-list button[data-act="add"]').click();
  await sleep(250);
  check('suggestion accepted', document.querySelectorAll('#feature-list tbody tr').length === 1);

  section('Map colouring');
  for (const mode of ['hr', 'lost', 'speed']) {
    document.querySelector('#map-color button[data-color="' + mode + '"]').click();
    await sleep(80);
    check('map coloured by ' + mode, ($('map-main')._clColorScale || {}).by === mode && /coloured by/.test($('map-title').textContent) && errors.length === 0, $('map-title').textContent);
  }

  section('Map zoom and pan');
  const mapEl = $('map-main');
  const view = () => mapEl._clView || { k: 1, tx: 0, ty: 0 };
  $('map-zoom-fit').click();
  await sleep(50);
  check('fit resets the view', view().k === 1 && $('map-zoom-fit').disabled);
  mapEl.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -300, clientX: 450, clientY: 220, bubbles: true, cancelable: true }));
  await sleep(80);
  const k1 = view().k;
  check('wheel zooms in', k1 > 1, 'k=' + k1.toFixed(2));
  check('fit button enabled when zoomed', !$('map-zoom-fit').disabled);
  $('map-zoom-in').click();
  await sleep(80);
  check('zoom-in button zooms further', view().k > k1, 'k=' + view().k.toFixed(2));
  // Dragging pans, and the click that ends a drag must not place a point.
  $('add-feature').click();
  await sleep(50);
  const before = document.querySelectorAll('#feature-list tbody tr').length;
  const txBefore = view().tx;
  const mev = (type, x, y) => mapEl.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  mev('pointerdown', 300, 200); mev('pointermove', 330, 210); mev('pointermove', 360, 230); mev('pointerup', 360, 230); mev('click', 360, 230);
  await sleep(80);
  check('drag pans the view', view().tx !== txBefore, txBefore.toFixed(0) + ' → ' + view().tx.toFixed(0));
  check('drag does not place a point', document.querySelectorAll('#feature-list tbody tr').length === before && $('pick-hint').textContent.includes('starts'));
  $('add-feature').click();   // cancel placing
  await sleep(50);
  document.querySelector('#feature-list [data-act="show"]').click();
  await sleep(100);
  check('show-on-map zooms to the feature', view().k > 1);
  $('map-zoom-fit').click();
  await sleep(50);
  check('no errors zooming', errors.length === 0, errors.join(' | ').slice(0, 300));

  section('Start line and rail');
  $('pick-start').click();
  await sleep(50);
  check('start-line mode hint', /start\/finish/.test($('pick-hint').textContent));
  $('pick-start').click();    // cancel
  const run = $('in-cxRunSpeed');
  run.value = '3.0';
  run.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(300);
  check('rail change re-analyses', G('Settings').get('cxRunSpeed') === 3);
  const lthr = $('in-cxLthr');
  lthr.value = '165';
  lthr.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(300);
  check('threshold HR slider is yours once moved', G('Settings').get('cxLthrUserSet') === true && /yours/.test($('src-cxLthr').textContent), $('src-cxLthr').textContent);
  $('reset-settings').click();
  await sleep(300);
  check('reset restores defaults', G('Settings').get('cxRunSpeed') === 3.5);
  window.HTMLAnchorElement.prototype.click = () => {};   // jsdom cannot navigate to a blob
  $('export-json').click();
  check('export does not throw', errors.length === 0, errors.join(' | ').slice(0, 300));

  section('Replay');
  document.querySelector('#tabbar .tab[data-tab="replay"]').click();
  await sleep(100);
  $('rp-scrub').value = '500';
  $('rp-scrub').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(50);
  check('replay scrubs', /lap \d/.test($('rp-sub').textContent), $('rp-sub').textContent);
  $('rp-play').click(); await sleep(250); $('rp-play').click();
  check('replay plays and pauses', $('rp-play').textContent.includes('Play'));

  section('Compare');
  document.querySelector('#race-list .ride-cmp').click();
  document.querySelector('#tabbar .tab[data-tab="compare"]').click();
  await sleep(150);
  check('compare table has the sample', document.querySelectorAll('#cmp-table tbody tr').length === 1);

  section('Settings drawer');
  $('settings-btn').click();
  check('drawer opens', $('settings-modal').style.display !== 'none');
  $('settings-close').click();
  check('drawer closes', $('settings-modal').style.display === 'none');

  check('no errors at the end', errors.length === 0, errors.join(' | ').slice(0, 400));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  fs.rmSync(SITE, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
