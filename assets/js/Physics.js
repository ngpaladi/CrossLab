'use strict';

/**
 * Physics.js — the signal-processing helpers CrossLab shares with CritLab.
 *
 * CritLab's version carries a full power model, a CdA calibration and a wind
 * solver, because a criterium is an aerodynamics problem. A cyclocross race is
 * not: at 20 km/h in a field the draft is worth little, and most of the time
 * that matters is spent off the bike or braking. What survives here is the
 * generic maths — smoothing, gradients, headings, percentiles — plus W′ balance
 * and normalised power for riders who race with a meter. Function bodies are
 * identical to CritLab's so the two tools agree on every derived series.
 */
const Physics = (() => {

  const G = 9.80665;

  /** Centred moving average over a fixed sample window. */
  function smooth(a, w) {
    const n = a.length;
    const out = new Float64Array(n);
    if (w <= 1) { for (let i = 0; i < n; i++) out[i] = a[i]; return out; }

    // Prefix sums keep this O(n) regardless of window size.
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (isFinite(a[i]) ? a[i] : 0);
    const half = Math.floor(w / 2);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    return out;
  }

  /** Trailing (causal) moving average — what a head unit shows as "3 s power". */
  function smoothTrailing(a, w) {
    const n = a.length;
    const out = new Float64Array(n);
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (isFinite(a[i]) ? a[i] : 0);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w + 1);
      out[i] = (pre[i + 1] - pre[lo]) / (i - lo + 1);
    }
    return out;
  }

  /** Central-difference derivative of y with respect to x. */
  function derivative(y, x) {
    const n = y.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const dx = x[i1] - x[i0];
      out[i] = dx !== 0 ? (y[i1] - y[i0]) / dx : 0;
      if (!isFinite(out[i])) out[i] = 0;
    }
    return out;
  }

  /**
   * Road gradient by least-squares fit of altitude against distance over a
   * ±`halfWindowM` metre window. Barometric altimeters are noisy at the
   * one-second scale; differentiating them naively produces gradient spikes
   * that show up as phantom watts.
   */
  function gradientSeries(alt, dist, halfWindowM = 35, minPoints = 9) {
    const n = alt.length;
    const out = new Float64Array(n);
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (lo < i && dist[i] - dist[lo] > halfWindowM) lo++;
      if (hi < i) hi = i;
      while (hi < n - 1 && dist[hi + 1] - dist[i] <= halfWindowM) hi++;

      // A rider at 45 km/h covers 12 m per sample, so a fixed metre window can
      // hold too few points to average altimeter noise away — and a short,
      // noisy fit invents gradients, which the power model reads as watts.
      // Widen symmetrically until there is enough to regress against.
      while (hi - lo + 1 < minPoints && (lo > 0 || hi < n - 1)) {
        if (lo > 0) lo--;
        if (hi < n - 1) hi++;
      }

      const m = hi - lo + 1;
      if (m < 3) { out[i] = 0; continue; }

      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = lo; k <= hi; k++) {
        const x = dist[k] - dist[i], y = alt[k];
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const den = m * sxx - sx * sx;
      const slope = Math.abs(den) > 1e-9 ? (m * sxy - sx * sy) / den : 0;
      out[i] = clamp(isFinite(slope) ? slope : 0, -0.25, 0.25);
    }
    return out;
  }

  /** Bearing of travel in radians clockwise from north, from a lat/lon track. */
  function headingSeries(lat, lon, n) {
    const out = new Float64Array(n);
    if (!lat || !lon) return out;
    const D = Math.PI / 180;
    let last = 0;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
      const dLat = (lat[i1] - lat[i0]) * D;
      const dLon = (lon[i1] - lon[i0]) * D;
      const x = Math.cos(lat[i] * D) * dLon;
      if (Math.abs(x) < 1e-12 && Math.abs(dLat) < 1e-12) { out[i] = last; continue; }
      last = Math.atan2(x, dLat);
      out[i] = last;
    }
    return out;
  }

  /**
   * Wind at sample `i`. A prepared ride carries per-sample `we`/`wn` arrays
   * when the wind comes from weather data (it can shift mid-race); the scalar
   * `cfg.we`/`cfg.wn` is the fallback for a fixed or fitted wind.
   */

  function percentile(sortedAsc, p) {
    const n = sortedAsc.length;
    if (!n) return NaN;
    const idx = clamp(p, 0, 1) * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  }

  // ── Fatigue, for riders with a power meter ────────────────────────────


  /**
   * W′ balance, Skiba's differential form with Clarke's recovery expression.
   * Above CP the tank drains at (P − CP); below it, it refills toward W′ with
   * a time constant set by how far below CP you are recovering.
   *
   * The reported balance is clamped to [0, W′] — "how much is left" cannot be
   * negative. Demand beyond empty is not discarded, though: it accumulates in
   * `overdraft`, which is the honest signal that the modelled W′ is too small
   * for this rider or that they were riding well past what the model allows.
   *
   * @returns {{bal:Float64Array, tau:number, minBal:number, minAt:number,
   *            spent:number, overdraft:number, depleted:boolean,
   *            depletedSeconds:number}}
   */
  function wPrimeBalance(watts, cp, wPrime, dt = 1) {
    const n = watts.length;
    const bal = new Float64Array(n);

    // Mean shortfall below CP sets the recovery time constant.
    let sum = 0, k = 0;
    for (let i = 0; i < n; i++) if (watts[i] < cp) { sum += cp - watts[i]; k++; }
    const dcp = k ? sum / k : 0;
    const tau = 546 * Math.exp(-0.01 * dcp) + 316;

    let b = wPrime;
    let minBal = wPrime, minAt = 0, spent = 0, overdraft = 0, emptyFor = 0;
    for (let i = 0; i < n; i++) {
      const p = isFinite(watts[i]) ? watts[i] : 0;
      if (p > cp) {
        const drain = (p - cp) * dt;
        spent += drain;
        b -= drain;
        if (b < 0) { overdraft -= b; b = 0; }
      } else {
        b = wPrime - (wPrime - b) * Math.exp(-dt / tau);
      }
      b = Math.max(0, Math.min(wPrime, b));
      bal[i] = b;
      if (b <= 0) emptyFor += dt;
      if (b < minBal) { minBal = b; minAt = i; }
    }

    return {
      bal, tau, minBal, minAt, spent, overdraft,
      depleted: minBal <= 0, depletedSeconds: emptyFor,
    };
  }

  /** Normalised power: 30 s rolling average, fourth-power mean, fourth root. */
  function normalizedPower(watts, dt = 1) {
    const w = Math.max(1, Math.round(30 / dt));
    if (watts.length < w) return mean(watts);
    const roll = smoothTrailing(watts, w);
    let s = 0, k = 0;
    for (let i = w - 1; i < roll.length; i++) { s += Math.pow(roll[i], 4); k++; }
    return k ? Math.pow(s / k, 0.25) : mean(watts);
  }

  /** Classic training-stress summary for a ride segment. */
  function loadMetrics(watts, ftp, dt = 1) {
    const np = normalizedPower(watts, dt);
    const avg = mean(watts);
    const seconds = watts.length * dt;
    const intensity = ftp > 0 ? np / ftp : 0;
    return {
      avg,
      np,
      intensity,
      variability: avg > 0 ? np / avg : 0,
      tss: ftp > 0 ? (seconds * np * intensity) / (ftp * 3600) * 100 : 0,
      kj: (avg * seconds) / 1000,
      seconds,
    };
  }

  function mean(a) {
    let s = 0, k = 0;
    for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; k++; }
    return k ? s / k : 0;
  }


  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  return {
    G,
    smooth, smoothTrailing, derivative, gradientSeries, headingSeries, percentile,
    wPrimeBalance, normalizedPower, loadMetrics, mean, clamp,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Physics;
