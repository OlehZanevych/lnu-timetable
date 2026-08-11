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
 * which is why they are numbered together.
 *
 * The **search is no longer the article's**. It began as the paper's two-phase multi-neighbourhood
 * local search under simulated-annealing acceptance, and measurement retired that: the repair phase
 * was a deterministic descent that reached a local optimum in its first iteration and never moved
 * again — with perturbation disabled a run logged one improvement in 89,070 iterations — and the
 * temperature was never consulted at all, so answers were identical for T from 2.5 to 8000. What
 * runs now is a **move-level stochastic local search**: sample one move from a composite
 * neighbourhood (reassignment, plus a targeted swap that trades with whoever holds the slot you
 * want), evaluate it by recomputing only the buckets it touches, and accept it by **late acceptance**
 * — a candidate is kept if it is no worse than the one accepted L moves ago. Construction is still
 * the most-constrained-first greedy the paper's alternative random population is judged against.
 * See TIMETABLE-GENERATION.md for the measurements behind each of those choices, and for the
 * parameters that are now vestigial.
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
  /**
   * Moves without a new incumbent before the schedule is perturbed. Scaled by 2000 inside the
   * loop, because an iteration is now a single move rather than a whole descent to a fixpoint.
   */
  stagnationLimit: number;
  /** L — late acceptance history length. */
  lahcLength?: number;
  /** Fraction of candidates drawn from N2 (swap) rather than N1 (reassign). */
  swapRate?: number;
  /** Rooms examined per slot before a scan gives up looking for a free one. */
  roomSample?: number;
  /** Fraction of candidates drawn from classes currently in a hard violation. */
  hotShare?: number;
  /** What one hard violation costs the acceptance test. Finite on purpose. */
  hardWeight?: number;
  /** Moves between hot-list refreshes. */
  hotRefresh?: number;
  /** Room-domain size below which a scan always looks at every room. */
  roomScanFullBelow?: number;
  /** Fraction of candidates drawn from the ejection chain (N4), while the search is still descending. */
  chainRate?: number;
  /** Barren moves after which the chain switches off — it helps the descent and hurts the endgame. */
  chainOffAfter?: number;
  seed: number;
}

export const DEFAULT_OPTIONS: SolverOptions = {
  // Deliberately far above what any run reaches: the wall-clock budget is the real bound, and an
  // iteration cap low enough to bite would stop a small instance while it still had seconds of
  // window reduction left to do. It stays as a backstop against a pathological zero-cost loop.
  // An iteration is now a single move rather than a descent to a fixpoint, so a run does tens of
  // millions of them: the old 1,000,000 was reached in 13 seconds of a 30-second budget and silently
  // ended the search less than half way through. The wall clock is the real bound, as the original
  // comment here always intended; this stays only as a backstop against a zero-cost loop.
  maxIterations: 2_000_000_000,
  timeLimitMs: 30_000,
  stagnationLimit: 30,
  // L — measured, not guessed, and re-measured at scale. A first sweep at n≤400 put the usable
  // range below ~1000 (at L=50000 the search stopped reaching feasibility at all). A second sweep
  // at n=3200 and n=12800 showed the optimum is *smaller* still, and does NOT grow with the
  // instance: at n=3200 soft cost was 638 at L=100 against 876 at L=500 and 3935 at L=1600, and at
  // n=12800 it was 4508 at L=100 against 23366 at L=500 — an 81% reduction on the largest instance
  // tested. A long history lets the uphill drift outrun the descent, and the bigger the instance
  // the more damage that does.
  lahcLength: 100,
  // Every measurement in scripts/timetable-bench was taken at 0.5, and the targeted-swap sweep put
  // the best rate between 0.4 and 0.6 with the optimum rising as the instance grows.
  swapRate: 0.5,
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
  /** Moves without a new incumbent. The old `temperature` and `intensity` readouts were removed
   *  with the annealing search they described — reporting a frozen number is worse than reporting
   *  nothing. */
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
    /** True when `rooms` is the unrestricted fallback (every room of this faculty), which lets the
     *  membership test skip the scan entirely. */
    anyRoom: boolean;
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
  /** O(1) "is this one of this faculty's rooms?", for the unrestricted membership test. */
  const isFacultyRoom = new Uint8Array(roomIds.length);
  for (const r of allRoomIndices) isFacultyRoom[r] = 1;

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
    const unrestricted = placeKind === PLACE_ROOM && req.roomIds.length === 0;
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
      anyRoom: unrestricted,
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
      anyRoom: false,
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
  /**
   * A вікно is a whole пара the entity could have been taught in and was not.
   *
   * Counting raw idle minutes instead — total gap, floored to academic hours — charges the ordinary
   * break between two consecutive bells as idle time, so a perfectly packed six-class day scored
   * about two window units and Π₇/Π₈ could never reach zero on a full day. That is not what a
   * деканат means by «без вікон», and it also meant the search's zero-cost exit could only ever
   * fire on a sparse instance.
   *
   * So what is counted is the number of *start times* that fall in the gap: each one is a пара the
   * entity was free for. Consecutive classes leave no start time between them and cost nothing;
   * a skipped пара costs one, whatever the bells' exact spacing, which is what makes the figure
   * comparable across the main grid and the спорткомплекс grid.
   */
  /** Every bell start time on any grid, ascending and deduplicated — the ticks a вікно is measured
   *  in. Built once; the two grids interleave, so this is not one set's ordinals. */
  const distinctStarts: number[] = (() => {
    const seen = new Set<number>();
    for (const t of times) seen.add(t.startMinutes);
    return [...seen].sort((a, b) => a - b);
  })();

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
    let n = 0;
    let reach = spans[0][1];
    for (let k = 1; k < spans.length; k++) {
      if (spans[k][0] > reach) n += freeStartsBetween(reach, spans[k][0]);
      reach = Math.max(reach, spans[k][1]);
    }
    return n;
  }

  /** Distinct bell start times t with `from <= t < to` — the пари nobody used in that gap. */
  function freeStartsBetween(from: number, to: number): number {
    let n = 0;
    for (let k = 0; k < distinctStarts.length; k++) {
      const t = distinctStarts[k];
      if (t >= to) break;
      if (t >= from) n++;
    }
    return n;
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

  // ── Per-bucket components, for incremental evaluation ─────────────────────
  //
  // Every Π is a sum over buckets, so a move only needs the buckets it touches recomputed rather
  // than the whole schedule. That is the difference between a search that can afford one candidate
  // per full `measure()` and one that can afford hundreds of thousands.
  //
  // These mirror the aggregate counters exactly — same predicates, same movable-aware skips — but
  // for one bucket at a time.

  function bucketConf(bucket: number[]): number {
    let n = 0;
    for (let x = 0; x < bucket.length; x++) {
      const a = genes[bucket[x]];
      if (a.start < 0) continue;
      for (let y = x + 1; y < bucket.length; y++) {
        const c = genes[bucket[y]];
        if (c.start < 0) continue;
        if (!a.movable && !c.movable) continue;
        if (!weeksOverlap(a.parity, c.parity)) continue;
        if (timesOverlap(a.start, a.end, c.start, c.end)) n++;
      }
    }
    return n;
  }

  function bucketTrav(bucket: number[]): number {
    let n = 0;
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        if (unreachablePair(genes[bucket[x]], genes[bucket[y]])) n++;
      }
    }
    return n;
  }

  function absBucketOver(b: number): number {
    const bucket = absBuckets[b];
    if (bucket.length < 2) return 0;
    const cap = abstractCapacity[Math.floor(b / DAY_SLOTS)];
    if (cap < 0) return 0;
    let n = 0;
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
    return n;
  }

  // ── Running counters ──────────────────────────────────────────────────────
  //
  // Windows and mixed days are kept as their two weekly sums rather than as the rounded average the
  // reported Violations carry: rounding is not incrementally maintainable, and a search steered by
  // a rounded counter is blind to any move that shifts the total by less than a whole unit. The
  // surrogate below is therefore smooth; the schedule that is finally returned is re-measured
  // exactly, so nothing that is reported was ever computed this way.
  const C = { lecConf: 0, grpConf: 0, roomConf: 0, lecTrav: 0, grpTrav: 0, absOver: 0,
              lecWinN: 0, lecWinD: 0, grpWinN: 0, grpWinD: 0, grpMixN: 0, grpMixD: 0 };

  function rebuildCounters() {
    C.lecConf = 0; C.grpConf = 0; C.roomConf = 0; C.lecTrav = 0; C.grpTrav = 0; C.absOver = 0;
    C.lecWinN = 0; C.lecWinD = 0; C.grpWinN = 0; C.grpWinD = 0; C.grpMixN = 0; C.grpMixD = 0;
    for (let b = 0; b < lecBuckets.length; b++) {
      const k = lecBuckets[b];
      C.lecConf += bucketConf(k); C.lecTrav += bucketTrav(k);
      C.lecWinN += windowsIn(k, PARITY_NUMERATOR); C.lecWinD += windowsIn(k, PARITY_DENOMINATOR);
    }
    for (let b = 0; b < grpBuckets.length; b++) {
      const k = grpBuckets[b];
      C.grpConf += bucketConf(k); C.grpTrav += bucketTrav(k);
      C.grpWinN += windowsIn(k, PARITY_NUMERATOR); C.grpWinD += windowsIn(k, PARITY_DENOMINATOR);
      C.grpMixN += mixedIn(k, PARITY_NUMERATOR); C.grpMixD += mixedIn(k, PARITY_DENOMINATOR);
    }
    for (let b = 0; b < roomBuckets.length; b++) C.roomConf += bucketConf(roomBuckets[b]);
    for (let b = 0; b < absBuckets.length; b++) C.absOver += absBucketOver(b);
  }

  const W = OBJECTIVE_WEIGHTS;
  const sq = (x: number) => x * x;
  /** The smooth surrogate the search descends; hard terms are exact integers. */
  function surrogate(): number {
    return W.lecturerConflicts * sq(C.lecConf) + W.groupConflicts * sq(C.grpConf)
      + W.roomConflicts * sq(C.roomConf) + W.groupTravel * sq(C.grpTrav)
      + W.lecturerTravel * sq(C.lecTrav) + W.abstractRoomOverflow * sq(C.absOver)
      + W.lecturerWindows * sq((C.lecWinN + C.lecWinD) / 2)
      + W.groupWindows * sq((C.grpWinN + C.grpWinD) / 2)
      + W.mixedOnlineDays * sq((C.grpMixN + C.grpMixD) / 2);
  }
  const hardNow = () => C.lecConf + C.grpConf + C.roomConf + C.grpTrav + C.lecTrav + C.absOver;

  // ── One move, evaluated incrementally ─────────────────────────────────────
  //
  // Buckets touched by moving gene `i` are those of its lecturers, groups, room and abstract room,
  // on the day it leaves and the day it arrives — a handful, against the whole schedule.
  const touchedLec: number[] = [], touchedGrp: number[] = [], touchedRoom: number[] = [], touchedAbs: number[] = [];
  const addUnique = (arr: number[], v: number) => { for (let k = 0; k < arr.length; k++) if (arr[k] === v) return; arr.push(v); };

  function collectTouched(i: number, newDay: number, newRoom: number) {
    touchedLec.length = 0; touchedGrp.length = 0; touchedRoom.length = 0; touchedAbs.length = 0;
    const g = genes[i];
    const days = g.day === newDay ? [g.day] : [g.day, newDay];
    for (const d of days) {
      if (d < 0) continue;
      for (const l of g.lecturers) addUnique(touchedLec, l * DAY_SLOTS + d);
      for (const gr of g.groups) addUnique(touchedGrp, gr * DAY_SLOTS + d);
      if (g.abstractRoom >= 0) addUnique(touchedAbs, g.abstractRoom * DAY_SLOTS + d);
    }
    for (const r of [g.room, newRoom]) {
      if (r < 0) continue;
      for (const d of days) if (d >= 0) addUnique(touchedRoom, r * DAY_SLOTS + d);
    }
  }

  /** Sums the touched buckets' components into `out`, with the sign given. */
  function accumulate(sign: number) {
    for (const b of touchedLec) {
      const k = lecBuckets[b];
      C.lecConf += sign * bucketConf(k); C.lecTrav += sign * bucketTrav(k);
      C.lecWinN += sign * windowsIn(k, PARITY_NUMERATOR); C.lecWinD += sign * windowsIn(k, PARITY_DENOMINATOR);
    }
    for (const b of touchedGrp) {
      const k = grpBuckets[b];
      C.grpConf += sign * bucketConf(k); C.grpTrav += sign * bucketTrav(k);
      C.grpWinN += sign * windowsIn(k, PARITY_NUMERATOR); C.grpWinD += sign * windowsIn(k, PARITY_DENOMINATOR);
      C.grpMixN += sign * mixedIn(k, PARITY_NUMERATOR); C.grpMixD += sign * mixedIn(k, PARITY_DENOMINATOR);
    }
    for (const b of touchedRoom) C.roomConf += sign * bucketConf(roomBuckets[b]);
    for (const b of touchedAbs) C.absOver += sign * absBucketOver(b);
  }

  /**
   * Offers gene `i` one placement and keeps it if late acceptance allows.
   *
   * The whole point of the rewrite: a candidate costs a handful of bucket recomputations rather
   * than a full `measure()` of the schedule, so the time budget buys hundreds of thousands of
   * genuine candidates instead of one descent to a fixpoint followed by an inert wait.
   */
  function tryMove(i: number, day: number, timeIdx: number, parity: number, room: number): boolean {
    const g = genes[i];
    if (g.day === day && g.timeIdx === timeIdx && g.parity === parity && g.room === room) return false;
    const start = times[timeIdx].startMinutes;
    const end = start + g.durationMinutes;
    if (!placementAllowed(i, day, start, end, parity, room)) return false;

    const oldDay = g.day, oldTime = g.timeIdx, oldParity = g.parity, oldRoom = g.room;
    collectTouched(i, day, room);
    accumulate(-1);
    place(i, day, timeIdx, parity, room);
    accumulate(1);

    const cost = hardNow() * hardWeight + surrogate();
    const slot = moveCount % lahcLength;
    const ok = cost <= lahcHistory[slot] || cost <= acceptedCost;
    if (ok) {
      acceptedCost = cost;
      return true;
    }
    // Reject: put it back, and undo the counter delta the same way it was applied.
    accumulate(-1);
    place(i, oldDay, oldTime, oldParity, oldRoom);
    accumulate(1);
    return false;
  }

  /** Does gene `g` admit this exact (day, time, parity) triple? Its domain already encodes the
   *  bell set it runs on and the NOT_BEFORE/NOT_AFTER/UNAVAILABLE rules of everyone involved. */
  function hasSlot(g: Gene, packed: number): boolean {
    const a = g.slots;
    for (let k = 0; k < a.length; k++) if (a[k] === packed) return true;
    return false;
  }
  /**
   * Is `room` in this class's domain?
   *
   * A class that names no room has the *whole faculty* as its domain — 1,620 rooms on the largest
   * instance here — so a linear membership test made every swap attempt O(rooms). Measured, that
   * held the search to 2,285 moves/s at n=31000 against 13,000/s at n=12800. A class with the full
   * domain needs no scan at all: the question is only whether the room belongs to this faculty,
   * which is one array read.
   */
  function hasRoom(g: Gene, room: number): boolean {
    if (room < 0) return g.rooms.length > 0 && g.rooms[0] === -1;
    if (g.anyRoom) return isFacultyRoom[room] === 1;
    const a = g.rooms;
    for (let k = 0; k < a.length; k++) if (a[k] === room) return true;
    return false;
  }

  /**
   * N2: two classes exchange their whole placement.
   *
   * A reassignment alone cannot move a class into an occupied slot, so once the timetable is dense
   * the single-move neighbourhood is mostly blocked — which is exactly when a swap is the only way
   * through. This is the "composite neighbourhood" every state-of-the-art result uses; the two
   * moves are evaluated as one candidate, because either half alone is usually worse than both.
   */
  function trySwap(i: number, j: number): boolean {
    if (i === j) return false;
    const gi = genes[i], gj = genes[j];
    if (gi.timeIdx < 0 || gj.timeIdx < 0) return false;
    const pi = packSlot(gi.day, gi.timeIdx, gi.parity);
    const pj = packSlot(gj.day, gj.timeIdx, gj.parity);
    if (pi === pj && gi.room === gj.room) return false;
    // Each must admit the other's slot and room, or the exchange would break a hard filter.
    if (!hasSlot(gi, pj) || !hasSlot(gj, pi)) return false;
    if (!hasRoom(gi, gj.room) || !hasRoom(gj, gi.room)) return false;

    const iDay = gi.day, iTime = gi.timeIdx, iPar = gi.parity, iRoom = gi.room;
    const jDay = gj.day, jTime = gj.timeIdx, jPar = gj.parity, jRoom = gj.room;

    collectTouched(i, jDay, jRoom);
    const lecN = touchedLec.slice(), grpN = touchedGrp.slice(), roomN = touchedRoom.slice(), absN = touchedAbs.slice();
    collectTouched(j, iDay, iRoom);
    for (const b of lecN) addUnique(touchedLec, b);
    for (const b of grpN) addUnique(touchedGrp, b);
    for (const b of roomN) addUnique(touchedRoom, b);
    for (const b of absN) addUnique(touchedAbs, b);

    accumulate(-1);
    place(i, jDay, jTime, jPar, jRoom);
    place(j, iDay, iTime, iPar, iRoom);
    accumulate(1);

    // MAX_CLASSES_PER_DAY is the one rule the domains do not carry, so it is checked on the result
    // rather than on the candidate.
    const legal = placementAllowed(i, gi.day, gi.start, gi.end, gi.parity, gi.room)
               && placementAllowed(j, gj.day, gj.start, gj.end, gj.parity, gj.room);
    const cost = hardNow() * hardWeight + surrogate();
    const slot = moveCount % lahcLength;
    if (legal && (cost <= lahcHistory[slot] || cost <= acceptedCost)) {
      acceptedCost = cost;
      return true;
    }
    accumulate(-1);
    place(i, iDay, iTime, iPar, iRoom);
    place(j, jDay, jTime, jPar, jRoom);
    accumulate(1);
    return false;
  }

  /**
   * N2′: a *targeted* exchange — pick the placement you want, and trade with whoever holds it.
   *
   * A uniformly random pair almost never admits each other's slot and room, so a random swap is
   * mostly a cheap rejection: raising the swap rate to 0.5 raised the iteration count by 60% and
   * made the answer worse. Choosing the partner by what is actually blocking the move you wanted
   * makes nearly every attempt a real candidate, which is what the composite neighbourhoods in the
   * literature are doing.
   */
  function tryTargetedSwap(i: number): boolean {
    const gi = genes[i];
    if (!gi.slots.length || !gi.rooms.length) return false;
    const packed = gi.slots[(rnd() * gi.slots.length) | 0];
    const room = gi.rooms[(rnd() * gi.rooms.length) | 0];
    if (room < 0) return false;               // roomless classes have nobody to trade a room with
    const day = unpackDay(packed);
    const timeIdx = unpackTime(packed);
    const parity = unpackParity(packed);
    const start = times[timeIdx].startMinutes;
    const end = start + gi.durationMinutes;

    // Who is in the way?
    const bucket = roomBuckets[room * DAY_SLOTS + day];
    let j = -1;
    for (let k = 0; k < bucket.length; k++) {
      const c = genes[bucket[k]];
      if (c === gi || !c.movable || c.start < 0) continue;
      if (!weeksOverlap(parity, c.parity)) continue;
      if (timesOverlap(start, end, c.start, c.end)) { j = bucket[k]; break; }
    }
    if (j < 0) return tryMove(i, day, timeIdx, parity, room);   // nobody there — a plain move
    return trySwap(i, j);
  }

  /**
   * An ejection chain: put a class where it wants to go, then find the class that was in the way and
   * let it go where *it* wants — recursively — instead of forcing it into the hole the first one
   * left.
   *
   * `tryTargetedSwap` is the depth-1 special case with a mandatory swap-back, and the swap-back is
   * the restriction: B has to accept exactly A's old placement, which is usually a placement B has
   * already rejected. A chain lets B take its own best free slot and passes the problem to whoever
   * that displaces, so it can express rearrangements no sequence of single moves reaches — each
   * intermediate state is worse, and a move-at-a-time search will not walk through them.
   *
   * This is the last neighbourhood the evidence pointed at, after a restart (cycle 18) and
   * ruin-and-recreate (cycle 19) both failed to leave the converged basin.
   *
   * The whole chain is one candidate: applied, costed once, and accepted or unwound as a unit.
   */
  const CHAIN_DEPTH = 3;

  function tryEjectionChain(i: number): boolean {
    const gi = genes[i];
    if (!gi.slots.length || !gi.rooms.length) return false;
    const packed = gi.slots[(rnd() * gi.slots.length) | 0];
    const room0 = gi.rooms[(rnd() * gi.rooms.length) | 0];
    if (room0 < 0) return false;
    let day = unpackDay(packed), timeIdx = unpackTime(packed), parity = unpackParity(packed);
    let room = room0;
    let start = times[timeIdx].startMinutes, end = start + gi.durationMinutes;
    if (!placementAllowed(i, day, start, end, parity, room)) return false;

    // Everything the chain touched, oldest first, so it can be unwound exactly.
    const undo: number[] = [];
    const moved = new Set<number>();

    const applyMove = (k: number, d: number, t: number, p: number, r: number) => {
      const g = genes[k];
      undo.push(k, g.day, g.timeIdx, g.parity, g.room);
      moved.add(k);
      collectTouched(k, d, r);
      accumulate(-1);
      place(k, d, t, p, r);
      accumulate(1);
    };

    applyMove(i, day, timeIdx, parity, room);

    for (let depth = 0; depth < CHAIN_DEPTH; depth++) {
      // Who is now double-booked in the room the last link took?
      const bucket = roomBuckets[room * DAY_SLOTS + day];
      let j = -1;
      for (let k = 0; k < bucket.length; k++) {
        const c = genes[bucket[k]];
        if (moved.has(bucket[k]) || !c.movable || c.start < 0) continue;
        if (!weeksOverlap(parity, c.parity)) continue;
        if (timesOverlap(start, end, c.start, c.end)) { j = bucket[k]; break; }
      }
      if (j < 0) break;                      // nobody displaced — the chain closes cleanly

      const spot = scanBest(j, true);
      if (!spot) break;                      // leave j where it is and let the cost decide
      applyMove(j, spot.day, spot.timeIdx, spot.parity, spot.room);
      day = spot.day; timeIdx = spot.timeIdx; parity = spot.parity; room = spot.room;
      start = times[timeIdx].startMinutes; end = start + genes[j].durationMinutes;
      if (room < 0) break;                   // j is roomless where it landed: nothing to displace
    }

    const cost = hardNow() * hardWeight + surrogate();
    const slot = moveCount % lahcLength;
    if (cost <= lahcHistory[slot] || cost <= acceptedCost) {
      acceptedCost = cost;
      return true;
    }
    for (let k = undo.length - 5; k >= 0; k -= 5) {
      const gi2 = undo[k], d = undo[k + 1], t = undo[k + 2], p = undo[k + 3], r = undo[k + 4];
      collectTouched(gi2, d, r);
      accumulate(-1);
      place(gi2, d, t, p, r);
      accumulate(1);
    }
    return false;
  }

  // ── Endgame focus: the classes actually in a hard violation ───────────────
  //
  // A run at n=31000 ends with about five violations among 29,760 classes, so a uniformly drawn
  // class is one of the guilty parties roughly 0.03% of the time and effectively the whole budget
  // is spent polishing a schedule that is already feasible everywhere else. Drawing candidates from
  // the offenders instead is the min-conflicts heuristic, and it is what turns "nearly feasible"
  // into feasible.
  //
  // The scan is a full pass, so it is amortised over tens of thousands of moves and only runs while
  // something is actually broken.
  let hotList: number[] = [];
  let hotStamp = -1;

  function refreshHot() {
    const seen = new Set<number>();
    const add = (i: number) => { if (genes[i].movable) seen.add(i); };
    const scanConf = (buckets: number[][]) => {
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        for (let x = 0; x < bucket.length; x++) {
          const a = genes[bucket[x]];
          if (a.start < 0) continue;
          for (let y = x + 1; y < bucket.length; y++) {
            const c = genes[bucket[y]];
            if (c.start < 0 || (!a.movable && !c.movable)) continue;
            if (weeksOverlap(a.parity, c.parity) && timesOverlap(a.start, a.end, c.start, c.end)) {
              add(bucket[x]); add(bucket[y]);
            }
          }
        }
      }
    };
    const scanTrav = (buckets: number[][]) => {
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        for (let x = 0; x < bucket.length; x++) for (let y = x + 1; y < bucket.length; y++) {
          if (unreachablePair(genes[bucket[x]], genes[bucket[y]])) { add(bucket[x]); add(bucket[y]); }
        }
      }
    };
    scanConf(lecBuckets); scanConf(grpBuckets); scanConf(roomBuckets);
    scanTrav(lecBuckets); scanTrav(grpBuckets);
    for (let b = 0; b < absBuckets.length; b++) if (absBucketOver(b) > 0) for (const g of absBuckets[b]) add(g);
    hotList = [...seen];
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
  /** How many rooms of a class's domain one scan looks at before giving up on finding a free one. */
  // Sampling the room domain is only worth its cost when a full scan is genuinely unaffordable.
  // Measured: at n=3200 (167 rooms) sampling made the answer ~30% worse, while at n=31000 (1620
  // rooms) a full scan spent 123 s of a 520 s budget in construction alone. So the full scan stays
  // wherever it is cheap, and the sample takes over only above a threshold.
  const ROOM_SAMPLE = opts.roomSample ?? 96;
  const ROOM_SCAN_FULL_BELOW = opts.roomScanFullBelow ?? 256;

  function scanBest(i: number, wantWindows: boolean, avoid: number = -2, wide: boolean = false):
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
      // Restricted candidate list. A class that names no room has the whole faculty as its domain,
      // so scanning every room makes construction O(n²) in the room count: measured at 1.3 s for
      // n=3200, 17.8 s at n=12800 and 123 s at n=31000 — two minutes before the search takes its
      // first move. Sampling a bounded number instead makes it linear. `wide` below restores the
      // full scan for the cases that need it.
      const limit = (wide || rooms.length <= ROOM_SCAN_FULL_BELOW) ? rooms.length : Math.min(rooms.length, ROOM_SAMPLE);
      for (let r = 0; r < limit; r++) {
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
      // The sample answers almost every class while the timetable is still sparse; only the ones it
      // cannot place cleanly pay for a full scan, which is exactly where the extra cost is worth it.
      let best = scanBest(i, true);
      if (!best || best.overlap > 0) {
        const full = scanBest(i, true, -2, true);
        if (full && (!best || full.overlap < best.overlap)) best = full;
      }
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

  /** Movable genes with no placement right now — the work N0 has outstanding. */
  let pendingUnplaced = 0;

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

  function snapshotInto(s: Snapshot): Snapshot {
    for (let i = 0; i < movableCount; i++) {
      s.day[i] = genes[i].day;
      s.timeIdx[i] = genes[i].timeIdx;
      s.room[i] = genes[i].room;
      s.parity[i] = genes[i].parity;
    }
    return s;
  }

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

  // ── Search: move-level stochastic local search under late acceptance ──────
  //
  // The previous loop descended to a local optimum in its first iteration and then re-ran the same
  // deterministic descent forever, measured: with perturbation disabled it logged one improvement
  // in 89,070 iterations and never left the construction value. All of its progress came from
  // kicking 15-30% of the schedule at random and descending again — a very coarse instrument.
  //
  // This replaces it with the shape every state-of-the-art timetabling result uses: sample a single
  // move, evaluate it incrementally, accept it by a rule that tolerates drift. Late Acceptance Hill
  // Climbing is the rule — a candidate is kept if it is no worse than the one accepted L moves ago
  // — chosen because it needs no temperature, and temperature was measured to be irrelevant here
  // (T from 2.5 to 8000 gave identical answers).
  rebuildCounters();
  // A finite price on a hard violation, not an absolute rank. With `hard × 1e12` any move that
  // *temporarily* makes things worse costs a trillion and is always rejected, so a schedule with a
  // single stuck violation can never be repaired — measured on one n=6400 instance that returned
  // byte-identical results at 30 s, 60 s and 120 s. Escaping usually needs to pass through a worse
  // state; this sets how much that is allowed to cost.
  // What one hard violation costs the acceptance test, measured in units of THIS instance's own
  // objective rather than as an absolute number.
  //
  // A fixed weight cannot be right: f is a sum of squared counters, so it grows with the square of
  // the instance. 1e8 is an enormous penalty at n=400 (f ≈ 1e5) and a rounding error at n=31000
  // (f ≈ 2e10), which is exactly what the measurements showed — 5/5 feasible and best-in-class soft
  // at n≤12800, then soft 57584 against 9977 for the infinite rank at n=31000, because feasibility
  // had stopped mattering to the search at all.
  //
  // Taking it as a fraction of the objective right after construction makes it scale-free: one hard
  // violation always costs about as much as a 2% swing in the whole soft cost — enough to dominate
  // any single soft move, finite enough to let the search pass through a worse state to repair a
  // stuck one.
  const hardWeight = opts.hardWeight ?? Math.max(1_000_000, surrogate() * 0.02);
  let acceptedCost = hardNow() * hardWeight + surrogate();
  const lahcLength = Math.max(50, opts.lahcLength ?? 5000);
  const lahcHistory = new Float64Array(lahcLength).fill(acceptedCost);
  let moveCount = 0;
  const swapRate = opts.swapRate ?? 0.3;
  const hotShare = opts.hotShare ?? 0.7;
  const hotRefresh = opts.hotRefresh ?? 50000;

  let bestCost = acceptedCost;
  let bestHard = hardNow();
  snapshotInto(best);
  bestV = measure();
  bestF = objectiveOf(bestV);

  let iteration = 0;
  let lastEmit = 0;
  let lastSnapshotEmit = 0;
  let sinceBest = 0;
  /**
   * Share of candidates drawn from the ejection chain rather than a swap or a reassignment —
   * **while the search is still descending**.
   *
   * Measured, the chain is worth 28-46% on every instance that is still improving and costs 28% on
   * every instance that has converged: same instance, same rate, same seed, n=12,800 gives 652
   * against the plain search's 913 at two minutes and 560 against its 438 at five. It is not a size
   * effect. A chain displaces up to four classes at once, which is what you want while there is
   * structure to break up and exactly wrong while polishing the last twenty windows — at that point
   * every candidate it offers is a large perturbation the acceptance test has to reject.
   *
   * So it is switched off once the incumbent stops moving, using the counter the loop already keeps.
   * The threshold is generous on purpose: the point is to stop the chain during the endgame, not to
   * ration it during the descent.
   */
  const chainRate = opts.chainRate ?? 0.15;
  const chainOffAfter = opts.chainOffAfter ?? 20_000;
  let improvements = 0;

  while (iteration < opts.maxIterations && !shouldStop()) {
    // The clock is read once per block of moves rather than once per move: Date.now() would
    // otherwise be a measurable fraction of the work at this move rate.
    if ((iteration & 1023) === 0 && Date.now() >= deadline) break;
    iteration++;

    // While anything is still infeasible, most candidates come from the classes responsible for it.
    if (hardNow() > 0 && iteration - hotStamp > hotRefresh) { refreshHot(); hotStamp = iteration; }
    const useHot = hotList.length > 0 && hardNow() > 0 && rnd() < hotShare;
    const i = useHot ? hotList[(rnd() * hotList.length) | 0] : movable[(rnd() * movable.length) | 0];
    const g = genes[i];
    if (!g.slots.length || !g.rooms.length) continue;
    moveCount++;
    if (sinceBest < chainOffAfter && rnd() < chainRate) {
      tryEjectionChain(i);
    } else if (rnd() < swapRate) {
      tryTargetedSwap(i);
    } else {
      const packed = g.slots[(rnd() * g.slots.length) | 0];
      const room = g.rooms[(rnd() * g.rooms.length) | 0];
      tryMove(i, unpackDay(packed), unpackTime(packed), unpackParity(packed), room);
    }

    const slot = moveCount % lahcLength;
    if (lahcHistory[slot] > acceptedCost) lahcHistory[slot] = acceptedCost;

    // The incumbent is still chosen lexicographically — fewer hard violations always wins,
    // whatever it costs in windows. Only the acceptance test is allowed to cross the cliff.
    const hardHere = hardNow();
    if (hardHere < bestHard || (hardHere === bestHard && acceptedCost < bestCost)) {
      bestHard = hardHere;
      bestCost = acceptedCost;
      snapshotInto(best);
      sinceBest = 0;
      // NOT `measure()` here. It is a full pass over every bucket — precisely what the incremental
      // counters exist to avoid — and this branch fires on most moves early in a run, so it made the
      // whole search O(n) per move again: measured, 13,000 moves/s at n=12800 fell to 2,100/s at
      // n=31000. The exact violations are computed once at the end, from the restored best.
      bestF = acceptedCost;
      if ((improvements++ & 255) === 0) history.push({ iteration, objective: bestF });
    } else {
      sinceBest++;
    }

    if (hardNow() === 0 && C.lecWinN + C.lecWinD === 0 && C.grpWinN + C.grpWinD === 0
        && C.grpMixN + C.grpMixD === 0) break;

    // A kick only when late acceptance has genuinely run out of room.
    if (sinceBest > opts.stagnationLimit * 2000) {
      emit('PERTURB', iteration, bestV, bestF, sinceBest);
      perturb(0.1 + 0.1 * rnd());
      rebuildCounters();
      acceptedCost = hardNow() * hardWeight + surrogate();
      lahcHistory.fill(acceptedCost);
      sinceBest = 0;
    }

    if ((iteration & 4095) === 0) {
      const now = Date.now();
      if (now - lastEmit > 120) {
        lastEmit = now;
        // Progress messages are the only consumer of the exact counters mid-run, and they arrive
        // about eight times a second, so paying for a full measure here is affordable where paying
        // for one per improvement was not.
        bestV = measure();
        const withSnapshot = now - lastSnapshotEmit > 1000;
        if (withSnapshot) lastSnapshotEmit = now;
        emit(hardOf(bestV) > 0 ? 'REPAIR' : 'WINDOWS', iteration, bestV, bestF, sinceBest,
             withSnapshot ? best : undefined);
      }
    }
  }

  restore(best);
  const finalV = measure();
  const finalF = objectiveOf(finalV);
  emit('DONE', iteration, finalV, finalF, sinceBest);

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
