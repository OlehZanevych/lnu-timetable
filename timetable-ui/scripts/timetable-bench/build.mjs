#!/usr/bin/env node
/**
 * Builds a UCTP instance AROUND A HIDDEN FEASIBLE SCHEDULE, by constructing the schedule first and
 * deriving the instance from it.
 *
 * The order is the whole point. Generating plausible requirements and then searching for a
 * schedule reproduces the problem being studied — and when the search stalls you cannot tell an
 * over-constrained instance from a weak algorithm. So this walks the week slot by slot and *places*
 * classes into free resources: a conflict is impossible by construction, the pass is O(n), and it
 * cannot fail. Courses, cohorts and eligibility are then read back off the result, and every
 * scheduling constraint is derived so the hidden schedule satisfies it.
 *
 * A perfect schedule therefore provably exists. Anything the solver cannot reach is a property of
 * the search.
 *
 * Structural rules that keep it realistic *and* keep travel satisfiable:
 *   · a cohort is taught in its home корпус; спорткомплекс is a корпус of its own
 *   · a lecturer stays in one корпус for a whole day (which is what timetables actually do)
 *   · a cohort's online classes sit on that cohort's online day, so no day mixes online with
 *     in-room — except for a deliberate minority, which get the full commute gap
 */
const HOUR_MIN = 40, DURATION = 2, CLASS_MIN = DURATION * HOUR_MIN;
const DAYS = [1, 2, 3, 4, 5, 6];
const MAIN_BELLS = [8 * 60 + 30, 10 * 60 + 10, 11 * 60 + 50, 13 * 60 + 30, 15 * 60 + 5, 16 * 60 + 45];
const PE_BELLS = [8 * 60, 9 * 60 + 40, 11 * 60 + 20, 13 * 60, 14 * 60 + 40];
const ABSTRACT_TRAVEL = 60, COMMUTE = 80;

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const irand = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, xs) => xs[Math.min(xs.length - 1, Math.floor(r() * xs.length))];
const shuffle = (r, xs) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function build(nClasses, seed = 1, opts = {}) {
  const cfg = { onlineShare: 0.08, peShare: 0.03, biweeklyShare: 0.12, unrestrictedShare: 0.15,
                mixedDayShare: 0.10, roomSlack: 1.15, externalShare: 0.04,
                lecturerConstraintShare: 0.35, groupConstraintShare: 0.20, roomConstraintShare: 0.15, ...opts };
  const r = rng(seed);

  const nGroups = Math.max(3, Math.round(nClasses / 15));
  const nLecturers = Math.max(3, Math.round(nClasses / 9));
  const nRooms = Math.max(6, Math.round((nClasses / 22) * cfg.roomSlack));
  const nAcademic = Math.min(5, Math.max(1, 1 + Math.floor(nClasses / 250)));   // teaching корпуси
  const buildings = [...Array.from({ length: nAcademic }, (_, i) => `b${i + 1}`), 'bsport'];

  // travel: directed, asymmetric, and long enough between some pairs that back-to-back across
  // them is impossible (the bell pitch leaves 20 minutes).
  const travel = new Map();
  for (const a of buildings) for (const b of buildings) if (a !== b) travel.set(`${a}>${b}`, r() < 0.3 ? irand(r, 22, 30) : irand(r, 7, 18));

  const rooms = [];
  for (let i = 0; i < nRooms; i++) {
    const roll = r();
    const kind = roll < 0.18 ? 'LECTURE_HALL' : roll < 0.42 ? 'COMPUTER_LAB' : 'SEMINAR_ROOM';
    rooms.push({ id: `r${i + 1}`, kind,
      capacity: kind === 'LECTURE_HALL' ? irand(r, 90, 220) : kind === 'COMPUTER_LAB' ? irand(r, 14, 30) : irand(r, 26, 40),
      buildingId: buildings[Math.min(nAcademic - 1, Math.floor(i * nAcademic / nRooms))] });
  }
  const roomBuilding = new Map(rooms.map((x) => [x.id, x.buildingId]));
  const roomsIn = (b, kind) => rooms.filter((x) => x.buildingId === b && (!kind || x.kind === kind));

  const groups = Array.from({ length: nGroups }, (_, i) => ({ id: `g${i + 1}`, studentsCount: irand(r, 18, 30) }));
  const lecturers = Array.from({ length: nLecturers }, (_, i) => ({ id: `l${i + 1}` }));
  const studentsOfMap = new Map(groups.map((g) => [g.id, g.studentsCount]));
  const studentsOf = (ids) => ids.reduce((s, id) => s + (studentsOfMap.get(id) ?? 0), 0);

  const cohorts = [];
  { let i = 0, c = 0;
    while (i < nGroups) { const k = Math.min(nGroups - i, irand(r, 1, 3));
      cohorts.push({ id: `co${c + 1}`, groupIds: groups.slice(i, i + k).map((g) => g.id),
        home: buildings[c % nAcademic], onlineDay: (r() < 0.5 ? DAYS[(c * 2 + 1) % DAYS.length] : null),
        peDay: DAYS[(c * 3 + 2) % DAYS.length], mixed: r() < cfg.mixedDayShare });
      i += k; c++; } }
  const cohortOfGroup = new Map(); cohorts.forEach((c) => c.groupIds.forEach((g) => cohortOfGroup.set(g, c)));

  const abstractRooms = [
    { id: 'ar-sport', name: 'Спортивні зали', capacity: null, buildingId: 'bsport' },
    { id: 'ar-remote', name: 'Дистанційно', capacity: null, buildingId: null }
  ];

  const classTimes = [];
  MAIN_BELLS.forEach((m, i) => classTimes.push({ id: `t${i + 1}`, setId: 'main', ordinal: i + 1, startTime: hhmm(m) }));
  PE_BELLS.forEach((m, i) => classTimes.push({ id: `p${i + 1}`, setId: 'pe', ordinal: i + 1, startTime: hhmm(m) }));
  const mainTimes = classTimes.filter((t) => t.setId === 'main');
  const peTimes = classTimes.filter((t) => t.setId === 'pe');
  const minOf = new Map(classTimes.map((t) => [t.id, t.startTime.split(':').reduce((h, m) => Number(h) * 60 + Number(m))]));

  // ── occupancy, keyed by (day, startMinute) so the two bell grids interleave correctly ────────
  const busyLec = new Map(), busyGrp = new Map(), busyRoom = new Map();
  const key = (id, day) => `${id}|${day}`;
  const overlapsAny = (m, id, day, s, e) => { const arr = m.get(key(id, day)); if (!arr) return false; return arr.some((x) => s < x.e && x.s < e); };
  const put = (m, id, day, s, e) => { const k = key(id, day); let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push({ s, e }); };
  const dayOf = new Map();  // lecturer|day -> building, so a lecturer stays put for the day

  const sessions = [];
  let courseNo = 0;

  const freeLecturerFor = (day, s, e, building) => {
    const pool = shuffle(r, lecturers);
    for (const l of pool) {
      if (overlapsAny(busyLec, l.id, day, s - 1, e + 1)) continue;
      const b = dayOf.get(key(l.id, day));
      if (b && b !== building) continue;
      return l.id;
    }
    return null;
  };
  const freeRoomFor = (day, s, e, building, kind) => {
    const pool = shuffle(r, roomsIn(building, kind));
    for (const x of pool) if (!overlapsAny(busyRoom, x.id, day, s, e)) return x.id;
    const any = shuffle(r, roomsIn(building, null));
    for (const x of any) if (!overlapsAny(busyRoom, x.id, day, s, e)) return x.id;
    return null;
  };

  const emit = (cohort, groupIds, hourType, day, t, roomId, kind) => {
    const s = minOf.get(t.id), e = s + CLASS_MIN;
    const lect = freeLecturerFor(day, s, e, kind === 'PE' ? 'bsport' : (kind === 'ONLINE' ? 'online' : cohort.home));
    if (!lect) return false;
    for (const g of groupIds) if (overlapsAny(busyGrp, g, day, s, e)) return false;
    if (roomId && overlapsAny(busyRoom, roomId, day, s, e)) return false;
    put(busyLec, lect, day, s, e);
    for (const g of groupIds) put(busyGrp, g, day, s, e);
    if (roomId) put(busyRoom, roomId, day, s, e);
    dayOf.set(key(lect, day), kind === 'ONLINE' ? 'online' : (kind === 'PE' ? 'bsport' : cohort.home));
    sessions.push({ cohort, groupIds: groupIds.slice(), hourType, day, timeId: t.id, s, e, roomId,
                    lecturerId: lect, kind, course: 0, parity: 0 });
    return true;
  };

  // ── slot-major fill ───────────────────────────────────────────────────────
  const mainQuota = Math.max(1, Math.round(nClasses * (1 - cfg.peShare)));
  outer:
  for (const day of DAYS) {
    for (const t of mainTimes) {
      for (const cohort of shuffle(r, cohorts)) {
        if (sessions.length >= mainQuota) break outer;
        const online = cohort.onlineDay !== null && day === cohort.onlineDay;
        const kind = online ? 'ONLINE' : 'NORMAL';
        // a lecture for the whole cohort, or a practical per group
        if (r() < 1 / (1 + cohort.groupIds.length)) {
          const roomId = kind === 'ONLINE' ? null : freeRoomFor(day, minOf.get(t.id), minOf.get(t.id) + CLASS_MIN, cohort.home, 'LECTURE_HALL');
          if (kind === 'ONLINE' || roomId) emit(cohort, cohort.groupIds, 'LECTURE', day, t, roomId, kind);
        } else {
          for (const g of cohort.groupIds) {
            if (sessions.length >= mainQuota) break outer;
            const hourType = r() < 0.4 ? 'LAB' : 'PRACTICAL';
            const roomId = kind === 'ONLINE' ? null : freeRoomFor(day, minOf.get(t.id), minOf.get(t.id) + CLASS_MIN, cohort.home, hourType === 'LAB' ? 'COMPUTER_LAB' : 'SEMINAR_ROOM');
            if (kind === 'ONLINE' || roomId) emit(cohort, [g], hourType, day, t, roomId, kind);
          }
        }
      }
    }
  }

  // Физвиховання on the спорткомплекс grid: first bell of the cohort's PE day, so the journey
  // there and back has the whole gap to the next main bell.
  for (const cohort of shuffle(r, cohorts)) {
    if (sessions.length >= nClasses) break;
    const t = peTimes[0], s = minOf.get(t.id), e = s + CLASS_MIN;
    const need = travel.get(`bsport>${cohort.home}`) ?? 0;
    const clash = cohort.groupIds.some((g) => { const a = busyGrp.get(key(g, cohort.peDay)) ?? []; return a.some((x) => (x.s < e && s < x.e) || (x.s >= e && x.s - e < need) || (x.e <= s && s - x.e < need)); });
    if (!clash) emit(cohort, cohort.groupIds, 'PRACTICAL', cohort.peDay, t, null, 'PE');
  }

  // Top up to the exact requested count if the PE pass could not use its whole reservation.
  if (sessions.length < nClasses) {
    top:
    for (const day of DAYS) for (const t of mainTimes) for (const cohort of shuffle(r, cohorts)) {
      if (sessions.length >= nClasses) break top;
      if (cohort.onlineDay !== null && day === cohort.onlineDay) continue;
      const g = pick(r, cohort.groupIds);
      const hourType = r() < 0.4 ? 'LAB' : 'PRACTICAL';
      const roomId = freeRoomFor(day, minOf.get(t.id), minOf.get(t.id) + CLASS_MIN, cohort.home, hourType === 'LAB' ? 'COMPUTER_LAB' : 'SEMINAR_ROOM');
      if (roomId) emit(cohort, [g], hourType, day, t, roomId, 'NORMAL');
    }
  }

  // ── courses, read back off the schedule ───────────────────────────────────
  // A course is a lecture stream plus the practicals of the cohort that follow it — which is how
  // the model actually works (one curriculum_item_hours row per kind, one working item per
  // department), and it is what makes the reported course count mean anything.
  {
    let n = 0;
    const perCohort = new Map();
    for (const s2 of sessions) { let a = perCohort.get(s2.cohort.id); if (!a) { a = []; perCohort.set(s2.cohort.id, a); } a.push(s2); }
    for (const [, list] of perCohort) {
      let cur = null, taken = 0;
      const size = 1 + (list[0]?.cohort.groupIds.length ?? 1);
      for (const s2 of list) {
        if (cur === null || s2.hourType === 'LECTURE' || taken >= size) { cur = ++n; taken = 0; }
        s2.course = cur; taken++;
      }
    }
    courseNo = n;
  }

  return { cfg, seed, nClasses, courseNo, r, sessions, rooms, roomBuilding, roomsIn, groups, lecturers,
           buildings, nAcademic, travel, abstractRooms, classTimes, mainTimes, peTimes, minOf,
           cohorts, cohortOfGroup, studentsOf, busyLec, busyGrp, busyRoom };
}
