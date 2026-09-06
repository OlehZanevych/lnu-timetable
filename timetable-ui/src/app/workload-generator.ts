/**
 * Automatic lecturer-workload generation for one department.
 *
 * Deliberately framework-free: no Angular, no GraphQL, no I/O. The caller maps the loaded tree into
 * the plain inputs below and applies the returned plan itself, which keeps the search testable and
 * keeps a dry run genuinely dry.
 *
 * ## The problem
 *
 * Every workload needs `lecturerCount` lecturers, drawn only from its own candidate pool, and each
 * lecturer carries hard ceilings (annual hours, distinct-course counts by hour type and by
 * mandatory/elective) plus soft floors of the same shape. Maximising total desirability subject to
 * those side constraints is a generalised assignment problem — NP-hard — so this does what a person
 * with a spreadsheet does, but exhaustively:
 *
 *   1. **Most-constrained-first greedy.** Slots are filled in order of how few feasible candidates
 *      they have, because a slot with one viable lecturer must claim them before a slot with ten
 *      takes them for a marginal desirability gain. Among feasible candidates a slot prefers the
 *      highest desirability, breaking ties toward the lecturer with the most headroom so the pool
 *      doesn't bottleneck later.
 *   2. **Repair pass** for unmet minimums: move an assignment from a lecturer who is above their
 *      floor to one who is below it, whenever both are candidates for that slot and the move stays
 *      feasible.
 *   3. **Improvement pass**: single moves (replace one holder of a slot with a more desirable
 *      candidate) and pairwise swaps (exchange the holders of two slots), taken whenever they raise
 *      total desirability without breaking a ceiling or deepening a floor deficit. Runs to a fixed
 *      point or a move cap, so it always terminates.
 *
 * INDIVIDUALLY-taught workloads are a different shape and get their own routine — the unit of work
 * is a student, not a slot; see {@link distributeStudents}.
 *
 * ## Why it is shaped the way it is
 *
 * The three phases above are the *semantics*. Everything else in this file is bookkeeping that
 * exists to make them cheap, and it is worth knowing why, because the obvious implementation is
 * quadratic and this one is not.
 *
 *   - **Feasibility is maintained, never recomputed.** Each workload keeps the set of lecturers who
 *     could take it right now. Assigning a lecturer changes only the workloads that lecturer is a
 *     candidate for, so a single assignment costs one ceiling check per such workload rather than a
 *     scan of every remaining slot.
 *   - **The next slot comes from a lazy heap**, keyed on that maintained count, with stale entries
 *     skipped by a per-workload version counter. Selecting the most constrained slot is therefore
 *     `O(log S)`, not a re-sort of everything still to place.
 *   - **Course membership is reference-counted.** "Distinct courses" is a set, and a lecturer may
 *     hold three labs of one course; dropping one must not remove the course. Counting references
 *     makes add and remove `O(1)` instead of a scan of everything the lecturer holds — which the
 *     repair and improvement passes do constantly.
 *   - **The floor deficit is a running total.** It changes only for the two lecturers a move
 *     touches, so a move is evaluated without walking the whole department.
 *
 * See `scripts/workload-bench/README.md` for the measurements these were derived from.
 */

// ── Inputs ───────────────────────────────────────────────────────────────────

export type HourType = 'LECTURE' | 'PRACTICAL' | 'LAB' | 'CONSULTATION' | 'ASSESSMENT' | 'INDEPENDENT_WORK';

/** Hour types a workload can actually be delivered for; the rest never produce slots. */
export const TAUGHT_HOUR_TYPES: HourType[] = ['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT'];

/** Only these three carry distinct-course constraints. */
const COUNTED_HOUR_TYPES = ['LECTURE', 'PRACTICAL', 'LAB'] as const;
type CountedHourType = (typeof COUNTED_HOUR_TYPES)[number];

export interface GenCandidate {
  lecturerId: string;
  /** 1..100; higher is more desirable. */
  desirability: number;
  /** INDIVIDUALLY only: desired number of students. */
  minStudents?: number | null;
  /** INDIVIDUALLY only: ceiling on students. */
  maxStudents?: number | null;
}

export interface GenWorkload {
  id: string;
  /** How many lecturers this workload should end up with (from working_curriculum_items). */
  lecturerCount: number;
  /** Lecturers already assigned. */
  assignedLecturerIds: string[];
  candidates: GenCandidate[];
  /** Academic hours of the underlying curriculum_item_hours row. */
  hours: number;
  hourType: HourType;
  /** Identifies the discipline for distinct-course counting. */
  courseId: string;
  /** courses.course_type of the effective course (an elective group resolves to its chosen option). */
  courseType: string;
  teachingFormat: 'TOGETHER' | 'SEPARATELY' | 'INDIVIDUALLY';
  /** INDIVIDUALLY only: the students to distribute among candidates. */
  studentIds?: string[];
  /** INDIVIDUALLY only: pairings already recorded. */
  assignedStudents?: { studentId: string; lecturerId: string }[];
  /** Free-text description used in the report. */
  label: string;
}

export interface GenLecturer {
  id: string;
  name: string;
  /** constraintType → value, straight from lecturer_workload_constraints. */
  constraints: Record<string, number>;
}

export interface GenInput {
  workloads: GenWorkload[];
  lecturers: GenLecturer[];
  /** `default_max_hours_per_year`, applied when a lecturer has no MAX_HOURS_PER_YEAR of their own. */
  defaultMaxHoursPerYear: number | null;
  /** 'gaps' fills only what is missing; 'all' reassigns every workload from scratch. */
  mode: 'gaps' | 'all';
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export interface GenAssignment {
  workloadId: string;
  workloadLabel: string;
  lecturerIds: string[];
  /** Lecturers added by this run, i.e. what actually changes. */
  addedLecturerIds: string[];
  /** INDIVIDUALLY only. */
  studentAssignments?: { studentId: string; lecturerId: string }[];
  changed: boolean;
}

export interface GenIssue {
  /**
   * `over-ceiling` is reported only by individual supervision, which may exceed the annual hour
   * ceiling as a last resort because a student cannot be left without a supervisor. Every other
   * phase treats a ceiling as inviolable, so no other phase can raise it.
   */
  kind: 'unfilled' | 'unmet-minimum' | 'no-candidates' | 'no-students' | 'over-ceiling';
  message: string;
  workloadId?: string;
  lecturerId?: string;
}

export interface GenResult {
  assignments: GenAssignment[];
  issues: GenIssue[];
  /** Sum of desirability over every slot filled by this run. */
  totalDesirability: number;
  filledSlots: number;
  requestedSlots: number;
  /** Per-lecturer load after generation, for the preview table. */
  load: { lecturerId: string; name: string; hours: number; courses: number }[];
  /** Timings and operation counts for the performance study; ignored by the UI. */
  telemetry: GenTelemetry;
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * Instrumentation for performance study. Purely observational: nothing here influences a decision
 * the search makes, so a run with telemetry produces the identical plan to one without. The counters
 * are plain integer increments on a hot path — measurable in the noise, and worth it because the
 * benchmark then measures the code that actually ships rather than a fork of it.
 *
 * `ops` is the machine-independent half of the measurement: it is identical on any CPU for the same
 * input, which is what makes it citable. `ms` is the machine-dependent half.
 */
export interface GenOpCounters {
  /** Ceiling checks — `Load.canTake`, the innermost predicate of the whole search. */
  canTake: number;
  /** Feasible-set recomputations for one (lecturer, workload) pair. */
  feasibleScan: number;
  /** Candidates examined across those scans. */
  feasibleCandidates: number;
  /** Slots placed by the greedy loop. */
  greedyIterations: number;
  /** Heap operations, and pops discarded as stale — the price of the lazy queue. */
  heapPush: number;
  heapPop: number;
  heapStalePop: number;
  /** Mutations of a lecturer's running load. */
  loadAdd: number;
  loadRemove: number;
  /** `Load.deficit()` calls, and lecturers walked to aggregate them. */
  deficitEvaluations: number;
  deficitLecturerScans: number;
  /** Repair pass: workloads examined, candidate moves probed, moves kept. */
  repairPasses: number;
  repairProbes: number;
  repairMoves: number;
  /** Improvement pass: the same three, plus the swap neighbourhood. */
  improvePasses: number;
  improveProbes: number;
  improveMoves: number;
  swapProbes: number;
  swapMoves: number;
  /** Students moved off an over-ceiling supervisor by the supervision repair pass. */
  supervisionRepairMoves: number;
}

export interface GenTelemetry {
  /** Wall-clock milliseconds, by phase. `total` is the whole call. */
  ms: {
    total: number; setup: number; greedy: number; repair: number;
    improve: number; individual: number; report: number;
  };
  /** The problem as the search saw it, after mode filtering. */
  size: {
    lecturers: number; workloads: number; slotWorkloads: number; individualWorkloads: number;
    requestedSlots: number; candidateEdges: number; students: number;
  };
  ops: GenOpCounters;
}

const newOpCounters = (): GenOpCounters => ({
  canTake: 0, feasibleScan: 0, feasibleCandidates: 0,
  greedyIterations: 0, heapPush: 0, heapPop: 0, heapStalePop: 0,
  loadAdd: 0, loadRemove: 0,
  deficitEvaluations: 0, deficitLecturerScans: 0,
  repairPasses: 0, repairProbes: 0, repairMoves: 0,
  improvePasses: 0, improveProbes: 0, improveMoves: 0,
  swapProbes: 0, swapMoves: 0,
  supervisionRepairMoves: 0
});

/** `performance.now()` where it exists (browser, Node 16+), `Date.now()` as a last resort. */
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

// ── Constraint bookkeeping ───────────────────────────────────────────────────

const isMandatory = (courseType: string) => courseType === 'MANDATORY';
const isElective = (courseType: string) => courseType === 'ELECTIVE' || courseType === 'ELECTIVE_GROUP';

const countedType = (h: HourType): CountedHourType | null =>
  (COUNTED_HOUR_TYPES as readonly string[]).includes(h) ? (h as CountedHourType) : null;

/** Index into the three parallel per-hour-type arrays; -1 for an hour type that is not counted. */
const typeIndex = (h: HourType): number =>
  h === 'LECTURE' ? 0 : h === 'PRACTICAL' ? 1 : h === 'LAB' ? 2 : -1;

/**
 * A lecturer's running load: hours plus the distinct (course, hourType) counts the course-count
 * constraints are expressed over.
 *
 * "Distinct courses" means a second lab in the same course costs nothing extra, which naively calls
 * for a `Set` per constraint family — and then removing an assignment has to ask whether any *other*
 * assignment still puts that course in that set, a scan of everything the lecturer holds. The repair
 * and improvement passes add and remove constantly, so that scan dominated them.
 *
 * Reference counts give the same answer in O(1): a course is in the set exactly while its count is
 * positive, and the set's *size* — which is all any constraint actually reads — is maintained as the
 * count crosses zero.
 */
class Load {
  hours = 0;

  /** courseId → how many held workloads put this course in each family. */
  private allRef = new Map<string, number>();
  private typeRef: Map<string, number>[] = [new Map(), new Map(), new Map()];
  /** Sizes of the corresponding sets, maintained as counts cross zero. */
  private allSize = 0;
  private typeSize = [0, 0, 0];
  private mandatorySize = [0, 0, 0];
  private electiveSize = [0, 0, 0];

  readonly lecturer: GenLecturer;
  private readonly defaultMaxHours: number | null;
  private readonly ops: GenOpCounters;

  /** Resolved once: constraint lookups happen inside the innermost loop of the search. */
  private readonly maxHoursLimit: number | null;
  private readonly minHoursLimit: number | null;
  private readonly maxCoursesLimit: number | null;
  private readonly maxType: (number | null)[] = [null, null, null];
  private readonly minType: (number | null)[] = [null, null, null];
  private readonly maxMandatory: (number | null)[] = [null, null, null];
  private readonly minMandatory: (number | null)[] = [null, null, null];
  private readonly maxElective: (number | null)[] = [null, null, null];
  private readonly minElective: (number | null)[] = [null, null, null];
  /** True when the lecturer carries no floor at all — the common case, and worth short-circuiting. */
  private readonly hasAnyFloor: boolean;

  // Written out rather than declared as constructor parameter properties, which are the one piece
  // of non-erasable TypeScript syntax; without them this file runs under `node --experimental-strip-types`
  // with no build step at all, which is what lets the benchmark harness measure the shipped code
  // rather than a compiled copy of it.
  constructor(lecturer: GenLecturer, defaultMaxHours: number | null, ops: GenOpCounters = newOpCounters()) {
    this.lecturer = lecturer;
    this.defaultMaxHours = defaultMaxHours;
    this.ops = ops;

    const lim = (name: string): number | null => {
      const v = lecturer.constraints[name];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    this.maxHoursLimit = lim('MAX_HOURS_PER_YEAR') ?? defaultMaxHours;
    this.minHoursLimit = lim('MIN_HOURS_PER_YEAR');
    this.maxCoursesLimit = lim('MAX_COURSES');
    let floors = this.minHoursLimit !== null;
    for (let i = 0; i < COUNTED_HOUR_TYPES.length; i++) {
      const t = COUNTED_HOUR_TYPES[i];
      this.maxType[i] = lim(`MAX_${t}_COURSES`);
      this.minType[i] = lim(`MIN_${t}_COURSES`);
      this.maxMandatory[i] = lim(`MAX_MANDATORY_${t}_COURSES`);
      this.minMandatory[i] = lim(`MIN_MANDATORY_${t}_COURSES`);
      this.maxElective[i] = lim(`MAX_ELECTIVE_${t}_COURSES`);
      this.minElective[i] = lim(`MIN_ELECTIVE_${t}_COURSES`);
      floors = floors || this.minType[i] !== null || this.minMandatory[i] !== null || this.minElective[i] !== null;
    }
    this.hasAnyFloor = floors;
  }

  add(w: GenWorkload) {
    this.ops.loadAdd++;
    this.hours += w.hours;
    const i = typeIndex(w.hourType);
    if (i < 0) return;

    const a = (this.allRef.get(w.courseId) ?? 0) + 1;
    this.allRef.set(w.courseId, a);
    if (a === 1) this.allSize++;

    const ref = this.typeRef[i];
    const n = (ref.get(w.courseId) ?? 0) + 1;
    ref.set(w.courseId, n);
    if (n === 1) {
      this.typeSize[i]++;
      if (isMandatory(w.courseType)) this.mandatorySize[i]++;
      else if (isElective(w.courseType)) this.electiveSize[i]++;
    }
  }

  remove(w: GenWorkload) {
    this.ops.loadRemove++;
    this.hours -= w.hours;
    const i = typeIndex(w.hourType);
    if (i < 0) return;

    const a = (this.allRef.get(w.courseId) ?? 0) - 1;
    if (a <= 0) { this.allRef.delete(w.courseId); this.allSize--; } else this.allRef.set(w.courseId, a);

    const ref = this.typeRef[i];
    const n = (ref.get(w.courseId) ?? 0) - 1;
    if (n <= 0) {
      ref.delete(w.courseId);
      this.typeSize[i]--;
      if (isMandatory(w.courseType)) this.mandatorySize[i]--;
      else if (isElective(w.courseType)) this.electiveSize[i]--;
    } else ref.set(w.courseId, n);
  }

  /** Would taking this workload break a ceiling? Floors are handled separately — they can't be met by refusing work. */
  canTake(w: GenWorkload): boolean {
    this.ops.canTake++;
    if (this.maxHoursLimit !== null && this.hours + w.hours > this.maxHoursLimit) return false;

    const i = typeIndex(w.hourType);
    if (i < 0) return true;

    if (this.maxCoursesLimit !== null
        && !this.allRef.has(w.courseId)
        && this.allSize + 1 > this.maxCoursesLimit) return false;

    const isNew = !this.typeRef[i].has(w.courseId);
    if (!isNew) return true;   // the course is already counted in every family it belongs to

    if (this.maxType[i] !== null && this.typeSize[i] + 1 > this.maxType[i]!) return false;
    if (isMandatory(w.courseType)) {
      if (this.maxMandatory[i] !== null && this.mandatorySize[i] + 1 > this.maxMandatory[i]!) return false;
    } else if (isElective(w.courseType)) {
      if (this.maxElective[i] !== null && this.electiveSize[i] + 1 > this.maxElective[i]!) return false;
    }
    return true;
  }

  /** Floors this lecturer still falls short of, as human-readable fragments. */
  unmetMinimums(): string[] {
    const out: string[] = [];
    if (this.minHoursLimit !== null && this.hours < this.minHoursLimit) {
      out.push(`годин на рік: ${this.hours} з ${this.minHoursLimit}`);
    }
    for (let i = 0; i < COUNTED_HOUR_TYPES.length; i++) {
      const t = COUNTED_HOUR_TYPES[i];
      const pairs: [number | null, number, string][] = [
        [this.minType[i], this.typeSize[i], 'дисциплін'],
        [this.minMandatory[i], this.mandatorySize[i], "обов'язкових дисциплін"],
        [this.minElective[i], this.electiveSize[i], 'вибіркових дисциплін']
      ];
      for (const [min, have, what] of pairs) {
        if (min !== null && have < min) out.push(`${HOUR_TYPE_UK[t]} — ${what}: ${have} з ${min}`);
      }
    }
    return out;
  }

  /** How far below its floors this lecturer is; drives the repair pass. */
  deficit(): number {
    this.ops.deficitEvaluations++;
    if (!this.hasAnyFloor) return 0;
    let d = 0;
    if (this.minHoursLimit !== null && this.hours < this.minHoursLimit) d += this.minHoursLimit - this.hours;
    const w = COURSE_DEFICIT_WEIGHT;
    for (let i = 0; i < COUNTED_HOUR_TYPES.length; i++) {
      // A missing course outweighs an hour: the weight is what makes the repair pass prefer giving
      // someone a discipline they lack over topping up someone's hours.
      if (this.minType[i] !== null && this.typeSize[i] < this.minType[i]!) d += (this.minType[i]! - this.typeSize[i]) * w;
      if (this.minMandatory[i] !== null && this.mandatorySize[i] < this.minMandatory[i]!) d += (this.minMandatory[i]! - this.mandatorySize[i]) * w;
      if (this.minElective[i] !== null && this.electiveSize[i] < this.minElective[i]!) d += (this.minElective[i]! - this.electiveSize[i]) * w;
    }
    return d;
  }

  /** Academic hours this lecturer could still take before their annual ceiling; Infinity if none. */
  hoursHeadroom(): number {
    return this.maxHoursLimit === null ? Infinity : this.maxHoursLimit - this.hours;
  }

  /** Individual supervision is booked in hours, not slots; this is how it asks about the ceiling. */
  addHours(h: number) { this.hours += h; }

  /** 0..1 share of the annual hour ceiling used — the tie-breaker that spreads work out. */
  fill(): number {
    const maxH = this.maxHoursLimit;
    return maxH && maxH > 0 ? this.hours / maxH : 0;
  }

  courseCount(): number { return this.allSize; }
}

const HOUR_TYPE_UK: Record<string, string> = {
  LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
  CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи'
};

// ── A lazy min-heap over workloads, keyed on how few candidates they have left ────────────────

interface HeapEntry { w: number; key: number; bulk: number; order: number; version: number }

/**
 * Most-constrained-first needs the minimum of a quantity that changes as the search runs. Rebuilding
 * the order each time is what made the original quadratic. Instead: push a fresh entry whenever a
 * workload's count changes, and discard entries whose version is out of date when they surface.
 *
 * Ties break on **hours, largest first**, then on the workload's position in the input. Largest-first
 * is the bin-packing instinct and it earns its place here: when the department is near capacity, the
 * long positions are the ones that stop fitting, and placing them while headroom still exists fills
 * more of the plan than placing them last. The previous implementation's tie order was an artefact of
 * `Array.prototype.sort` stability across repeated re-sorts — not something to preserve deliberately.
 */
class SlotHeap {
  private a: HeapEntry[] = [];
  private readonly ops: GenOpCounters;

  constructor(ops: GenOpCounters) { this.ops = ops; }

  get size() { return this.a.length; }

  private less(x: HeapEntry, y: HeapEntry) {
    if (x.key !== y.key) return x.key < y.key;
    if (x.bulk !== y.bulk) return x.bulk < y.bulk;
    return x.order < y.order;
  }

  push(e: HeapEntry) {
    this.ops.heapPush++;
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): HeapEntry | undefined {
    this.ops.heapPop++;
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function generateWorkloads(input: GenInput): GenResult {
  const t0 = now();
  const ops = newOpCounters();
  const { mode, defaultMaxHoursPerYear } = input;

  const loads = new Map<string, Load>();
  for (const l of input.lecturers) loads.set(l.id, new Load(l, defaultMaxHoursPerYear, ops));

  const individual = input.workloads.filter((w) => w.teachingFormat === 'INDIVIDUALLY');
  const slotWorkloads = input.workloads.filter((w) => w.teachingFormat !== 'INDIVIDUALLY');
  const W = slotWorkloads.length;

  /** Workload index by id, and the reverse; the search works in indices, the report in ids. */
  const indexOf = new Map<string, number>();
  for (let i = 0; i < W; i++) indexOf.set(slotWorkloads[i].id, i);

  // Per-workload state, held as parallel arrays: this is the hot data of the whole search.
  const chosen: string[][] = new Array(W);           // lecturers settled on, in the order taken
  const chosenSet: Set<string>[] = new Array(W);
  const held: Map<string, GenWorkload[]> = new Map();   // lecturerId → workloads currently held
  const candidateOf: Map<string, GenCandidate>[] = new Array(W);   // lecturerId → candidate record
  const feasible: Set<string>[] = new Array(W);     // lecturers who could take it right now
  const version = new Int32Array(W);
  const needed = new Int32Array(W);

  /** lecturerId → indices of the workloads they are a candidate for. The invalidation index. */
  const candidateWorkloads = new Map<string, number[]>();

  const issues: GenIssue[] = [];
  const locked = new Set<string>();
  const lockKey = (workloadId: string, lecturerId: string) => `${workloadId}:${lecturerId}`;

  for (let i = 0; i < W; i++) {
    const w = slotWorkloads[i];
    chosen[i] = [];
    chosenSet[i] = new Set();
    feasible[i] = new Set();
    const map = new Map<string, GenCandidate>();
    for (const c of w.candidates) {
      if (!loads.has(c.lecturerId) || map.has(c.lecturerId)) continue;
      map.set(c.lecturerId, c);
      let list = candidateWorkloads.get(c.lecturerId);
      if (!list) { list = []; candidateWorkloads.set(c.lecturerId, list); }
      list.push(i);
    }
    candidateOf[i] = map;
  }

  // ── Floor deficit, maintained rather than recomputed ──
  //
  // The repair and improvement passes both need "is the department further from its floors than it
  // was a moment ago?". Recomputing it walks every lecturer; keeping it as a running total means a
  // move updates only the two lecturers it touched.
  const deficitOf = new Map<string, number>();
  const shortOfFloor = new Set<string>();
  let totalDeficit = 0;
  const seedDeficits = () => {
    totalDeficit = 0;
    shortOfFloor.clear();
    for (const [id, load] of loads) {
      ops.deficitLecturerScans++;
      const d = load.deficit();
      deficitOf.set(id, d);
      if (d > 0) shortOfFloor.add(id);
      totalDeficit += d;
    }
  };
  const refreshDeficit = (lecturerId: string) => {
    const load = loads.get(lecturerId);
    if (!load) return;
    const before = deficitOf.get(lecturerId) ?? 0;
    const after = load.deficit();
    if (after === before) return;
    deficitOf.set(lecturerId, after);
    totalDeficit += after - before;
    if (after > 0) shortOfFloor.add(lecturerId); else shortOfFloor.delete(lecturerId);
  };

  // ── Core mutations ──
  const take = (lecturerId: string, wIdx: number) => {
    const w = slotWorkloads[wIdx];
    loads.get(lecturerId)!.add(w);
    let list = held.get(lecturerId);
    if (!list) { list = []; held.set(lecturerId, list); }
    list.push(w);
    chosen[wIdx].push(lecturerId);
    chosenSet[wIdx].add(lecturerId);
  };
  const drop = (lecturerId: string, wIdx: number) => {
    const w = slotWorkloads[wIdx];
    const list = held.get(lecturerId);
    if (list) {
      const i = list.findIndex((x) => x.id === w.id);
      if (i >= 0) list.splice(i, 1);
    }
    loads.get(lecturerId)!.remove(w);
    const c = chosen[wIdx];
    const j = c.indexOf(lecturerId);
    if (j >= 0) c.splice(j, 1);
    chosenSet[wIdx].delete(lecturerId);
  };

  // ── Seed ──
  // In 'gaps' mode existing assignments stand and consume capacity; in 'all' mode we start clean.
  const outsideDepartment: string[][] = new Array(W);
  for (let i = 0; i < W; i++) {
    outsideDepartment[i] = [];
    const w = slotWorkloads[i];
    if (mode !== 'gaps') continue;
    for (const id of w.assignedLecturerIds) {
      locked.add(lockKey(w.id, id));
      if (loads.has(id)) take(id, i);
      else outsideDepartment[i].push(id);   // outside the department: keep, but don't track capacity
    }
  }
  for (let i = 0; i < W; i++) {
    for (const id of outsideDepartment[i]) { chosen[i].push(id); chosenSet[i].add(id); }
  }

  // ── INDIVIDUALLY workloads, before anything else ──
  //
  // Individual supervision is the least flexible work in the problem: every student must have a
  // supervisor, the eligible pool is one course's candidates, and the cost is `hours × students`,
  // which on a group of sixty is a third of someone's year. Booking it *after* the slot search — as
  // this used to — meant the slots had already spent the headroom of exactly the people who then had
  // to absorb it, and the annual ceiling was routinely blown as a result.
  //
  // Placing it first is the same most-constrained-first instinct the greedy applies to slots, one
  // level up: commit the work that has nowhere else to go, then fit the flexible work around it.
  //
  // Going first must not mean taking everything, though. Left unchecked the first pass would fill a
  // lecturer to their ceiling with supervision and leave nothing for the classes only they can
  // teach — which is the same collision, merely reversed. So each lecturer gets an **individual-work
  // budget**: their annual ceiling split between the two kinds of work in proportion to the demand
  // they actually face for each, where demand is what they would receive if every position they are
  // a candidate for were shared evenly among its candidates.
  //
  // The budget is a preference, not a wall. A student without a supervisor is not an option, so a
  // candidate over budget is passed over while anyone else has room, and only taken when nobody has.
  const slotDemand = new Map<string, number>();
  for (let i = 0; i < W; i++) {
    const w = slotWorkloads[i];
    const n = candidateOf[i].size;
    if (!n) continue;
    const share = (w.hours * w.lecturerCount) / n;
    for (const id of candidateOf[i].keys()) slotDemand.set(id, (slotDemand.get(id) ?? 0) + share);
  }
  const individualDemand = new Map<string, number>();
  for (const w of individual) {
    const students = w.studentIds?.length ?? 0;
    const n = w.candidates.length;
    if (!n || !students) continue;
    const share = (w.hours * students) / n;
    for (const c of w.candidates) {
      individualDemand.set(c.lecturerId, (individualDemand.get(c.lecturerId) ?? 0) + share);
    }
  }
  const individualBudget = new Map<string, number>();
  for (const [id, load] of loads) {
    const ind = individualDemand.get(id) ?? 0;
    const slot = slotDemand.get(id) ?? 0;
    const ceiling = load.hoursHeadroom() + load.hours;
    individualBudget.set(id, ind + slot > 0 && Number.isFinite(ceiling)
      ? (ceiling * ind) / (ind + slot)
      : Infinity);
  }

  const studentPlans = new Map<string, { studentId: string; lecturerId: string }[]>();
  const individualBooked = new Map<string, number>();
  const tBeforeIndividual = now();

  // Supervision a lecturer already holds costs hours exactly as a new pairing does, and in 'gaps'
  // mode those pairings stand. They were never booked against anyone's ceiling: the seed loop above
  // walks the *slot* positions, and `distributeStudents` copies an existing pairing into its plan
  // without charging for it. The lecturer therefore looked emptier to every later decision than they
  // were, and the plan could pass the generator's own ceiling test while the independent validator
  // — which counts every supervised student — found the lecturer over the statutory limit. That is
  // where the overrun the benchmark attributes to individual supervision actually comes from.
  if (mode === 'gaps') {
    for (const w of individual) {
      const roster = new Set(w.studentIds ?? []);
      for (const a of w.assignedStudents ?? []) {
        if (!roster.has(a.studentId)) continue;
        loads.get(a.lecturerId)?.addHours(w.hours);
      }
    }
  }
  for (const w of individual) {
    studentPlans.set(w.id, distributeStudents(w, mode, loads, issues, individualBudget, individualBooked));
  }
  /**
   * Which supervisions this run is not entitled to move.
   *
   * In `gaps` mode a student already paired with a supervisor is settled work: the mode exists to
   * fill what is missing without disturbing what is there, and re-pairing a diploma student with a
   * different supervisor part-way through a year is not a scheduling detail. The repair below
   * therefore may only move supervisions this run created. Without this set it moved pre-existing
   * ones too, which drove the reported ceiling overrun to zero by quietly rewriting the seed — a
   * lawful-looking plan that the department never asked for.
   */
  const lockedSupervision = new Set<string>();
  if (mode === 'gaps') {
    for (const w of individual) {
      const roster = new Set(w.studentIds ?? []);
      for (const a of w.assignedStudents ?? []) {
        if (roster.has(a.studentId)) lockedSupervision.add(`${w.id}\u0000${a.studentId}`);
      }
    }
  }
  // The positions were placed one at a time and could not see each other; this takes students off
  // whoever ended up over the ceiling, wherever a lawful home for them exists.
  const supervisionRepairs =
    repairSupervisionCeilings(individual, studentPlans, loads, lockedSupervision, ops);
  if (supervisionRepairs > 0) {
    issues.push({ kind: 'over-ceiling', workloadId: '',
      message: `Індивідуальну роботу перерозподілено: ${supervisionRepairs} студент(ів) передано ` +
        'викладачам із запасом годин, щоб не перевищувати річний ліміт.' });
  }
  const individualMs = now() - tBeforeIndividual;

  // ── Slots still to fill ──
  let requestedSlots = 0;
  for (let i = 0; i < W; i++) {
    const w = slotWorkloads[i];
    const need = Math.max(0, w.lecturerCount - chosen[i].length);
    needed[i] = need;
    requestedSlots += need;
    if (need > 0 && !w.candidates.length) {
      issues.push({ kind: 'no-candidates', workloadId: w.id,
        message: `${w.label}: не задано кандидатів, ${need} місць(я) залишиться незаповненими.` });
    }
  }

  // ── Initial feasibility, and the heap over it ──
  const heap = new SlotHeap(ops);
  for (let i = 0; i < W; i++) {
    if (needed[i] <= 0) continue;
    const w = slotWorkloads[i];
    const set = feasible[i];
    for (const [id, _c] of candidateOf[i]) {
      ops.feasibleCandidates++;
      if (!chosenSet[i].has(id) && loads.get(id)!.canTake(w)) set.add(id);
    }
    heap.push({ w: i, key: set.size, bulk: w.hours, order: i, version: 0 });
  }

  /**
   * One lecturer's load changed, so re-test that lecturer against every workload they are a
   * candidate for — and only those. This replaces the original implementation's full re-scan and is
   * the change that takes the greedy from quadratic to near-linear.
   */
  const revalidate = (lecturerId: string) => {
    const list = candidateWorkloads.get(lecturerId);
    if (!list) return;
    const load = loads.get(lecturerId)!;
    for (const i of list) {
      if (needed[i] <= 0) continue;                 // nothing left to place here
      const set = feasible[i];
      // Feasibility is monotone during the greedy: loads only grow, so a ceiling that has been
      // crossed stays crossed, and a lecturer already chosen for this workload stays chosen. A
      // lecturer who is not in the set therefore cannot re-enter it, and testing them again is pure
      // waste — which on a dense instance is most of the work this loop would otherwise do.
      if (!set.has(lecturerId)) continue;
      ops.feasibleScan++;
      if (load.canTake(slotWorkloads[i])) continue;
      set.delete(lecturerId);
      version[i]++;
      heap.push({ w: i, key: set.size, bulk: slotWorkloads[i].hours, order: i, version: version[i] });
    }
  };

  // Candidates of each workload, best first. Built once and shared by both local-search passes:
  // each walks it on every visit, and re-sorting there would put an O(C log C) inside a hot loop.
  const ranked: GenCandidate[][] = new Array(W);
  for (let i = 0; i < W; i++) {
    ranked[i] = [...candidateOf[i].values()].sort(
      (a, b) => b.desirability - a.desirability || (a.lecturerId < b.lecturerId ? -1 : 1));
  }

  const tSetup = now();

  // ── 1. Most-constrained-first greedy ──
  let filledSlots = 0;
  while (heap.size) {
    const e = heap.pop()!;
    const i = e.w;
    if (e.version !== version[i] || needed[i] <= 0) { ops.heapStalePop++; continue; }

    const w = slotWorkloads[i];
    const set = feasible[i];
    if (!set.size) {
      // Feasibility only shrinks while the greedy runs — loads never fall — so no later slot of this
      // workload can succeed either. Report one issue per slot that will go unfilled, and stop
      // reconsidering the workload.
      for (let k = 0; k < needed[i]; k++) {
        issues.push({ kind: 'unfilled', workloadId: w.id,
          message: `${w.label}: не вдалося підібрати викладача (немає доступних кандидатів або вичерпано обмеження).` });
      }
      needed[i] = 0;
      continue;
    }

    // Best feasible candidate: highest desirability, then the one with the most headroom so the
    // pool does not bottleneck later, then a stable tie-break on id.
    let best: GenCandidate | null = null;
    let bestFill = 0;
    for (const id of set) {
      const cand = candidateOf[i].get(id)!;
      const fill = loads.get(id)!.fill();
      if (best === null
          || cand.desirability > best.desirability
          || (cand.desirability === best.desirability
              && (fill < bestFill || (fill === bestFill && id < best.lecturerId)))) {
        best = cand; bestFill = fill;
      }
    }

    ops.greedyIterations++;
    take(best!.lecturerId, i);
    filledSlots++;
    needed[i]--;
    revalidate(best!.lecturerId);

    // The workload itself changed: the lecturer just taken is no longer available to it, and its
    // remaining need dropped. `revalidate` covered the first only if the lecturer is a candidate
    // here, which they are — but the count must be re-published either way.
    if (needed[i] > 0) {
      if (set.delete(best!.lecturerId)) { /* already reflected below */ }
      version[i]++;
      heap.push({ w: i, key: set.size, bulk: w.hours, order: i, version: version[i] });
    }
  }
  const tGreedy = now();

  // ── 2. Repair pass: move work toward lecturers below their floors ──
  seedDeficits();
  const searchCtx: SearchContext = {
    slotWorkloads, chosen, chosenSet, candidateOf, ranked, candidateWorkloads, loads,
    take, drop, locked, lockKey, ops,
    getTotalDeficit: () => totalDeficit, refreshDeficit,
    deficitOf: (id) => deficitOf.get(id) ?? 0,
    shortOfFloor, indexOf
  };
  repair(searchCtx);
  const tRepair = now();

  // ── 3. Improvement pass: raise total desirability without breaking anything ──
  improve(searchCtx);
  const tImprove = now();

  // ── Report ──
  for (const l of input.lecturers) {
    for (const u of loads.get(l.id)!.unmetMinimums()) {
      issues.push({ kind: 'unmet-minimum', lecturerId: l.id, message: `${l.name}: не досягнуто мінімуму — ${u}.` });
    }
  }

  const assignments: GenAssignment[] = [];
  let totalDesirability = 0;

  for (let i = 0; i < W; i++) {
    const w = slotWorkloads[i];
    const ids = chosen[i];
    const before = mode === 'gaps' ? w.assignedLecturerIds : [];
    const added = ids.filter((id) => !before.includes(id));
    for (const id of added) totalDesirability += candidateOf[i].get(id)?.desirability ?? 0;
    assignments.push({
      workloadId: w.id, workloadLabel: w.label, lecturerIds: ids, addedLecturerIds: added,
      changed: !sameSet(ids, w.assignedLecturerIds)
    });
  }

  for (const w of individual) {
    const plan = studentPlans.get(w.id) ?? [];
    const ids = Array.from(new Set(plan.map((p) => p.lecturerId)));
    assignments.push({
      workloadId: w.id, workloadLabel: w.label, lecturerIds: ids,
      addedLecturerIds: ids.filter((id) => !w.assignedLecturerIds.includes(id)),
      studentAssignments: plan,
      changed: !sameStudentPlan(plan, w.assignedStudents ?? [])
    });
  }

  const load = input.lecturers.map((l) => ({
    lecturerId: l.id, name: l.name,
    hours: loads.get(l.id)!.hours, courses: loads.get(l.id)!.courseCount()
  })).sort((a, b) => b.hours - a.hours);

  const tEnd = now();
  const telemetry: GenTelemetry = {
    ms: {
      total: tEnd - t0, setup: tSetup - t0 - individualMs, greedy: tGreedy - tSetup,
      repair: tRepair - tGreedy, improve: tImprove - tRepair,
      individual: individualMs, report: tEnd - tImprove
    },
    size: {
      lecturers: input.lecturers.length,
      workloads: input.workloads.length,
      slotWorkloads: W,
      individualWorkloads: individual.length,
      requestedSlots,
      candidateEdges: input.workloads.reduce((n, w) => n + w.candidates.length, 0),
      students: individual.reduce((n, w) => n + (w.studentIds?.length ?? 0), 0)
    },
    ops
  };

  return { assignments, issues, totalDesirability, filledSlots, requestedSlots, load, telemetry };
}

// ── Local search ─────────────────────────────────────────────────────────────

interface SearchContext {
  slotWorkloads: GenWorkload[];
  chosen: string[][];
  chosenSet: Set<string>[];
  candidateOf: Map<string, GenCandidate>[];
  ranked: GenCandidate[][];
  /** lecturerId → indices of the workloads they are a candidate for. Drives both worklists. */
  candidateWorkloads: Map<string, number[]>;
  loads: Map<string, Load>;
  take: (lecturerId: string, wIdx: number) => void;
  drop: (lecturerId: string, wIdx: number) => void;
  locked: Set<string>;
  lockKey: (workloadId: string, lecturerId: string) => string;
  ops: GenOpCounters;
  getTotalDeficit: () => number;
  refreshDeficit: (lecturerId: string) => void;
  /** Current floor deficit of one lecturer, from the maintained table. */
  deficitOf: (lecturerId: string) => number;
  /** Lecturers currently short of a floor. Repair starts from these and nowhere else. */
  shortOfFloor: Set<string>;
  indexOf?: Map<string, number>;
}

/** Move limits. Generous enough never to bind on a real department, present so nothing can spin. */
/**
 * ω — the exchange rate between the two floor shortfalls, one unit per hour short and this many
 * per course short.
 *
 * Hours and courses are different units and any single objective over both has to price one in the
 * other. The value is a policy choice rather than a derived constant, so it is named here and it is
 * overridable rather than asserted to be right; `scripts/workload-bench/omega-sweep.mjs` measures
 * what the whole instance family does as it varies. `WL_COURSE_DEFICIT_WEIGHT` exists for that
 * sweep; the deployed configuration never sets it.
 */
const COURSE_DEFICIT_WEIGHT = (() => {
  // `globalThis.process` is typed only where @types/node is in scope; the app's tsconfig has no
  // index signature for it, so the lookup is narrowed here rather than reaching through `any`.
  // The optional chain is what keeps this safe in the browser, where there is no `process` at all.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const v = Number(env?.['WL_COURSE_DEFICIT_WEIGHT']);
  return Number.isFinite(v) && v > 0 ? v : 10;
})();

const REPAIR_MOVE_CAP = 4;      // × the number of workloads
const IMPROVE_MOVE_CAP = 4;

/**
 * Moves work toward lecturers who are short of a floor.
 *
 * The search is driven **from the lecturers who are short**, not from the workloads. That is the
 * whole trick: a floor can only be closed by giving work to someone who lacks it, so the only moves
 * worth evaluating are those whose receiver is currently below a floor and whose donor is not. The
 * earlier shape — sweep every workload, try every holder against every candidate — spent nearly all
 * of its probes on workloads that could not have helped anyone.
 *
 * Receivers are walked best-first by desirability, so the move accepted is the cheapest one that
 * helps: `cost = donor − receiver` only grows along that list, and meeting a floor costs desirability
 * by construction, so paying more for it than necessary is a choice nobody made deliberately.
 *
 * Terminates because every accepted move strictly decreases a non-negative integer total, and
 * carries a move cap besides.
 */
function repair(ctx: SearchContext) {
  const { slotWorkloads, chosen, chosenSet, candidateOf, ranked, candidateWorkloads, loads,
          take, drop, locked, lockKey, ops, getTotalDeficit, refreshDeficit, deficitOf,
          shortOfFloor } = ctx;
  const W = slotWorkloads.length;
  if (!W || getTotalDeficit() === 0) return;

  const cap = REPAIR_MOVE_CAP * W;
  let moves = 0;

  // A worklist of lecturers to try to help. Re-entered whenever a move leaves them still short.
  const queue: string[] = [...shortOfFloor];
  const queued = new Set(queue);

  while (queue.length && moves < cap) {
    const to = queue.shift()!;
    queued.delete(to);
    if (deficitOf(to) <= 0) continue;

    const where = candidateWorkloads.get(to);
    if (!where) continue;

    let helped = false;
    for (const i of where) {
      if (chosenSet[i].has(to)) continue;
      const w = slotWorkloads[i];
      const receiver = candidateOf[i].get(to);
      if (!receiver) continue;

      // The donor is not filtered on having slack of their own. Taking from someone who is also
      // below a floor usually just moves the problem, but occasionally it is the only move that
      // helps overall — and the total-deficit test below is the honest arbiter. Filtering such
      // donors out lost a third of all repairs; ordering donors by slack first gained 0.4 % of
      // desirability for 3 % of the runtime. Neither earned its place.
      for (const from of [...chosen[i]]) {
        if (from === to || !loads.has(from) || locked.has(lockKey(w.id, from))) continue;
        ops.repairProbes++;
        const before = getTotalDeficit();
        drop(from, i);
        if (!loads.get(to)!.canTake(w)) { take(from, i); continue; }
        take(to, i);
        refreshDeficit(from);
        refreshDeficit(to);
        if (getTotalDeficit() < before) {
          ops.repairMoves++; moves++; helped = true;
          // The donor may now be short themselves, and the receiver may still be.
          for (const id of [from, to]) {
            if (deficitOf(id) > 0 && !queued.has(id)) { queued.add(id); queue.push(id); }
          }
          break;
        }
        drop(to, i);
        take(from, i);
        refreshDeficit(from);
        refreshDeficit(to);
      }
      if (helped) break;
    }
    ops.repairPasses++;
  }
}

/**
 * Hill-climbs on total desirability, keeping every ceiling satisfied and never increasing the floor
 * deficit. Two neighbourhoods:
 *
 *   **shift** — replace one holder of a slot with a more desirable candidate;
 *   **swap**  — exchange the holders of two slots that each prefer the other's lecturer.
 *
 * A shift alone cannot reach an arrangement where A should hold B's slot and B should hold A's,
 * because either single move on its own is infeasible or non-improving. The GAP literature is
 * consistent on this: shift ∪ swap is the standard neighbourhood, and swap is the cheapest real gain
 * over shift alone — Yagiura, Ibaraki and Glover treat both as ejection chains, of length one and
 * two respectively.
 *
 * Driven by a worklist rather than repeated sweeps. A workload is worth re-examining only when a
 * lecturer it could use has changed state, so an accepted move re-enqueues exactly the workloads the
 * two affected lecturers are candidates for. Sweeping all of them after every move — which is what
 * the previous shape did — rescanned a whole department to find the handful of positions that could
 * have moved.
 */
function improve(ctx: SearchContext) {
  const { slotWorkloads, chosen, chosenSet, candidateOf, ranked, candidateWorkloads, loads,
          take, drop, locked, lockKey, ops, getTotalDeficit, refreshDeficit } = ctx;
  const W = slotWorkloads.length;
  if (!W) return;

  const score = (i: number, id: string) => candidateOf[i].get(id)?.desirability ?? 0;
  const movable = (i: number, id: string) =>
    loads.has(id) && !locked.has(lockKey(slotWorkloads[i].id, id));

  /** Which workloads a lecturer currently holds — the swap neighbourhood needs it. */
  const holdersIndex = new Map<string, Set<number>>();
  for (let i = 0; i < W; i++) {
    for (const id of chosen[i]) {
      let set = holdersIndex.get(id);
      if (!set) { set = new Set(); holdersIndex.set(id, set); }
      set.add(i);
    }
  }
  const noteTake = (id: string, i: number) => {
    let set = holdersIndex.get(id);
    if (!set) { set = new Set(); holdersIndex.set(id, set); }
    set.add(i);
  };
  const noteDrop = (id: string, i: number) => holdersIndex.get(id)?.delete(i);

  const queue: number[] = [];
  const queued = new Uint8Array(W);
  for (let i = 0; i < W; i++) { queue.push(i); queued[i] = 1; }
  const enqueue = (i: number) => { if (!queued[i]) { queued[i] = 1; queue.push(i); } };
  const enqueueFor = (lecturerId: string) => {
    const where = candidateWorkloads.get(lecturerId);
    if (where) for (const i of where) enqueue(i);
  };

  const cap = IMPROVE_MOVE_CAP * W;
  let moves = 0;
  let head = 0;

  while (head < queue.length && moves < cap) {
    const i = queue[head++];
    queued[i] = 0;
    // Reclaim the consumed prefix so a long run cannot grow the array without bound.
    if (head > 4096 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }

    ops.improvePasses++;
    const w = slotWorkloads[i];
    let movedHere = false;

    // ── shift ──
    // Every strictly better candidate is tried, best first, not merely the best one: the best may be
    // out of headroom while the second-best is not, and settling for the incumbent in that case
    // leaves desirability on the table.
    for (const from of [...chosen[i]]) {
      if (!movable(i, from)) continue;
      const fromScore = score(i, from);

      for (const cand of ranked[i]) {
        const to = cand.lecturerId;
        if (cand.desirability <= fromScore) break;      // ranked: nothing after this is better
        if (chosenSet[i].has(to)) continue;

        ops.improveProbes++;
        const d0 = getTotalDeficit();
        drop(from, i);
        if (!loads.get(to)!.canTake(w)) { take(from, i); continue; }
        take(to, i);
        refreshDeficit(from);
        refreshDeficit(to);
        if (getTotalDeficit() <= d0) {
          noteDrop(from, i); noteTake(to, i);
          movedHere = true; ops.improveMoves++; moves++;
          enqueueFor(from); enqueueFor(to);
          break;
        }
        drop(to, i);
        take(from, i);
        refreshDeficit(from);
        refreshDeficit(to);
      }
      if (movedHere) break;
    }

    // ── swap ──
    // Only worth trying where a shift failed: if a strictly better candidate could simply be taken,
    // the shift above already took them.
    if (!movedHere) {
      for (const from of [...chosen[i]]) {
        if (!movable(i, from)) continue;
        const fromScore = score(i, from);

        for (const cand of ranked[i]) {
          const other = cand.lecturerId;
          const gainHere = cand.desirability - fromScore;
          if (gainHere <= 0) break;                     // ranked: nothing after this can pay
          if (chosenSet[i].has(other)) continue;
          const theirSlots = holdersIndex.get(other);
          if (!theirSlots) continue;

          for (const j of theirSlots) {
            if (j === i) continue;
            // `from` must be a candidate for their slot, and the exchange must pay overall.
            if (!candidateOf[j].has(from) || chosenSet[j].has(from)) continue;
            if (!movable(j, other)) continue;
            if (gainHere + (score(j, from) - score(j, other)) <= 0) continue;

            ops.swapProbes++;
            const d0 = getTotalDeficit();
            drop(from, i); drop(other, j);
            const ok = loads.get(other)!.canTake(w) && loads.get(from)!.canTake(slotWorkloads[j]);
            if (!ok) { take(from, i); take(other, j); continue; }
            take(other, i); take(from, j);
            refreshDeficit(from); refreshDeficit(other);
            if (getTotalDeficit() <= d0) {
              noteDrop(from, i); noteDrop(other, j);
              noteTake(other, i); noteTake(from, j);
              movedHere = true; ops.swapMoves++; moves++;
              enqueueFor(from); enqueueFor(other);
              break;
            }
            drop(other, i); drop(from, j);
            take(from, i); take(other, j);
            refreshDeficit(from); refreshDeficit(other);
          }
          if (movedHere) break;
        }
        if (movedHere) break;
      }
    }

    if (movedHere) enqueue(i);
  }
}

/** How many times the supervision repair sweeps the over-ceiling lecturers before giving up. */
const SUPERVISION_REPAIR_PASSES = 8;

/**
 * Moves supervision off lecturers who are over the annual ceiling, one student at a time.
 *
 * {@link distributeStudents} places each position greedily and in isolation: it sees the positions
 * already booked, never the ones still to come. That is enough to keep most plans lawful but not
 * all of them --- on two of the benchmark's forty-eight instances an integer program proves a
 * lawful supervision roster exists while the greedy pass returns one over the ceiling, purely
 * because an early position spent headroom a later position then needed.
 *
 * This pass repairs exactly that. A move is applied only when it takes a student from a supervisor
 * who is over the ceiling and gives them to a candidate of the *same* position who is still under
 * it afterwards, so the total overrun strictly falls and no new violation is ever created. Where no
 * such move exists the overrun is inherent to the instance --- no ordering of the same students
 * over the same candidate pools is lawful --- and the pass leaves it.
 *
 * Donors already at their desired student count give a student up first, so repairing a ceiling
 * does not deepen a floor shortfall while any cheaper move remains. Every choice is totally
 * ordered, so the result is deterministic.
 */
function repairSupervisionCeilings(
  individual: GenWorkload[],
  studentPlans: Map<string, { studentId: string; lecturerId: string }[]>,
  loads: Map<string, Load>,
  locked: Set<string>,
  ops: GenOpCounters
): number {
  const room = (id: string) => {
    const load = loads.get(id);
    return load ? load.hoursHeadroom() : Infinity;
  };
  const overrun = (id: string) => {
    const r = room(id);
    return Number.isFinite(r) ? Math.max(0, -r) : 0;
  };

  const held = new Map<string, Set<string>>();
  const byPosition = new Map<string, GenWorkload>();
  for (const w of individual) {
    byPosition.set(w.id, w);
    for (const a of studentPlans.get(w.id) ?? []) {
      let held_ = held.get(a.lecturerId);
      if (!held_) held.set(a.lecturerId, (held_ = new Set()));
      held_.add(w.id);
    }
  }

  let moved = 0;
  for (let pass = 0; pass < SUPERVISION_REPAIR_PASSES; pass++) {
    const over = [...loads.keys()].filter((id) => overrun(id) > 0)
      .sort((a, b) => overrun(b) - overrun(a) || (a < b ? -1 : 1));
    if (!over.length) break;
    let movedHere = false;

    for (const from of over) {
      const positions = [...(held.get(from) ?? [])].sort();
      for (const wid of positions) {
        if (overrun(from) <= 0) break;
        const w = byPosition.get(wid);
        if (!w || !w.hours) continue;
        const plan = studentPlans.get(wid) ?? [];
        const count = new Map<string, number>();
        for (const a of plan) count.set(a.lecturerId, (count.get(a.lecturerId) ?? 0) + 1);

        const cap = (c: GenCandidate) => (c.maxStudents == null ? Infinity : c.maxStudents);
        const takers = w.candidates
          .filter((c) => c.lecturerId !== from
            && loads.has(c.lecturerId)
            && (count.get(c.lecturerId) ?? 0) < cap(c)
            && room(c.lecturerId) >= w.hours)
          .sort((a, b) => room(b.lecturerId) - room(a.lecturerId)
            || b.desirability - a.desirability
            || (a.lecturerId < b.lecturerId ? -1 : 1));
        if (!takers.length) continue;

        // Only supervisions this run created may move; see `lockedSupervision` at the call site.
        const student = plan
          .filter((a) => a.lecturerId === from && !locked.has(`${wid}\u0000${a.studentId}`))
          .map((a) => a.studentId).sort().pop();
        if (student === undefined) continue;

        const to = takers[0];
        for (const a of plan) if (a.studentId === student) a.lecturerId = to.lecturerId;
        loads.get(from)!.addHours(-w.hours);
        loads.get(to.lecturerId)!.addHours(w.hours);
        let held_ = held.get(to.lecturerId);
        if (!held_) held.set(to.lecturerId, (held_ = new Set()));
        held_.add(wid);
        if (!plan.some((a) => a.lecturerId === from)) held.get(from)!.delete(wid);
        moved++; movedHere = true; ops.supervisionRepairMoves++;
      }
    }
    if (!movedHere) break;
  }
  return moved;
}

// ── INDIVIDUALLY: distribute students among candidates ───────────────────────

/**
 * Hands each student to a supervising lecturer, following the rule the candidate limits encode:
 * every candidate is first brought up to their desired count (MIN_STUDENTS) in order of
 * desirability, then whatever remains is shared out among candidates that still have headroom
 * below MAX_STUDENTS, again by desirability. A candidate with no limits is unbounded.
 *
 * **The annual hour ceiling is respected here too, and this is a change in behaviour.** Individual
 * supervision costs `hours × students`, which on a group of twenty is a substantial part of a year's
 * load, and this routine previously booked it without ever consulting `MAX_HOURS_PER_YEAR`. A
 * lecturer could therefore finish a generated plan over the statutory 600 hours (ст. 56 Закону
 * України «Про вищу освіту») without the search having done anything wrong — the benchmark measured
 * 1 721 such lecturers across the 48 test instances.
 *
 * A student cannot simply be left without a supervisor, so the ceiling is a **strong preference, not
 * a veto**: candidates with headroom are exhausted first, and only when none is left does the
 * routine overrun — reporting exactly who and by how much, instead of overrunning silently.
 */
export function distributeStudents(
  w: GenWorkload,
  mode: 'gaps' | 'all',
  loads: Map<string, Load>,
  issues: GenIssue[],
  /** Hours of individual work each lecturer should ideally not exceed; see the caller. */
  budget?: Map<string, number>,
  /** Individual hours already booked to each lecturer across earlier positions. */
  bookedSoFar?: Map<string, number>
): { studentId: string; lecturerId: string }[] {
  const students = [...(w.studentIds ?? [])];
  if (!students.length) {
    if (w.candidates.length) {
      issues.push({ kind: 'no-students', workloadId: w.id,
        message: `${w.label}: у групах цієї позиції немає студентів, розподіляти нічого.` });
    }
    return mode === 'gaps' ? [...(w.assignedStudents ?? [])] : [];
  }
  if (!w.candidates.length) {
    issues.push({ kind: 'no-candidates', workloadId: w.id,
      message: `${w.label}: не задано кандидатів, студентів не розподілено.` });
    return mode === 'gaps' ? [...(w.assignedStudents ?? [])] : [];
  }

  const plan = new Map<string, string>();          // studentId → lecturerId
  const count = new Map<string, number>();
  for (const c of w.candidates) count.set(c.lecturerId, 0);

  if (mode === 'gaps') {
    const roster = new Set(students);
    for (const a of w.assignedStudents ?? []) {
      if (!roster.has(a.studentId)) continue;
      plan.set(a.studentId, a.lecturerId);
      count.set(a.lecturerId, (count.get(a.lecturerId) ?? 0) + 1);
    }
  }

  const byDesirability = [...w.candidates].sort((a, b) => b.desirability - a.desirability
    || a.lecturerId.localeCompare(b.lecturerId));
  const pending = students.filter((s) => !plan.has(s));
  let head = 0;
  const capacity = (c: GenCandidate) => (c.maxStudents == null ? Infinity : c.maxStudents);

  // Hours already booked here, so the ceiling test sees this workload's own accumulating cost.
  const booked = bookedSoFar ?? new Map<string, number>();
  const thisCall = new Map<string, number>();
  /** Room left under the annual ceiling, counting what this pass has booked already. */
  const ceilingRoom = (lecturerId: string) => {
    const load = loads.get(lecturerId);
    if (!load) return Infinity;
    return load.hoursHeadroom() - (booked.get(lecturerId) ?? 0);
  };
  /** Room left under the individual-work budget. */
  const budgetRoom = (lecturerId: string) =>
    (budget?.get(lecturerId) ?? Infinity) - (booked.get(lecturerId) ?? 0);

  const withinBudget = (lecturerId: string) =>
    budgetRoom(lecturerId) >= w.hours && ceilingRoom(lecturerId) >= w.hours;
  const withinCeiling = (lecturerId: string) => ceilingRoom(lecturerId) >= w.hours;

  const assign = (studentId: string, lecturerId: string) => {
    plan.set(studentId, lecturerId);
    count.set(lecturerId, (count.get(lecturerId) ?? 0) + 1);
    booked.set(lecturerId, (booked.get(lecturerId) ?? 0) + w.hours);
    thisCall.set(lecturerId, (thisCall.get(lecturerId) ?? 0) + w.hours);
  };

  // Round 1 — everyone up to their desired count, best candidates first.
  for (const c of byDesirability) {
    const want = c.minStudents ?? 0;
    while ((count.get(c.lecturerId) ?? 0) < Math.min(want, capacity(c))
           && head < pending.length && withinBudget(c.lecturerId)) {
      assign(pending[head++], c.lecturerId);
    }
  }

  // Round 2 — the remainder goes by desirability, as the candidate limits are meant to express:
  // the most desirable candidate takes extra students until they hit their ceiling, then the next.
  // Load only breaks ties, so candidates of *equal* desirability still end up sharing evenly
  // rather than one of them being filled to the brim first.
  let open = byDesirability.filter((c) => (count.get(c.lecturerId) ?? 0) < capacity(c));
  let overran = false;
  while (head < pending.length) {
    if (!open.length) {
      issues.push({ kind: 'unfilled', workloadId: w.id,
        message: `${w.label}: ${pending.length - head} студент(ів) не розподілено — вичерпано максимальні кількості студентів у кандидатів.` });
      break;
    }
    open.sort((a, b) => b.desirability - a.desirability
      || (count.get(a.lecturerId)! - (a.minStudents ?? 0)) - (count.get(b.lecturerId)! - (b.minStudents ?? 0))
      || a.lecturerId.localeCompare(b.lecturerId));

    // Three tiers, in order: someone with room to spare after their slot reservation; failing that,
    // someone merely under their ceiling; failing that, the ceiling has to give — a student must have
    // a supervisor — and the overrun goes where there is most room left, so it lands as thinly as it
    // can.
    let pick = open.find((c) => withinBudget(c.lecturerId))
            ?? open.find((c) => withinCeiling(c.lecturerId));
    if (!pick) {
      overran = true;
      pick = [...open].sort((a, b) =>
        ceilingRoom(b.lecturerId) - ceilingRoom(a.lecturerId)
        || b.desirability - a.desirability
        || (a.lecturerId < b.lecturerId ? -1 : 1))[0];
    }

    assign(pending[head++], pick.lecturerId);
    if ((count.get(pick.lecturerId) ?? 0) >= capacity(pick)) {
      open = open.filter((c) => c.lecturerId !== pick!.lecturerId);
    }
  }

  // Individual work still consumes the lecturer's hours.
  for (const [lecturerId, hours] of thisCall) {
    loads.get(lecturerId)?.addHours(hours);
  }

  if (overran) {
    issues.push({ kind: 'over-ceiling', workloadId: w.id,
      message: `${w.label}: індивідуальну роботу розподілено понад річний ліміт годин — усі кандидати вичерпали допустимий обсяг.` });
  }

  return students.filter((s) => plan.has(s)).map((s) => ({ studentId: s, lecturerId: plan.get(s)! }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

function sameStudentPlan(a: { studentId: string; lecturerId: string }[],
                         b: { studentId: string; lecturerId: string }[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(b.map((x) => [x.studentId, x.lecturerId]));
  return a.every((x) => m.get(x.studentId) === x.lecturerId);
}
