#!/usr/bin/env node
// Compose several single-faculty instances into one whole-university problem.
//
// `timetable-generator/README.md` names this as a known limitation: "the whole-university mode is
// untested against real data at scale ... the largest real instance available here is one
// faculty's". The benchmark has the same gap — `emit.mjs` generates one faculty, uniformly coupled,
// and a university is not that. A university is **near-decomposable**: dense contention inside a
// faculty, sparse contention between them, through exactly two channels — rooms that more than one
// faculty may book, and people who teach for more than one.
//
// The composition has to keep the property the whole harness rests on: that a perfect schedule
// provably exists, so a residual soft cost is a statement about the search and never about the
// data. Concatenating F faculties trivially keeps it (their hidden schedules cannot conflict,
// because nothing is shared) and equally trivially tests nothing. Adding contention the obvious way
// — declare some rooms shared, delete some rooms to make them scarce — destroys it, because two
// faculties' hidden schedules were built independently and will collide.
//
// So the contention is derived from the hidden schedule rather than imposed on it, which is the
// same trick `emit.mjs` uses to build an instance backwards. Two entities in different faculties
// are **merged into one identity** only when their hidden usages are disjoint in time: a room that
// faculty A never uses on Tuesday at 10:00 can be the same physical room as one faculty B uses
// then, and a lecturer free on Thursday afternoon in A can be the person teaching in B. The merged
// hidden schedule is then still feasible by construction — every class is exactly where it was —
// while the *search* now faces a room that two faculties contend for and a person whose week spans
// both. Scarcity is real: the room count falls by the number of merges.
//
//   node bench/compose-university.mjs --out bench/instances-uni --faculties 5 \
//        --size 3200 --seeds "1 2 3" --room-share 0.30 --lecturer-share 0.10
//
// The `--size` is per faculty, so five faculties of 3 200 make a 16 000-class university.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { validate } from '../../timetable-ui/scripts/timetable-bench/validate.mjs';

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  argv[a.slice(2)] = nx && !nx.startsWith('--') ? (i++, nx) : true;
}
const outDir = argv.out ?? 'bench/instances-uni';
const nFac = Number(argv.faculties ?? 5);
const size = Number(argv.size ?? 3200);
const seeds = String(argv.seeds ?? '1').split(/\s+/).filter(Boolean).map(Number);
const roomShare = Number(argv['room-share'] ?? 0.30);
const lecShare = Number(argv['lecturer-share'] ?? 0.10);
const srcDir = argv.src ?? '../timetable-ui/scripts/timetable-bench/instances';
const crossTravel = Number(argv['cross-travel'] ?? 0);
mkdirSync(outDir, { recursive: true });

// A deterministic PRNG, so a composed instance is reproducible from its name alone.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const load = (f) => JSON.parse(gunzipSync(readFileSync(f)));
const pre = (i, id) => (id == null ? id : `f${i}_${id}`);
// The central teaching block the shared rooms sit in — no journey to or from anywhere.
const kShared = 'b_shared';

function compose(uniSeed) {
  const rand = rng(uniSeed * 7919 + 13);
  // One faculty per source seed, cycling if fewer archives than faculties are asked for.
  const parts = [];
  for (let i = 0; i < nFac; i++) {
    const s = (i % 5) + 1;
    parts.push(load(`${srcDir}/n${String(size).padStart(5, '0')}-s${s}.json.gz`));
  }

  // The bell grid, the working days and the three scalars have to be common. They are, because
  // every part comes from the same generator configuration — asserted rather than assumed.
  const base = parts[0].problem;
  const bells = JSON.stringify(base.classTimes);
  for (const p of parts) {
    if (JSON.stringify(p.problem.classTimes) !== bells) {
      throw new Error('bell grids differ between faculties; composition would be unsound');
    }
  }

  const out = {
    requirements: [], fixedEntries: [], classTimes: base.classTimes, rooms: [],
    academicHourMinutes: base.academicHourMinutes, days: base.days,
    lecturerConstraints: [], groupConstraints: [], roomConstraints: [],
    roomBuilding: [], buildingTravel: [], abstractRooms: [],
    abstractRoomTravelMinutes: base.abstractRoomTravelMinutes,
    universityCommuteMinutes: base.universityCommuteMinutes,
  };
  const hidden = [];

  // ── 1. concatenate, prefixing every identity with its faculty ───────────────
  //
  // Every list in a `SolverProblem` that looks like a table is an array of entry pairs —
  // `roomBuilding` is [roomId, buildingId], `buildingTravel` is ["from>to", minutes], and the three
  // constraint lists are [subjectId, rules]. Prefixing has to go through the pairs, not around them.
  const roomOf = [];
  const lecOf = [];
  const facultyBuildings = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].problem;
    const h = parts[i].hidden;

    for (const r of p.rooms) out.rooms.push(pre(i, r));
    roomOf.push(p.rooms.map((r) => pre(i, r)));
    const mine = new Set();
    for (const [r, b] of p.roomBuilding) {
      out.roomBuilding.push([pre(i, r), pre(i, b)]);
      mine.add(pre(i, b));
    }
    for (const a of p.abstractRooms) {
      const q = structuredClone(a);
      q.id = pre(i, a.id);
      q.buildingId = a.buildingId == null ? null : pre(i, a.buildingId);
      if (q.buildingId) mine.add(q.buildingId);
      out.abstractRooms.push(q);
    }
    facultyBuildings.push([...mine]);
    for (const [k, v] of p.buildingTravel) {
      const [from, to] = k.split('>');
      out.buildingTravel.push([`${pre(i, from)}>${pre(i, to)}`, v]);
    }

    const lecSet = new Set();
    for (const r of p.requirements) {
      const q = structuredClone(r);
      q.key = pre(i, r.key);
      q.workloadId = pre(i, r.workloadId);
      q.entryId = r.entryId == null ? null : pre(i, r.entryId);
      q.lecturerIds = r.lecturerIds.map((l) => pre(i, l));
      q.groupIds = r.groupIds.map((g) => pre(i, g));
      q.roomIds = r.roomIds.map((x) => pre(i, x));
      q.abstractRoomId = r.abstractRoomId == null ? null : pre(i, r.abstractRoomId);
      q.lecturerIds.forEach((l) => lecSet.add(l));
      out.requirements.push(q);
    }
    lecOf.push([...lecSet]);

    for (const e of p.fixedEntries) {
      const q = structuredClone(e);
      if (q.id != null) q.id = pre(i, e.id);
      if (q.lecturerIds) q.lecturerIds = q.lecturerIds.map((l) => pre(i, l));
      if (q.groupIds) q.groupIds = q.groupIds.map((g) => pre(i, g));
      if (q.roomId != null) q.roomId = pre(i, e.roomId);
      if (q.abstractRoomId != null) q.abstractRoomId = pre(i, e.abstractRoomId);
      out.fixedEntries.push(q);
    }
    for (const [id, rules] of p.lecturerConstraints) out.lecturerConstraints.push([pre(i, id), rules]);
    for (const [id, rules] of p.groupConstraints) out.groupConstraints.push([pre(i, id), rules]);
    for (const [id, rules] of p.roomConstraints) out.roomConstraints.push([pre(i, id), rules]);

    for (const e of h) {
      const q = structuredClone(e);
      q.key = pre(i, e.key);
      if (q.roomId != null) q.roomId = pre(i, e.roomId);
      hidden.push(q);
    }
  }

  // Cross-campus travel, and why it is what it is.
  //
  // Π₅ (lecturer travel) is a **hard** term. A composed instance that puts a thirty-minute walk
  // between two buildings whose classes are consecutive bells apart is an instance whose own hidden
  // schedule is infeasible — and the feasibility guarantee is the entire reason this harness builds
  // instances backwards. Inventing a travel matrix the planted schedule cannot satisfy would throw
  // that away to gain nothing: what this composition exists to test is contention for **rooms and
  // people**, not the walk between корпуси, which the single-faculty instances already exercise with
  // the generator's own asymmetric figures.
  //
  // So the shared rooms are modelled as a central teaching block reachable from every faculty
  // without a journey, and the faculties themselves are held at `--cross-travel` from one another —
  // which costs nothing in the planted schedule, because a lecturer is only ever merged across
  // faculties on **disjoint days** and so never has to make that walk.
  for (let i = 0; i < facultyBuildings.length; i++) {
    for (let j = 0; j < facultyBuildings.length; j++) {
      if (i === j) continue;
      for (const a of facultyBuildings[i]) {
        for (const b of facultyBuildings[j]) out.buildingTravel.push([`${a}>${b}`, crossTravel]);
      }
    }
  }
  const allBuildings = facultyBuildings.flat();
  for (const b of allBuildings) {
    out.buildingTravel.push([`${kShared}>${b}`, 0]);
    out.buildingTravel.push([`${b}>${kShared}`, 0]);
  }

  // ── 2. occupancy of the merged hidden schedule, per entity ──────────────────
  //
  // Two mistakes are easy here and both were made before this comment existed. A class occupies an
  // *interval*, not a bell — a two-hour class starting at t1 runs through t2 — so comparing bell
  // indices declares overlapping classes disjoint. And Π₅ (lecturer travel) is a **hard** term in
  // this model: a person merged across two faculties is a person who has to walk between two
  // campuses, and a thirty-minute walk between classes twenty minutes apart is a violation the
  // composed hidden schedule would carry.
  //
  // So rooms are tested for interval overlap, and lecturers for *day* disjointness, which subsumes
  // both problems and is what a service teacher's week really looks like: certain days in one
  // faculty, the rest in the other.
  const reqByKey = new Map(out.requirements.map((r) => [r.key, r]));
  const timeById = new Map(out.classTimes.map((t) => [t.id, t]));
  const minutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };
  const roomUse = new Map();   // room -> [{day, s, e, parity}]
  const lecDays = new Map();   // lecturer -> Set(day)
  const lecUse = new Map();    // lecturer -> [{day, s, e, parity}]
  for (const e of hidden) {
    const r = reqByKey.get(e.key);
    const t = timeById.get(e.classStartTimeId);
    if (!r || !t) continue;
    const s0 = minutes(t.startTime);
    const dur = (r.durationHours || 0) * out.academicHourMinutes;
    const iv = { day: e.dayOfWeek, s: s0, e: s0 + dur, parity: e.weekParity || 'WEEKLY' };
    if (e.roomId != null) {
      if (!roomUse.has(e.roomId)) roomUse.set(e.roomId, []);
      roomUse.get(e.roomId).push(iv);
    }
    for (const l of r.lecturerIds) {
      if (!lecDays.has(l)) lecDays.set(l, new Set());
      lecDays.get(l).add(e.dayOfWeek);
      if (!lecUse.has(l)) lecUse.set(l, []);
      lecUse.get(l).push(iv);
    }
  }
  // The fixed entries are part of the timetable too — other faculties' classes, already placed —
  // and they carry lecturers and rooms of their own. An occupancy map built from the hidden schedule
  // alone declares a lecturer free on a day they are in fact teaching, and the merge that follows
  // puts two classes on one person.
  for (const e of out.fixedEntries) {
    const s0 = minutes(e.startTime);
    const dur = (e.durationHours || 0) * out.academicHourMinutes;
    const iv = { day: e.dayOfWeek, s: s0, e: s0 + dur, parity: e.weekParity || 'WEEKLY' };
    if (e.roomId != null) {
      if (!roomUse.has(e.roomId)) roomUse.set(e.roomId, []);
      roomUse.get(e.roomId).push(iv);
    }
    for (const l of e.lecturerIds ?? []) {
      if (!lecDays.has(l)) lecDays.set(l, new Set());
      lecDays.get(l).add(e.dayOfWeek);
      if (!lecUse.has(l)) lecUse.set(l, []);
      lecUse.get(l).push(iv);
    }
  }

  const maxJourney = Math.max(crossTravel, out.universityCommuteMinutes || 0,
                              out.abstractRoomTravelMinutes || 0);
  const weeksOverlap = (a2, b2) => a2 === 'WEEKLY' || b2 === 'WEEKLY' || a2 === b2;
  const roomsDisjoint = (x, y) => {
    const A = roomUse.get(x) ?? [], B2 = roomUse.get(y) ?? [];
    for (const u of A) {
      for (const v of B2) {
        if (u.day !== v.day) continue;
        if (!weeksOverlap(u.parity, v.parity)) continue;
        if (u.s < v.e && v.s < u.e) return false;
      }
    }
    return true;
  };
  // Lecturers are tested for interval disjointness, like rooms, rather than for disjoint *days*.
  // Day disjointness is what a service teacher's week looks like and it is the safer test — it
  // rules out the cross-campus walk as well as the clash — but at these densities no two lecturers
  // in different faculties have disjoint day sets at all, and the composition degenerates to a
  // concatenation that tests nothing. Interval disjointness is sound whenever the walk between
  // faculties is not itself a violation, which is why `--cross-travel` defaults to zero and why
  // that default is a stated simplification rather than an oversight.
  const lecturersDisjoint = (x, y) => {
    if (crossTravel > 0) {
      const A0 = lecDays.get(x) ?? new Set(), B0 = lecDays.get(y) ?? new Set();
      for (const d of A0) if (B0.has(d)) return false;
      return true;
    }
    const A = lecUse.get(x) ?? [], B2 = lecUse.get(y) ?? [];
    for (const u of A) {
      for (const v of B2) {
        if (u.day !== v.day) continue;
        if (!weeksOverlap(u.parity, v.parity)) continue;
        if (u.s < v.e && v.s < u.e) return false;          // they clash outright
        // Π₅ is hard, and the journey between two classes of one person is defined by cases (A §1.4,
        // eq. 7): the walk between корпуси, the commute to and from an online class, and the
        // allowance for an abstract room with no address. A merge has to survive the *worst* of
        // them, because which case applies depends on where the search later puts these classes,
        // not on where the planted schedule put them.
        const gap = u.s <= v.s ? v.s - u.e : u.s - v.e;
        if (gap < maxJourney) return false;
      }
    }
    return true;
  };

  // ── 3. merge identities across faculties, only where the hidden use is disjoint ──
  const roomAlias = new Map();
  const lecAlias = new Map();
  const shuffled = (arr) => {
    const a = [...arr];
    for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; }
    return a;
  };
  let roomMerges = 0, lecMerges = 0;
  for (let i = 1; i < parts.length; i++) {
    const hosts = roomOf[i - 1].filter((h) => !roomAlias.has(h));
    const wantR = Math.floor(roomOf[i].length * roomShare);
    let madeR = 0;
    for (const r of shuffled(roomOf[i])) {
      if (madeR >= wantR) break;
      if (roomAlias.has(r)) continue;
      const host = shuffled(hosts).find((h) => !roomAlias.has(h) && roomsDisjoint(r, h));
      if (!host) continue;
      roomAlias.set(r, host);
      roomUse.set(host, [...(roomUse.get(host) ?? []), ...(roomUse.get(r) ?? [])]);
      madeR++; roomMerges++;
    }
    const lhosts = lecOf[i - 1].filter((h) => !lecAlias.has(h));
    const wantL = Math.floor(lecOf[i].length * lecShare);
    let madeL = 0;
    for (const l of shuffled(lecOf[i])) {
      if (madeL >= wantL) break;
      if (lecAlias.has(l)) continue;
      const host = shuffled(lhosts).find((h) => !lecAlias.has(h) && lecturersDisjoint(l, h));
      if (!host) continue;
      lecAlias.set(l, host);
      const u = lecDays.get(host) ?? new Set();
      for (const d of lecDays.get(l) ?? []) u.add(d);
      lecDays.set(host, u);
      lecUse.set(host, [...(lecUse.get(host) ?? []), ...(lecUse.get(l) ?? [])]);
      madeL++; lecMerges++;
    }
  }
  const rmap = (r) => roomAlias.get(r) ?? r;
  const lmap = (l) => lecAlias.get(l) ?? l;

  // ── 4. rewrite every reference through the aliases ──────────────────────────
  for (const r of out.requirements) {
    r.lecturerIds = [...new Set(r.lecturerIds.map(lmap))];
    r.roomIds = [...new Set(r.roomIds.map(rmap))];
  }
  for (const e of out.fixedEntries) {
    if (e.lecturerIds) e.lecturerIds = [...new Set(e.lecturerIds.map(lmap))];
    if (e.roomId != null) e.roomId = rmap(e.roomId);
  }
  for (const c of out.lecturerConstraints) c.subjectId = lmap(c.subjectId);
  for (const c of out.roomConstraints) c.subjectId = rmap(c.subjectId);
  for (const e of hidden) if (e.roomId != null) e.roomId = rmap(e.roomId);
  {
    // A merged room no longer exists: the host carries it. Room scarcity is the point — the room
    // count falls by exactly the number of merges.
    const seen = new Set();
    out.rooms = out.rooms.filter((id) => {
      if (roomAlias.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const live = new Set(out.rooms);
    const hosts = new Set(roomAlias.values());
    out.roomBuilding = out.roomBuilding
      .filter(([r]) => live.has(r))
      .map(([r, b]) => [r, hosts.has(r) ? kShared : b]);
  }

  const meta = {
    nClasses: out.requirements.length,
    seed: uniSeed,
    faculties: nFac,
    perFaculty: size,
    requirements: out.requirements.length,
    fixedEntries: out.fixedEntries.length,
    rooms: out.rooms.length,
    roomMerges,
    lecturerMerges: lecMerges,
    crossTravelMinutes: crossTravel,
    composedFrom: `n${String(size).padStart(5, '0')} × ${nFac}`,
  };
  return { problem: out, hidden, meta };
}

const index = [];
for (const s of seeds) {
  const t0 = Date.now();
  const { problem, hidden, meta } = compose(s);
  // The guarantee, checked rather than asserted: the composed hidden schedule must still be
  // feasible. If merging ever collided, this is where it shows up.
  const ref = validate(problem, hidden);
  const name = `uni${nFac}x${String(size).padStart(5, '0')}-s${s}`;
  if (ref.hard !== 0) {
    console.error(`${name}: REJECTED — composed hidden schedule has ${ref.hard} hard violations ` +
                  `(${JSON.stringify(ref.violations)})`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(`${outDir}/${name}.json.gz`,
                gzipSync(Buffer.from(JSON.stringify({ meta, problem, hidden }))));
  index.push({ file: `${name}.json.gz`, ...meta, referenceSoft: ref.soft });
  console.log(`${name}: ${meta.nClasses} classes, ${meta.rooms} rooms ` +
              `(${meta.roomMerges} shared across faculties), ${meta.lecturerMerges} shared lecturers, ` +
              `hidden hard=0 soft=${ref.soft} — ${Date.now() - t0} ms`);
}
writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 1));
