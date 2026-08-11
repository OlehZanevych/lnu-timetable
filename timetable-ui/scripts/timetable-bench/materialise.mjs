#!/usr/bin/env node
/**
 * Writes the benchmark instances to disk as gzipped JSON.
 *
 * The generator is fully deterministic — the same `(n, seed)` always produces the same instance,
 * byte for byte — so these files are a convenience and an archive, not the source of truth. They
 * exist so a result published from them can still be reproduced years later even if the generator
 * is edited, which is the one thing regeneration cannot promise.
 *
 *   node materialise.mjs               # the whole ladder, seeds 1-5
 *   node materialise.mjs --sizes 400,3200 --seeds 1,2
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from './emit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'instances');

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) argv[a.slice(2)] = process.argv[++i];
}
const SIZES = (argv.sizes ?? '25,50,100,200,400,800,1600,3200,6400,12800').split(',').map(Number);
const SEEDS = (argv.seeds ?? '1,2,3,4,5').split(',').map(Number);

mkdirSync(OUT, { recursive: true });
const index = [];
let bytes = 0;

for (const n of SIZES) {
  for (const seed of SEEDS) {
    const { problem, hidden, meta } = emit(n, seed);
    // The hidden schedule ships with the instance: it is the proof that a perfect answer exists,
    // and the reference every measured result is scored against.
    const buf = gzipSync(Buffer.from(JSON.stringify({ meta, problem, hidden }), 'utf8'));
    const name = `n${String(n).padStart(5, '0')}-s${seed}.json.gz`;
    writeFileSync(join(OUT, name), buf);
    bytes += buf.length;
    index.push({ file: name, ...meta });
    console.log(`${name.padEnd(22)} ${(buf.length / 1024).toFixed(0).padStart(6)} kB   ` +
      `${meta.requirements} classes · ${meta.courses} courses · ${meta.groups} groups · ` +
      `${meta.lecturers} lecturers · ${meta.rooms} rooms`);
  }
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\n${index.length} instances, ${(bytes / 1048576).toFixed(1)} MB total`);
