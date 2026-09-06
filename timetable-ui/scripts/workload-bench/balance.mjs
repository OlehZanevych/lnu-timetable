/**
 * Balance measured two ways, because raw hours are the wrong axis when posts differ in size.
 *
 * The obvious measure is the Gini coefficient of assigned hours, and on its own it misleads. The
 * generator defines headroom as a *share* precisely because a full post and a half post are not
 * comparable in hours, so reading balance off the raw hours contradicts the quantity the search
 * optimises against. Six hundred hours on a full post and three hundred on a half post are
 * perfectly balanced in utilisation and maximally unequal in the raw figure, so both are reported
 * and the utilisation coefficient is the one to read.
 *
 * This computes both, over the whole family, for the current generator and for the one it replaced.
 * Quality metrics are deterministic functions of the plan, so no timing is involved and this does
 * not need the quiet machine the wall-clock harness does.
 *
 *   node --experimental-strip-types scripts/workload-bench/balance.mjs
 *
 * Writes results/balance.csv.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const OUT = join(HERE, 'results', 'balance.csv');

const { generateWorkloads } = await import('../../src/app/workload-generator.ts');
const before = (await import('../../src/app/workload-generator.baseline.ts')).generateWorkloads;
const { verifyPlan } = await import('./lib/metrics.mjs');

/** Standard Gini on a non-negative sample; 0 for a degenerate or empty one. */
const gini = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  const n = a.length;
  if (!n) return 0;
  const total = a.reduce((s, x) => s + x, 0);
  if (total <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (2 * (i + 1) - n - 1) * a[i];
  return acc / (n * total);
};

const rows = [['dataset', 'scenario', 'lecturers', 'impl',
  'giniHours', 'giniUtilisation', 'lecturersWithCeiling', 'lecturersTotal'].join(',')];

const files = readdirSync(DATA).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
for (const f of files) {
  const d = JSON.parse(readFileSync(join(DATA, f), 'utf8'));
  for (const [impl, fn] of [['after', generateWorkloads], ['before', before]]) {
    const v = verifyPlan(d.input, fn(structuredClone(d.input)));
    // Utilisation is only defined where a ceiling is: a lecturer with no cap has no denominator,
    // and inventing one (the statutory default, say) would put a number where there is none.
    const capped = v.loads.filter((l) => l.maxHours);
    rows.push([`${d.meta.scenario}-${d.meta.lecturers}`, d.meta.scenario, d.meta.lecturers, impl,
      gini(v.loads.map((l) => l.hours)).toFixed(6),
      gini(capped.map((l) => l.hours / l.maxHours)).toFixed(6),
      capped.length, v.loads.length].join(','));
  }
}
writeFileSync(OUT, rows.join('\n') + '\n');

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const impl of ['before', 'after']) {
  const rs = rows.slice(1).map((r) => r.split(',')).filter((c) => c[3] === impl);
  console.log(`${impl.padEnd(6)} gini(hours) ${mean(rs.map((c) => +c[4])).toFixed(3)}   ` +
    `gini(utilisation) ${mean(rs.map((c) => +c[5])).toFixed(3)}`);
}
const anyUncapped = rows.slice(1).map((r) => r.split(',')).some((c) => c[6] !== c[7]);
console.log(anyUncapped
  ? 'some lecturers carry no ceiling; utilisation is computed over the capped ones only'
  : 'every lecturer carries a ceiling, so the two measures cover the same population');
console.log(`wrote ${OUT}`);
