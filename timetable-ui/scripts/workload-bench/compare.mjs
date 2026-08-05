#!/usr/bin/env node
/**
 * Runs two versions of the generator over the same datasets and reports the difference in both
 * dimensions that matter: how long it took, and how good the answer was.
 *
 * Speed alone is not a result. A search can be made arbitrarily fast by giving up, so every
 * comparison here carries the quality columns beside the timing ones, and any regression in fill
 * rate, desirability or feasibility is reported as a failure regardless of the speedup.
 *
 *   node compare.mjs --base ./workload-generator.ts --cand ./workload-generator.opt.ts
 *   node compare.mjs --max-lecturers 40 --repeats 3
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadGenerator } from './lib/load-generator.mjs';
import { verifyPlan, desirabilityBound, planFingerprint, distribution } from './lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}

const basePath = resolve(String(args.base ?? './workload-generator.ts'));
const candPath = resolve(String(args.cand ?? './workload-generator.opt.ts'));
const repeats = Number(args.repeats ?? 3);
const maxLecturers = Number(args['max-lecturers'] ?? Infinity);
const only = args.scenarios ? String(args.scenarios).split(',') : null;
const skipBase = Boolean(args['skip-base']);

const base = skipBase ? null : await loadGenerator(basePath);
const cand = await loadGenerator(candPath);

const datasets = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')))
  .filter((d) => (!only || only.includes(d.scenario)) && d.meta.lecturers <= maxLecturers)
  .sort((a, b) => a.meta.lecturers - b.meta.lecturers || a.scenario.localeCompare(b.scenario));

console.log(`\nbase      ${basePath.split('/').pop()}${skipBase ? '  (skipped)' : ''}`);
console.log(`candidate ${candPath.split('/').pop()}`);
console.log(`${datasets.length} datasets, ${repeats} repeats each\n`);

console.log(pad('dataset', 24) + r('base ms', 10) + r('cand ms', 10) + r('speedup', 9) +
            r('fill Δ', 9) + r('desir Δ', 10) + r('gap b→c', 14) + r('viol', 6) + r('det', 5));
console.log('─'.repeat(105));

const rows = [];
let failures = 0;

for (const d of datasets) {
  const b = skipBase ? null : run(base.generateWorkloads, d.input, repeats);
  const c = run(cand.generateWorkloads, d.input, repeats);

  const bv = b ? verifyPlan(d.input, b.result) : null;
  const cv = verifyPlan(d.input, c.result);
  const { bound } = desirabilityBound(d.input);

  const bGap = b && bound ? 1 - b.result.totalDesirability / bound : null;
  const cGap = bound ? 1 - c.result.totalDesirability / bound : null;

  const fillB = b ? b.result.filledSlots / Math.max(1, b.result.requestedSlots) : null;
  const fillC = c.result.filledSlots / Math.max(1, c.result.requestedSlots);

  const bad = cv.ceilingBySearch.length + cv.structural.length;
  const regressed = b && (fillC < fillB - 1e-9 || c.result.totalDesirability < b.result.totalDesirability);
  if (bad || regressed) failures++;

  const row = {
    dataset: d.id, scenario: d.scenario, lecturers: d.meta.lecturers,
    slots: c.result.requestedSlots,
    baseMs: b ? round(b.ms, 2) : null,
    candMs: round(c.ms, 2),
    speedup: b ? round(b.ms / c.ms, 2) : null,
    baseFill: fillB == null ? null : round(fillB, 4),
    candFill: round(fillC, 4),
    baseDesirability: b ? b.result.totalDesirability : null,
    candDesirability: c.result.totalDesirability,
    desirabilityDelta: b ? c.result.totalDesirability - b.result.totalDesirability : null,
    baseGap: bGap == null ? null : round(bGap, 4),
    candGap: cGap == null ? null : round(cGap, 4),
    baseOverrunHours: bv ? bv.ceilingOverrunHours : null,
    candOverrunHours: cv.ceilingOverrunHours,
    baseFloorShort: bv ? bv.floorViolations.reduce((s, f) => s + f.short, 0) : null,
    candFloorShort: cv.floorViolations.reduce((s, f) => s + f.short, 0),
    baseHoursGini: bv ? distribution(bv.loads.map((l) => l.hours)).gini : null,
    candHoursGini: distribution(cv.loads.map((l) => l.hours)).gini,
    ceilingBySearch: cv.ceilingBySearch.length,
    structural: cv.structural.length,
    deterministic: c.deterministic,
    candOps: c.result.telemetry.ops,
    candMsPhases: c.result.telemetry.ms
  };
  rows.push(row);

  const fillDelta = b ? (fillC - fillB) * 100 : 0;
  console.log(
    pad(row.dataset, 24) +
    r(b ? fmt(b.ms) : '—', 10) + r(fmt(c.ms), 10) +
    r(b ? `${row.speedup}×` : '—', 9) +
    r(b ? signed(fillDelta, 2) + '%' : '—', 9) +
    r(b ? signed(row.desirabilityDelta, 0) : '—', 10) +
    r(b ? `${(bGap * 100).toFixed(1)}%→${(cGap * 100).toFixed(1)}%` : `${(cGap * 100).toFixed(1)}%`, 14) +
    r(bad || '·', 6) + r(c.deterministic ? 'ok' : 'FAIL', 5) +
    (regressed ? '   ← QUALITY REGRESSION' : '')
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
const withBase = rows.filter((x) => x.speedup != null);
if (withBase.length) {
  const totalBase = withBase.reduce((n, x) => n + x.baseMs, 0);
  const totalCand = withBase.reduce((n, x) => n + x.candMs, 0);
  const speedups = withBase.map((x) => x.speedup).sort((a, b) => a - b);
  console.log('\n── Speed ' + '─'.repeat(60));
  console.log(`  total          ${fmt(totalBase)} ms → ${fmt(totalCand)} ms   (${round(totalBase / totalCand, 2)}× overall)`);
  console.log(`  per dataset    min ${speedups[0]}×   median ${speedups[Math.floor(speedups.length / 2)]}×   max ${speedups[speedups.length - 1]}×`);

  const dDes = withBase.reduce((n, x) => n + x.desirabilityDelta, 0);
  const better = withBase.filter((x) => x.desirabilityDelta > 0).length;
  const worse = withBase.filter((x) => x.desirabilityDelta < 0).length;
  const fillBetter = withBase.filter((x) => x.candFill > x.baseFill + 1e-9).length;
  const fillWorse = withBase.filter((x) => x.candFill < x.baseFill - 1e-9).length;
  const gapBase = withBase.reduce((n, x) => n + x.baseGap, 0) / withBase.length;
  const gapCand = withBase.reduce((n, x) => n + x.candGap, 0) / withBase.length;
  const floorBase = withBase.reduce((n, x) => n + x.baseFloorShort, 0);
  const floorCand = withBase.reduce((n, x) => n + x.candFloorShort, 0);
  const giniBase = withBase.reduce((n, x) => n + x.baseHoursGini, 0) / withBase.length;
  const giniCand = withBase.reduce((n, x) => n + x.candHoursGini, 0) / withBase.length;

  console.log('\n── Quality ' + '─'.repeat(60));
  console.log(`  total desirability   ${signed(dDes, 0)}   (better on ${better}, worse on ${worse}, equal on ${withBase.length - better - worse})`);
  console.log(`  mean optimality gap  ${(gapBase * 100).toFixed(2)}% → ${(gapCand * 100).toFixed(2)}%`);
  console.log(`  fill rate            better on ${fillBetter}, worse on ${fillWorse}`);
  console.log(`  unmet floor total    ${floorBase} → ${floorCand}`);
  console.log(`  ceiling overrun hrs  ${withBase.reduce((n, x) => n + x.baseOverrunHours, 0)} → ${withBase.reduce((n, x) => n + x.candOverrunHours, 0)}   (individual supervision)`);
  console.log(`  mean hours Gini      ${giniBase.toFixed(3)} → ${giniCand.toFixed(3)}`);
}

console.log('\n── Correctness ' + '─'.repeat(60));
console.log(`  ceiling breaches by search  ${rows.reduce((n, x) => n + x.ceilingBySearch, 0)}`);
console.log(`  structural errors           ${rows.reduce((n, x) => n + x.structural, 0)}`);
console.log(`  non-deterministic datasets  ${rows.filter((x) => !x.deterministic).length}`);
console.log(`  quality regressions         ${failures}\n`);

mkdirSync(join(HERE, 'results'), { recursive: true });
writeFileSync(join(HERE, 'results', `compare${args.label ? '.' + args.label : ''}.json`),
              JSON.stringify({ basePath, candPath, repeats, rows }, null, 2));

process.exit(failures ? 1 : 0);

function run(fn, input, n) {
  fn(input);                       // warm-up, discarded
  let best = Infinity;
  let result = null;
  let fp = null;
  let deterministic = true;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = fn(input);
    const ms = performance.now() - t;
    if (ms < best) { best = ms; result = r; }
    const f = planFingerprint(r);
    if (fp === null) fp = f; else if (f !== fp) deterministic = false;
    if (result === null) result = r;
  }
  return { ms: best, result, deterministic };
}

function pad(v, n) { return String(v).padEnd(n); }
function r(v, n) { return String(v).padEnd(n); }
function fmt(n) { return n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2); }
function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }
function signed(n, d) { return (n > 0 ? '+' : '') + n.toFixed(d); }
