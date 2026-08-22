#!/usr/bin/env node
// Generates additional instances with the *same* generator the shipped harness uses, at sizes it
// does not archive and at constraint densities it does not exercise.
//
// Two reasons for more data. The archived ladder stops at n = 12 800, and the solver studied here
// reaches f(σ) = 0 on most of it inside thirty seconds — a benchmark every entrant passes measures
// nothing. And the archived instances are generated at `roomSlack: 1.15`, a comfortable faculty; the
// interesting regime for a one-hour budget is the tight one, where the room dimension actually binds
// and a schedule with no windows may not exist at all.
//
//   node bench/generate.mjs --out bench/instances-xl --sizes "25600 51200" --seeds "1 2 3"
//   node bench/generate.mjs --out bench/instances-tight --sizes "3200 6400" --seeds "1 2 3" \
//        --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'
//
// The hidden feasible schedule is still constructed first and the instance derived from it, so a
// perfect answer provably exists however tight the parameters are made — that property is what makes
// a residual soft cost a statement about the search rather than about the data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { emit } from '../../timetable-ui/scripts/timetable-bench/emit.mjs';

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  argv[a.slice(2)] = nx && !nx.startsWith('--') ? (i++, nx) : true;
}

const out = argv.out ?? 'bench/instances-xl';
const sizes = String(argv.sizes ?? '25600').split(/\s+/).filter(Boolean).map(Number);
const seeds = String(argv.seeds ?? '1 2 3').split(/\s+/).filter(Boolean).map(Number);
const opts = argv.opts ? JSON.parse(argv.opts) : {};

mkdirSync(out, { recursive: true });
const index = [];
for (const n of sizes) {
  for (const seed of seeds) {
    const t0 = Date.now();
    const { problem, hidden, meta } = emit(n, seed, opts);
    const name = `n${String(n).padStart(5, '0')}-s${seed}`;
    const file = `${name}.json.gz`;
    writeFileSync(`${out}/${file}`, gzipSync(Buffer.from(JSON.stringify({ meta, problem, hidden }))));
    index.push({ file, ...meta, opts });
    console.log(`${name}: ${meta.requirements} requirements, ${meta.groups} groups, ` +
                `${meta.lecturers} lecturers, ${meta.rooms} rooms — ${Date.now() - t0} ms`);
  }
}
writeFileSync(`${out}/index.json`, JSON.stringify(index, null, 1));
