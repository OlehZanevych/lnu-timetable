#!/usr/bin/env node
/**
 * Runs the shipped lecturer-workload generator over every dataset in `data/` and reports everything
 * a performance study needs: wall-clock by phase, machine-independent operation counts, solution
 * quality against an upper bound, and an independent feasibility check of every plan produced.
 *
 *   node scripts/workload-bench/run-benchmark.mjs
 *   node scripts/workload-bench/run-benchmark.mjs --repeats 9
 *   node scripts/workload-bench/run-benchmark.mjs --scenarios baseline,dense-candidates
 *   node scripts/workload-bench/run-benchmark.mjs --max-lecturers 80      # skip the slow tail
 *   node scripts/workload-bench/run-benchmark.mjs --label after-fix       # tag the results files
 *   node scripts/workload-bench/run-benchmark.mjs --generator path/to/workload-generator.ts
 *
 * Outputs, all under `results/`:
 *   metrics.csv       one row per dataset — the table a paper's appendix is built from
 *   metrics.json      the same, plus per-run detail and the environment it was measured on
 *   scaling.csv       fitted growth exponents per scenario
 *
 * Timing method: one discarded warm-up run per dataset (so JIT compilation and the first-touch cost
 * of the input arrays are not attributed to the algorithm), then N timed repeats of which the
 * minimum, mean and standard deviation are all reported. The minimum is the least contaminated
 * estimate of the true cost; the spread is what says whether the minimum can be trusted.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

import { loadGenerator, GENERATOR_PATH } from './lib/load-generator.mjs';
import { measure, planFingerprint, powerLawFit, verifyPlan } from './lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');
const RESULTS_DIR = join(HERE, 'results');

const args = parseArgs(process.argv.slice(2));
const maxRepeats = Number(args.repeats ?? 5);
/**
 * Total timed budget per dataset. A 150-second instance measured five times tells you nothing a
 * single measurement plus its neighbours on the curve do not, and it turns a sweep into an
 * afternoon. Small instances still get the full repeat count, which is where run-to-run noise
 * actually matters.
 */
const budgetMs = Number(args['budget-ms'] ?? 8000);
const maxLecturers = Number(args['max-lecturers'] ?? Infinity);
const only = args.scenarios ? String(args.scenarios).split(',') : null;
const label = args.label ? String(args.label) : null;
const suffix = label ? `.${label}` : '';
const generatorPath = args.generator ? resolve(String(args.generator)) : GENERATOR_PATH;

if (!existsSync(DATA_DIR)) {
  console.error(`No datasets. Run:  node ${join('scripts', 'workload-bench', 'generate-datasets.mjs')}`);
  process.exit(1);
}

const files = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort();

const { generateWorkloads, bytes, via } = await loadGenerator(generatorPath);

const datasets = files
  .map((f) => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')))
  .filter((d) => (!only || only.includes(d.scenario)) && d.meta.lecturers <= maxLecturers)
  // Cheapest first, so a run interrupted early still has the small end of every curve.
  .sort((a, b) => a.meta.lecturers - b.meta.lecturers || a.scenario.localeCompare(b.scenario));

if (!datasets.length) { console.error('No datasets matched the filters.'); process.exit(1); }

console.log(`\nGenerator : ${generatorPath.replace(process.cwd() + '/', '')} (${(bytes / 1024).toFixed(1)} kB of TypeScript)`);
console.log(`Loaded via: ${via}`);
console.log(`Node      : ${process.version}   ${os.type()} ${os.arch()}`);
console.log(`CPU       : ${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}`);
console.log(`Method    : warm-up + up to ${maxRepeats} timed repeats per dataset (${budgetMs} ms budget each), minimum reported\n`);

console.log(pad('dataset', 24) + rpad('slots', 8) + rpad('ms', 10) + rpad('±sd', 8) +
            rpad('µs/slot', 9) + rpad('fill', 7) + rpad('gap', 8) + rpad('canTake', 12) +
            rpad('viol', 6) + '  hot phase');
console.log('─'.repeat(115));

const rows = [];
const detail = [];
let determinismFailures = 0;
let feasibilityFailures = 0;

let datasetsRun = 0;

for (const dataset of datasets) {
  // Warm-up, discarded: the first call through a fresh function is interpreted, not compiled.
  // Datasets run smallest-first, so by the time the large ones come round the code is long since
  // optimised and a warm-up would cost a minute to change nothing.
  if (datasetsRun < 4 || dataset.stats.slots < 1500) generateWorkloads(dataset.input);
  datasetsRun++;

  const runs = [];
  let fingerprint = null;
  let lastResult = null;
  let spent = 0;

  for (let i = 0; i < maxRepeats; i++) {
    const t0 = performance.now();
    const result = generateWorkloads(dataset.input);
    const wall = performance.now() - t0;

    const fp = planFingerprint(result);
    if (fingerprint === null) fingerprint = fp;
    else if (fp !== fingerprint) {
      console.error(`  ✗ ${dataset.id}: repeat ${i + 1} produced a different plan (${fp} ≠ ${fingerprint})`);
      determinismFailures++;
    }
    runs.push({ wall, telemetry: result.telemetry });
    lastResult = result;
    spent += wall;
    // Always take at least two, so a fingerprint comparison is possible and `sd` means something.
    if (i >= 1 && spent + wall > budgetMs) break;
  }

  const walls = runs.map((r) => r.wall).sort((a, b) => a - b);
  const mean = walls.reduce((s, v) => s + v, 0) / walls.length;
  const sd = Math.sqrt(walls.reduce((s, v) => s + (v - mean) ** 2, 0) / walls.length);
  // Phase breakdown from the median run, so one unlucky GC pause cannot define the profile.
  const median = runs.slice().sort((a, b) => a.wall - b.wall)[Math.floor(runs.length / 2)];
  const representative = { ...lastResult, telemetry: median.telemetry };

  const row = measure(dataset, representative, {
    msMean: walls[0],            // the minimum: our estimate of the true cost
    msMin: walls[0],
    msMax: walls[walls.length - 1],
    msSd: sd,
    repeats: runs.length
  });
  row.msArithmeticMean = round(mean, 3);
  row.planFingerprint = fingerprint;

  // Only breaches the slot search is responsible for count as failures. Overruns caused purely by
  // individual supervision, and breaches inherited from locked assignments, are reported in their
  // own columns instead — see lib/metrics.mjs.
  if (row.structuralErrors || row.ceilingViolationsBySearch) {
    feasibilityFailures++;
    console.error(`  ✗ ${dataset.id}: ${row.structuralErrors} structural, ${row.ceilingViolationsBySearch} ceiling breaches by the search`);
    for (const v of row._violations.search) console.error(`      ${v.lecturerId} ${v.rule}: ${v.actual} > ${v.limit}`);
    for (const v of row._violations.structural) console.error(`      ${v}`);
  }

  const phases = { greedy: row.msGreedy, repair: row.msRepair, improve: row.msImprove,
                   individual: row.msIndividual, setup: row.msSetup, report: row.msReport };
  const hot = Object.entries(phases).sort((a, b) => b[1] - a[1])[0];
  // Against the median run's own total, not the minimum across repeats — mixing the two can print
  // a share above 100 %.
  const medianTotal = Object.values(phases).reduce((n, v) => n + v, 0);
  const hotShare = medianTotal > 0 ? Math.round((hot[1] / medianTotal) * 100) : 0;

  console.log(
    pad(row.dataset, 24) + rpad(row.slotsRequested, 8) + rpad(fmt(row.msMin), 10) +
    rpad(fmt(sd), 8) + rpad(row.usPerSlot.toFixed(1), 9) +
    rpad(pct(row.fillRate), 7) + rpad(pct(row.optimalityGap), 8) +
    rpad(compact(row.opsCanTake), 12) +
    rpad(row.ceilingViolationsBySearch + row.structuralErrors, 6) + `  ${hot[0]} ${hotShare}%`
  );

  const { _violations, ...clean } = row;
  rows.push(clean);
  detail.push({ id: dataset.id, walls, telemetry: median.telemetry, violations: _violations });
}

// ── Scaling ──────────────────────────────────────────────────────────────────

const scenarios = [...new Set(rows.map((r) => r.scenario))];
const scaling = [];

for (const s of scenarios) {
  const rs = rows.filter((r) => r.scenario === s).sort((a, b) => a.lecturers - b.lecturers);
  scaling.push({
    scenario: s,
    points: rs.length,
    alphaTimeVsLecturers: powerLawFit(rs.map((r) => ({ x: r.lecturers, y: r.msMin }))),
    alphaTimeVsSlots: powerLawFit(rs.map((r) => ({ x: r.slotsRequested, y: r.msMin }))),
    alphaCanTakeVsSlots: powerLawFit(rs.map((r) => ({ x: r.slotsRequested, y: r.opsCanTake }))),
    alphaGreedyVsSlots: powerLawFit(rs.map((r) => ({ x: r.slotsRequested, y: r.msGreedy }))),
    alphaRepairVsSlots: powerLawFit(rs.map((r) => ({ x: r.slotsRequested, y: Math.max(r.msRepair, 1e-6) }))),
    alphaImproveVsSlots: powerLawFit(rs.map((r) => ({ x: r.slotsRequested, y: Math.max(r.msImprove, 1e-6) })))
  });
}

console.log('\n── Empirical growth, time ∝ Nᵅ ' + '─'.repeat(60));
console.log(pad('scenario', 22) + rpad('α (vs lecturers)', 20) + rpad('R²', 8) +
            rpad('α (vs slots)', 16) + rpad('R²', 8) + rpad('α greedy', 12) + 'α canTake');
for (const s of scaling) {
  console.log(
    pad(s.scenario, 22) +
    rpad(fmtA(s.alphaTimeVsLecturers.alpha), 20) + rpad(fmtA(s.alphaTimeVsLecturers.r2), 8) +
    rpad(fmtA(s.alphaTimeVsSlots.alpha), 16) + rpad(fmtA(s.alphaTimeVsSlots.r2), 8) +
    rpad(fmtA(s.alphaGreedyVsSlots.alpha), 12) + fmtA(s.alphaCanTakeVsSlots.alpha)
  );
}

// ── Where the time goes ──────────────────────────────────────────────────────

const totalMs = rows.reduce((n, r) => n + r.msMin, 0);
const phaseShare = ['msSetup', 'msGreedy', 'msRepair', 'msImprove', 'msIndividual', 'msReport']
  .map((k) => ({ phase: k.slice(2).toLowerCase(), ms: rows.reduce((n, r) => n + r[k], 0) }))
  .sort((a, b) => b.ms - a.ms);

console.log('\n── Where the time goes, summed over every dataset ' + '─'.repeat(40));
for (const p of phaseShare) {
  const share = totalMs > 0 ? (p.ms / totalMs) * 100 : 0;
  console.log(`  ${pad(p.phase, 12)}${rpad(fmt(p.ms), 12)}${bar(share)} ${share.toFixed(1)} %`);
}

// ── Correctness summary ──────────────────────────────────────────────────────

const worstFill = [...rows].sort((a, b) => a.fillRate - b.fillRate)[0];
const worstGap = [...rows].sort((a, b) => b.optimalityGap - a.optimalityGap)[0];
const floorsBroken = rows.reduce((n, r) => n + r.floorViolations, 0);

console.log('\n── Correctness ' + '─'.repeat(60));
console.log(`  ceiling breaches caused by the slot search   ${rows.reduce((n, r) => n + r.ceilingViolationsBySearch, 0)}`);
console.log(`  … caused by individual supervision only      ${rows.reduce((n, r) => n + r.ceilingViolationsByIndividual, 0)}`);
console.log(`  … inherited from locked assignments          ${rows.reduce((n, r) => n + r.ceilingViolationsPreExisting, 0)}`);
console.log(`  structural errors                            ${rows.reduce((n, r) => n + r.structuralErrors, 0)}`);
console.log(`  determinism failures across repeats          ${determinismFailures}`);
console.log(`  unmet floors (soft — reported, not a bug)    ${floorsBroken}`);
console.log(`  lowest fill rate                             ${pct(worstFill.fillRate)}  (${worstFill.dataset})`);
console.log(`  largest optimality gap vs upper bound        ${pct(worstGap.optimalityGap)}  (${worstGap.dataset})`);
console.log(`  slowest single run                           ${fmt(Math.max(...rows.map((r) => r.msMin)))} ms  ` +
            `(${rows.find((r) => r.msMin === Math.max(...rows.map((x) => x.msMin))).dataset})`);

// ── Write ────────────────────────────────────────────────────────────────────

mkdirSync(RESULTS_DIR, { recursive: true });

// Each artifact is written independently: a sweep can take the better part of an hour, and a fault
// while serialising one of them must not take the other two with it.
const write = (name, produce) => {
  try { writeFileSync(join(RESULTS_DIR, name), produce()); }
  catch (e) { console.error(`  ! could not write ${name}: ${e.message}`); }
};

write(`metrics${suffix}.csv`, () => toCsv(rows));
write(`scaling${suffix}.csv`, () => toCsv(scaling.map((s) => ({
  scenario: s.scenario, points: s.points,
  alpha_time_vs_lecturers: s.alphaTimeVsLecturers.alpha, r2_time_vs_lecturers: s.alphaTimeVsLecturers.r2,
  alpha_time_vs_slots: s.alphaTimeVsSlots.alpha, r2_time_vs_slots: s.alphaTimeVsSlots.r2,
  alpha_greedy_vs_slots: s.alphaGreedyVsSlots.alpha,
  alpha_repair_vs_slots: s.alphaRepairVsSlots.alpha,
  alpha_improve_vs_slots: s.alphaImproveVsSlots.alpha,
  alpha_cantake_vs_slots: s.alphaCanTakeVsSlots.alpha
}))));
write(`metrics${suffix}.json`, () => JSON.stringify({
  schemaVersion: 1,
  label,
  method: {
    warmupRuns: 1, maxTimedRepeats: maxRepeats, perDatasetBudgetMs: budgetMs,
    reported: 'msMin is the minimum of the timed repeats; msSd their standard deviation',
    generator: generatorPath.split('/').slice(-3).join('/')
  },
  environment: {
    node: process.version, platform: os.platform(), arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / 1048576)
  },
  summary: {
    datasets: rows.length,
    ceilingViolationsBySearch: rows.reduce((n, r) => n + r.ceilingViolationsBySearch, 0),
    ceilingViolationsByIndividual: rows.reduce((n, r) => n + r.ceilingViolationsByIndividual, 0),
    ceilingViolationsPreExisting: rows.reduce((n, r) => n + r.ceilingViolationsPreExisting, 0),
    structuralErrors: rows.reduce((n, r) => n + r.structuralErrors, 0),
    determinismFailures, phaseShare, totalMs: round(totalMs, 3)
  },
  scaling, rows, detail
}, null, 2));

console.log(`\nWrote ${RESULTS_DIR}/metrics${suffix}.csv, scaling${suffix}.csv, metrics${suffix}.json\n`);

if (determinismFailures || feasibilityFailures) process.exit(1);

// ── Helpers ──────────────────────────────────────────────────────────────────

function toCsv(list) {
  if (!list.length) return '';
  const flat = list.map((r) => flatten(r));
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...flat.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, `${prefix}${k}_`));
    else out[`${prefix}${k}`] = Array.isArray(v) ? v.join(' ') : v;
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

// Declarations, not `const` arrows: the report is printed above, and a `const` would still be in
// its temporal dead zone by then.
function pad(v, n) { return String(v).padEnd(n); }
function rpad(v, n) { return String(v).padEnd(n); }
function pct(v) { return `${(v * 100).toFixed(1)}%`; }
function fmt(n) { return n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2); }
function fmtA(n) { return n == null ? '—' : n.toFixed(2); }
function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }
function compact(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n); }
function bar(p) { return '█'.repeat(Math.max(0, Math.round(p / 3))).padEnd(34); }
