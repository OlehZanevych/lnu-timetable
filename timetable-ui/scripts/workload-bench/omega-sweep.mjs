/**
 * Is the floor-deficit exchange rate load-bearing?
 *
 * The generator's floor deficit prices one missing course at omega hour-units, with omega = 10.
 * That number is a policy choice rather than a derived constant, so how much of the generator's
 * output rests on it is a question the deployment has to be able to answer. This script answers it
 * the only way that settles anything, by running the whole instance family at several values and
 * reporting what moves.
 *
 * The generator reads `WL_COURSE_DEFICIT_WEIGHT`, so each value is a separate child process: the
 * weight is read once when the module is first evaluated, and re-importing inside one process would
 * silently reuse the first value. Getting that wrong would produce a sweep in which every row is
 * identical and a conclusion of "omega does not matter" that means nothing.
 *
 *   node --experimental-strip-types scripts/workload-bench/omega-sweep.mjs [--omegas 5,10,20]
 *
 * Writes results/omega-sweep.csv.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const OUT = join(HERE, 'results', 'omega-sweep.csv');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const OMEGAS = String(arg('--omegas', '5,10,20')).split(',').map(Number);

// ── the child: one omega, every instance, quality metrics only ──────────────
if (process.env.WL_OMEGA_CHILD) {
  const { generateWorkloads } = await import('../../src/app/workload-generator.ts');
  const { verifyPlan } = await import('./lib/metrics.mjs');
  const out = [];
  for (const f of readdirSync(DATA).filter((x) => x.endsWith('.json') && x !== 'index.json').sort()) {
    const d = JSON.parse(readFileSync(join(DATA, f), 'utf8'));
    const r = generateWorkloads(structuredClone(d.input));
    const v = verifyPlan(d.input, r);
    out.push({
      dataset: `${d.meta.scenario}-${d.meta.lecturers}`,
      scenario: d.meta.scenario,
      lecturers: d.meta.lecturers,
      filled: r.filledSlots,
      requested: r.requestedSlots,
      desirability: +r.totalDesirability.toFixed(4),
      // The floor shortfall in the validator's own units, which are hours and courses counted
      // separately — deliberately not re-weighted by omega, so the comparison across omega values
      // is of outcomes rather than of the objective that produced them.
      floorViolations: v.floorViolations.length,
      floorShortfallHours: +v.floorViolations
        .filter((x) => x.rule === 'MIN_HOURS_PER_YEAR')
        .reduce((t, x) => t + x.short, 0).toFixed(2),
      floorShortfallCourses: v.floorViolations
        .filter((x) => x.rule !== 'MIN_HOURS_PER_YEAR')
        .reduce((t, x) => t + x.short, 0),
      overrunHours: +v.ceilingOverrunHours.toFixed(2),
      structural: v.structural.length,
    });
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ── the parent: one child per omega, then the comparison ────────────────────
const rows = [['omega', 'dataset', 'scenario', 'lecturers', 'filled', 'requested', 'desirability',
  'floorViolations', 'floorShortfallHours', 'floorShortfallCourses', 'overrunHours',
  'structural'].join(',')];
const byOmega = new Map();

for (const omega of OMEGAS) {
  const raw = execFileSync(process.execPath, [
    '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url),
  ], {
    env: { ...process.env, WL_OMEGA_CHILD: '1', WL_COURSE_DEFICIT_WEIGHT: String(omega) },
    maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
  });
  const res = JSON.parse(raw);
  byOmega.set(omega, new Map(res.map((r) => [r.dataset, r])));
  for (const r of res) {
    rows.push([omega, r.dataset, r.scenario, r.lecturers, r.filled, r.requested, r.desirability,
      r.floorViolations, r.floorShortfallHours, r.floorShortfallCourses, r.overrunHours,
      r.structural].join(','));
  }
  const tot = (k) => res.reduce((t, r) => t + r[k], 0);
  console.log(`omega=${String(omega).padStart(3)}  filled ${tot('filled')}  ` +
    `desirability ${tot('desirability').toFixed(0)}  ` +
    `floor: ${tot('floorShortfallHours').toFixed(0)} h + ${tot('floorShortfallCourses')} courses  ` +
    `over ceiling ${tot('overrunHours')} h  structural ${tot('structural')}`);
}

writeFileSync(OUT, rows.join('\n') + '\n');

// How many instances actually produce a different plan at all? A weight that changes no plan is
// not a modelling risk; a weight that changes many is one the deployment has to justify.
const base = byOmega.get(OMEGAS.includes(10) ? 10 : OMEGAS[0]);
for (const omega of OMEGAS) {
  if (byOmega.get(omega) === base) continue;
  const m = byOmega.get(omega);
  let differ = 0;
  for (const [k, v] of base) if (m.get(k).desirability !== v.desirability || m.get(k).filled !== v.filled) differ++;
  console.log(`omega=${omega}: ${differ}/${base.size} instances differ from the deployed weight`);
}
console.log(`wrote ${OUT}`);
