#!/usr/bin/env node
/**
 * How much is left on the table?
 *
 * The search is deterministic, so it lands in one local optimum and stops. The question this answers
 * is whether that optimum is a good one or merely the first one: if permuting the input — which
 * changes nothing about the problem, only the order arbitrary ties are broken in — moves the answer
 * a lot, then a multi-start is a cheap quality win now that a single run costs a fraction of what it
 * used to. If it moves the answer barely at all, the local optimum is robust and effort belongs
 * elsewhere.
 *
 *   node experiment-multistart.mjs --starts 12 --max-lecturers 40
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadGenerator } from './lib/load-generator.mjs';
import { verifyPlan, desirabilityBound } from './lib/metrics.mjs';
import { Rng } from './lib/rng.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}

const starts = Number(args.starts ?? 12);
const maxLecturers = Number(args['max-lecturers'] ?? 40);
const genPath = resolve(String(args.generator ?? './workload-generator.opt.ts'));
const { generateWorkloads } = await loadGenerator(genPath);

const datasets = readdirSync(join(HERE, 'data'))
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(join(HERE, 'data', f), 'utf8')))
  .filter((d) => d.meta.lecturers <= maxLecturers)
  .sort((a, b) => a.meta.lecturers - b.meta.lecturers || a.scenario.localeCompare(b.scenario));

console.log(`\n${starts} starts per dataset, ${datasets.length} datasets\n`);
console.log(pad('dataset', 24) + p('single', 10) + p('best', 10) + p('gain', 9) +
            p('bound gap', 12) + p('spread', 10) + p('1× ms', 9) + p('n× ms', 9));
console.log('─'.repeat(96));

let totalSingle = 0, totalBest = 0, totalOne = 0, totalAll = 0;

for (const d of datasets) {
  const { bound } = desirabilityBound(d.input);

  // Start 0 is the input exactly as it is — the answer the shipped code gives.
  const t0 = performance.now();
  const first = generateWorkloads(d.input);
  const oneMs = performance.now() - t0;

  let best = first;
  let bestScore = objective(d.input, first);
  const scores = [bestScore];

  const tAll = performance.now();
  for (let s = 1; s < starts; s++) {
    const permuted = permute(d.input, s);
    const r = generateWorkloads(permuted);
    const score = objective(permuted, r);
    scores.push(score);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  const allMs = performance.now() - tAll + oneMs;

  const singleDes = first.totalDesirability;
  const bestDes = best.totalDesirability;
  const spread = Math.max(...scores) - Math.min(...scores);

  totalSingle += singleDes; totalBest += bestDes;
  totalOne += oneMs; totalAll += allMs;

  console.log(
    pad(d.id, 24) + p(singleDes, 10) + p(bestDes, 10) +
    p(signed(((bestDes / singleDes - 1) * 100), 2) + '%', 9) +
    p(`${((1 - singleDes / bound) * 100).toFixed(1)}%→${((1 - bestDes / bound) * 100).toFixed(1)}%`, 12) +
    p(spread.toFixed(0), 10) + p(oneMs.toFixed(1), 9) + p(allMs.toFixed(0), 9)
  );
}

console.log('\n── Summary ' + '─'.repeat(60));
console.log(`  desirability   ${totalSingle} → ${totalBest}   (${signed((totalBest / totalSingle - 1) * 100, 2)}%)`);
console.log(`  time           ${totalOne.toFixed(0)} ms → ${totalAll.toFixed(0)} ms  (${(totalAll / totalOne).toFixed(1)}× for ${starts} starts)\n`);

/**
 * The objective a multi-start must rank candidates by. Desirability alone would let a start that
 * abandoned a floor or left slots empty look like the winner, so the three are combined in the same
 * priority the algorithm itself uses: fill first, floors second, desirability third.
 */
function objective(input, result) {
  const v = verifyPlan(input, result);
  const floorShort = v.floorViolations.reduce((s, f) => s + f.short, 0);
  const unfilled = result.requestedSlots - result.filledSlots;
  return -unfilled * 100000 - floorShort * 100 + result.totalDesirability;
}

/**
 * The same instance with its workloads in a different order. Nothing about the problem changes —
 * only which of several equally-constrained slots the greedy reaches first.
 */
function permute(input, seed) {
  const rng = new Rng(0x9e3779b9 ^ seed);
  return { ...input, workloads: rng.shuffle([...input.workloads]) };
}

function pad(v, n) { return String(v).padEnd(n); }
function p(v, n) { return String(v).padEnd(n); }
function signed(n, d) { return (n > 0 ? '+' : '') + n.toFixed(d); }
