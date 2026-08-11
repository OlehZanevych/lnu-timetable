#!/usr/bin/env node
/**
 * Summarises the tuning log written by run.mjs: per (variant, n, budget) the median hard/soft and
 * the feasible rate.
 *
 *   node report.mjs                              # results/measurements.jsonl
 *   node report.mjs --file results/my-run.jsonl
 *
 * For an experiment.mjs sweep use its own `-summary.csv` instead — that one carries the dispersion.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const fileArg = process.argv.indexOf('--file');
const F = resolve(fileArg > 0 ? process.argv[fileArg + 1] : join(HERE, 'results/measurements.jsonl'));
if (!existsSync(F)) { console.log('no results yet'); process.exit(0); }
const rows = readFileSync(F, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && !x.error);
const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const g = new Map();
for (const r of rows) { const k = `${r.label ?? r.variant}|${r.n}|${r.timeBudgetMs}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
console.log('variant'.padEnd(22) + 'n'.padStart(7) + 'budget'.padStart(9) + 'runs'.padStart(6) + 'feas'.padStart(6) + 'hard'.padStart(7) + 'soft'.padStart(8) + 'refSoft'.padStart(9) + 'iters'.padStart(10) + 'wall'.padStart(8) + 'rssMB'.padStart(7));
console.log('─'.repeat(99));
for (const [k, list] of [...g.entries()].sort((a, b) => { const [av, an, ab] = a[0].split('|'); const [bv, bn, bb] = b[0].split('|'); return av.localeCompare(bv) || Number(an) - Number(bn) || Number(ab) - Number(bb); })) {
  const [v, n, b] = k.split('|');
  const feas = list.filter((r) => r.check.feasible).length;
  console.log(v.padEnd(22) + n.padStart(7) + (Number(b) / 1000 + 's').padStart(9) + String(list.length).padStart(6) +
    `${feas}/${list.length}`.padStart(6) + String(med(list.map((r) => r.check.hard))).padStart(7) +
    String(med(list.map((r) => r.check.soft))).padStart(8) + String(med(list.map((r) => r.reference.soft))).padStart(9) +
    String(med(list.map((r) => r.iterations))).padStart(10) + (med(list.map((r) => r.wallMs)) + 'ms').padStart(8) +
    String(med(list.map((r) => r.peakRssMb))).padStart(7));
}
