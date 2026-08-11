#!/usr/bin/env node
/**
 * Turns a hidden schedule into the SolverProblem the solver is given, and the reference solution
 * it is scored against.
 *
 * Every scheduling constraint here is DERIVED FROM the hidden schedule — a lecturer's NOT_BEFORE
 * is set at or below their earliest class, an UNAVAILABLE window is carved out of a gap they
 * genuinely have, an abstract room's capacity is its busiest slot — so the hidden schedule
 * satisfies all of them by construction. The constraints are real restrictions on the search
 * (they rule out most of the space) without ruling out the optimum.
 */
import { build } from './build.mjs';

const HOUR_MIN = 40, CLASS_MIN = 80;
const DAYS = [1, 2, 3, 4, 5, 6];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shuffle = (r, xs) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const irand = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

export function emit(nClasses, seed = 1, opts = {}) {
  const b = build(nClasses, seed, opts);
  const { r, cfg, sessions, rooms, roomBuilding, groups, lecturers, travel, abstractRooms,
          classTimes, mainTimes, peTimes, minOf, cohorts } = b;

  // biweekly: a weekly class that is conflict-free stays conflict-free on a subset of weeks, so
  // this can never make the hidden schedule invalid — it only widens the solver's choice.
  for (const s of sessions) if (s.kind !== 'PE' && r() < cfg.biweeklyShare) s.parity = r() < 0.5 ? 1 : 2;

  // eligibility: the room it actually sits in, plus a few plausible alternatives of the same kind
  // in the same корпус. A share name no room at all (unrestricted).
  const roomsLike = (id) => { const me = rooms.find((x) => x.id === id); return rooms.filter((x) => x.buildingId === me.buildingId && x.kind === me.kind).map((x) => x.id); };

  const externalCount = Math.round(sessions.length * cfg.externalShare);
  const externalSet = new Set(shuffle(r, sessions.map((_, i) => i)).slice(0, externalCount));

  const requirements = [], fixedEntries = [], hidden = [];
  sessions.forEach((s, i) => {
    const parityName = s.parity === 0 ? 'WEEKLY' : s.parity === 1 ? 'NUMERATOR' : 'DENOMINATOR';
    if (externalSet.has(i)) {
      fixedEntries.push({ id: `x${i}`, dayOfWeek: s.day, weekParity: parityName, startTime: hhmm(s.s),
        durationHours: 2, lecturerIds: [s.lecturerId], groupIds: s.groupIds, roomId: s.roomId ?? null,
        abstractRoomId: s.kind === 'PE' ? 'ar-sport' : null, isOnline: s.kind === 'ONLINE',
        studentsCount: b.studentsOf(s.groupIds) });
      return;
    }
    const unrestricted = s.kind === 'NORMAL' && r() < cfg.unrestrictedShare;
    requirements.push({
      key: `k${i}`, workloadId: `w${i}`, entryId: null,
      courseName: `Дисципліна ${s.course}`, hourType: s.hourType, durationHours: 2,
      classStartTimeSetId: s.kind === 'PE' ? 'pe' : 'main',
      lecturerIds: [s.lecturerId], groupIds: s.groupIds,
      roomIds: (s.kind !== 'NORMAL' || unrestricted) ? [] : [...new Set([s.roomId, ...shuffle(r, roomsLike(s.roomId)).slice(0, irand(r, 1, 4))])],
      abstractRoomId: s.kind === 'PE' ? 'ar-sport' : null,
      isOnline: s.kind === 'ONLINE', studentsCount: b.studentsOf(s.groupIds),
      isBiweekly: s.parity !== 0, current: null, locked: false
    });
    const t = classTimes.find((x) => minOf.get(x.id) === s.s && x.setId === (s.kind === 'PE' ? 'pe' : 'main'));
    hidden.push({ key: `k${i}`, dayOfWeek: s.day, classStartTimeId: t.id, roomId: s.roomId ?? null, weekParity: parityName });
  });

  // ── constraints derived from the hidden schedule ──────────────────────────
  const dayMap = (list, idOf) => { const m = new Map(); for (const s of list) { const id = idOf(s); let d = m.get(id); if (!d) { d = new Map(); m.set(id, d); } let a = d.get(s.day); if (!a) { a = []; d.set(s.day, a); } a.push(s); } return m; };
  const lecDays = dayMap(sessions, (s) => s.lecturerId);
  const grpDays = new Map();
  for (const s of sessions) for (const g of s.groupIds) { let d = grpDays.get(g); if (!d) { d = new Map(); grpDays.set(g, d); } let a = d.get(s.day); if (!a) { a = []; d.set(s.day, a); } a.push(s); }
  const roomDays = dayMap(sessions.filter((s) => s.roomId), (s) => s.roomId);

  const derive = (byDay, share) => {
    const out = [];
    if (r() > share) return out;
    const all = [...byDay.values()].flat();
    if (!all.length) return out;
    const roll = r();
    if (roll < 0.3) {
      // NOT_BEFORE at or below the earliest class actually held
      const earliest = Math.min(...all.map((s) => s.s));
      out.push({ type: 'NOT_BEFORE', dayOfWeek: null, value: hhmm(Math.max(0, Math.floor(earliest / 30) * 30)) });
    } else if (roll < 0.6) {
      const latest = Math.max(...all.map((s) => s.e));
      out.push({ type: 'NOT_AFTER', dayOfWeek: null, value: hhmm(Math.min(23 * 60 + 59, Math.ceil(latest / 30) * 30)) });
    } else if (roll < 0.85) {
      // MAX_CLASSES_PER_DAY at the busiest day actually worked
      const worst = Math.max(...[...byDay.values()].map((a) => a.length));
      out.push({ type: 'MAX_CLASSES_PER_DAY', dayOfWeek: null, value: String(Math.max(1, worst)) });
    } else {
      // UNAVAILABLE over a window genuinely free on one day
      const day = [...byDay.keys()][Math.floor(r() * byDay.size)];
      const busy = (byDay.get(day) ?? []).map((s) => [s.s, s.e]).sort((a, c) => a[0] - c[0]);
      let from = 8 * 60, to = 22 * 60;
      for (const [s2, e2] of busy) { if (from < s2) { to = s2; break; } from = Math.max(from, e2); }
      if (to - from >= 30) out.push({ type: 'UNAVAILABLE', dayOfWeek: day, value: `${hhmm(from)}-${hhmm(Math.min(to, from + 120))}` });
    }
    return out;
  };

  const lecturerConstraints = [], groupConstraints = [], roomConstraints = [];
  for (const [id, byDay] of lecDays) { const c = derive(byDay, cfg.lecturerConstraintShare); if (c.length) lecturerConstraints.push([id, c]); }
  for (const [id, byDay] of grpDays) { const c = derive(byDay, cfg.groupConstraintShare); if (c.length) groupConstraints.push([id, c]); }
  for (const [id, byDay] of roomDays) { const c = derive(byDay, cfg.roomConstraintShare); if (c.length) roomConstraints.push([id, c]); }

  // abstract-room capacity: exactly the busiest slot of the hidden schedule, so the ceiling binds
  // and is still satisfiable.
  const load = new Map();
  for (const s of sessions) {
    if (s.kind !== 'PE') continue;
    const k = `ar-sport|${s.day}|${s.s}|${s.parity}`;
    load.set(k, (load.get(k) ?? 0) + b.studentsOf(s.groupIds));
  }
  const peak = load.size ? Math.max(...load.values()) : 0;
  const ars = abstractRooms.map((a) => ({ ...a, capacity: a.id === 'ar-sport' && peak > 0 ? peak : null }));

  const problem = {
    requirements, fixedEntries, classTimes,
    rooms: rooms.map((x) => x.id),
    academicHourMinutes: HOUR_MIN, days: DAYS,
    lecturerConstraints, groupConstraints, roomConstraints,
    roomBuilding: [...roomBuilding.entries()],
    buildingTravel: [...travel.entries()],
    abstractRooms: ars,
    abstractRoomTravelMinutes: 60,
    universityCommuteMinutes: 80
  };
  const meta = { nClasses, seed, courses: b.courseNo, groups: groups.length, lecturers: lecturers.length,
                 rooms: rooms.length, buildings: b.buildings.length, requirements: requirements.length,
                 fixedEntries: fixedEntries.length,
                 constraints: lecturerConstraints.length + groupConstraints.length + roomConstraints.length,
                 online: sessions.filter((s) => s.kind === 'ONLINE').length,
                 pe: sessions.filter((s) => s.kind === 'PE').length,
                 biweekly: sessions.filter((s) => s.parity !== 0).length };
  return { problem, hidden, meta };
}
