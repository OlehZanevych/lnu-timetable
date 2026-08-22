#!/usr/bin/env node
// Scores one C++ run with the harness's INDEPENDENT validator.
//
// The separation is the whole point of the exercise: the solver reports the violations it knows how
// to count, and a change that accidentally stopped counting one would look like an improvement.
// Every number that reaches a results file comes from `validate.mjs` re-reading the schedule from
// scratch, exactly as `timetable-bench/run.mjs` does for the TypeScript solver.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename } from 'node:path';
// The validator is the shipped harness's own, imported rather than copied: a scorer that
// drifted from the one the TypeScript solver is measured with would make every comparison
// in this study meaningless.
import { validate } from '../../timetable-ui/scripts/timetable-bench/validate.mjs';

const [, , instanceFile, placementFile, summaryJson, label = 'default', timeMs = '0', threads = '0'] =
  process.argv;

const raw = readFileSync(instanceFile);
const archive = JSON.parse(instanceFile.endsWith('.gz') ? gunzipSync(raw) : raw);
const problem = archive.problem ?? archive;
const placements = JSON.parse(readFileSync(placementFile, 'utf8'));
const summary = summaryJson ? JSON.parse(summaryJson) : {};

const check = validate(problem, placements);
const reference = archive.hidden ? validate(problem, archive.hidden) : null;

console.log(JSON.stringify({
  ts: new Date().toISOString(),
  label,
  solver: 'cpp',
  instance: basename(instanceFile).replace(/\.json(\.gz)?$/, ''),
  n: archive.meta?.nClasses ?? problem.requirements.length,
  seed: archive.meta?.seed ?? null,
  timeMs: Number(timeMs),
  threads: Number(threads),
  meta: archive.meta ?? null,
  moves: summary.moves ?? null,
  seconds: summary.seconds ?? null,
  solverHard: summary.hard ?? null,
  solverSoft: summary.soft ?? null,
  solverObjective: summary.objective ?? null,
  placed: summary.placed ?? placements.length,
  unplaced: summary.unplaced ?? null,
  check: {
    feasible: check.feasible, hard: check.hard, soft: check.soft, objective: check.objective,
    violations: check.violations, filters: check.filters,
  },
  referenceSoft: reference ? reference.soft : null,
  referenceObjective: reference ? reference.objective : null,
  workers: summary.workers ?? null,
}));
