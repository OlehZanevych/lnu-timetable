#!/usr/bin/env node
/**
 * The full experiment: every instance size, repeated, with every metric an article might want.
 *
 *   node experiment.mjs                          # the default sweep (see below)
 *   node experiment.mjs --repeats 25             # 25 repetitions per instance
 *   node experiment.mjs --sizes 400,3200         # a subset
 *   node experiment.mjs --instances 1,2,3        # which generated variants to use
 *   node experiment.mjs --budget fixed:30000     # equal budget everywhere instead of scaled
 *   node experiment.mjs --out results/run-A      # where to write
 *
 * Two things make it usable for a paper rather than just for tuning.
 *
 * **It is resumable.** Every finished run is appended to the JSONL immediately and its key is
 * skipped on a restart, so a four-hour sweep survives a closed laptop and can be extended with
 * more repetitions later without redoing the ones already done.
 *
 * **It records the run, not just the answer.** Wall time, moves, moves/s and peak memory; all nine
 * Π counters and the hard/soft split, scored by the INDEPENDENT validator rather than by the
 * solver's own bookkeeping; the objective; the hidden reference schedule the instance was built
 * around, so every number has a known-achievable comparison; the convergence history; and
 * time-to-feasibility — the moment the run first reached zero hard violations, which is usually
 * the number a reader cares about most and cannot be recovered afterwards.
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from './emit.mjs';
import { validate } from './validate.mjs';
import { loadSolver, hydrate } from './run.mjs';
import { loadBestKnown, instanceKey } from './bestknown.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The archived instance is preferred over a fresh generation, so a published result stays tied to
 * the exact bytes it was produced from even if the generator is later edited. The generator is
 * deterministic, so when the file is absent regenerating gives the same instance anyway.
 */
function loadInstance(n, seed) {
  const file = join(HERE, 'instances', `n${String(n).padStart(5, '0')}-s${seed}.json.gz`);
  if (existsSync(file)) {
    const { meta, problem, hidden } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    return { meta, problem, hidden, source: 'archive' };
  }
  return { ...emit(n, seed), source: 'generated' };
}

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) argv[a.slice(2)] = process.argv[++i];
}

const SIZES = (argv.sizes ?? '25,50,100,200,400,800,1600,3200,6400,12800').split(',').map(Number);
const INSTANCES = (argv.instances ?? '1').split(',').map(Number);
const REPEATS = Number(argv.repeats ?? 25);
const SOLVER = resolve(argv.solver ?? join(HERE, '../../src/app/timetable-solver.ts'));
const OUT = resolve(argv.out ?? join(HERE, 'results/experiment'));

/**
 * Budget per run. Scaled by default: every size gets a budget where it actually converges, which
 * is what makes a quality-versus-size curve mean anything. `--budget fixed:30000` gives the other
 * useful figure — what each size reaches under an equal budget.
 */
function budgetFor(n) {
  const spec = argv.budget ?? 'scaled';
  if (spec.startsWith('fixed:')) return Number(spec.slice(6));
  if (n <= 100) return 10_000;
  if (n <= 800) return 30_000;
  if (n <= 3200) return 60_000;
  if (n <= 6400) return 120_000;
  return 300_000;
}

mkdirSync(dirname(OUT), { recursive: true });
const JSONL = `${OUT}.jsonl`;
const done = new Set(
  existsSync(JSONL)
    ? readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).runKey; } catch { return null; } })
    : []
);

const plan = [];
for (const n of SIZES) for (const inst of INSTANCES) for (let rep = 1; rep <= REPEATS; rep++) {
  const runKey = `n${n}-i${inst}-r${rep}-b${budgetFor(n)}`;
  if (!done.has(runKey)) plan.push({ n, inst, rep, runKey, budget: budgetFor(n) });
}

const totalMs = plan.reduce((a, j) => a + j.budget, 0);
console.log(`${plan.length} runs to do (${done.size} already done), about ` +
  `${(totalMs / 3_600_000).toFixed(1)} h of solver time\n`);
console.log(['size', 'inst', 'rep', 'budget', 'feasible', 'hard', 'soft', 'refSoft', 'feasAt', 'moves/s'].map((h, i) => h.padStart(i ? 10 : 6)).join(''));
console.log('─'.repeat(96));

const mod = await loadSolver(SOLVER);

/**
 * The best soft cost anyone has recorded for each instance, so a result can be quoted as a gap
 * rather than only against the constructed reference — which is a plausible human timetable, not an
 * optimum, and so flatters every number by roughly thirty times. `bestknown.mjs` explains why this
 * is a best-known table and not a bound. Run `node bestknown.mjs --add <out>.jsonl` afterwards to
 * fold this sweep's results back in.
 */
const bestKnown = loadBestKnown();

for (const job of plan) {
  const { problem, hidden, meta, source } = loadInstance(job.n, job.inst);
  const reference = validate(problem, hidden);

  // Time-to-feasibility has to be caught while the run happens; it cannot be recovered from the
  // final schedule.
  const started = Date.now();
  let firstFeasibleMs = null, firstFeasibleIter = null, peakRss = 0;
  const samples = [];
  const res = mod.solveTimetable(
    hydrate(problem),
    { timeLimitMs: job.budget, seed: 1000 * job.rep + job.inst },
    (p) => {
      if (firstFeasibleMs === null && p.hardTotal === 0) { firstFeasibleMs = Date.now() - started; firstFeasibleIter = p.iteration; }
      const rss = process.memoryUsage().rss; if (rss > peakRss) peakRss = rss;
      if (samples.length === 0 || Date.now() - started - samples[samples.length - 1].ms > 1000) {
        samples.push({ ms: Date.now() - started, iteration: p.iteration, objective: p.objective, hard: p.hardTotal });
      }
    }
  );
  const wallMs = Date.now() - started;
  const bk = bestKnown[instanceKey(job.n, job.inst)];
  const placements = res.assignments.filter((a) => a.placement).map((a) => ({ key: a.key, ...a.placement }));
  const v = validate(problem, placements);

  const row = {
    runKey: job.runKey, ts: new Date().toISOString(),
    solver: SOLVER.split('/').pop(),
    n: job.n, instanceSeed: job.inst, repeat: job.rep, searchSeed: 1000 * job.rep + job.inst,
    budgetMs: job.budget, wallMs,
    instance: meta, instanceSource: source,
    moves: res.iterations, movesPerSec: Math.round(res.iterations / (wallMs / 1000)),
    peakRssMb: Math.round(peakRss / 1048576),
    feasible: v.feasible, hard: v.hard, soft: v.soft, objective: v.objective,
    violations: v.violations, filters: v.filters,
    timeToFeasibleMs: firstFeasibleMs, iterationsToFeasible: firstFeasibleIter,
    placed: placements.length, unplaced: v.filters.unplaced,
    reference: { hard: reference.hard, soft: reference.soft, objective: reference.objective },
    softVsReference: reference.soft > 0 ? Number((v.soft / reference.soft).toFixed(4)) : null,
    bestKnownSoft: bk?.soft ?? null,
    // Percent above the best schedule ever found for this instance. Negative means this run *is*
    // the new best — fold it in with `node bestknown.mjs --add` and the figure becomes 0.
    gapToBestKnownPct: bk && bk.soft > 0 ? Number((100 * (v.soft - bk.soft) / bk.soft).toFixed(2))
                     : bk && bk.soft === 0 && v.soft === 0 ? 0 : null,
    convergence: res.history,
    samples
  };
  appendFileSync(JSONL, JSON.stringify(row) + '\n');

  console.log(
    String(job.n).padStart(6) + String(job.inst).padStart(10) + String(job.rep).padStart(10) +
    String(job.budget / 1000 + 's').padStart(10) + String(v.feasible ? 'yes' : 'NO').padStart(10) +
    String(v.hard).padStart(10) + String(v.soft).padStart(10) + String(reference.soft).padStart(10) +
    String(firstFeasibleMs === null ? '—' : (firstFeasibleMs / 1000).toFixed(1) + 's').padStart(10) +
    String(row.movesPerSec).padStart(10));
}

// ── summary ────────────────────────────────────────────────────────────────
const rows = readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const by = new Map();
for (const r of rows) { const k = `${r.n}|${r.budgetMs}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }

const stat = (xs) => {
  if (!xs.length) return { n: 0 };
  const s = xs.slice().sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { n: xs.length, min: s[0], max: s[s.length - 1], median: s[Math.floor(s.length / 2)],
           mean: Number(mean.toFixed(2)), sd: Number(sd.toFixed(2)) };
};

const summary = [...by.entries()].map(([k, list]) => {
  const [n, budgetMs] = k.split('|').map(Number);
  const feasible = list.filter((r) => r.feasible);
  return {
    n, budgetMs, runs: list.length,
    feasibleRate: Number((feasible.length / list.length).toFixed(3)),
    courses: list[0].instance.courses, groups: list[0].instance.groups,
    lecturers: list[0].instance.lecturers, rooms: list[0].instance.rooms,
    soft: stat(feasible.map((r) => r.soft)),
    hard: stat(list.map((r) => r.hard)),
    timeToFeasibleMs: stat(feasible.map((r) => r.timeToFeasibleMs).filter((x) => x != null)),
    movesPerSec: stat(list.map((r) => r.movesPerSec)),
    peakRssMb: stat(list.map((r) => r.peakRssMb)),
    referenceSoft: list[0].reference.soft,
    softVsReference: stat(feasible.map((r) => r.softVsReference)),
    // Only meaningful when the group is one instance: best-known is per instance, and a group
    // spanning several seeds has no single value. The *gap* stays meaningful either way, since it
    // is computed per run against that run's own instance.
    bestKnownSoft: new Set(list.map((r) => r.instanceSeed)).size === 1 ? list[0].bestKnownSoft ?? null : null,
    gapToBestKnownPct: stat(feasible.map((r) => r.gapToBestKnownPct).filter((x) => x != null))
  };
}).sort((a, b) => a.n - b.n || a.budgetMs - b.budgetMs);

writeFileSync(`${OUT}-summary.json`, JSON.stringify(summary, null, 1));
const csvCols = ['n', 'courses', 'groups', 'lecturers', 'rooms', 'budgetMs', 'runs', 'feasibleRate',
  'soft.median', 'soft.mean', 'soft.sd', 'soft.min', 'soft.max', 'referenceSoft', 'softVsReference.median',
  'bestKnownSoft', 'gapToBestKnownPct.median', 'gapToBestKnownPct.min',
  'timeToFeasibleMs.median', 'movesPerSec.median', 'peakRssMb.max'];
const pick = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
writeFileSync(`${OUT}-summary.csv`,
  csvCols.join(',') + '\n' + summary.map((r) => csvCols.map((c) => pick(r, c) ?? '').join(',')).join('\n') + '\n');

console.log(`\nwrote ${JSONL}`);
console.log(`      ${OUT}-summary.json`);
console.log(`      ${OUT}-summary.csv   (${summary.length} rows, ready for a table or a plot)`);
