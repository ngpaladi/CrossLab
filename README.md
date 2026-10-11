# CrossLab

Cyclocross race analysis in the browser. Load a `.fit` file or pull a race
straight from intervals.icu, mark where the barriers, run-ups and sand are, and
CrossLab lines every lap up against a clean median lap and tells you where the
time went — which feature, which lap, and whether it is technique or legs.

**[Open the tool →](https://www.noahpaladino.com/CrossLab/)**

No server, no account, no upload. Races live in your browser's IndexedDB.

The cyclocross sibling of [CritLab](https://github.com/ngpaladi/CritLab). The
two share settings, the intervals.icu key, and the raw ride format.

## Features

- **Place the features yourself** — two clicks on the course map per feature:
  where it starts and where you are back up to speed. Barriers, run-ups,
  stairs, sand, mud, off-camber, corners, descents, pavement, the pit. Saved
  with the race; copyable to another race on the same course.
- **Where the time went** — per feature: best, median and worst pass, time
  *left on the table* (how much slower each pass was than your best), *cost
  per pass* (how much longer than riding the same metres at approach speed),
  approach and exit speed, recovery time, seconds on foot, seconds stopped,
  and a verdict: steady, a few bad laps (named), or erratic.
- **Delta trace** — seconds behind your best lap, along the lap, one line per
  lap. Where a line steps up is where that lap lost time.
- **Lap × sector heatmap** — every lap against your own median for each
  stretch of the course. A column that stays red is a habit; a row that is red
  is a lap that went wrong.
- **Unplanned stops** — anywhere you came nearly to a halt with no feature
  marked, costed and drawn on the map.
- **Suggestions** — places where you were at running pace on most laps are
  offered as features with one click.
- **Fade** — second half against first, split into time in features and time
  riding between them.
- **Race trimming** — finds the race inside a file that also holds the
  pre-ride, the grid and the cool-down lap.
- **Power and HR**, if present — lap power, NP, W′ balance, riding power versus
  power inside features. Neither is required; speed, GPS and cadence are the
  signals.
- **Replay, same-course comparison, OpenStreetMap basemap, weather on the day**
  including rain in the 24 h before the start.

## Running locally

Requires Ruby and Bundler for the site, Node for the tests.

```bash
bundle install
bundle exec jekyll serve --livereload
# → http://localhost:4000/CrossLab/
```

## Tests

```bash
npm install        # jsdom, for the DOM test
npm test           # unit + DOM, no network

npm run test:unit  # analyser against a synthetic cross race with planted faults
npm run test:dom   # builds the site, boots it in jsdom, drives every tab
```

`test/harness.js` checks the analyser against a **simulated** race: seven laps
of a 2.4 km course with barriers, a run-up and a sand pit, a fumbled remount
planted on two specific laps, a bog planted on another, an unplanned stop
planted where no feature is marked, and a fade. The tests assert that the
analyser gets all of them back, and that the sector times on every lap sum to
the lap time exactly.

## Architecture

Jekyll static site on GitHub Pages. No build step beyond Jekyll, no framework,
no bundler, no runtime dependencies.

```
assets/js/
  Fit.js         — FIT binary decoder (shared with CritLab; reads sub_sport)
  Intervals.js   — intervals.icu v1 client (shared; power optional here)
  Weather.js     — Open-Meteo archive + forecast (shared)
  Osm.js         — OpenStreetMap basemap via Overpass (shared)
  Physics.js     — smoothing, gradients, headings, W′ balance (CritLab's helpers)
  Analyzer.js    — laps, mean lap, alignment, features, bobbles, sectors, findings
  Charts.js      — canvas charts with hover, OKLab ramps
  RideStore.js   — normalisation to a 1 Hz grid, IndexedDB, shared Settings
  Demo.js        — the synthetic sample race (and test fixture)
  app.js         — UI state, the feature picker, rendering
index.html       — the analyser
about.html       — what it computes, and what it assumes
```

### Data flow

1. A `.fit`, an intervals.icu activity, or a JSON export becomes a **raw ride**.
2. `RideStore.prepare` resamples it onto a 1 Hz grid.
3. `Analyzer.detectLaps` finds the laps; `buildMeanLap` stacks them into one
   clean course; `alignLap` snaps every lap to it by geography, giving the
   moment each lap passed every metre of the course.
4. Placed features are resolved onto the course and timed per lap from those
   moments. Sectors, the delta trace, bobbles and suggestions come from the
   same array, so everything is consistent by construction.
5. `Charts` draws it; `app.js` narrates it.

## Storage, shared with CritLab

Both tools are served from the same origin, so browser storage is one bag.

| key | where | what | shared |
|---|---|---|---|
| `cl-settings` | localStorage | preferences, rider numbers (`cx*` keys are CrossLab's) | yes |
| `cl-icu-key` | local/sessionStorage | the intervals.icu key, in its own slot | yes |
| `cl-wx-*`, `cl-osm-*` | localStorage | weather and map caches | yes |
| `crosslab` / `rides` | IndexedDB | raw rides with their features, keyed by `id` | no — same schema, own database |

CrossLab's *Reset to defaults* resets only its own keys and the rider numbers.
It never touches the intervals.icu settings or CritLab-only preferences.

## Privacy

Static page. The intervals.icu key is sent only to intervals.icu, directly from
your browser. Open-Meteo gets rounded coordinates and a date; Overpass gets a
bounding box. Nothing else leaves the browser.

## License

MIT
