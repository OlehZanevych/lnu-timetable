#!/usr/bin/env node
/**
 * Runs a solver variant on a generated instance and scores the result with the INDEPENDENT
 * validator, never with the solver's own counters.
 *
 * That separation is the point: the solver reports the violations it knows how to count, and a
 * change that accidentally stops counting one would look like an improvement. Every number in the
 * results file comes from validate.mjs re-reading the schedule from scratch.
 *
 *   node run.mjs --variant variants/baseline.ts --n 400 --seed 1 --time 30000
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { emit } from './emit.mjs';
import { validate } from './validate.mjs';

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  argv[a.slice(2)] = nx && !nx.startsWith('--') ? (i++, nx) : true;
}

const cache = new Map();
export async function loadSolver(path) {
  if (cache.has(path)) return cache.get(path);
  const src = readFileSync(path, 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip', sourceUrl: pathToFileURL(path).href });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
  cache.set(path, mod);
  return mod;
}

/** The instance is stored with Maps flattened to arrays; the solver wants real Maps. */
export function hydrate(problem) {
  return { ...problem,
    lecturerConstraints: new Map(problem.lecturerConstraints),
    groupConstraints: new Map(problem.groupConstraints),
    roomConstraints: new Map(problem.roomConstraints),
    roomBuilding: new Map(problem.roomBuilding),
    buildingTravel: new Map(problem.buildingTravel) };
}

export async function runOne({ variant, n, seed = 1, time = 30000, opts = {}, solverOpts = {} }) {
  const mod = await loadSolver(variant);
  const { problem, hidden, meta } = emit(n, seed, opts);
  const hydrated = hydrate(problem);
  const ref = validate(problem, hidden);

  const t0 = Date.now();
  let peakRss = 0;
  const res = mod.solveTimetable(hydrated, { timeLimitMs: time, seed: 20260802 + seed, ...solverOpts }, () => {
    const rss = process.memoryUsage().rss; if (rss > peakRss) peakRss = rss;
  });
  const wall = Date.now() - t0;

  const placements = res.assignments.filter((a) => a.placement).map((a) => ({ key: a.key, ...a.placement }));
  const v = validate(problem, placements);

  return {
    ts: new Date().toISOString(), variant: variant.split('/').pop(), n, seed, timeBudgetMs: time, solverOpts,
    meta, wallMs: wall, solverElapsedMs: res.elapsedMs, iterations: res.iterations,
    placed: placements.length, unplacedReported: res.unplaced.length,
    solverObjective: res.objective, solverViolations: res.violations,
    check: { feasible: v.feasible, hard: v.hard, soft: v.soft, objective: v.objective,
             violations: v.violations, filters: v.filters },
    reference: { hard: ref.hard, soft: ref.soft, objective: ref.objective },
    peakRssMb: Math.round(peakRss / 1048576),
    historyTail: res.history.slice(-5)
  };
}

if (argv.job || argv.n) {
  const job = argv.job ? JSON.parse(argv.job)
    : { variant: argv.variant ?? 'variants/baseline.ts', n: Number(argv.n), seed: Number(argv.seed ?? 1), time: Number(argv.time ?? 30000) };
  const out = await runOne(job);
  out.jobId = job.id ?? null; out.label = job.label ?? null;
  const dest = argv.out ?? '/home/claude/tt/results/results.jsonl';
  mkdirSync(dest.replace(/\/[^/]*$/, ''), { recursive: true });
  appendFileSync(dest, JSON.stringify(out) + '\n');
  const c = out.check;
  console.log(`${out.variant} n=${out.n} seed=${out.seed} budget=${out.timeBudgetMs}ms → wall=${out.wallMs}ms iters=${out.iterations} placed=${out.placed}/${out.meta.requirements} HARD=${c.hard} soft=${c.soft} f=${c.objective} feasible=${c.feasible} rss=${out.peakRssMb}MB`);
  if (!c.feasible) console.log('   filters', JSON.stringify(c.filters), 'V', JSON.stringify(c.violations));
}
