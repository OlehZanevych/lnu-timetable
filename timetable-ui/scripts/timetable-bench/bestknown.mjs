#!/usr/bin/env node
/**
 * Maintains the best soft cost ever recorded for each instance, and reports every result as a gap
 * against it.
 *
 *   node bestknown.mjs                                  # rebuild from every results file present
 *   node bestknown.mjs --add results/experiment.jsonl   # fold one more run in
 *   node bestknown.mjs --show                           # print the table
 *
 * ## Why "best known" and not "optimal"
 *
 * Every soft figure in this study has been quoted against the hidden schedule each instance was
 * built around. That reference is honest but weak: it is a feasible, human-plausible timetable, not
 * an optimum, and it is roughly thirty times worse than what the solver reaches. "28× better than
 * the reference" therefore says much less than it sounds like — the reference could have been twice
 * as bad and the number twice as impressive.
 *
 * The instance generator cannot supply anything better. It guarantees a **hard**-feasible schedule
 * exists, because it builds one; it makes no claim at all about the reachable soft minimum, and a
 * meaningful lower bound on Π₇/Π₈ is itself a hard combinatorial problem. Anyone quoting "within
 * x% of optimal" from this harness would be inventing the denominator.
 *
 * So this does what the timetabling literature does — ITC-2007 and its successors report results
 * against the **best known solution**, not against an optimum, precisely because optima for
 * instances this size are unknown. The best known value is whatever the best run ever recorded
 * achieved, it only ever improves, and a result is quoted as its gap above it. That is a claim that
 * stays true: it cannot be inflated by a weak reference, and when someone later finds a better
 * schedule the bound tightens rather than breaking.
 *
 * The one thing it is not is an absolute quality statement. A gap of 0% means "nothing better has
 * been found yet", which on a young instance family means less than it does on ITC-2007 after
 * fifteen years of attention. Both columns are therefore kept: the constructed reference says the
 * solver beats a plausible human timetable, the best-known gap says how it compares to itself.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, 'results/best-known.json');

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) argv[a.slice(2)] = process.argv[i + 1]?.startsWith('--') !== false ? true : process.argv[++i];
}

/** `n` and the instance seed identify an instance; the budget and the solver deliberately do not. */
export const instanceKey = (n, seed) => `n${n}-s${seed}`;

/**
 * Only results measured under the **corrected window definition** may enter the store.
 *
 * Soft cost changed scale partway through the study: the earlier definition converted each gap to
 * academic hours and floored, charging the ordinary inter-bell break as idle time, and produced
 * figures roughly an order of magnitude larger. Folding those into a best-known table would be
 * comparing two different objectives — and because the old numbers are *larger*, the damage is
 * subtle: they would silently win only on the instances where no corrected-metric run exists yet,
 * which is exactly where a reader would most trust the number.
 *
 * The whitelist is by solver file, because that is what every results row already carries. `v15` is
 * the variant the definition changed in; `timetable-solver.ts` is the shipped file, which
 * experiment.mjs records by name.
 */
const CORRECTED_METRIC = /^(v1[5-9]|v[2-9][0-9]|timetable-solver)/;
const measuredUnderCurrentMetric = (name) => !!name && CORRECTED_METRIC.test(name);

export function loadBestKnown() {
  if (!existsSync(STORE)) return {};
  try { return JSON.parse(readFileSync(STORE, 'utf8')).instances ?? {}; } catch { return {}; }
}

/**
 * Fold a set of result rows in. Only *feasible* results count: a schedule with a hard violation is
 * not a solution at all, and letting one set the bar would make the gap meaningless.
 */
export function foldInto(best, rows) {
  let improved = 0, skipped = 0;
  for (const r of rows) {
    const n = r.n;
    const seed = r.instanceSeed ?? r.seed;
    if (n == null || seed == null) continue;
    const feasible = r.feasible ?? r.check?.feasible;
    const soft = r.soft ?? r.check?.soft;
    if (!feasible || typeof soft !== 'number') continue;
    const solver = r.solver ?? (r.variant ?? '').split('/').pop();
    if (!measuredUnderCurrentMetric(solver)) { skipped++; continue; }
    const key = instanceKey(n, seed);
    const cur = best[key];
    if (!cur || soft < cur.soft) {
      best[key] = {
        soft,
        n,
        instanceSeed: seed,
        solver: solver ?? null,
        budgetMs: r.budgetMs ?? r.timeBudgetMs ?? null,
        searchSeed: r.searchSeed ?? r.solverOpts?.seed ?? null,
        ts: r.ts ?? null,
        referenceSoft: r.reference?.soft ?? null
      };
      improved++;
    }
  }
  return { improved, skipped };
}

function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && !r.error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const best = argv.add ? loadBestKnown() : {};
  const files = argv.add
    ? [resolve(argv.add)]
    : readdirSync(join(HERE, 'results')).filter((f) => f.endsWith('.jsonl')).map((f) => join(HERE, 'results', f));

  let total = 0, improved = 0, skipped = 0;
  for (const f of files) {
    const rows = readRows(f);
    total += rows.length;
    const r = foldInto(best, rows);
    improved += r.improved; skipped += r.skipped;
  }

  writeFileSync(STORE, JSON.stringify({
    note: 'Best soft cost ever recorded per instance. Feasible runs only. Monotone: only ever improves.',
    instances: best
  }, null, 1));

  const keys = Object.keys(best).sort((a, b) => best[a].n - best[b].n || best[a].instanceSeed - best[b].instanceSeed);
  console.log(`${files.length} file(s), ${total} rows → ${keys.length} instances, ${improved} improvement(s), ` +
    `${skipped} row(s) skipped as pre-dating the corrected window metric\n`);
  console.log('instance'.padEnd(14) + 'bestSoft'.padStart(10) + 'reference'.padStart(11) + 'budget'.padStart(9) + '  solver');
  console.log('─'.repeat(70));
  for (const k of keys) {
    const b = best[k];
    console.log(k.padEnd(14) + String(b.soft).padStart(10) + String(b.referenceSoft ?? '—').padStart(11) +
      String(b.budgetMs ? b.budgetMs / 1000 + 's' : '—').padStart(9) + '  ' + (b.solver ?? '—'));
  }
  console.log(`\nwrote ${STORE}`);
}
