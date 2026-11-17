// GTA VI launch-day Twitch viewers forecast (gta6-twitch-ccu-forecast-01 v3).
//
// Method: pooled kernel-weighted log-ratio curves over past big launches.
// For each comparable launch, log-ratios lr_h = ln(viewers_h / viewers_1)
// for hours 2..24. Per hour, a weighted mean and weighted SD of the
// log-ratios give parametric normal quantiles: mu + z_tau * sd * 0.9.
// Weights: a Gaussian kernel on log hour-1 viewers (bandwidth 1 log unit,
// so launches of a similar size dominate), x1.5 for console-first
// launches (PS5/Xbox without PC, or a midnight-local rolling unlock),
// x2 for simultaneous-global launches (one worldwide unlock moment,
// whose ratio curves carry the synchronized-surge shape). Curves are
// 3-point smoothed across hours. House-shape fallback if fewer than 5
// usable comparables. Deterministic, Node 22 stdlib only, no network.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const MAX_Q = 1_000_000_000;
const HOUR_MS = 3600 * 1000;

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

function lowerText(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (Array.isArray(v)) return v.map(String).join(' ').toLowerCase();
  if (v && typeof v === 'object') return JSON.stringify(v).toLowerCase();
  return '';
}

function isConsoleFirst(c) {
  const platforms = lowerText(c.platforms);
  const unlock = lowerText(c.unlock);
  const namesConsole = /\bps5\b|playstation|xbox/.test(platforms);
  const namesPc = /\bpc\b/.test(platforms);
  if (namesConsole && !namesPc) return true;
  if (/midnight|rolling/.test(unlock)) return true;
  return false;
}

function isSimultaneousGlobal(c) {
  return /simultaneous|single global|single time/.test(lowerText(c.unlock));
}

// Hour (1..24) of a timestamp relative to a launch's day_start, or null.
function hourOf(from, dayStartMs) {
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return null;
  const diff = (t - dayStartMs) / HOUR_MS;
  const r = Math.round(diff);
  if (Math.abs(diff - r) > 1e-6) return null;
  return r + 1;
}

// A comparable's per-hour log-ratios + hour-1 viewers + flags, or null.
function comparableRatios(c) {
  if (!c || !Array.isArray(c.hourly) || !c.day_start) return null;
  const dayStartMs = Date.parse(c.day_start);
  if (!Number.isFinite(dayStartMs)) return null;
  const byHour = new Map();
  for (const row of c.hourly) {
    if (!row || typeof row.from !== 'string') continue;
    const h = hourOf(row.from, dayStartMs);
    if (h === null || h < 1 || h > 24) continue;
    const v = row.viewers;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && !byHour.has(h)) {
      byHour.set(h, v);
    }
  }
  const v1 = byHour.get(1);
  if (v1 === undefined || v1 <= 0) return null;
  const ratios = {};
  for (let h = 2; h <= 24; h++) {
    const vh = byHour.get(h);
    if (vh === undefined || vh <= 0) return null;
    ratios[h] = Math.log(vh / v1);
  }
  return { ratios, v1, consoleFirst: isConsoleFirst(c), simultaneous: isSimultaneousGlobal(c) };
}

function clipRound(q) {
  let v = q;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) v = 0.01;
  if (v > MAX_Q) v = MAX_Q;
  v = Math.round(v * 100) / 100;
  if (v <= 0) v = 0.01;
  if (v > MAX_Q) v = MAX_Q;
  return v;
}

function smooth3(values) {
  const n = values.length;
  if (n < 3) return values.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push((values[0] + values[1]) / 2);
    else if (i === n - 1) out.push((values[n - 2] + values[n - 1]) / 2);
    else out.push((values[i - 1] + values[i] + values[i + 1]) / 3);
  }
  return out;
}

function finishRows(p, curves, smooth = true) {
  // curves: 5 log-ratio curves (one per quantile level), each 23 long.
  // The pooled curves are 3-point smoothed across hours; the house-shape
  // fallback is used as-is (no smoothing), matching the baseline exactly.
  const smoothed = smooth ? curves.map(smooth3) : curves;
  const rows = [];
  for (let hi = 0; hi < 23; hi++) {
    const q = [];
    for (let li = 0; li < 5; li++) {
      const raw = p * Math.exp(smoothed[li][hi]);
      q.push(clipRound(Math.max(raw, q.length ? q[q.length - 1] : 0)));
    }
    rows.push({ hour: hi + 2, q });
  }
  return rows;
}

function fallbackForecast(p) {
  const curves = [[], [], [], [], []];
  for (let h = 2; h <= 24; h++) {
    const spread = 0.15 * Math.sqrt(h - 1);
    for (let li = 0; li < 5; li++) curves[li].push(Z[li] * spread);
  }
  return finishRows(p, curves, false);
}

function forecast(p, comparables) {
  const kept = [];
  for (const c of comparables || []) {
    const r = comparableRatios(c);
    if (r) kept.push(r);
  }
  if (kept.length < 5) return fallbackForecast(p);
  const lp = Math.log(p);
  const curves = [[], [], [], [], []];
  for (let h = 2; h <= 24; h++) {
    let tot = 0;
    let mu = 0;
    const pairs = [];
    for (const k of kept) {
      const kw = Math.exp(-0.5 * ((Math.log(k.v1) - lp) / 1.0) ** 2);
      let w = (k.consoleFirst ? 1.5 : 1.0) * kw;
      if (k.simultaneous) w *= 2.0;
      pairs.push([k.ratios[h], w]);
      tot += w;
      mu += k.ratios[h] * w;
    }
    mu /= tot;
    let variance = 0;
    for (const [v, w] of pairs) variance += w * (v - mu) ** 2;
    variance /= tot;
    const sd = Math.sqrt(Math.max(variance, 1e-9)) * 0.9;
    for (let li = 0; li < 5; li++) curves[li].push(mu + Z[li] * sd);
  }
  return finishRows(p, curves);
}

function runCase(kase) {
  const known = Array.isArray(kase.known) ? kase.known[0] : null;
  const p =
    known && typeof known.viewers === 'number' && known.viewers > 0
      ? known.viewers
      : 1;
  const hours = forecast(p, kase.comparables);
  return { hours };
}

mkdirSync(outputDir, { recursive: true });
const files = readdirSync(inputDir)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const f of files) {
  const kase = JSON.parse(readFileSync(join(inputDir, f), 'utf8'));
  const out = runCase(kase);
  const base = basename(f, '.in');
  writeFileSync(join(outputDir, `${base}.out`), JSON.stringify(out));
}
