#!/usr/bin/env node
// Runs the **shipped TypeScript solver** on an archived instance and emits the same JSONL a C++ run
// emits, so the two can be put in one table.
//
// Why this exists rather than quoting `TIMETABLE-GENERATION.md` §8. Those figures were measured on a
// two-core sandbox at some point in the past; these are measured on whatever machine is running this
// script, at the same moment, on the same instance, and scored by the same validator. A claim of the
// form "n× better" is only worth making when both sides were timed by the same clock.
//
// The solver is loaded from its TypeScript source unchanged, via `node:module`'s
// `stripTypeScriptTypes`, exactly as `timetable-bench/run.mjs` does — so what is measured is
// literally the file the application ships (Node 22.13+ or 24+).
//
//   node bench/run-ts.mjs --instance ../timetable-ui/scripts/timetable-bench/instances/n12800-s1.json.gz \
//        --time 30000 --workers 4 --out bench/results/ts.jsonl
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { fork } from 'node:child_process';
import { validate } from '../../timetable-ui/scripts/timetable-bench/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOLVER = resolve(here, '../../timetable-ui/src/app/timetable-solver.ts');

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  argv[a.slice(2)] = nx && !nx.startsWith('--') ? (i++, nx) : true;
}

async function loadSolver() {
  const js = stripTypeScriptTypes(readFileSync(SOLVER, 'utf8'),
                                  { mode: 'strip', sourceUrl: pathToFileURL(SOLVER).href });
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
}

/** The archive stores Maps flattened to arrays; the solver wants real Maps. */
function hydrate(problem) {
  return { ...problem,
    lecturerConstraints: new Map(problem.lecturerConstraints),
    groupConstraints: new Map(problem.groupConstraints),
    roomConstraints: new Map(problem.roomConstraints),
    roomBuilding: new Map(problem.roomBuilding),
    buildingTravel: new Map(problem.buildingTravel) };
}

function readArchive(file) {
  const raw = readFileSync(file);
  return JSON.parse(file.endsWith('.gz') ? gunzipSync(raw) : raw);
}

// ── the child: one seed, one process ─────────────────────────────────────────
// The browser runs the search as a portfolio of Web Workers on different seeds, best answer wins
// (TIMETABLE-GENERATION.md §8a). A process per seed is the closest thing Node has, and it is the
// only honest way to compare a k-worker browser fleet with a k-thread C++ run.
if (process.env.TG_TS_CHILD) {
  const { instance, time, seed } = JSON.parse(process.env.TG_TS_CHILD);
  const mod = await loadSolver();
  const archive = readArchive(instance);
  const res = mod.solveTimetable(hydrate(archive.problem), { timeLimitMs: Number(time), seed });
  const placements = res.assignments.filter((a) => a.placement).map((a) => ({ key: a.key, ...a.placement }));
  // `process.send` is asynchronous, and at n = 6 400 the placement list is six thousand objects.
  // Exiting straight after it truncates the message and the parent sees a worker that produced
  // nothing and exited 0 — which looks exactly like the solver failing on large instances and is
  // not. Await the flush (top-level await, so nothing falls through to the parent branch below)
  // and only then exit.
  await new Promise((flushed) => {
    process.send({ placements, iterations: res.iterations, elapsedMs: res.elapsedMs }, flushed);
  });
  process.exit(0);
}

// ── the parent ───────────────────────────────────────────────────────────────
const instance = argv.instance;
const time = Number(argv.time ?? 30000);
const workers = Number(argv.workers ?? 1);
const label = argv.label ?? `ts-${workers}w`;
const out = argv.out ?? 'bench/results/ts.jsonl';
if (!instance) { console.error('--instance is required'); process.exit(2); }

const archive = readArchive(instance);
const started = Date.now();

const results = await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((done) => {
  // Seeds strided by 7919, as the client's fleet does, so the k streams start far apart.
  // The solver holds its own index per worker and the largest instances are hundreds of megabytes,
  // so the heap is raised explicitly rather than left at whatever this Node's default happens to be:
  // a comparison that quietly loses its opponent to an out-of-memory kill is not a comparison.
  const child = fork(fileURLToPath(import.meta.url), [], {
    execArgv: ['--max-old-space-size=3072'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, TG_TS_CHILD: JSON.stringify({ instance, time, seed: 20260802 + i * 7919 }) },
  });
  let payload = null;
  child.on('message', (m) => { payload = m; });
  child.on('error', (e) => console.error(`worker ${i} error: ${e.message}`));
  child.on('exit', (code, signal) => {
    if (!payload) console.error(`worker ${i} produced nothing (code ${code}, signal ${signal})`);
    done(payload);
  });
})));

const wall = Date.now() - started;
const scored = results.filter(Boolean).map((r) => ({ ...r, check: validate(archive.problem, r.placements) }));
// Best by (hard, objective), exactly the rule the client's fleet uses.
scored.sort((a, b) => (a.check.hard - b.check.hard) || (a.check.objective - b.check.objective));
const best = scored[0];
if (!best) { console.error('every worker failed'); process.exit(1); }

const reference = archive.hidden ? validate(archive.problem, archive.hidden) : null;
mkdirSync(dirname(out), { recursive: true });
const record = {
  ts: new Date().toISOString(),
  label,
  solver: 'typescript',
  instance: basename(instance).replace(/\.json(\.gz)?$/, ''),
  n: archive.meta?.nClasses ?? archive.problem.requirements.length,
  seed: archive.meta?.seed ?? null,
  timeMs: time,
  threads: workers,
  meta: archive.meta ?? null,
  moves: best.iterations,
  seconds: wall / 1000,
  placed: best.placements.length,
  check: { feasible: best.check.feasible, hard: best.check.hard, soft: best.check.soft,
           objective: best.check.objective, violations: best.check.violations, filters: best.check.filters },
  referenceSoft: reference ? reference.soft : null,
  referenceObjective: reference ? reference.objective : null,
};
appendFileSync(out, JSON.stringify(record) + '\n');
console.log(`${label} ${record.instance} ${time}ms → HARD=${record.check.hard} soft=${record.check.soft} ` +
            `f=${record.check.objective} moves=${record.moves} wall=${wall}ms`);
