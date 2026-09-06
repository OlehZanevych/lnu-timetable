/**
 * The before/after wall-clock comparison, both versions on this machine.
 *
 * The committed `metrics.base.csv` and `metrics.csv` were measured on two different machines, so
 * the ratio between their wall-clock totals confounds the two implementations with the two hosts
 * and is not a speed-up. Nothing recorded in those files can repair that, which is why every
 * performance figure taken from them is an operation count or a fitted exponent. This script
 * supplies the missing wall clock the only way it can be supplied: it runs the pre-engineering
 * generator (the file as it stood at commit ba13a51) and the current one back to back, in one
 * process, over the same instances, and records the host beside the results.
 *
 * It times only. The historical file carries no telemetry, so no operation count is taken from it
 * here; those come from the instrumented runs `run-benchmark.mjs` produces.
 *
 *   node --experimental-strip-types scripts/workload-bench/same-machine.mjs [--max-lecturers 320]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { verifyPlan } from './lib/metrics.mjs';

const DATA = new URL('data/', import.meta.url);
const OUT = new URL('results/same-machine.csv', import.meta.url);
const META = new URL('results/same-machine-host.json', import.meta.url);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const MAXLEC = Number(arg('--max-lecturers', '320'));
const REPEATS = Number(arg('--repeats', '5'));
const BUDGET = Number(arg('--budget-ms', '60000'));

const before = (await import('../../src/app/workload-generator.baseline.ts')).generateWorkloads;
const after = (await import('../../src/app/workload-generator.ts')).generateWorkloads;

const datasets = readdirSync(DATA)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8')))
  .filter((d) => d.meta.lecturers <= MAXLEC)
  // Cheapest first, so an interrupted run still has the small end of every curve.
  .sort((a, b) => a.meta.lecturers - b.meta.lecturers || a.scenario.localeCompare(b.scenario));

const rows = [['dataset', 'scenario', 'lecturers', 'slots',
  'msBefore', 'msMedianBefore', 'msMaxBefore', 'msIqrBefore', 'repeatsBefore',
  'msAfter', 'msMedianAfter', 'msMaxAfter', 'msIqrAfter', 'repeatsAfter',
  'speedup', 'speedupMedian',
  'filledBefore', 'filledAfter', 'requestedSlots',
  'overrunHoursBefore', 'overrunHoursAfter', 'ceilingBreachesBefore', 'ceilingBreachesAfter',
  'floorViolationsBefore', 'floorViolationsAfter'].join(',')];

/**
 * The whole distribution, not the minimum alone.
 *
 * An earlier version of this script reported the minimum of the repeats, on the usual argument that
 * the minimum is the least contaminated estimate of uncontended execution. That is defensible and it
 * is also unfalsifiable from the output: a single number carries no evidence about whether it can be
 * trusted. Median and spread are reported alongside it so a reader can see the noise, and the repeat
 * count is reported because the time budget gives the two implementations different numbers of runs
 * — the pre-engineering one is sometimes measured once where the current one is measured five times.
 */
const quantile = (sorted, q) => {
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const timed = (fn, input) => {
  const runs = [];
  let spent = 0;
  fn(structuredClone(input));                                  // warm-up, discarded
  while (runs.length < REPEATS && spent < BUDGET) {
    const t = performance.now();
    fn(structuredClone(input));
    const d = performance.now() - t;
    runs.push(d); spent += d;
  }
  const s = [...runs].sort((x, y) => x - y);
  return {
    ms: s[0], median: quantile(s, 0.5), max: s[s.length - 1],
    iqr: quantile(s, 0.75) - quantile(s, 0.25), n: runs.length,
  };
};

/**
 * The host, recorded BY THE RUN rather than remembered afterwards.
 *
 * The defect this whole script exists to repair was a wall-clock ratio computed across two result
 * files whose machines were recorded in a log beside them instead of in the results themselves.
 * Writing the host into a sidecar the analysis script reads is the general form of that fix: a
 * future reader of `same-machine.csv` cannot be separated from the machine it was taken on.
 */
const host = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  os: `${os.type()} ${os.release()}`,
  arch: os.arch(),
  cpuModel: os.cpus()[0]?.model ?? 'unknown',
  cpuCount: os.cpus().length,
  totalMemGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
  containerised: true,
  method: `one discarded warm-up, then up to ${REPEATS} timed repeats or a ${BUDGET} ms budget, ` +
    'per generator per instance; both generators loaded into one process and run back to back',
};
writeFileSync(META, JSON.stringify(host, null, 2) + '\n');

console.log(`Node      : ${host.node}   ${host.os} ${host.arch}`);
console.log(`CPU       : ${host.cpuModel} \u00d7 ${host.cpuCount},  ${host.totalMemGiB} GiB`);
console.log(`Method    : ${host.method}\n`);
console.log('dataset'.padEnd(26) + 'slots'.padStart(7) + 'before/ms'.padStart(13) +
            'after/ms'.padStart(12) + 'speedup'.padStart(10) + 'n b/a'.padStart(8) +
            'filled b/a'.padStart(16) + 'overrun h b/a'.padStart(16));
console.log('\u2500'.repeat(110));

for (const d of datasets) {
  const b = timed(before, d.input);
  const a = timed(after, d.input);
  const rb = before(structuredClone(d.input));
  const ra = after(structuredClone(d.input));
  const id = `${d.meta.scenario}-${d.meta.lecturers}`;
  const vb = verifyPlan(d.input, rb);
  const va = verifyPlan(d.input, ra);
  rows.push([id, d.meta.scenario, d.meta.lecturers, d.stats.slots,
    b.ms.toFixed(3), b.median.toFixed(3), b.max.toFixed(3), b.iqr.toFixed(3), b.n,
    a.ms.toFixed(3), a.median.toFixed(3), a.max.toFixed(3), a.iqr.toFixed(3), a.n,
    (b.ms / a.ms).toFixed(3), (b.median / a.median).toFixed(3),
    rb.filledSlots, ra.filledSlots, ra.requestedSlots,
    vb.ceilingOverrunHours.toFixed(1), va.ceilingOverrunHours.toFixed(1),
    vb.ceilingViolations.length, va.ceilingViolations.length,
    vb.floorViolations.length, va.floorViolations.length].join(','));
  console.log(id.padEnd(26) + String(d.stats.slots).padStart(7) +
    b.ms.toFixed(1).padStart(13) + a.ms.toFixed(2).padStart(12) +
    `${(b.ms / a.ms).toFixed(1)}\u00d7`.padStart(10) +
    `${b.n}/${a.n}`.padStart(8) +
    `${rb.filledSlots}/${ra.filledSlots}`.padStart(16) +
    `${vb.ceilingOverrunHours.toFixed(0)}/${va.ceilingOverrunHours.toFixed(0)}`.padStart(16));
  writeFileSync(OUT, rows.join('\n') + '\n');
}
console.log(`\nwrote ${OUT.pathname}`);
