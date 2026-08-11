#!/usr/bin/env node
/**
 * An INDEPENDENT re-check of a schedule against the instance.
 *
 * Written from the domain semantics (schema.sql's constraint rules and TIMETABLE-GENERATION.md's
 * definitions), deliberately NOT by calling into the solver. A validator that shares code with the
 * thing it validates agrees with it by construction, including where both are wrong — this is the
 * same reason workload-bench re-implements the workload constraint semantics rather than importing
 * them.
 *
 * Returns the nine Π counters plus the hard filters the solver treats as domain restrictions
 * (room eligibility, bell-set membership, and the four scheduling constraint types), which a
 * conforming schedule must satisfy exactly.
 */
const HOUR = 40;
const parityCode = (p) => (p === 'NUMERATOR' ? 1 : p === 'DENOMINATOR' ? 2 : 0);
const weeksOverlap = (a, b) => a === 0 || b === 0 || a === b;
const overlaps = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };

export function validate(problem, placements) {
  const hourMin = problem.academicHourMinutes || HOUR;
  const timeById = new Map(problem.classTimes.map((t) => [t.id, t]));
  const roomBuilding = new Map(problem.roomBuilding);
  const travel = new Map(problem.buildingTravel);
  const absById = new Map(problem.abstractRooms.map((a) => [a.id, a]));
  const reqByKey = new Map(problem.requirements.map((q) => [q.key, q]));
  const cons = { lec: new Map(problem.lecturerConstraints), grp: new Map(problem.groupConstraints), room: new Map(problem.roomConstraints) };

  const V = { lecturerConflicts: 0, groupConflicts: 0, roomConflicts: 0, groupTravel: 0, lecturerTravel: 0,
              abstractRoomOverflow: 0, lecturerWindows: 0, groupWindows: 0, mixedOnlineDays: 0 };
  const F = { unplaced: 0, badRoom: 0, badBellSet: 0, constraintBreaches: 0, duplicates: 0 };

  // ── materialise ───────────────────────────────────────────────────────────
  const evs = [];
  const seen = new Set();
  for (const p of placements) {
    if (!p || !p.key) continue;
    if (seen.has(p.key)) { F.duplicates++; continue; }
    seen.add(p.key);
    const q = reqByKey.get(p.key);
    if (!q) continue;
    const t = timeById.get(p.classStartTimeId);
    if (!t) { F.badBellSet++; continue; }
    if (t.setId !== q.classStartTimeSetId) F.badBellSet++;
    const s = toMin(t.startTime), e = s + q.durationHours * hourMin;
    const inRoom = !q.isOnline && !q.abstractRoomId;
    if (inRoom) {
      if (!p.roomId) F.badRoom++;
      else if (q.roomIds.length && !q.roomIds.includes(p.roomId)) F.badRoom++;
      else if (!q.roomIds.length && !problem.rooms.includes(p.roomId)) F.badRoom++;
    } else if (p.roomId) F.badRoom++;
    evs.push({ q, day: p.dayOfWeek, s, e, parity: parityCode(p.weekParity), roomId: inRoom ? p.roomId : null,
               abs: q.abstractRoomId, online: !!q.isOnline, students: q.studentsCount || 0,
               lecturerIds: q.lecturerIds, groupIds: q.groupIds });
  }
  for (const q of problem.requirements) if (!seen.has(q.key)) F.unplaced++;

  for (const f of problem.fixedEntries || []) {
    const s = toMin(f.startTime), e = s + f.durationHours * hourMin;
    evs.push({ q: null, day: f.dayOfWeek, s, e, parity: parityCode(f.weekParity), roomId: f.roomId,
               abs: f.abstractRoomId, online: !!f.isOnline, students: f.studentsCount || 0,
               lecturerIds: f.lecturerIds || [], groupIds: f.groupIds || [], fixed: true });
  }

  const placeOf = (ev) => ev.online ? { k: 3, b: null, a: null }
    : ev.abs ? (absById.get(ev.abs)?.buildingId ? { k: 1, b: absById.get(ev.abs).buildingId, a: ev.abs } : { k: 2, b: null, a: ev.abs })
    : { k: 0, b: roomBuilding.get(ev.roomId) ?? null, a: null };
  const journey = (x, y) => {
    if (x.k === 3 && y.k === 3) return 0;
    if (x.k === 3 || y.k === 3) return problem.universityCommuteMinutes || 0;
    if (x.a && x.a === y.a) return 0;
    if (x.k === 2 || y.k === 2) return problem.abstractRoomTravelMinutes || 0;
    if (!x.b || !y.b || x.b === y.b) return 0;
    return travel.get(`${x.b}>${y.b}`) ?? 0;
  };
  for (const ev of evs) ev.place = placeOf(ev);

  // ── buckets ───────────────────────────────────────────────────────────────
  const push = (m, id, day, ev) => { const k = `${id}|${day}`; let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(ev); };
  const lecB = new Map(), grpB = new Map(), roomB = new Map(), absB = new Map();
  for (const ev of evs) {
    for (const id of ev.lecturerIds) push(lecB, id, ev.day, ev);
    for (const id of ev.groupIds) push(grpB, id, ev.day, ev);
    if (ev.roomId) push(roomB, ev.roomId, ev.day, ev);
    if (ev.abs) push(absB, ev.abs, ev.day, ev);
  }

  const pairScan = (buckets, onConflict, onTravel) => {
    for (const arr of buckets.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], c = arr[j];
      if (!weeksOverlap(a.parity, c.parity)) continue;
      if (overlaps(a.s, a.e, c.s, c.e)) { onConflict && onConflict(); continue; }
      if (!onTravel) continue;
      // Order the pair in TIME first, then ask for the journey: building_travel_times is directed
      // and the two directions routinely disagree (b1→b4 is 10 minutes here, b4→b1 is 16). Reading
      // the journey in the bucket's arbitrary array order instead scores roughly half of all
      // cross-building pairs against the wrong figure.
      const [f, l] = a.s <= c.s ? [a, c] : [c, a];
      const need = journey(f.place, l.place);
      if (need <= 0) continue;
      if (l.s - f.e < need) onTravel();
    }
  };
  pairScan(lecB, () => V.lecturerConflicts++, () => V.lecturerTravel++);
  pairScan(grpB, () => V.groupConflicts++, () => V.groupTravel++);
  pairScan(roomB, () => V.roomConflicts++, null);

  // Π6: total students sharing an abstract room at one instant vs its ceiling
  for (const [k, arr] of absB) {
    const cap = absById.get(k.split('|')[0])?.capacity;
    if (cap == null) continue;
    for (const week of [1, 2]) {
      const inWeek = arr.filter((x) => x.parity === 0 || x.parity === week);
      const starts = [...new Set(inWeek.map((x) => x.s))];
      for (const t of starts) {
        const sum = inWeek.filter((x) => x.s <= t && t < x.e).reduce((a, x) => a + x.students, 0);
        if (sum > cap) V.abstractRoomOverflow++;
      }
    }
  }

  // Π7/Π8 windows, averaged over the two weeks, and Π9 mixed days
  // A вікно is a whole пара the entity could have been taught in and was not: what is counted is
  // the number of bell start times falling in each gap. Consecutive classes leave no start time
  // between them and cost nothing; a skipped пара costs one. Counting raw idle minutes instead
  // charges the ordinary break between two bells, which would call a perfectly packed day full of
  // windows.
  const allStarts = [...new Set(problem.classTimes.map((t) => toMin(t.startTime)))].sort((a, b) => a - b);
  const freeStartsBetween = (from, to) => allStarts.reduce((n, t) => (t >= from && t < to ? n + 1 : n), 0);
  const windows = (buckets, into) => {
    for (const arr of buckets.values()) {
      let tot = 0;
      for (const week of [1, 2]) {
        const day = arr.filter((x) => x.parity === 0 || x.parity === week).sort((a, b) => a.s - b.s);
        if (day.length < 2) continue;
        let reach = day[0].e;
        for (let i = 1; i < day.length; i++) {
          if (day[i].s > reach) tot += freeStartsBetween(reach, day[i].s);
          reach = Math.max(reach, day[i].e);
        }
      }
      into(tot / 2);
    }
  };
  let lw = 0, gw = 0;
  windows(lecB, (x) => { lw += x; });
  windows(grpB, (x) => { gw += x; });
  V.lecturerWindows = Math.round(lw); V.groupWindows = Math.round(gw);

  for (const arr of grpB.values()) for (const week of [1, 2]) {
    const day = arr.filter((x) => x.parity === 0 || x.parity === week);
    if (day.some((x) => x.online) && day.some((x) => !x.online)) V.mixedOnlineDays += 0.5;
  }
  V.mixedOnlineDays = Math.round(V.mixedOnlineDays);

  // ── scheduling constraints: "more specific wins", UNAVAILABLE accumulates ──
  const checkSubject = (map, buckets) => {
    for (const [k, arr] of buckets) {
      const [id, dayStr] = k.split('|'); const day = Number(dayStr);
      const list = map.get(id); if (!list) continue;
      const forDay = (type) => { const d = list.find((c) => c.type === type && c.dayOfWeek === day); return d ?? list.find((c) => c.type === type && c.dayOfWeek === null); };
      const nb = forDay('NOT_BEFORE'), na = forDay('NOT_AFTER'), mx = forDay('MAX_CLASSES_PER_DAY');
      for (const ev of arr) {
        if (nb && ev.s < toMin(nb.value)) F.constraintBreaches++;
        if (na && ev.e > toMin(na.value)) F.constraintBreaches++;
      }
      if (mx) for (const week of [1, 2]) {
        const n = arr.filter((x) => x.parity === 0 || x.parity === week).length;
        if (n > Number(mx.value)) F.constraintBreaches++;
      }
      for (const c of list.filter((c) => c.type === 'UNAVAILABLE' && (c.dayOfWeek === null || c.dayOfWeek === day))) {
        const from = toMin(c.value.slice(0, 5)), to = toMin(c.value.slice(6, 11));
        for (const ev of arr) if (overlaps(ev.s, ev.e, from, to)) F.constraintBreaches++;
      }
    }
  };
  checkSubject(cons.lec, lecB); checkSubject(cons.grp, grpB); checkSubject(cons.room, roomB);

  const hard = V.lecturerConflicts + V.groupConflicts + V.roomConflicts + V.groupTravel + V.lecturerTravel + V.abstractRoomOverflow;
  const soft = V.lecturerWindows + V.groupWindows + V.mixedOnlineDays;
  const W = { lecturerConflicts: 150, groupConflicts: 100, roomConflicts: 50, groupTravel: 90, lecturerTravel: 120,
              abstractRoomOverflow: 50, lecturerWindows: 5, groupWindows: 20, mixedOnlineDays: 30 };
  const objective = Object.entries(W).reduce((a, [k, w]) => a + w * V[k] * V[k], 0);
  return { violations: V, filters: F, hard, soft, objective,
           feasible: hard === 0 && F.unplaced === 0 && F.badRoom === 0 && F.badBellSet === 0 && F.constraintBreaches === 0 && F.duplicates === 0 };
}
