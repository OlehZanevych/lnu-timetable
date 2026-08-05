#!/usr/bin/env node
/**
 * Writes the benchmark fixtures: one JSON file per (scenario, department size).
 *
 * Every file is a pure function of its seed, and every seed is a pure function of its cell, so the
 * whole `data/` directory can be thrown away and rebuilt byte-for-byte. That is why the files are
 * worth committing at all: they are not opaque blobs, they are a cache of something reproducible,
 * and a reviewer can check the cache is honest by rerunning this script and diffing.
 *
 *   node scripts/workload-bench/generate-datasets.mjs
 *   node scripts/workload-bench/generate-datasets.mjs --sizes 10,20 --scenarios baseline,tight-floors
 *   node scripts/workload-bench/generate-datasets.mjs --check     # rebuild in memory, diff, write nothing
 *
 * The JSON is minified on purpose. These files are read by machines and diffed only as a whole; at
 * the largest size, pretty-printing them costs several megabytes to no one's benefit.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildDataset } from './lib/dataset.mjs';
import { SCENARIOS, SIZES, seedFor } from './lib/scenarios.mjs';
import { ALL_CONSTRAINT_TYPES, CANDIDATE_CONSTRAINT_TYPES } from './lib/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');

const args = parseArgs(process.argv.slice(2));
const sizes = args.sizes ? args.sizes.split(',').map(Number) : SIZES;
const scenarios = args.scenarios
  ? SCENARIOS.filter((s) => args.scenarios.split(',').includes(s.key))
  : SCENARIOS;
const check = Boolean(args.check);

if (!scenarios.length) { console.error('No matching scenarios.'); process.exit(1); }

mkdirSync(DATA_DIR, { recursive: true });

// A clean rebuild: stale files from a removed scenario would otherwise be benchmarked forever.
if (!check && !args.sizes && !args.scenarios) {
  for (const f of readdirSync(DATA_DIR)) {
    if (f.endsWith('.json')) rmSync(join(DATA_DIR, f));
  }
}

const manifest = [];
const coveredConstraints = new Set();
const coveredCandidateConstraints = new Set();
const coveredFormats = new Set();
const coveredHourTypes = new Set();
const coveredCourseTypes = new Set();
const coveredModes = new Set();
let mismatches = 0;
let totalBytes = 0;

console.log(`\n${scenarios.length} scenarios × ${sizes.length} sizes = ${scenarios.length * sizes.length} datasets\n`);
console.log(pad('dataset', 26) + pad('courses', 9) + pad('positions', 11) + pad('slots', 8) +
            pad('cand.edges', 12) + pad('students', 10) + pad('h/lect', 8) + pad('demand', 8) + 'size');
console.log('─'.repeat(110));

for (const scenario of scenarios) {
  for (const lecturers of sizes) {
    const seed = seedFor(scenario.key, lecturers);
    const built = buildDataset({ lecturers, scenario, seed });

    const file = {
      schemaVersion: 1,
      id: `${scenario.key}-${lecturers}`,
      scenario: scenario.key,
      scenarioTitle: scenario.title,
      description: scenario.description,
      generatedBy: 'scripts/workload-bench/generate-datasets.mjs',
      meta: built.meta,
      stats: built.stats,
      input: built.input
    };

    const json = JSON.stringify(file);
    const path = join(DATA_DIR, `${file.id}.json`);
    const digest = createHash('sha256').update(json).digest('hex').slice(0, 12);

    if (check) {
      if (!existsSync(path)) { console.error(`  MISSING ${file.id}`); mismatches++; }
      else if (readFileSync(path, 'utf8') !== json) { console.error(`  DIFFERS ${file.id}`); mismatches++; }
    } else {
      writeFileSync(path, json);
    }

    totalBytes += json.length;
    const s = built.stats;
    for (const k of s.constraintTypesUsed) coveredConstraints.add(k);
    for (const k of Object.keys(s.byFormat)) coveredFormats.add(k);
    for (const k of Object.keys(s.byHourType)) coveredHourTypes.add(k);
    for (const k of Object.keys(s.byCourseType)) coveredCourseTypes.add(k);
    coveredModes.add(built.input.mode);
    if (s.byFormat.INDIVIDUALLY) for (const k of CANDIDATE_CONSTRAINT_TYPES) coveredCandidateConstraints.add(k);

    manifest.push({
      id: file.id, scenario: scenario.key, lecturers, seed, sha256: digest,
      bytes: json.length, stats: s
    });

    console.log(
      pad(file.id, 26) + pad(s.courses, 9) + pad(s.positions, 11) + pad(s.slots, 8) +
      pad(s.candidateEdges, 12) + pad(s.students, 10) + pad(s.plannedHoursPerLecturer, 8) +
      pad(s.demandRatio.toFixed(2), 8) + kb(json.length)
    );
  }
}

// ── Coverage: the dataset set is only useful if it exercises every branch there is ──
const missingConstraints = ALL_CONSTRAINT_TYPES.filter((c) => !coveredConstraints.has(c));
const missingCandidate = CANDIDATE_CONSTRAINT_TYPES.filter((c) => !coveredCandidateConstraints.has(c));

console.log('\n── Coverage ' + '─'.repeat(60));
console.log(`  lecturer constraint types   ${coveredConstraints.size}/${ALL_CONSTRAINT_TYPES.length}` +
            (missingConstraints.length ? `  MISSING: ${missingConstraints.join(', ')}` : '  (all)'));
console.log(`  candidate constraint types  ${coveredCandidateConstraints.size}/${CANDIDATE_CONSTRAINT_TYPES.length}` +
            (missingCandidate.length ? `  MISSING: ${missingCandidate.join(', ')}` : '  (all)'));
console.log(`  teaching formats            ${[...coveredFormats].sort().join(', ')}`);
console.log(`  hour types                  ${[...coveredHourTypes].sort().join(', ')}`);
console.log(`  course types                ${[...coveredCourseTypes].sort().join(', ')}`);
console.log(`  generation modes            ${[...coveredModes].sort().join(', ')}`);
console.log(`\n  ${manifest.length} files, ${kb(totalBytes)} total`);

if (!check) {
  writeFileSync(join(DATA_DIR, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    generated: 'deterministic — rebuild with generate-datasets.mjs',
    sizes, scenarios: scenarios.map((s) => ({ key: s.key, title: s.title, description: s.description,
      mode: s.mode, demandRatio: s.demandRatio, preAssigned: s.preAssigned })),
    coverage: {
      lecturerConstraintTypes: [...coveredConstraints].sort(),
      candidateConstraintTypes: [...coveredCandidateConstraints].sort(),
      teachingFormats: [...coveredFormats].sort(),
      hourTypes: [...coveredHourTypes].sort(),
      courseTypes: [...coveredCourseTypes].sort(),
      modes: [...coveredModes].sort()
    },
    datasets: manifest
  }, null, 2));
  console.log(`\nWrote ${DATA_DIR}\n`);
} else {
  console.log(mismatches ? `\n${mismatches} file(s) differ from a fresh build.\n` : '\nAll files match a fresh build.\n');
  process.exit(mismatches ? 1 : 0);
}

if (missingConstraints.length || missingCandidate.length) {
  console.error('Coverage is incomplete — raise the constraint probabilities in lib/scenarios.mjs.');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function pad(v, n) { return String(v).padEnd(n); }
function kb(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1024 / 1024).toFixed(2)} MB`; }
