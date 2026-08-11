/**
 * University Course Timetabling solver — pure TypeScript, no Angular, no GraphQL, no I/O.
 *
 * The formulation follows «Adaptive Memetic Algorithm for University Course Timetabling»
 * (see ../../Articles/memetic-algorithms): a *class requirement* is a lecturer + groups +
 * periodicity, and a schedule assigns it a day, a start time, a room and — for biweekly
 * requirements — a week parity. The objective is the article's Eq. (1),
 *
 *     f(σ) = Σ_{i=1..9} β_i · Π_i(σ)^{α_i},   β = (150, 100, 50, 90, 120, 50, 5, 20, 30),  α_i = 2
 *
 * with Π₁/Π₂/Π₃ counting lecturer/group/room conflicts, Π₄/Π₅ pairs of classes a group or a
 * lecturer is not given time to walk between, Π₆ the abstract rooms holding more students in one
 * slot than they seat, Π₇/Π₈ the idle windows in lecturers' and groups' days, and Π₉ the days on
 * which one group is sent both online and into a room. The first six are hard (see `hardOf`),
 * which is why they are numbered together. The search is the article's two-phase multi-neighbourhood local
 * search (N1 reassignment / N2 swap / N3 chain move under simulated-annealing acceptance and a
 * tabu list, then a bounded window-reduction phase) driven by an effectiveness-adaptive
 * intensity, started from a most-constrained-first greedy construction rather than from a random
 * population — see TIMETABLE-GENERATION.md for why, and for every deviation from the paper.
 *
 * Everything the LNU model adds on top of the paper's abstract instance is handled as a **hard
 * filter** rather than as a penalty: a placement is only ever considered if the room is one the
 * workload allows, the start time belongs to the workload's own grid of bells, and none of the
 * lecturer/group/room scheduling constraints (NOT_BEFORE, NOT_AFTER, UNAVAILABLE,
 * MAX_CLASSES_PER_DAY) forbid it. A requirement with no admissible placement at all is left
 * unplaced and reported, never squeezed in by breaking a rule.
 */

// ── Public shapes ───────────────────────────────────────────────────────────

/** timetable_entries.week_parity. */
export type WeekParity = 'WEEKLY' | 'NUMERATOR' | 'DENOMINATOR';

/** timetable_constraint_type — the four scheduling restrictions, shared by all three subjects. */
export type ConstraintType = 'MAX_CLASSES_PER_DAY' | 'NOT_BEFORE' | 'NOT_AFTER' | 'UNAVAILABLE';

/** One row of lecturer_/academic_group_/room_timetable_constraints. */
export interface SolverConstraint {
  type: ConstraintType;
  /** null = every day; 1..7 = that day only (a day rule overrides the every-day rule of its type). */
  dayOfWeek: number | null;
  /** 'N' | 'HH:MM' | 'HH:MM-HH:MM', exactly as stored. */
  value: string;
}

/** One class_start_times row, flattened with the set it belongs to. */
export interface SolverClassTime {
  id: string;
  setId: string;
  ordinal: number;
  /** "HH:MM" */
  startTime: string;
}

/** A day/time/room/parity assignment — one timetable_entries row. */
export interface SolverPlacement {
  dayOfWeek: number;
  classStartTimeId: string;
  /**
   * `timetable_entries.room_id`, which is nullable: a class held in an abstract room shares a
   * place with several others and has nothing to allocate, and a class held online has nowhere to
   * be. Both write NULL — *which* of the two it is is read from the workload, not copied here.
   * A null is therefore a real placement, not an unplaced class.
   */
  roomId: string | null;
  weekParity: WeekParity;
}

/** One class session that has to be placed (the article's "class requirement"). */
export interface SolverRequirement {
  /** Stable identity of the block this requirement came from (workloadId::wk|bi::index). */
  key: string;
  workloadId: string;
  /** Existing timetable_entries row, when this session is already scheduled. */
  entryId: string | null;
  courseName: string;
  hourType: string;
  durationHours: number;
  /** Which grid of bells this workload's classes run on. */
  classStartTimeSetId: string;
  lecturerIds: string[];
  /** Academic groups actually attending — a workload's own groups plus every combined group's members. */
  groupIds: string[];
  /** Rooms the workload allows (rooms ∪ roomGroups). Empty means unrestricted — but only for a
   *  class that is in a room at all; see `abstractRoomId` and `isOnline`. */
  roomIds: string[];
  /**
   * The one `abstract_rooms` row this class is held in — a place several classes legitimately
   * share at the same hour («Спортивні зали»). An alternative to `roomIds`, not an addition to
   * them, so a class with one is in no room and takes part in no room conflict.
   */
  abstractRoomId: string | null;
  /**
   * Held online — `lecturer_workload_online_classes` has a row for this workload, whose presence
   * *is* the fact. No place at all, so again no room and no room conflict. Read before
   * `abstractRoomId`, which is read before `roomIds`.
   */
  isOnline: boolean;
  /**
   * How many students attend, summed over the groups (`academic_groups.students_count`) — what an
   * abstract room's capacity caps, across every class sharing it in one slot. The column is
   * nullable and an unknown count contributes 0: an unentered figure is not evidence of a crowd,
   * and inventing one would reject placements the data does not object to.
   */
  studentsCount: number;
  /** Held every second week, so the solver also chooses NUMERATOR / DENOMINATOR. */
  isBiweekly: boolean;
  /** Where it currently sits, if anywhere. */
  current: SolverPlacement | null;
  /** Keep the current placement untouched (the "fill the gaps only" mode). */
  locked: boolean;
}

/**
 * A class this run must schedule *around* but may never move: another faculty's entry that
 * occupies one of our rooms, one of our lecturers, or one of our academic groups.
 */
export interface SolverFixedEntry {
  id: string;
  dayOfWeek: number;
  weekParity: WeekParity;
  /** "HH:MM" */
  startTime: string;
  durationHours: number;
  lecturerIds: string[];
  groupIds: string[];
  roomId: string | null;
  /** The abstract room this external class occupies, if any — its students count against that
   *  place's capacity exactly as ours do, whoever owns the class. */
  abstractRoomId: string | null;
  /** Held online, so it occupies nothing and only its people's time is taken. */
  isOnline: boolean;
  /** Students attending, for the abstract-room capacity ceiling; 0 when unknown. */
  studentsCount: number;
}

/**
 * One `abstract_rooms` row: a place several classes share at the same hour.
 *
 * Deliberately not a room. Nothing that reasons about room exclusivity reads these, which is the
 * whole point — «Спортивні зали» holding the groups of half a faculty at once is not a clash. What
 * it does have is a `capacity`, and unlike a room's that is a ceiling on the **total** students of
 * every class sharing it in one slot rather than on the size of any one of them.
 */
export interface SolverAbstractRoom {
  id: string;
  name: string;
  /** null = unlimited; the ceiling is on the sum of the students of everything in it at once. */
  capacity: number | null;
  /** Where it is. null = no address at all, and the flat `abstractRoomTravelMinutes` applies. */
  buildingId: string | null;
}

export interface SolverProblem {
  requirements: SolverRequirement[];
  fixedEntries: SolverFixedEntry[];
  classTimes: SolverClassTime[];
  /** Every room this faculty may schedule into — the fallback domain for an unrestricted workload. */
  rooms: string[];
  /** global_properties.academic_hour_duration_minutes */
  academicHourMinutes: number;
  /** Working days, 1 = Monday. */
  days: number[];
  lecturerConstraints: Map<string, SolverConstraint[]>;
  groupConstraints: Map<string, SolverConstraint[]>;
  roomConstraints: Map<string, SolverConstraint[]>;
  /**
   * Which building each room is in. A room missing from the map is treated as being nowhere in
   * particular: no journey to or from it is ever too short, because the alternative is inventing a
   * constraint out of an absent `rooms.building_id`.
   */
  roomBuilding: Map<string, string>;
  /**
   * How long it takes to get from one building to another, keyed `fromId + '>' + toId`, in minutes
   * — `building_travel_times`, which is directed and may disagree with itself in the two
   * directions. A pair with no entry is treated as reachable instantly, for the same reason.
   */
  buildingTravel: Map<string, number>;
  /** Every abstract room any class of this run — ours or an external one — is held in. */
  abstractRooms: SolverAbstractRoom[];
  /**
   * `global_properties.abstract_room_travel_time_minutes` — the journey to or from an abstract
   * room that has no building, which is the only figure there can be when there is no address to
   * measure from. Non-positive (a blank property) reads as "no journey", as everywhere else here.
   */
  abstractRoomTravelMinutes: number;
  /**
   * `global_properties.university_commute_time_minutes` — how long it takes to get between home
   * and the university, which is the gap a day mixing an online class with an in-room one has to
   * leave. Non-positive reads as "no journey".
   */
  universityCommuteMinutes: number;
}

export interface SolverOptions {
  /** Outer iterations (one local-search round each). */
  maxIterations: number;
  /** Wall-clock budget; the run stops at whichever of the two comes first. */
  timeLimitMs: number;
  /** Phase-1 passes per outer iteration. */
  repairIterations: number;
  /** W_max — window-reducing moves per Phase 2 invocation. */
  windowMoves: number;
  tabuTenure: number;
  initialTemperature: number;
  coolingFactor: number;
  /** Outer iterations without global improvement before the schedule is perturbed. */
  stagnationLimit: number;
  /** Fraction of genes Phase 1 examines, adapted by Eq. (5). */
  intensity: number;
  minIntensity: number;
  maxIntensity: number;
  /** δ — the adaptation step of Eq. (5). */
  adaptationStep: number;
  seed: number;
}

export const DEFAULT_OPTIONS: SolverOptions = {
  // Deliberately far above what any run reaches: the wall-clock budget is the real bound, and an
  // iteration cap low enough to bite would stop a small instance while it still had seconds of
  // window reduction left to do. It stays as a backstop against a pathological zero-cost loop.
  maxIterations: 1_000_000,
  timeLimitMs: 30_000,
  repairIterations: 40,
  windowMoves: 5,
  tabuTenure: 6,
  initialTemperature: 2.5,
  coolingFactor: 0.92,
  stagnationLimit: 30,
  intensity: 0.35,
  minIntensity: 0.15,
  maxIntensity: 1.0,
  adaptationStep: 0.02,
  seed: 20260802
};

/** The article's β weights and α exponents (Eq. 1). */
export const OBJECTIVE_WEIGHTS = {
  lecturerConflicts: 150,
  groupConflicts: 100,
  roomConflicts: 50,
  // Π₄/Π₅ — a group or a lecturer given less time between two classes than the walk between their
  // buildings takes. Weighted just below the corresponding double-booking, and for the same reason
  // it is *below*: a clash makes a timetable impossible, an unreachable pair makes it late. Both
  // are hard — see `hardOf` — because a schedule nobody can physically keep is not a schedule.
  groupTravel: 90,
  lecturerTravel: 120,
  // Π₆ — an abstract room holding more students in one slot than it seats. The room-exclusivity
  // constraint in the form a *shared* place takes it: Π₃ asks "is more than one class here?",
  // this asks "are more students here than fit?", so it carries the same weight. Hard, for the
  // same reason Π₃ is — a place that cannot hold the cohort does not hold the class.
  abstractRoomOverflow: 50,
  lecturerWindows: 5,
  groupWindows: 20,
  // Π₉ — (group, day, week) triples mixing an online class with an in-room one. Soft: the deanery
  // prefers online days and campus days kept apart, but a group with a single online class in the
  // week cannot always have that. Above a group window (20) because a mixed day costs the group a
  // whole university_commute_time_minutes journey — 80 minutes, two academic hours, where one
  // window unit is one — and below it doubled, because Π₉ is bounded by groups × days while Π₇/Π₈
  // grow with the class count, so at equal weight the squared mixed term would swamp the window
  // reduction that is most of what the search spends its budget on. Below every hard β, so the
  // modal's table still reads hard-above-soft.
  mixedOnlineDays: 30
} as const;

export const OBJECTIVE_EXPONENT = 2;

/** Π₁..Π₉ of Eq. (1), in declaration order, so a result can be read as well as compared. */
export interface Violations {
  lecturerConflicts: number;
  groupConflicts: number;
  roomConflicts: number;
  /** Consecutive classes a group cannot physically get between in the gap they are given. */
  groupTravel: number;
  /** The same for a lecturer, who walks the same streets. */
  lecturerTravel: number;
  /** (abstract room, day, week, instant) points whose classes hold more students than it seats. */
  abstractRoomOverflow: number;
  lecturerWindows: number;
  groupWindows: number;
  /** (group, day, week) triples on which the group is sent both online and into a room. */
  mixedOnlineDays: number;
}

export type SolverPhase = 'PREPARE' | 'CONSTRUCT' | 'REPAIR' | 'WINDOWS' | 'PERTURB' | 'DONE';

export interface SolverProgress {
  phase: SolverPhase;
  iteration: number;
  maxIterations: number;
  elapsedMs: number;
  /** f(σ) of the best schedule found so far. */
  objective: number;
  violations: Violations;
  /** Π₁..Π₆ — the hard terms, i.e. how far the best schedule still is from feasibility. */
  hardTotal: number;
  placed: number;
  total: number;
  unplaced: number;
  temperature: number;
  intensity: number;
  stagnation: number;
  /**
   * The best schedule so far, attached to roughly one progress message a second.
   *
   * It exists so a run can be stopped and still produce something applicable: the solver is one
   * synchronous loop, so a worker running it cannot read a `cancel` message until it finishes, and
   * the only way to stop it early is to terminate the worker — which discards whatever it held.
   */
  assignments?: SolverAssignment[];
}

/** One remaining clash, named in the terms the user entered the data in. */
export interface SolverConflict {
  kind: 'LECTURER' | 'GROUP' | 'ROOM' | 'GROUP_TRAVEL' | 'LECTURER_TRAVEL' | 'ABSTRACT_ROOM_CAPACITY';
  subjectId: string;
  dayOfWeek: number;
  /** Both sides of the clash, by requirement key. */
  keys: [string, string];
  descriptions: [string, string];
}

export interface SolverAssignment {
  key: string;
  /** null when the requirement could not be placed at all. */
  placement: SolverPlacement | null;
}

export interface SolverUnplaced {
  key: string;
  courseName: string;
  hourType: string;
  reason: string;
}

export interface SolverResult {
  assignments: SolverAssignment[];
  objective: number;
  violations: Violations;
  unplaced: SolverUnplaced[];
  conflicts: SolverConflict[];
  iterations: number;
  elapsedMs: number;
  /** (iteration, f) of every global improvement — enough to draw a convergence curve. */
  history: { iteration: number; objective: number }[];
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** "HH:MM" → minutes since midnight. Returns -1 for anything unparseable. */
export function parseMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Deterministic PRNG (mulberry32) so the same inputs and seed give the same schedule. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARITY_WEEKLY = 0;
const PARITY_NUMERATOR = 1;
const PARITY_DENOMINATOR = 2;

const PARITY_NAMES: WeekParity[] = ['WEEKLY', 'NUMERATOR', 'DENOMINATOR'];

function parityCode(p: WeekParity): number {
  return p === 'NUMERATOR' ? PARITY_NUMERATOR : p === 'DENOMINATOR' ? PARITY_DENOMINATOR : PARITY_WEEKLY;
}

/** Two classes in one slot clash only if their week patterns overlap (article, §Input Data). */
function weeksOverlap(a: number, b: number): boolean {
  return a === PARITY_WEEKLY || b === PARITY_WEEKLY || a === b;
}

/** Half-open interval overlap. */
function timesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

const DAY_SLOTS = 8; // day is 1..7; index 0 is unused, which keeps the arithmetic obvious

/** The resolved scheduling rules of one subject on one day. */
interface DayRules {
  /** Nothing may start before this minute; -1 when unset. */
  notBefore: number;
  /** Nothing may end after this minute; Number.MAX_SAFE_INTEGER when unset. */
  notAfter: number;
  /** Forbidden [from, to) windows, flattened as pairs. */
  windows: number[];
  /** Cap per calendar week; -1 when unset. */
  maxPerDay: number;
}

const NO_RULES: DayRules = { notBefore: -1, notAfter: Number.MAX_SAFE_INTEGER, windows: [], maxPerDay: -1 };

/**
 * Resolves a subject's constraint rows into one `DayRules` per day, applying the
 * "more specific wins" rule from schema.sql: a day-specific row *overrides* the every-day row
 * of the same type, except UNAVAILABLE windows, which accumulate.
 */
function resolveRules(constraints: SolverConstraint[] | undefined): DayRules[] {
  const out: DayRules[] = [];
  for (let d = 0; d < DAY_SLOTS; d++) {
    out.push({ notBefore: -1, notAfter: Number.MAX_SAFE_INTEGER, windows: [], maxPerDay: -1 });
  }
  if (!constraints || constraints.length === 0) return out;

  const days = [1, 2, 3, 4, 5, 6, 7];
  for (const type of ['NOT_BEFORE', 'NOT_AFTER', 'MAX_CLASSES_PER_DAY'] as ConstraintType[]) {
    const general = constraints.find((c) => c.type === type && c.dayOfWeek == null);
    for (const d of days) {
      const specific = constraints.find((c) => c.type === type && c.dayOfWeek === d);
      const row = specific ?? general;
      if (!row) continue;
      const rules = out[d];
      if (type === 'NOT_BEFORE') rules.notBefore = parseMinutes(row.value);
      else if (type === 'NOT_AFTER') {
        const v = parseMinutes(row.value);
        rules.notAfter = v < 0 ? Number.MAX_SAFE_INTEGER : v;
      } else {
        const n = Number(row.value);
        rules.maxPerDay = Number.isFinite(n) && n >= 0 ? n : -1;
      }
    }
  }
  // UNAVAILABLE accumulates: several disjoint gaps in one day are a normal thing to want.
  for (const c of constraints) {
    if (c.type !== 'UNAVAILABLE') continue;
    const [rawFrom, rawTo] = (c.value ?? '').split('-');
    const from = parseMinutes(rawFrom ?? '');
    const to = parseMinutes(rawTo ?? '');
    if (from < 0 || to < 0) continue;
    const targets = c.dayOfWeek == null ? days : [c.dayOfWeek];
    for (const d of targets) {
      if (d < 0 || d >= DAY_SLOTS) continue;
      out[d].windows.push(from, to);
    }
  }
  return out;
}

/** Whether a class occupying [start, end) on `day` is allowed by one subject's time rules. */
function timeAllowed(rules: DayRules, start: number, end: number): boolean {
  if (rules.notBefore >= 0 && start < rules.notBefore) return false;
  if (end > rules.notAfter) return false;
  const w = rules.windows;
  for (let i = 0; i < w.length; i += 2) {
    if (timesOverlap(start, end, w[i], w[i + 1])) return false;
  }
  return true;
}

// ── The solver ──────────────────────────────────────────────────────────────

/**
 * Builds a timetable for `problem`. `onProgress` is called a few times a second with the state of
 * the search; `shouldStop` lets a host cancel between rounds.
 */
export function solveTimetable(
  problem: SolverProblem,
  options: Partial<SolverOptions> = {},
  onProgress: (p: SolverProgress) => void = () => {},
  shouldStop: () => boolean = () => false
): SolverResult {
  const opts: SolverOptions = { ...DEFAULT_OPTIONS, ...options };
  const rnd = makeRandom(opts.seed || 1);
  const started = Date.now();
  const deadline = started + opts.timeLimitMs;

  // ── Entity numbering ──────────────────────────────────────────────────────
  const lecturerIdx = new Map<string, number>();
  const groupIdx = new Map<string, number>();
  const roomIdx = new Map<string, number>();
  const roomIds: string[] = [];
  const lecturerIds: string[] = [];
  const groupIds: string[] = [];

  const intern = (map: Map<string, number>, list: string[], id: string): number => {
    let i = map.get(id);
    if (i === undefined) {
      i = list.length;
      list.push(id);
      map.set(id, i);
    }
    return i;
  };

  for (const r of problem.rooms) intern(roomIdx, roomIds, r);
  for (const req of problem.requirements) {
    for (const l of req.lecturerIds) intern(lecturerIdx, lecturerIds, l);
    for (const g of req.groupIds) intern(groupIdx, groupIds, g);
    for (const a of req.roomIds) intern(roomIdx, roomIds, a);
  }
  for (const e of problem.fixedEntries) {
    for (const l of e.lecturerIds) intern(lecturerIdx, lecturerIds, l);
    for (const g of e.groupIds) intern(groupIdx, groupIds, g);
    if (e.roomId) intern(roomIdx, roomIds, e.roomId);
  }

  // ── Buildings ─────────────────────────────────────────────────────────────
  // Rooms are interned above; a building index per room turns "are these two classes in the same
  // place?" into an integer comparison inside the innermost loop of the objective.
  const buildingIdx = new Map<string, number>();
  const buildingIds: string[] = [];
  const roomBuildingIdx = roomIds.map((rid) => {
    const b = problem.roomBuilding.get(rid);
    return b === undefined ? -1 : intern(buildingIdx, buildingIds, b);
  });
  // ── Abstract rooms ────────────────────────────────────────────────────────
  // A place several classes share at the same hour. Interned like every other entity, and its
  // building interned into the *same* table as the rooms' — an abstract room that has an address
  // is, for every purpose in the objective, that address. Interned before the travel matrix is
  // sized, since a building only an abstract room sits in still has to fit in it.
  const abstractIdx = new Map<string, number>();
  const abstractIds: string[] = [];
  const abstractNames: string[] = [];
  /** Ceiling on the total students of everything sharing the place in one slot; -1 = unlimited. */
  const abstractCapacity: number[] = [];
  const abstractBuilding: number[] = [];
  for (const a of problem.abstractRooms ?? []) {
    if (abstractIdx.has(a.id)) continue;
    abstractIdx.set(a.id, abstractIds.length);
    abstractIds.push(a.id);
    abstractNames.push(a.name);
    abstractCapacity.push(a.capacity != null && a.capacity > 0 ? a.capacity : -1);
    abstractBuilding.push(a.buildingId ? intern(buildingIdx, buildingIds, a.buildingId) : -1);
  }

  /** Minutes between two building indices, -1 when the pair has no stored time. */
  const travelMatrix = new Int32Array(buildingIds.length * buildingIds.length).fill(-1);
  for (let a = 0; a < buildingIds.length; a++) {
    for (let b = 0; b < buildingIds.length; b++) {
      if (a === b) continue;
      const m = problem.buildingTravel.get(`${buildingIds[a]}>${buildingIds[b]}`);
      if (m !== undefined && m > 0) travelMatrix[a * buildingIds.length + b] = m;
    }
  }
  const travelBetween = (from: number, to: number): number =>
    travelMatrix[from * buildingIds.length + to];
  /**
   * The journey to or from an abstract room that has no building: one flat figure, from anywhere,
   * because there is no address to measure between. A blank property reads as "no journey", the
   * same convention `building_travel_times` gets.
   */
  const abstractTravelMinutes = problem.abstractRoomTravelMinutes > 0 ? problem.abstractRoomTravelMinutes : 0;
  /**
   * Home ↔ the university: the gap a day that mixes an online class with an in-room one has to
   * leave, in either direction. Same convention for a blank value.
   */
  const commuteMinutes = problem.universityCommuteMinutes > 0 ? problem.universityCommuteMinutes : 0;

  const lecturerRules = lecturerIds.map((id) => resolveRules(problem.lecturerConstraints.get(id)));
  const groupRules = groupIds.map((id) => resolveRules(problem.groupConstraints.get(id)));
  const roomRules = roomIds.map((id) => resolveRules(problem.roomConstraints.get(id)));

  // ── Class times ───────────────────────────────────────────────────────────
  const times = problem.classTimes
    .map((t) => ({ ...t, startMinutes: parseMinutes(t.startTime) }))
    .filter((t) => t.startMinutes >= 0)
    .sort((a, b) => a.startMinutes - b.startMinutes);
  const timeIdxById = new Map<string, number>();
  times.forEach((t, i) => timeIdxById.set(t.id, i));
  const timesBySet = new Map<string, number[]>();
  times.forEach((t, i) => {
    const list = timesBySet.get(t.setId);
    if (list) list.push(i);
    else timesBySet.set(t.setId, [i]);
  });

  const hourMinutes = problem.academicHourMinutes > 0 ? problem.academicHourMinutes : 40;
  const days = problem.days.length ? problem.days : [1, 2, 3, 4, 5, 6];

  // ── Genes ─────────────────────────────────────────────────────────────────
  // Movable requirements come first, then everything immovable: this faculty's locked entries
  // (in "fill the gaps" mode) and every external entry. Immovable genes take part in every
  // conflict and window count — the schedule has to fit around them — but are never moved, and a
  // clash *between two* of them is not counted, since no run could ever resolve it.

  // The three alternative ways a class is held, split into four kinds because the two halves of
  // "an abstract room" behave differently in Π₄/Π₅: one has an address and is that address, the
  // other has none and costs one flat journey from anywhere. The kind is a property of the
  // *requirement* — a class in an abstract room or online has no room to choose — so it is decided
  // once, when the gene is built, and never by `place`. It is kept explicitly rather than inferred
  // from `building`, which is -1 for three different reasons (no room yet, a room whose
  // building_id is unset, and no address at all) that must not be conflated.
  const PLACE_ROOM = 0;             // one room, exclusively
  const PLACE_ABSTRACT_HERE = 1;    // an abstract room that belongs to a building
  const PLACE_ABSTRACT_NOWHERE = 2; // an abstract room with no address at all
  const PLACE_ONLINE = 3;           // no place

  interface Gene {
    reqIndex: number;      // -1 for an external entry
    key: string;
    label: string;
    movable: boolean;
    lecturers: number[];
    groups: number[];
    durationMinutes: number;
    /** Admissible (day, timeIdx, parity) triples, packed; empty for immovable genes. */
    slots: Int32Array;
    /** Admissible room indices. */
    rooms: Int32Array;
    // current placement
    day: number;
    timeIdx: number;   // -1 when unplaced
    room: number;      // -1 when unplaced or roomless
    /** Building of `room`, or -1 when there is no room or the room's building is unknown. */
    building: number;
    /** PLACE_ROOM / PLACE_ABSTRACT_HERE / PLACE_ABSTRACT_NOWHERE / PLACE_ONLINE. */
    placeKind: number;
    /** Interned abstract room index, -1 when this class is not held in one. */
    abstractRoom: number;
    /** The building this class is in regardless of any room: the abstract room's, or -1. Kept so
     *  `building` can be restored for a gene that has no room to derive it from. */
    homeBuilding: number;
    /** Students attending — what an abstract room's capacity caps, summed over everything in it. */
    students: number;
    parity: number;
    start: number;
    end: number;
  }

  const PACK_DAY = 100000;
  const PACK_PARITY = 10000;
  const packSlot = (day: number, timeIdx: number, parity: number) =>
    day * PACK_DAY + parity * PACK_PARITY + timeIdx;
  const unpackDay = (v: number) => Math.floor(v / PACK_DAY);
  const unpackParity = (v: number) => Math.floor((v % PACK_DAY) / PACK_PARITY);
  const unpackTime = (v: number) => v % PACK_PARITY;

  /**
   * The building a gene sits in, given a room index. A class in a room follows its room; a class
   * in an abstract room follows the abstract room whether it is placed or not; a class online, or
   * one in a place with no address, is nowhere. This is what keeps `place` from wiping the
   * building of a gene that legitimately has no room.
   */
  const buildingFor = (g: Gene, room: number): number =>
    g.placeKind === PLACE_ROOM ? (room >= 0 ? roomBuildingIdx[room] : -1) : g.homeBuilding;

  const genes: Gene[] = [];
  const unplaced: SolverUnplaced[] = [];
  /** Genes construction could not fit; N0 keeps retrying them, so the report is filtered at the end. */
  const constructionFailures: { key: string; gene: number }[] = [];

  // The fallback domain of a workload with no room restriction is *this faculty's* rooms, not
  // everything `roomIds` happens to hold: that table also interned the rooms named by individual
  // workloads and the rooms of every external class, which are frequently another faculty's and
  // whose own constraints were never loaded. Scheduling into one of those would put a class in a
  // room nobody said it could use.
  const allRoomIndices = problem.rooms.map((id) => roomIdx.get(id)!).filter((v) => v !== undefined);

  const requirements = problem.requirements;

  for (let ri = 0; ri < requirements.length; ri++) {
    const req = requirements[ri];
    const durationMinutes = Math.max(1, req.durationHours) * hourMinutes;
    const lecturers = req.lecturerIds.map((id) => lecturerIdx.get(id)!).filter((v) => v !== undefined);
    const groups = req.groupIds.map((id) => groupIdx.get(id)!).filter((v) => v !== undefined);
    // Where it is held. The three ways are alternatives, and they override each other in this
    // order: an online class is online whatever else the workload names, and an abstract room
    // replaces the rooms rather than joining them (see the V7 migration).
    const heldInAbstract = !req.isOnline && req.abstractRoomId != null;
    const abstractRoom = heldInAbstract ? abstractIdx.get(req.abstractRoomId!) ?? -1 : -1;
    const homeBuilding = abstractRoom >= 0 ? abstractBuilding[abstractRoom] : -1;
    const placeKind = req.isOnline
      ? PLACE_ONLINE
      : heldInAbstract
        ? (homeBuilding >= 0 ? PLACE_ABSTRACT_HERE : PLACE_ABSTRACT_NOWHERE)
        : PLACE_ROOM;
    // A class that is not in a room has no room domain, and must never be handed one by the
    // unrestricted fallback: `roomIds` is empty here because there is nothing to restrict, not
    // because any room will do. The single -1 is a real, admissible "no room" choice — an *empty*
    // array would make the scan find nothing and report the class as unplaceable.
    const roomDomain = placeKind !== PLACE_ROOM
      ? [-1]
      : (req.roomIds.length ? req.roomIds.map((id) => roomIdx.get(id)!) : allRoomIndices)
          .filter((v) => v !== undefined);

    let immovable = req.locked && req.current != null;

    // Admissible (day, time, parity) triples: the workload's own bells, on a working day, with
    // every lecturer's and every group's time rules satisfied. Room rules are checked per room.
    const slotList: number[] = [];
    const setTimes = timesBySet.get(req.classStartTimeSetId) ?? [];
    const parities = req.isBiweekly ? [PARITY_NUMERATOR, PARITY_DENOMINATOR] : [PARITY_WEEKLY];
    if (!immovable) {
      for (const day of days) {
        for (const ti of setTimes) {
          const start = times[ti].startMinutes;
          const end = start + durationMinutes;
          let ok = true;
          for (const l of lecturers) {
            if (!timeAllowed(lecturerRules[l][day] ?? NO_RULES, start, end)) { ok = false; break; }
          }
          if (ok) {
            for (const g of groups) {
              if (!timeAllowed(groupRules[g][day] ?? NO_RULES, start, end)) { ok = false; break; }
            }
          }
          if (!ok) continue;
          for (const p of parities) slotList.push(packSlot(day, ti, p));
        }
      }
      if (slotList.length === 0 || roomDomain.length === 0) {
        const reason = roomDomain.length === 0
          ? 'немає жодної дозволеної аудиторії'
          : setTimes.length === 0
            ? 'для набору дзвінків цього навантаження не задано жодного часу початку'
            : 'обмеження розкладу викладачів або груп не залишають жодного вільного часу';
        unplaced.push({ key: req.key, courseName: req.courseName, hourType: req.hourType, reason });
        // Nothing satisfies the rules — but if this session is already scheduled, dropping it from
        // the index would let the rest of the run schedule *into* a slot the timetable still
        // occupies. It stays exactly where it is, immovable, and is reported instead.
        if (!req.current) continue;
        immovable = true;
      }
    }

    const cur = req.current;
    const curTimeIdx = cur ? timeIdxById.get(cur.classStartTimeId) ?? -1 : -1;
    // A stored entry may have no room at all now — that is what an abstract-room or online class
    // writes — so an absent room is "roomless", not "unknown room".
    const curRoom = cur && cur.roomId ? roomIdx.get(cur.roomId) ?? -1 : -1;
    const curParity = cur ? parityCode(cur.weekParity) : (req.isBiweekly ? PARITY_NUMERATOR : PARITY_WEEKLY);
    const curStart = curTimeIdx >= 0 ? times[curTimeIdx].startMinutes : -1;

    genes.push({
      reqIndex: ri,
      key: req.key,
      label: `${req.courseName}${req.hourType ? ` (${req.hourType})` : ''}`,
      movable: !immovable,
      lecturers,
      groups,
      durationMinutes,
      slots: Int32Array.from(slotList),
      rooms: Int32Array.from(roomDomain),
      day: cur ? cur.dayOfWeek : -1,
      timeIdx: curTimeIdx,
      room: curRoom,
      building: placeKind === PLACE_ROOM ? (curRoom >= 0 ? roomBuildingIdx[curRoom] : -1) : homeBuilding,
      placeKind,
      abstractRoom,
      homeBuilding,
      students: Math.max(0, req.studentsCount || 0),
      parity: curParity,
      start: curStart,
      end: curStart >= 0 ? curStart + durationMinutes : -1
    });
  }

  const movableCount = genes.length;

  for (const e of problem.fixedEntries) {
    const externalRoom = e.roomId ? roomIdx.get(e.roomId) ?? -1 : -1;
    // Another faculty's class is held one of the same three ways, and its students count against
    // the same shared place: «Спортивні зали» does not care whose groups are in it.
    const externalAbstract = !e.isOnline && e.abstractRoomId != null
      ? abstractIdx.get(e.abstractRoomId) ?? -1 : -1;
    const externalHome = externalAbstract >= 0 ? abstractBuilding[externalAbstract] : -1;
    const externalKind = e.isOnline
      ? PLACE_ONLINE
      : e.abstractRoomId != null
        ? (externalHome >= 0 ? PLACE_ABSTRACT_HERE : PLACE_ABSTRACT_NOWHERE)
        : PLACE_ROOM;
    const start = parseMinutes(e.startTime);
    if (start < 0) continue;
    const durationMinutes = Math.max(1, e.durationHours) * hourMinutes;
    genes.push({
      reqIndex: -1,
      key: `external:${e.id}`,
      label: 'заняття іншого факультету',
      movable: false,
      lecturers: e.lecturerIds.map((id) => lecturerIdx.get(id)!).filter((v) => v !== undefined),
      groups: e.groupIds.map((id) => groupIdx.get(id)!).filter((v) => v !== undefined),
      durationMinutes,
      slots: new Int32Array(0),
      rooms: new Int32Array(0),
      day: e.dayOfWeek,
      timeIdx: -1,
      room: externalKind === PLACE_ROOM ? externalRoom : -1,
      building: externalKind === PLACE_ROOM
        ? (externalRoom >= 0 ? roomBuildingIdx[externalRoom] : -1)
        : externalHome,
      placeKind: externalKind,
      abstractRoom: externalAbstract,
      homeBuilding: externalHome,
      students: Math.max(0, e.studentsCount || 0),
      parity: parityCode(e.weekParity),
      start,
      end: start + durationMinutes
    });
  }

  const V = genes.length;
  const movable: number[] = [];
  for (let i = 0; i < V; i++) if (genes[i].movable) movable.push(i);

  /**
   * Whether there is any journey in this problem at all — if not, the whole Π₄/Π₅ pass is skipped
   * rather than walked for nothing, exactly as it was before travel existed.
   *
   * It is *not* just `building_travel_times` any more. Two of the three journeys this run knows
   * about do not come from that table: the flat figure to a place with no address, and the commute
   * an online class puts either side of itself. A database with no travel rows would otherwise
   * silently drop both.
   */
  const travelKnown = travelMatrix.some((m) => m > 0)
    || (abstractTravelMinutes > 0 && genes.some((g) => g.placeKind === PLACE_ABSTRACT_NOWHERE))
    || (commuteMinutes > 0 && genes.some((g) => g.placeKind === PLACE_ONLINE));

  // ── Occupancy index ───────────────────────────────────────────────────────
  // One bucket per (entity, day), holding the genes placed there. Lists rather than the article's
  // counters, because classes here have *durations* — two different grids of bells overlap
  // partially, and a two-hour class covers two one-hour slots — so a conflict is an interval
  // overlap test, not an equality of slot numbers. The lists are short (a lecturer's day), so the
  // test stays cheap and, unlike counters, stays exact.

  const lecBuckets: number[][] = new Array(lecturerIds.length * DAY_SLOTS);
  const grpBuckets: number[][] = new Array(groupIds.length * DAY_SLOTS);
  const roomBuckets: number[][] = new Array(roomIds.length * DAY_SLOTS);
  // One more family of buckets, for the shared places. Deliberately *not* `roomBuckets`: nothing
  // that tests room exclusivity may see these, which is the whole reason abstract rooms exist.
  // What is asked of them is the opposite question — not "is more than one class here?" but "do
  // the classes here hold more students than fit?".
  const absBuckets: number[][] = new Array(abstractIds.length * DAY_SLOTS);
  for (let i = 0; i < lecBuckets.length; i++) lecBuckets[i] = [];
  for (let i = 0; i < grpBuckets.length; i++) grpBuckets[i] = [];
  for (let i = 0; i < roomBuckets.length; i++) roomBuckets[i] = [];
  for (let i = 0; i < absBuckets.length; i++) absBuckets[i] = [];

  function indexInsert(i: number) {
    const g = genes[i];
    if (g.day < 0 || g.start < 0) return;
    for (const l of g.lecturers) lecBuckets[l * DAY_SLOTS + g.day].push(i);
    for (const gr of g.groups) grpBuckets[gr * DAY_SLOTS + g.day].push(i);
    if (g.room >= 0) roomBuckets[g.room * DAY_SLOTS + g.day].push(i);
    if (g.abstractRoom >= 0) absBuckets[g.abstractRoom * DAY_SLOTS + g.day].push(i);
  }

  function removeFrom(list: number[], value: number) {
    const at = list.indexOf(value);
    if (at >= 0) list.splice(at, 1);
  }

  function indexRemove(i: number) {
    const g = genes[i];
    if (g.day < 0 || g.start < 0) return;
    for (const l of g.lecturers) removeFrom(lecBuckets[l * DAY_SLOTS + g.day], i);
    for (const gr of g.groups) removeFrom(grpBuckets[gr * DAY_SLOTS + g.day], i);
    if (g.room >= 0) removeFrom(roomBuckets[g.room * DAY_SLOTS + g.day], i);
    if (g.abstractRoom >= 0) removeFrom(absBuckets[g.abstractRoom * DAY_SLOTS + g.day], i);
  }

  for (let i = 0; i < V; i++) indexInsert(i);

  /** How many genes in `bucket` clash with the interval [start, end) of parity `parity`. */
  function clashesIn(bucket: number[], self: number, start: number, end: number, parity: number): number {
    let n = 0;
    for (let k = 0; k < bucket.length; k++) {
      const j = bucket[k];
      if (j === self) continue;
      const o = genes[j];
      if (!weeksOverlap(parity, o.parity)) continue;
      if (timesOverlap(start, end, o.start, o.end)) n++;
    }
    return n;
  }

  /** ov(i) for a candidate placement of gene `i` — the article's Eq. (2), interval-aware. */
  function overlapAt(i: number, day: number, start: number, end: number, parity: number, room: number): number {
    const g = genes[i];
    let n = 0;
    for (const l of g.lecturers) n += clashesIn(lecBuckets[l * DAY_SLOTS + day], i, start, end, parity);
    for (const gr of g.groups) n += clashesIn(grpBuckets[gr * DAY_SLOTS + day], i, start, end, parity);
    if (room >= 0) n += clashesIn(roomBuckets[room * DAY_SLOTS + day], i, start, end, parity);
    return n;
  }

  /** ov(i) where it currently sits. */
  function overlapOf(i: number): number {
    const g = genes[i];
    if (g.day < 0 || g.start < 0) return 0;
    return overlapAt(i, g.day, g.start, g.end, g.parity, g.room);
  }

  /** Classes an entity already has on `day` in the calendar week(s) `parity` falls in. */
  function dayLoadExceeds(bucket: number[], self: number, day: number, parity: number, cap: number): boolean {
    if (cap < 0) return false;
    // WEEKLY falls in both weeks, NUMERATOR/DENOMINATOR in one each, so the cap has to hold for
    // (WEEKLY + NUMERATOR) and for (WEEKLY + DENOMINATOR) separately — counting all three
    // together would reject a legal timetable that merely alternates two classes in one slot.
    let inNumerator = parity === PARITY_WEEKLY || parity === PARITY_NUMERATOR ? 1 : 0;
    let inDenominator = parity === PARITY_WEEKLY || parity === PARITY_DENOMINATOR ? 1 : 0;
    for (let k = 0; k < bucket.length; k++) {
      const j = bucket[k];
      if (j === self) continue;
      const p = genes[j].parity;
      if (p === PARITY_WEEKLY || p === PARITY_NUMERATOR) inNumerator++;
      if (p === PARITY_WEEKLY || p === PARITY_DENOMINATOR) inDenominator++;
    }
    return inNumerator > cap || inDenominator > cap;
  }

  /** Every hard rule that is not about clashing: room eligibility and MAX_CLASSES_PER_DAY. */
  function placementAllowed(i: number, day: number, start: number, end: number, parity: number, room: number): boolean {
    const g = genes[i];
    if (room >= 0 && !timeAllowed(roomRules[room][day] ?? NO_RULES, start, end)) return false;
    for (const l of g.lecturers) {
      const cap = (lecturerRules[l][day] ?? NO_RULES).maxPerDay;
      if (dayLoadExceeds(lecBuckets[l * DAY_SLOTS + day], i, day, parity, cap)) return false;
    }
    for (const gr of g.groups) {
      const cap = (groupRules[gr][day] ?? NO_RULES).maxPerDay;
      if (dayLoadExceeds(grpBuckets[gr * DAY_SLOTS + day], i, day, parity, cap)) return false;
    }
    if (room >= 0) {
      const cap = (roomRules[room][day] ?? NO_RULES).maxPerDay;
      if (dayLoadExceeds(roomBuckets[room * DAY_SLOTS + day], i, day, parity, cap)) return false;
    }
    return true;
  }

  function place(i: number, day: number, timeIdx: number, parity: number, room: number) {
    indexRemove(i);
    const g = genes[i];
    g.day = day;
    g.timeIdx = timeIdx;
    g.parity = parity;
    g.room = room;
    // Not `room >= 0 ? … : -1`: a class in an abstract room never has a room and would otherwise
    // lose the building it is genuinely in on every placement.
    g.building = buildingFor(g, room);
    g.start = timeIdx >= 0 ? times[timeIdx].startMinutes : -1;
    g.end = g.start >= 0 ? g.start + g.durationMinutes : -1;
    indexInsert(i);
  }

  // ── Objective ─────────────────────────────────────────────────────────────

  /**
   * Windows in one bucket, in academic hours, for one calendar week: the idle time between the
   * first and the last class of that day. A gap shorter than one academic hour (a break between
   * two consecutive classes) is not a window.
   */
  function windowsIn(bucket: number[], week: number): number {
    const spans: number[][] = [];
    for (let k = 0; k < bucket.length; k++) {
      const g = genes[bucket[k]];
      if (g.start < 0) continue;
      if (g.parity !== PARITY_WEEKLY && g.parity !== week) continue;
      spans.push([g.start, g.end]);
    }
    if (spans.length < 2) return 0;
    spans.sort((a, b) => a[0] - b[0]);
    let idle = 0;
    let reach = spans[0][1];
    for (let k = 1; k < spans.length; k++) {
      if (spans[k][0] > reach) idle += spans[k][0] - reach;
      reach = Math.max(reach, spans[k][1]);
    }
    return Math.floor(idle / hourMinutes);
  }

  /** Π₆ / Π₇: window counts summed over every entity and day, averaged over the two weeks. */
  function windowTotal(buckets: number[][]): number {
    let numerator = 0;
    let denominator = 0;
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      if (bucket.length < 2) continue;
      numerator += windowsIn(bucket, PARITY_NUMERATOR);
      denominator += windowsIn(bucket, PARITY_DENOMINATOR);
    }
    return Math.round((numerator + denominator) / 2);
  }

  /** Π₁ / Π₂ / Π₃: unordered pairs that clash, counted once per shared entity. */
  function conflictTotal(buckets: number[][]): number {
    let n = 0;
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      for (let x = 0; x < bucket.length; x++) {
        const a = genes[bucket[x]];
        for (let y = x + 1; y < bucket.length; y++) {
          const c = genes[bucket[y]];
          // A clash between two immovable classes is not this run's to fix, and counting it would
          // put a floor under f that no amount of search could lift.
          if (!a.movable && !c.movable) continue;
          if (!weeksOverlap(a.parity, c.parity)) continue;
          if (timesOverlap(a.start, a.end, c.start, c.end)) n++;
        }
      }
    }
    return n;
  }

  /**
   * Π₄ / Π₅: pairs of classes one entity has on the same day, in overlapping weeks, in different
   * buildings, with less time between them than the journey takes.
   *
   * Only *non-overlapping* pairs are counted. A pair that overlaps in time is already a clash and
   * is counted by `conflictTotal`; charging it a second time here would make one mistake cost two
   * penalties and pull the search toward fixing it twice.
   *
   * What "the journey takes" means for each of the three ways a class can be held is
   * `journeyMinutes`; everything unknown is treated as reachable instantly — an unassigned room is
   * not evidence of a long walk, and inventing one would reject schedules the data does not object
   * to.
   */
  /**
   * How long the journey between two placed classes takes, in minutes, given in the order they
   * happen (the matrix is directed, so the order is the journey actually made). 0 means there is
   * nothing to cross, which is also how every absence is read.
   *
   * Four rules, one per way a class can be held:
   *
   *  - **online ↔ online** — no journey at all; the student never leaves the desk.
   *  - **online ↔ a place** — `university_commute_time_minutes`: the student goes home, or comes
   *    in. Symmetric, and charged to a lecturer as readily as to a group: they make the same trip.
   *  - **an abstract room with a building** — behaves exactly like that building, so two classes
   *    in one building are free and any other pair is `building_travel_times`.
   *  - **an abstract room with no building** — no address to measure from, so one flat
   *    `abstract_room_travel_time_minutes` to or from anywhere. Except from itself: two classes in
   *    the *same* abstract room are in the same place, and the same place is free, exactly as it
   *    is for two classes in one building.
   *
   * A *room* whose `building_id` is unset stays what it was before abstract rooms existed —
   * unknown rather than nowhere, and unknown costs nothing.
   */
  function journeyMinutes(first: Gene, second: Gene): number {
    const firstOnline = first.placeKind === PLACE_ONLINE;
    const secondOnline = second.placeKind === PLACE_ONLINE;
    if (firstOnline && secondOnline) return 0;
    if (firstOnline || secondOnline) return commuteMinutes;
    if (first.abstractRoom >= 0 && first.abstractRoom === second.abstractRoom) return 0;
    if (first.placeKind === PLACE_ABSTRACT_NOWHERE || second.placeKind === PLACE_ABSTRACT_NOWHERE) {
      return abstractTravelMinutes;
    }
    if (first.building < 0 || second.building < 0) return 0;
    if (first.building === second.building) return 0;
    const need = travelBetween(first.building, second.building);
    return need > 0 ? need : 0;
  }

  /**
   * The Π₄/Π₅ predicate for one pair of an entity's classes, ordered as they happen, or null when
   * the pair is fine.
   *
   * One function rather than two identical ones, because the objective and the conflict report ran
   * copies of it and a rule added to one and not the other is a report that disagrees with the
   * number beside it.
   */
  function unreachablePair(a: Gene, c: Gene): { first: Gene; second: Gene } | null {
    if (a.start < 0 || c.start < 0) return null;
    // Neither end movable: no run could fix it, and counting it would only put a floor under f.
    if (!a.movable && !c.movable) return null;
    if (!weeksOverlap(a.parity, c.parity)) return null;
    // An overlapping pair is already a Π₁/Π₂ clash; charging it again would cost one mistake two
    // penalties and pull the search toward fixing it twice.
    if (timesOverlap(a.start, a.end, c.start, c.end)) return null;
    const [first, second] = a.start <= c.start ? [a, c] : [c, a];
    const need = journeyMinutes(first, second);
    if (need <= 0 || second.start - first.end >= need) return null;
    return { first, second };
  }

  function travelTotal(buckets: number[][]): number {
    if (!travelKnown) return 0;
    let n = 0;
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      for (let x = 0; x < bucket.length; x++) {
        const a = genes[bucket[x]];
        if (a.start < 0) continue;
        for (let y = x + 1; y < bucket.length; y++) {
          if (unreachablePair(a, genes[bucket[y]])) n++;
        }
      }
    }
    return n;
  }

  /**
   * Π₆: abstract rooms holding, at some instant, more students than they seat.
   *
   * The ceiling is on the **total** students of every class sharing the place at once, which is
   * what makes it unlike a room's capacity and unlike Π₃: an abstract room is *meant* to hold
   * several classes, and the only question is how many students that adds up to. External classes
   * count — «Спортивні зали» does not care which faculty's groups are in it — and a group whose
   * `students_count` is unset contributes 0, because an unentered figure is not evidence of a
   * crowd and inventing one would reject placements the data does not object to.
   *
   * The sum of a set of intervals reaches its maximum at one of their starts, so testing every
   * distinct start instant of the bucket finds every breach; charging one breach per instant
   * rather than per class keeps a crowded hour from costing as much as the number of classes in
   * it. The two calendar weeks are walked separately, and *not* averaged as the window terms are:
   * a weekly class over its capacity is over it every week, and counting it twice is the honest
   * reading. A breach whose every class is immovable is skipped, as for every other term.
   */
  function abstractOverflowTotal(): number {
    let n = 0;
    for (let b = 0; b < absBuckets.length; b++) {
      const bucket = absBuckets[b];
      if (bucket.length < 2) continue;
      const cap = abstractCapacity[Math.floor(b / DAY_SLOTS)];
      if (cap < 0) continue;
      for (let week = PARITY_NUMERATOR; week <= PARITY_DENOMINATOR; week++) {
        for (let x = 0; x < bucket.length; x++) {
          const a = genes[bucket[x]];
          if (a.start < 0) continue;
          if (a.parity !== PARITY_WEEKLY && a.parity !== week) continue;
          // One charge per distinct instant: two classes starting together describe one crowd.
          let seen = false;
          for (let k = 0; k < x && !seen; k++) {
            const e = genes[bucket[k]];
            seen = e.start === a.start && (e.parity === PARITY_WEEKLY || e.parity === week);
          }
          if (seen) continue;
          let total = 0;
          let anyMovable = false;
          for (let y = 0; y < bucket.length; y++) {
            const c = genes[bucket[y]];
            if (c.start < 0) continue;
            if (c.parity !== PARITY_WEEKLY && c.parity !== week) continue;
            if (c.start > a.start || c.end <= a.start) continue;
            total += c.students;
            if (c.movable) anyMovable = true;
          }
          if (anyMovable && total > cap) n++;
        }
      }
    }
    return n;
  }

  /** Whether one bucket's classes in one calendar week mix an online class with an in-room one. */
  function mixedIn(bucket: number[], week: number): number {
    let online = 0;
    let inPlace = 0;
    for (let k = 0; k < bucket.length; k++) {
      const g = genes[bucket[k]];
      if (g.start < 0) continue;
      if (g.parity !== PARITY_WEEKLY && g.parity !== week) continue;
      if (g.placeKind === PLACE_ONLINE) online++; else inPlace++;
      if (online > 0 && inPlace > 0) return 1;
    }
    return 0;
  }

  /**
   * Π₉: (group, day, week) triples whose classes are a mix of online and in-room.
   *
   * The deanery's stated preference is that online classes take place on their own days and
   * in-person classes on others, so what is counted is the *day*, not the pair: one online class
   * dropped into a campus day costs the same as three, because the damage is the trip home and
   * back, which happens once. Soft — a group with a single online class in the week may have
   * nowhere to put it — and averaged over the two calendar weeks exactly as the window terms are,
   * so a purely weekly schedule is not charged twice for the same day.
   */
  function mixedTotal(buckets: number[][]): number {
    let numerator = 0;
    let denominator = 0;
    for (let b = 0; b < buckets.length; b++) {
      const bucket = buckets[b];
      if (bucket.length < 2) continue;
      numerator += mixedIn(bucket, PARITY_NUMERATOR);
      denominator += mixedIn(bucket, PARITY_DENOMINATOR);
    }
    return Math.round((numerator + denominator) / 2);
  }

  function measure(): Violations {
    return {
      lecturerConflicts: conflictTotal(lecBuckets),
      groupConflicts: conflictTotal(grpBuckets),
      roomConflicts: conflictTotal(roomBuckets),
      groupTravel: travelTotal(grpBuckets),
      lecturerTravel: travelTotal(lecBuckets),
      abstractRoomOverflow: abstractOverflowTotal(),
      lecturerWindows: windowTotal(lecBuckets),
      groupWindows: windowTotal(grpBuckets),
      // Groups only: it is the students who are sent home and back, and the preference was theirs.
      mixedOnlineDays: mixedTotal(grpBuckets)
    };
  }

  /** Eq. (1): f(σ) = Σ β_i · Π_i^{α_i}. */
  function objectiveOf(v: Violations): number {
    const p = (x: number) => Math.pow(x, OBJECTIVE_EXPONENT);
    return OBJECTIVE_WEIGHTS.lecturerConflicts * p(v.lecturerConflicts)
      + OBJECTIVE_WEIGHTS.groupConflicts * p(v.groupConflicts)
      + OBJECTIVE_WEIGHTS.roomConflicts * p(v.roomConflicts)
      + OBJECTIVE_WEIGHTS.groupTravel * p(v.groupTravel)
      + OBJECTIVE_WEIGHTS.lecturerTravel * p(v.lecturerTravel)
      + OBJECTIVE_WEIGHTS.abstractRoomOverflow * p(v.abstractRoomOverflow)
      + OBJECTIVE_WEIGHTS.lecturerWindows * p(v.lecturerWindows)
      + OBJECTIVE_WEIGHTS.groupWindows * p(v.groupWindows)
      + OBJECTIVE_WEIGHTS.mixedOnlineDays * p(v.mixedOnlineDays);
  }

  // A schedule with an unreachable pair is as unusable as one with a double booking — the class is
  // simply not attended — so travel counts toward "how far from feasible", not toward comfort.
  // A place holding more students than it seats is as unusable as a double booking — the class
  // happens somewhere the cohort does not fit — so it counts toward "how far from feasible" too.
  // This line is the only thing that makes a term hard; Π₉ is deliberately absent from it.
  const hardOf = (v: Violations) =>
    v.lecturerConflicts + v.groupConflicts + v.roomConflicts + v.groupTravel + v.lecturerTravel
    + v.abstractRoomOverflow;

  // ── Construction ──────────────────────────────────────────────────────────
  // Most-constrained-first: a requirement with one viable placement has to claim it before a
  // requirement with a hundred takes it for a marginal gain. This is the saturation-degree idea
  // from graph colouring (DSATUR), which is where the timetabling literature's greedy heuristics
  // come from, applied to |slots| × |rooms| rather than to a colour count.

  // `avoid` defaults to -2, not -1: -1 is a *real* room value now — the whole room domain of a
  // class held in an abstract room or online — so -1 as "nothing to avoid" would make the scan
  // skip the only choice such a class has and report it as unplaceable.
  function scanBest(i: number, wantWindows: boolean, avoid: number = -2):
      { day: number; timeIdx: number; parity: number; room: number; overlap: number; windows: number } | null {
    const g = genes[i];
    let best: { day: number; timeIdx: number; parity: number; room: number; overlap: number; windows: number } | null = null;
    const slots = g.slots;
    const offset = slots.length ? Math.floor(rnd() * slots.length) : 0;

    for (let s = 0; s < slots.length; s++) {
      const packed = slots[(s + offset) % slots.length];
      const day = unpackDay(packed);
      const parity = unpackParity(packed);
      const timeIdx = unpackTime(packed);
      const start = times[timeIdx].startMinutes;
      const end = start + g.durationMinutes;

      // Fast filter, as in the article's N1: skip a slot where the lecturer is already busy.
      let peopleOverlap = 0;
      for (const l of g.lecturers) peopleOverlap += clashesIn(lecBuckets[l * DAY_SLOTS + day], i, start, end, parity);
      for (const gr of g.groups) peopleOverlap += clashesIn(grpBuckets[gr * DAY_SLOTS + day], i, start, end, parity);
      if (best && peopleOverlap > best.overlap) continue;

      const rooms = g.rooms;
      const roomOffset = rooms.length ? Math.floor(rnd() * rooms.length) : 0;
      for (let r = 0; r < rooms.length; r++) {
        const room = rooms[(r + roomOffset) % rooms.length];
        if (room === avoid) continue;
        if (!placementAllowed(i, day, start, end, parity, room)) continue;
        // room = -1 is the whole domain of a class held in an abstract room or online: it is in
        // no room, so it contests none.
        const overlap = peopleOverlap
          + (room >= 0 ? clashesIn(roomBuckets[room * DAY_SLOTS + day], i, start, end, parity) : 0);
        if (best && overlap > best.overlap) continue;
        const windows = wantWindows && overlap === 0 ? windowCostAt(i, day) : 0;
        if (!best || overlap < best.overlap || (overlap === best.overlap && windows < best.windows)) {
          best = { day, timeIdx, parity, room, overlap, windows };
        }
        if (overlap === 0 && !wantWindows) return best;
        if (overlap === 0 && windows === 0) return best;
      }
    }
    return best;
  }

  /**
   * The soft cost gene `i` would live inside on `day`, counted for its own lecturers and groups:
   * the windows it sits in, plus the mixed online/in-room days it takes part in.
   *
   * Everything is expressed in units of one *lecturer* window, using the objective's own exchange
   * rates — 4 = β(groupWindows)/β(lecturerWindows) = 20/5, 6 = β(mixedOnlineDays)/β(lecturerWindows)
   * = 30/5 — so the local decision trades the three against each other exactly as f does. Π₉ is in
   * here rather than only in `measure` because a term the scan cannot see is a term the search
   * only ever scores, never steers by: `scanBest` breaks a tie on this number, so without it a
   * class would be as happy to land on a group's campus day as on its online one.
   */
  function windowCostAt(i: number, day: number): number {
    const g = genes[i];
    let n = 0;
    for (const l of g.lecturers) {
      n += windowsIn(lecBuckets[l * DAY_SLOTS + day], PARITY_NUMERATOR)
        + windowsIn(lecBuckets[l * DAY_SLOTS + day], PARITY_DENOMINATOR);
    }
    for (const gr of g.groups) {
      const bucket = grpBuckets[gr * DAY_SLOTS + day];
      n += 4 * (windowsIn(bucket, PARITY_NUMERATOR) + windowsIn(bucket, PARITY_DENOMINATOR))
        + 6 * (mixedIn(bucket, PARITY_NUMERATOR) + mixedIn(bucket, PARITY_DENOMINATOR));
    }
    return n;
  }

  function construct() {
    // Clear every movable gene, then place them most-constrained-first.
    for (const i of movable) {
      indexRemove(i);
      const g = genes[i];
      g.day = -1; g.timeIdx = -1; g.room = -1; g.start = -1; g.end = -1;
      // `building` is not derived from `day`, so it has to be reset here too, or an unplaced gene
      // would keep the building of the room it last sat in.
      g.building = buildingFor(g, -1);
    }
    const order = [...movable].sort((a, b) => {
      const ga = genes[a], gb = genes[b];
      const da = ga.slots.length * ga.rooms.length;
      const db = gb.slots.length * gb.rooms.length;
      if (da !== db) return da - db;
      return (gb.lecturers.length + gb.groups.length) - (ga.lecturers.length + ga.groups.length);
    });

    for (const i of order) {
      const best = scanBest(i, true);
      if (best) {
        place(i, best.day, best.timeIdx, best.parity, best.room);
        continue;
      }
      // Its domain is not empty (that was caught while the gene was built) — every admissible
      // placement is closed by a per-day cap other classes have already used up, or by a room rule
      // on the only rooms still free. If it was already scheduled, put it back where it was rather
      // than leaving a hole the rest of the run would schedule into.
      const g = genes[i];
      const req = requirements[g.reqIndex];
      unplaced.push({
        key: req.key,
        courseName: req.courseName,
        hourType: req.hourType,
        reason: 'жодне з дозволених місць не вільне — обмеження «не більше пар на день» або правила аудиторій'
      });
      constructionFailures.push({ key: req.key, gene: i });
      pendingUnplaced++;
      const cur = req.current;
      if (!cur) continue;
      const timeIdx = timeIdxById.get(cur.classStartTimeId) ?? -1;
      // A roomless class is put back roomless; only a class that is *supposed* to be in a room
      // needs one to be restored.
      const room = g.placeKind === PLACE_ROOM ? (cur.roomId ? roomIdx.get(cur.roomId) ?? -1 : -1) : -1;
      if (timeIdx < 0 || (g.placeKind === PLACE_ROOM && room < 0)) continue;
      const start = times[timeIdx].startMinutes;
      const parity = parityCode(cur.weekParity);
      if (!placementAllowed(i, cur.dayOfWeek, start, start + g.durationMinutes, parity, room)) continue;
      place(i, cur.dayOfWeek, timeIdx, parity, room);
      pendingUnplaced--;
    }
  }

  // ── Phase 1: overlap repair ───────────────────────────────────────────────

  // A string key rather than a packed integer: there is no bound on the number of class start times
  // (every set's times share one array), so any fixed stride would alias one gene's placement onto
  // another's and both forbid legal moves and let tabu ones through.
  /** Movable genes with no placement right now — the work N0 has outstanding. */
  let pendingUnplaced = 0;

  const tabu = new Map<string, number>();
  const tabuKey = (i: number, day: number, timeIdx: number, parity: number, room: number) =>
    `${i}:${day}:${parity}:${timeIdx}:${room}`;

  let temperature = opts.initialTemperature;
  let clock = 0;

  function repairPhase(rounds: number) {
    for (let round = 0; round < rounds; round++) {
      clock++;
      let improved = false;

      // N0 — retry whatever construction could not fit. Its admissible placements were all closed
      // by per-day caps or room rules at the time; by now the classes that closed them have moved,
      // so a gene left out at the start is regularly placeable a few passes later. Without this it
      // would only ever be rescued by a random perturbation. Skipped entirely — including the
      // expensive scan — while nothing is outstanding, which is the normal case.
      if (pendingUnplaced > 0) {
        for (const i of movable) {
          if (genes[i].day >= 0) continue;
          const spot = scanBest(i, false);
          if (!spot) continue;
          place(i, spot.day, spot.timeIdx, spot.parity, spot.room);
          pendingUnplaced--;
          improved = true;
        }
      }

      const conflicted: { i: number; ov: number }[] = [];
      for (const i of movable) {
        const ov = overlapOf(i);
        if (ov > 0) conflicted.push({ i, ov });
      }
      if (conflicted.length === 0) return;
      conflicted.sort((a, b) => b.ov - a.ov);

      const budget = Math.max(1, Math.ceil(movable.length * Math.min(1, Math.max(0.02, opts.intensity))));
      const slice = conflicted.slice(0, Math.min(budget, conflicted.length));

      // N1 — reassignment.
      for (const { i } of slice) {
        const g = genes[i];
        const before = overlapOf(i);
        if (before === 0) continue;
        const best = scanBest(i, false);
        if (!best) continue;
        const key = tabuKey(i, best.day, best.timeIdx, best.parity, best.room);
        const isTabu = (tabu.get(key) ?? 0) > clock;
        const delta = best.overlap - before;
        if (isTabu && delta >= 0) continue;
        if (delta < 0 || rnd() < Math.exp(-delta / Math.max(0.0001, temperature))) {
          tabu.set(tabuKey(i, g.day, g.timeIdx, g.parity, g.room), clock + opts.tabuTenure);
          place(i, best.day, best.timeIdx, best.parity, best.room);
          if (delta < 0) improved = true;
        }
      }

      // N2 — swap the two most conflicted genes' placements, when both placements suit both.
      if (!improved && slice.length >= 2) {
        const a = slice[0].i;
        const b = slice[1].i;
        if (swapPlacements(a, b)) improved = true;
      }

      // N3 — chain move: shove the worst gene into a random conflict-free placement.
      if (!improved && slice.length > 0) {
        const i = slice[0].i;
        const g = genes[i];
        if (g.slots.length) {
          for (let attempt = 0; attempt < 12; attempt++) {
            const packed = g.slots[Math.floor(rnd() * g.slots.length)];
            const day = unpackDay(packed);
            const parity = unpackParity(packed);
            const timeIdx = unpackTime(packed);
            const start = times[timeIdx].startMinutes;
            const end = start + g.durationMinutes;
            const room = g.rooms[Math.floor(rnd() * g.rooms.length)];
            if (!placementAllowed(i, day, start, end, parity, room)) continue;
            if (overlapAt(i, day, start, end, parity, room) === 0) {
              place(i, day, timeIdx, parity, room);
              improved = true;
              break;
            }
          }
        }
      }

      temperature *= opts.coolingFactor;
      if (temperature < 0.01) temperature = 0.01;
      if (!improved && round > 4) return;
    }
  }

  /** Exchange two genes' (day, time, room, parity), if the exchange is admissible and pays. */
  function swapPlacements(a: number, b: number): boolean {
    const ga = genes[a];
    const gb = genes[b];
    if (ga.day < 0 || gb.day < 0) return false;
    // Each has to be allowed to sit where the other does.
    const aPacked = packSlot(gb.day, gb.timeIdx, gb.parity);
    const bPacked = packSlot(ga.day, ga.timeIdx, ga.parity);
    if (!ga.slots.includes(aPacked) || !gb.slots.includes(bPacked)) return false;
    if (!ga.rooms.includes(gb.room) || !gb.rooms.includes(ga.room)) return false;

    const before = overlapOf(a) + overlapOf(b);
    const oldA = { day: ga.day, timeIdx: ga.timeIdx, parity: ga.parity, room: ga.room };
    const oldB = { day: gb.day, timeIdx: gb.timeIdx, parity: gb.parity, room: gb.room };

    place(a, oldB.day, oldB.timeIdx, oldB.parity, oldB.room);
    place(b, oldA.day, oldA.timeIdx, oldA.parity, oldA.room);

    const okA = placementAllowed(a, ga.day, ga.start, ga.end, ga.parity, ga.room);
    const okB = placementAllowed(b, gb.day, gb.start, gb.end, gb.parity, gb.room);
    const after = overlapOf(a) + overlapOf(b);
    const delta = after - before;

    if (okA && okB && (delta < 0 || rnd() < Math.exp(-delta / Math.max(0.0001, temperature)))) {
      return delta < 0;
    }
    place(a, oldA.day, oldA.timeIdx, oldA.parity, oldA.room);
    place(b, oldB.day, oldB.timeIdx, oldB.parity, oldB.room);
    return false;
  }

  // ── Phase 2: window reduction ─────────────────────────────────────────────
  // Only runs on a conflict-free schedule, and only for a bounded number of moves: unbounded
  // window reduction would let one call solve the whole soft-constraint subproblem, leaving the
  // outer loop nothing to do (article, §Bounded depth).

  /** Scanning every gene for its window contribution is the expensive part, so a large faculty is
   *  sampled rather than swept: the worst offenders are numerous, and any of them is worth moving. */
  const WINDOW_SCAN_SAMPLE = 250;

  function windowPhase(maxMoves: number) {
    for (let move = 0; move < maxMoves; move++) {
      let worst = -1;
      let worstCost = 0;
      const stride = movable.length > WINDOW_SCAN_SAMPLE ? movable.length / WINDOW_SCAN_SAMPLE : 1;
      const start = stride > 1 ? rnd() * stride : 0;
      for (let pos = start; pos < movable.length; pos += stride) {
        const i = movable[Math.floor(pos)];
        const g = genes[i];
        if (g.day < 0) continue;
        const cost = windowCostAt(i, g.day);
        if (cost > worstCost) { worstCost = cost; worst = i; }
      }
      if (worst < 0) return;

      const g = genes[worst];
      const old = { day: g.day, timeIdx: g.timeIdx, parity: g.parity, room: g.room };
      const beforeWindows = totalWindowScore();

      const best = scanBest(worst, true);
      if (!best || (best.day === old.day && best.timeIdx === old.timeIdx && best.room === old.room)) return;
      if (best.overlap > 0) return;

      place(worst, best.day, best.timeIdx, best.parity, best.room);
      const afterWindows = totalWindowScore();
      if (afterWindows >= beforeWindows) {
        place(worst, old.day, old.timeIdx, old.parity, old.room);
        return;
      }
    }
  }

  /** The weighted soft part of f(σ) — what Phase 2 accepts or rejects a move on. Π₉ is in it for
   *  the same reason it is in `windowCostAt`: a move that trades a window for a mixed day is not
   *  an improvement, and only a measure holding both can say so. */
  function totalWindowScore(): number {
    const lw = windowTotal(lecBuckets);
    const gw = windowTotal(grpBuckets);
    const md = mixedTotal(grpBuckets);
    return OBJECTIVE_WEIGHTS.lecturerWindows * lw * lw
      + OBJECTIVE_WEIGHTS.groupWindows * gw * gw
      + OBJECTIVE_WEIGHTS.mixedOnlineDays * md * md;
  }

  // ── Perturbation ──────────────────────────────────────────────────────────

  function perturb(strength: number) {
    const n = Math.max(1, Math.floor(movable.length * strength));
    for (let k = 0; k < n; k++) {
      const i = movable[Math.floor(rnd() * movable.length)];
      const g = genes[i];
      if (!g.slots.length || !g.rooms.length) continue;
      for (let attempt = 0; attempt < 6; attempt++) {
        const packed = g.slots[Math.floor(rnd() * g.slots.length)];
        const day = unpackDay(packed);
        const parity = unpackParity(packed);
        const timeIdx = unpackTime(packed);
        const start = times[timeIdx].startMinutes;
        const end = start + g.durationMinutes;
        const room = g.rooms[Math.floor(rnd() * g.rooms.length)];
        if (!placementAllowed(i, day, start, end, parity, room)) continue;
        place(i, day, timeIdx, parity, room);
        break;
      }
    }
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  interface Snapshot { day: Int16Array; timeIdx: Int32Array; room: Int32Array; parity: Int8Array }

  function snapshot(): Snapshot {
    const s: Snapshot = {
      day: new Int16Array(movableCount),
      timeIdx: new Int32Array(movableCount),
      room: new Int32Array(movableCount),
      parity: new Int8Array(movableCount)
    };
    for (let i = 0; i < movableCount; i++) {
      s.day[i] = genes[i].day;
      s.timeIdx[i] = genes[i].timeIdx;
      s.room[i] = genes[i].room;
      s.parity[i] = genes[i].parity;
    }
    return s;
  }

  function restore(s: Snapshot) {
    for (let i = 0; i < movableCount; i++) {
      if (!genes[i].movable) continue;
      place(i, s.day[i], s.timeIdx[i], s.parity[i], s.room[i]);
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  const history: { iteration: number; objective: number }[] = [];
  let intensity = opts.intensity;

  const emit = (phase: SolverPhase, iteration: number, v: Violations, f: number, stagnation: number,
                snap?: Snapshot) => {
    onProgress({
      phase,
      iteration,
      maxIterations: opts.maxIterations,
      elapsedMs: Date.now() - started,
      objective: f,
      violations: v,
      hardTotal: hardOf(v),
      placed: movable.filter((i) => genes[i].day >= 0).length,
      // Only the genes this run may move — a "fill the gaps" run whose faculty is mostly scheduled
      // would otherwise read as "12 of 1400 placed".
      total: movable.length,
      unplaced: pendingUnplaced,
      temperature,
      intensity,
      stagnation,
      assignments: snap ? assignmentsFrom(snap) : undefined
    });
  };

  /** The assignments a snapshot stands for, without having to restore it into the index first. */
  function assignmentsFrom(s: Snapshot): SolverAssignment[] {
    const out: SolverAssignment[] = [];
    for (let i = 0; i < movableCount; i++) {
      const g = genes[i];
      if (!g.movable) continue;
      const day = s.day[i];
      const ti = s.timeIdx[i];
      const room = s.room[i];
      // `room < 0` is not "unplaced": a class in an abstract room or online is placed and has no
      // room, and writes NULL. Only a missing day or bell means the search could not fit it.
      out.push({
        key: requirements[g.reqIndex].key,
        placement: day >= 0 && ti >= 0
          ? {
              dayOfWeek: day,
              classStartTimeId: times[ti].id,
              roomId: room >= 0 ? roomIds[room] : null,
              weekParity: PARITY_NAMES[s.parity[i]]
            }
          : null
      });
    }
    return out;
  }

  emit('PREPARE', 0, measure(), 0, 0);

  construct();

  let current = measure();
  let currentF = objectiveOf(current);
  let best = snapshot();
  let bestV = current;
  let bestF = currentF;
  history.push({ iteration: 0, objective: bestF });
  emit('CONSTRUCT', 0, bestV, bestF, 0);

  let stagnation = 0;
  let iteration = 0;
  let lastEmit = 0;
  let lastSnapshotEmit = 0;

  while (iteration < opts.maxIterations && Date.now() < deadline && !shouldStop()) {
    iteration++;

    repairPhase(opts.repairIterations);
    let v = measure();
    if (hardOf(v) === 0) {
      windowPhase(opts.windowMoves);
      v = measure();
    }
    currentF = objectiveOf(v);

    // A schedule is better when it is closer to feasibility, and — among equally feasible ones —
    // when f is lower. Eq. (1) alone would let a run trade a lecturer clash for a handful of
    // windows once Π₆/Π₇ grow large, which is never the trade a deanery wants.
    const better = hardOf(v) < hardOf(bestV) || (hardOf(v) === hardOf(bestV) && currentF < bestF);
    if (better) {
      best = snapshot();
      bestV = v;
      bestF = currentF;
      history.push({ iteration, objective: bestF });
      stagnation = 0;
      intensity = Math.min(opts.maxIntensity, intensity + 3 * opts.adaptationStep);
    } else {
      stagnation++;
      intensity = Math.max(opts.minIntensity, intensity - 0.5 * opts.adaptationStep);
    }
    opts.intensity = intensity;

    // f(σ) = 0 — every soft term has to be listed here, or a run stops with one still positive.
    if (hardOf(bestV) === 0 && bestV.lecturerWindows === 0 && bestV.groupWindows === 0
        && bestV.mixedOnlineDays === 0) break;

    if (stagnation >= opts.stagnationLimit) {
      restore(best);
      emit('PERTURB', iteration, bestV, bestF, stagnation);
      perturb(0.15 + 0.15 * rnd());
      temperature = opts.initialTemperature;
      stagnation = 0;
    }

    const now = Date.now();
    if (now - lastEmit > 120) {
      lastEmit = now;
      // The snapshot is what makes "stop now" usable, but it costs an array of V placements, so it
      // rides along with roughly one message a second rather than with every one.
      const withSnapshot = now - lastSnapshotEmit > 1000;
      if (withSnapshot) lastSnapshotEmit = now;
      emit(hardOf(bestV) > 0 ? 'REPAIR' : 'WINDOWS', iteration, bestV, bestF, stagnation,
           withSnapshot ? best : undefined);
    }
  }

  restore(best);
  const finalV = measure();
  const finalF = objectiveOf(finalV);
  emit('DONE', iteration, finalV, finalF, stagnation);

  // ── Result ────────────────────────────────────────────────────────────────

  const assignments: SolverAssignment[] = [];
  for (let i = 0; i < movableCount; i++) {
    const g = genes[i];
    const req = requirements[g.reqIndex];
    if (!g.movable) continue;
    assignments.push({
      key: req.key,
      // As in `assignmentsFrom`: a roomless gene is placed, not unplaced.
      placement: g.day >= 0 && g.timeIdx >= 0
        ? {
            dayOfWeek: g.day,
            classStartTimeId: times[g.timeIdx].id,
            roomId: g.room >= 0 ? roomIds[g.room] : null,
            weekParity: PARITY_NAMES[g.parity]
          }
        : null
    });
  }

  // A construction failure that N0 later resolved is no longer worth reporting; one that stayed
  // unplaced, and one whose domain was empty from the start, both are.
  const resolved = new Set(constructionFailures.filter((f) => genes[f.gene].day >= 0).map((f) => f.key));

  return {
    assignments,
    objective: finalF,
    violations: finalV,
    unplaced: unplaced.filter((u) => !resolved.has(u.key)),
    conflicts: collectConflicts(),
    iterations: iteration,
    elapsedMs: Date.now() - started,
    history
  };

  function collectConflicts(): SolverConflict[] {
    const out: SolverConflict[] = [];
    const scan = (buckets: number[][], ids: string[], kind: SolverConflict['kind']) => {
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        if (bucket.length < 2) continue;
        const entity = Math.floor(b / DAY_SLOTS);
        const day = b % DAY_SLOTS;
        for (let x = 0; x < bucket.length; x++) {
          for (let y = x + 1; y < bucket.length; y++) {
            const a = genes[bucket[x]];
            const c = genes[bucket[y]];
            if (!a.movable && !c.movable) continue;
            if (!weeksOverlap(a.parity, c.parity)) continue;
            if (!timesOverlap(a.start, a.end, c.start, c.end)) continue;
            if (out.length >= 200) return;
            out.push({
              kind,
              subjectId: ids[entity],
              dayOfWeek: day,
              keys: [a.key, c.key],
              descriptions: [a.label, c.label]
            });
          }
        }
      }
    };
    /** The same sweep for Π₄/Π₅ — pairs that do not overlap but are too far apart to reach. The
     *  predicate itself is `unreachablePair`, shared with the objective so the list and the number
     *  beside it cannot disagree. */
    const scanTravel = (buckets: number[][], ids: string[], kind: SolverConflict['kind']) => {
      if (!travelKnown) return;
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        if (bucket.length < 2) continue;
        const entity = Math.floor(b / DAY_SLOTS);
        const day = b % DAY_SLOTS;
        for (let x = 0; x < bucket.length; x++) {
          for (let y = x + 1; y < bucket.length; y++) {
            const pair = unreachablePair(genes[bucket[x]], genes[bucket[y]]);
            if (!pair) continue;
            if (out.length >= 200) return;
            out.push({
              kind,
              subjectId: ids[entity],
              dayOfWeek: day,
              keys: [pair.first.key, pair.second.key],
              descriptions: [pair.first.label, pair.second.label]
            });
          }
        }
      }
    };

    /**
     * Π₆ — an abstract room over its capacity. Reported once per breaching instant, naming two of
     * the classes sharing it: the crowd is what is wrong, and listing every class in it would fill
     * the 200-entry budget with one hour of «Спортивні зали».
     *
     * Once per *instant*, not once per week: Π₆ deliberately counts a weekly breach twice, because
     * it happens in both weeks, but printing the same two class names twice would only read as a
     * bug. So the list is shorter than the number beside it whenever a weekly class is involved.
     */
    const scanAbstract = () => {
      const reported = new Set<string>();
      for (let b = 0; b < absBuckets.length; b++) {
        const bucket = absBuckets[b];
        if (bucket.length < 2) continue;
        const room = Math.floor(b / DAY_SLOTS);
        const day = b % DAY_SLOTS;
        const cap = abstractCapacity[room];
        if (cap < 0) continue;
        for (let week = PARITY_NUMERATOR; week <= PARITY_DENOMINATOR; week++) {
          for (let x = 0; x < bucket.length; x++) {
            const a = genes[bucket[x]];
            if (a.start < 0) continue;
            if (a.parity !== PARITY_WEEKLY && a.parity !== week) continue;
            let seen = false;
            for (let k = 0; k < x && !seen; k++) {
              const e = genes[bucket[k]];
              seen = e.start === a.start && (e.parity === PARITY_WEEKLY || e.parity === week);
            }
            if (seen) continue;
            let total = 0;
            let anyMovable = false;
            let other: Gene | null = null;
            for (let y = 0; y < bucket.length; y++) {
              const c = genes[bucket[y]];
              if (c.start < 0) continue;
              if (c.parity !== PARITY_WEEKLY && c.parity !== week) continue;
              if (c.start > a.start || c.end <= a.start) continue;
              total += c.students;
              if (c.movable) anyMovable = true;
              if (c !== a && !other) other = c;
            }
            if (!anyMovable || total <= cap || !other) continue;
            const at = `${room}:${day}:${a.start}`;
            if (reported.has(at)) continue;
            reported.add(at);
            if (out.length >= 200) return;
            out.push({
              kind: 'ABSTRACT_ROOM_CAPACITY',
              subjectId: abstractIds[room],
              dayOfWeek: day,
              keys: [a.key, other.key],
              descriptions: [
                `${a.label} — ${abstractNames[room]}: ${total} студентів, місткість ${cap}`,
                other.label
              ]
            });
          }
        }
      }
    };

    scan(lecBuckets, lecturerIds, 'LECTURER');
    scan(grpBuckets, groupIds, 'GROUP');
    scan(roomBuckets, roomIds, 'ROOM');
    scanTravel(grpBuckets, groupIds, 'GROUP_TRAVEL');
    scanTravel(lecBuckets, lecturerIds, 'LECTURER_TRAVEL');
    scanAbstract();
    return out;
  }
}
