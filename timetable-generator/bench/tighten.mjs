#!/usr/bin/env node
// Makes an archived instance's `MAX_CLASSES_PER_DAY` caps as tight as they can be while the hidden
// schedule still satisfies them: for every lecturer and every group, the cap becomes exactly the
// most classes that entity has on any one day of the hidden schedule.
//
// This is the one hard rule that is a property of a *set* rather than of a placement — each of k
// classes can pass the check on its own against a day that does not yet hold the other k−1, and the
// k together can still break the cap. Any operator that moves several classes at once has to ask
// again once they are all down, and an instance whose caps are slack will never notice that it
// doesn't. This makes them maximally un-slack.
//
//   node bench/tighten.mjs bench/instances/n03200-s1.json.gz bench/instances-cap/n03200-s1.json.gz
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname } from 'node:path';

const [, , src, dst] = process.argv;
if (!src || !dst) { console.error('usage: tighten.mjs IN.json.gz OUT.json.gz'); process.exit(2); }

const archive = JSON.parse(gunzipSync(readFileSync(src)));
const problem = archive.problem;
const byKey = new Map(problem.requirements.map((r) => [r.key, r]));

// Per calendar week, exactly as the rule counts: WEEKLY falls in both weeks and
// NUMERATOR/DENOMINATOR in one each, so the cap has to hold for (WEEKLY + NUMERATOR) and for
// (WEEKLY + DENOMINATOR) separately.
const load = { lec: new Map(), grp: new Map() };
const bump = (m, id, day, week) => {
  const k = `${id}|${day}|${week}`;
  m.set(k, (m.get(k) ?? 0) + 1);
};
const account = (lecturerIds, groupIds, day, parity) => {
  for (const week of [1, 2]) {
    if (parity !== 'WEEKLY' && parity !== (week === 1 ? 'NUMERATOR' : 'DENOMINATOR')) continue;
    for (const id of lecturerIds) bump(load.lec, id, day, week);
    for (const id of groupIds) bump(load.grp, id, day, week);
  }
};
for (const p of archive.hidden) {
  const q = byKey.get(p.key);
  if (q) account(q.lecturerIds, q.groupIds, p.dayOfWeek, p.weekParity);
}
for (const f of problem.fixedEntries ?? []) {
  account(f.lecturerIds ?? [], f.groupIds ?? [], f.dayOfWeek, f.weekParity);
}

const peak = (m) => {
  const out = new Map();
  for (const [k, n] of m) {
    const id = k.split('|')[0];
    out.set(id, Math.max(out.get(id) ?? 0, n));
  }
  return out;
};

const apply = (list, peaks) => {
  const bySubject = new Map(list.map(([id, rows]) => [id, rows]));
  for (const [id, cap] of peaks) {
    const rows = (bySubject.get(id) ?? []).filter((r) => r.type !== 'MAX_CLASSES_PER_DAY');
    rows.push({ type: 'MAX_CLASSES_PER_DAY', dayOfWeek: null, value: String(cap) });
    bySubject.set(id, rows);
  }
  return [...bySubject.entries()];
};

problem.lecturerConstraints = apply(problem.lecturerConstraints, peak(load.lec));
problem.groupConstraints = apply(problem.groupConstraints, peak(load.grp));
archive.meta = { ...archive.meta, tightenedCaps: true };

mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, gzipSync(Buffer.from(JSON.stringify(archive))));
console.log(`${src} → ${dst}: capped ${problem.lecturerConstraints.length} lecturers, ` +
            `${problem.groupConstraints.length} groups at their hidden-schedule peak`);
