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
 * those side constraints is an integer program — NP-hard in general — so this does what a person
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
 *   3. **Improvement pass**: repeated single moves — replacing one holder of a slot with a more
 *      desirable candidate — that raise total desirability without breaking a ceiling or deepening
 *      a floor deficit. Runs to a fixed point or an iteration cap, so it always terminates.
 *      (Pairwise swaps between two slots are *not* attempted; see WORKLOAD-GENERATION.md.)
 *
 * INDIVIDUALLY-taught workloads are a different shape and get their own routine — the unit of work
 * is a student, not a slot; see {@link distributeStudents}.
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
  kind: 'unfilled' | 'unmet-minimum' | 'no-candidates' | 'no-students';
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
}

// ── Constraint bookkeeping ───────────────────────────────────────────────────

const isMandatory = (courseType: string) => courseType === 'MANDATORY';
const isElective = (courseType: string) => courseType === 'ELECTIVE' || courseType === 'ELECTIVE_GROUP';

const countedType = (h: HourType): CountedHourType | null =>
  (COUNTED_HOUR_TYPES as readonly string[]).includes(h) ? (h as CountedHourType) : null;

/**
 * A lecturer's running load: hours plus the distinct (course, hourType) sets the course-count
 * constraints are expressed over. Sets rather than counters because "distinct courses" means a
 * second lab in the same course costs nothing extra.
 */
class Load {
  hours = 0;
  /** hourType → set of courseIds. */
  private byType = new Map<CountedHourType, Set<string>>();
  private byTypeMandatory = new Map<CountedHourType, Set<string>>();
  private byTypeElective = new Map<CountedHourType, Set<string>>();
  /** Every course with any taught hour type, for MAX_COURSES. */
  private allCourses = new Set<string>();

  readonly lecturer: GenLecturer;
  private readonly defaultMaxHours: number | null;

  // Mechanically desugared from `constructor(readonly lecturer, private readonly defaultMaxHours)`
  // so this historical file loads under `node --experimental-strip-types`. No behavioural change.
  constructor(lecturer: GenLecturer, defaultMaxHours: number | null) {
    this.lecturer = lecturer;
    this.defaultMaxHours = defaultMaxHours;
  }

  private set(map: Map<CountedHourType, Set<string>>, t: CountedHourType): Set<string> {
    let s = map.get(t);
    if (!s) { s = new Set(); map.set(t, s); }
    return s;
  }

  add(w: GenWorkload) {
    this.hours += w.hours;
    const t = countedType(w.hourType);
    if (!t) return;
    this.allCourses.add(w.courseId);
    this.set(this.byType, t).add(w.courseId);
    if (isMandatory(w.courseType)) this.set(this.byTypeMandatory, t).add(w.courseId);
    if (isElective(w.courseType)) this.set(this.byTypeElective, t).add(w.courseId);
  }

  remove(w: GenWorkload, others: GenWorkload[]) {
    this.hours -= w.hours;
    const t = countedType(w.hourType);
    if (!t) return;
    // A course only leaves a set when no *other* assignment still puts it there.
    const stillTyped = others.some((o) => o.courseId === w.courseId && countedType(o.hourType) === t);
    if (!stillTyped) {
      this.set(this.byType, t).delete(w.courseId);
      if (isMandatory(w.courseType)) this.set(this.byTypeMandatory, t).delete(w.courseId);
      if (isElective(w.courseType)) this.set(this.byTypeElective, t).delete(w.courseId);
    }
    if (!others.some((o) => o.courseId === w.courseId && countedType(o.hourType))) {
      this.allCourses.delete(w.courseId);
    }
  }

  private limit(name: string): number | null {
    const v = this.lecturer.constraints[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  private maxHours(): number | null {
    return this.limit('MAX_HOURS_PER_YEAR') ?? this.defaultMaxHours;
  }

  private counts(t: CountedHourType) {
    return {
      all: this.set(this.byType, t).size,
      mandatory: this.set(this.byTypeMandatory, t).size,
      elective: this.set(this.byTypeElective, t).size
    };
  }

  /** Would taking this workload break a ceiling? Floors are handled separately — they can't be met by refusing work. */
  canTake(w: GenWorkload): boolean {
    const maxH = this.maxHours();
    if (maxH !== null && this.hours + w.hours > maxH) return false;

    const t = countedType(w.hourType);
    if (!t) return true;

    const newCourse = !this.set(this.byType, t).has(w.courseId);
    const c = this.counts(t);

    const maxAll = this.limit('MAX_COURSES');
    if (maxAll !== null && !this.allCourses.has(w.courseId) && this.allCourses.size + 1 > maxAll) return false;

    const maxT = this.limit(`MAX_${t}_COURSES`);
    if (maxT !== null && newCourse && c.all + 1 > maxT) return false;

    if (isMandatory(w.courseType)) {
      const m = this.limit(`MAX_MANDATORY_${t}_COURSES`);
      const isNew = !this.set(this.byTypeMandatory, t).has(w.courseId);
      if (m !== null && isNew && c.mandatory + 1 > m) return false;
    }
    if (isElective(w.courseType)) {
      const e = this.limit(`MAX_ELECTIVE_${t}_COURSES`);
      const isNew = !this.set(this.byTypeElective, t).has(w.courseId);
      if (e !== null && isNew && c.elective + 1 > e) return false;
    }
    return true;
  }

  /** Floors this lecturer still falls short of, as human-readable fragments. */
  unmetMinimums(): string[] {
    const out: string[] = [];
    const minH = this.limit('MIN_HOURS_PER_YEAR');
    if (minH !== null && this.hours < minH) out.push(`годин на рік: ${this.hours} з ${minH}`);
    for (const t of COUNTED_HOUR_TYPES) {
      const c = this.counts(t);
      const pairs: [string, number, string][] = [
        [`MIN_${t}_COURSES`, c.all, 'дисциплін'],
        [`MIN_MANDATORY_${t}_COURSES`, c.mandatory, "обов'язкових дисциплін"],
        [`MIN_ELECTIVE_${t}_COURSES`, c.elective, 'вибіркових дисциплін']
      ];
      for (const [key, have, what] of pairs) {
        const min = this.limit(key);
        if (min !== null && have < min) out.push(`${HOUR_TYPE_UK[t]} — ${what}: ${have} з ${min}`);
      }
    }
    return out;
  }

  /** How far below its floors this lecturer is; drives the repair pass. */
  deficit(): number {
    let d = 0;
    const minH = this.limit('MIN_HOURS_PER_YEAR');
    if (minH !== null && this.hours < minH) d += minH - this.hours;
    for (const t of COUNTED_HOUR_TYPES) {
      const c = this.counts(t);
      for (const [key, have] of [[`MIN_${t}_COURSES`, c.all],
                                 [`MIN_MANDATORY_${t}_COURSES`, c.mandatory],
                                 [`MIN_ELECTIVE_${t}_COURSES`, c.elective]] as [string, number][]) {
        const min = this.limit(key);
        if (min !== null && have < min) d += (min - have) * 10;   // a missing course outweighs an hour
      }
    }
    return d;
  }

  /** 0..1 share of the annual hour ceiling used — the tie-breaker that spreads work out. */
  fill(): number {
    const maxH = this.maxHours();
    return maxH && maxH > 0 ? this.hours / maxH : 0;
  }

  courseCount(): number { return this.allCourses.size; }
}

const HOUR_TYPE_UK: Record<string, string> = {
  LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
  CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи'
};

// ── Main entry point ─────────────────────────────────────────────────────────

interface Slot { workload: GenWorkload; index: number }

export function generateWorkloads(input: GenInput): GenResult {
  const { mode, defaultMaxHoursPerYear } = input;
  const lecturerById = new Map(input.lecturers.map((l) => [l.id, l]));
  const loads = new Map<string, Load>();
  for (const l of input.lecturers) loads.set(l.id, new Load(l, defaultMaxHoursPerYear));

  /** lecturerId → workloads currently held, needed to undo set membership correctly. */
  const held = new Map<string, GenWorkload[]>();
  /**
   * `workloadId:lecturerId` pairs that existed before this run. In 'gaps' mode they are untouchable
   * — the whole point of that mode is that it only adds — so the repair and improvement passes must
   * not move them, however much desirability a swap would buy.
   */
  const locked = new Set<string>();
  const lockKey = (workloadId: string, lecturerId: string) => `${workloadId}:${lecturerId}`;
  const chosen = new Map<string, string[]>();   // workloadId → lecturerIds this run settled on
  const issues: GenIssue[] = [];

  const take = (lecturerId: string, w: GenWorkload) => {
    loads.get(lecturerId)!.add(w);
    (held.get(lecturerId) ?? held.set(lecturerId, []).get(lecturerId)!).push(w);
    chosen.get(w.id)!.push(lecturerId);
  };
  const drop = (lecturerId: string, w: GenWorkload) => {
    const list = held.get(lecturerId) ?? [];
    const i = list.findIndex((x) => x.id === w.id);
    if (i >= 0) list.splice(i, 1);
    loads.get(lecturerId)!.remove(w, list);
    const c = chosen.get(w.id)!;
    const j = c.indexOf(lecturerId);
    if (j >= 0) c.splice(j, 1);
  };

  // Seed: in 'gaps' mode existing assignments stand and consume capacity; in 'all' mode we start clean.
  const individual = input.workloads.filter((w) => w.teachingFormat === 'INDIVIDUALLY');
  const slotWorkloads = input.workloads.filter((w) => w.teachingFormat !== 'INDIVIDUALLY');

  for (const w of slotWorkloads) {
    chosen.set(w.id, []);
    if (mode === 'gaps') {
      for (const id of w.assignedLecturerIds) {
        locked.add(lockKey(w.id, id));
        if (loads.has(id)) take(id, w);
        else chosen.get(w.id)!.push(id);   // outside the department: keep, but don't track capacity
      }
    }
  }

  // Build the slots still to fill.
  const slots: Slot[] = [];
  for (const w of slotWorkloads) {
    const need = Math.max(0, w.lecturerCount - chosen.get(w.id)!.length);
    if (need > 0 && !w.candidates.length) {
      issues.push({ kind: 'no-candidates', workloadId: w.id,
        message: `${w.label}: не задано кандидатів, ${need} місць(я) залишиться незаповненими.` });
    }
    for (let i = 0; i < need; i++) slots.push({ workload: w, index: i });
  }
  const requestedSlots = slots.length;

  // ── 1. Most-constrained-first greedy ──
  const feasibleFor = (w: GenWorkload): GenCandidate[] =>
    w.candidates.filter((c) => loads.has(c.lecturerId)
      && !chosen.get(w.id)!.includes(c.lecturerId)
      && loads.get(c.lecturerId)!.canTake(w));

  const remaining = [...slots];
  let filledSlots = 0;
  while (remaining.length) {
    // Re-evaluate every round: a choice made now changes what is feasible elsewhere.
    remaining.sort((a, b) => feasibleFor(a.workload).length - feasibleFor(b.workload).length);
    const slot = remaining.shift()!;
    const options = feasibleFor(slot.workload);
    if (!options.length) {
      issues.push({ kind: 'unfilled', workloadId: slot.workload.id,
        message: `${slot.workload.label}: не вдалося підібрати викладача (немає доступних кандидатів або вичерпано обмеження).` });
      continue;
    }
    options.sort((a, b) => b.desirability - a.desirability
      || loads.get(a.lecturerId)!.fill() - loads.get(b.lecturerId)!.fill()
      || a.lecturerId.localeCompare(b.lecturerId));
    take(options[0].lecturerId, slot.workload);
    filledSlots++;
  }

  // ── 2. Repair pass: move work toward lecturers below their floors ──
  repair(slotWorkloads, chosen, loads, take, drop, locked, lockKey);

  // ── 3. Improvement pass: raise total desirability without breaking anything ──
  improve(slotWorkloads, chosen, loads, take, drop, locked, lockKey);

  // ── INDIVIDUALLY workloads: distribute students instead of slots ──
  const studentPlans = new Map<string, { studentId: string; lecturerId: string }[]>();
  for (const w of individual) {
    const plan = distributeStudents(w, mode, loads, issues);
    studentPlans.set(w.id, plan);
  }

  // ── Report ──
  for (const l of input.lecturers) {
    const unmet = loads.get(l.id)!.unmetMinimums();
    for (const u of unmet) {
      issues.push({ kind: 'unmet-minimum', lecturerId: l.id, message: `${l.name}: не досягнуто мінімуму — ${u}.` });
    }
  }

  const assignments: GenAssignment[] = [];
  let totalDesirability = 0;

  for (const w of slotWorkloads) {
    const ids = chosen.get(w.id)!;
    const before = mode === 'gaps' ? w.assignedLecturerIds : [];
    const added = ids.filter((id) => !before.includes(id));
    for (const id of added) {
      totalDesirability += w.candidates.find((c) => c.lecturerId === id)?.desirability ?? 0;
    }
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

  return { assignments, issues, totalDesirability, filledSlots, requestedSlots, load };
}

// ── Local search ─────────────────────────────────────────────────────────────

type Take = (lecturerId: string, w: GenWorkload) => void;
type Drop = (lecturerId: string, w: GenWorkload) => void;
type LockKey = (workloadId: string, lecturerId: string) => string;

/**
 * Moves an assignment from a lecturer comfortably above their floors to one below theirs, whenever
 * the receiver is also a candidate and the move stays feasible. Strictly decreasing total deficit,
 * so it terminates.
 */
function repair(workloads: GenWorkload[], chosen: Map<string, string[]>, loads: Map<string, Load>,
                take: Take, drop: Drop, locked: Set<string>, lockKey: LockKey) {
  for (let pass = 0; pass < 50; pass++) {
    const totalDeficit = () => Array.from(loads.values()).reduce((s, l) => s + l.deficit(), 0);
    const before = totalDeficit();
    if (before === 0) return;
    let moved = false;

    for (const w of workloads) {
      const holders = [...chosen.get(w.id)!];
      for (const from of holders) {
        if (!loads.has(from) || locked.has(lockKey(w.id, from))) continue;
        for (const cand of w.candidates) {
          const to = cand.lecturerId;
          if (to === from || !loads.has(to) || chosen.get(w.id)!.includes(to)) continue;
          drop(from, w);
          if (!loads.get(to)!.canTake(w)) { take(from, w); continue; }
          take(to, w);
          if (totalDeficit() < before) { moved = true; break; }
          drop(to, w);
          take(from, w);
        }
        if (moved) break;
      }
      if (moved) break;
    }
    if (!moved) return;
  }
}

/**
 * Hill-climbs on total desirability with single moves, keeping every ceiling satisfied and never
 * increasing the deficit. Capped so a pathological input can't spin.
 */
function improve(workloads: GenWorkload[], chosen: Map<string, string[]>, loads: Map<string, Load>,
                 take: Take, drop: Drop, locked: Set<string>, lockKey: LockKey) {
  const score = (w: GenWorkload, id: string) => w.candidates.find((c) => c.lecturerId === id)?.desirability ?? 0;
  const deficit = () => Array.from(loads.values()).reduce((s, l) => s + l.deficit(), 0);

  for (let pass = 0; pass < 30; pass++) {
    let improved = false;
    for (const w of workloads) {
      for (const from of [...chosen.get(w.id)!]) {
        if (!loads.has(from) || locked.has(lockKey(w.id, from))) continue;
        const better = w.candidates
          .filter((c) => c.desirability > score(w, from) && loads.has(c.lecturerId)
            && !chosen.get(w.id)!.includes(c.lecturerId))
          .sort((a, b) => b.desirability - a.desirability);
        for (const cand of better) {
          const d0 = deficit();
          drop(from, w);
          if (!loads.get(cand.lecturerId)!.canTake(w)) { take(from, w); continue; }
          take(cand.lecturerId, w);
          if (deficit() <= d0) { improved = true; break; }
          drop(cand.lecturerId, w);
          take(from, w);
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (!improved) return;
  }
}

// ── INDIVIDUALLY: distribute students among candidates ───────────────────────

/**
 * Hands each student to a supervising lecturer, following the rule the candidate limits encode:
 * every candidate is first brought up to their desired count (MIN_STUDENTS) in order of
 * desirability, then whatever remains is shared out among candidates that still have headroom
 * below MAX_STUDENTS, again by desirability. A candidate with no limits is unbounded.
 */
export function distributeStudents(
  w: GenWorkload,
  mode: 'gaps' | 'all',
  loads: Map<string, Load>,
  issues: GenIssue[]
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
    for (const a of w.assignedStudents ?? []) {
      if (!students.includes(a.studentId)) continue;
      plan.set(a.studentId, a.lecturerId);
      count.set(a.lecturerId, (count.get(a.lecturerId) ?? 0) + 1);
    }
  }

  const byDesirability = [...w.candidates].sort((a, b) => b.desirability - a.desirability
    || a.lecturerId.localeCompare(b.lecturerId));
  const pending = students.filter((s) => !plan.has(s));
  const capacity = (c: GenCandidate) => (c.maxStudents == null ? Infinity : c.maxStudents);

  // Round 1 — everyone up to their desired count, best candidates first.
  for (const c of byDesirability) {
    const want = c.minStudents ?? 0;
    while ((count.get(c.lecturerId) ?? 0) < Math.min(want, capacity(c)) && pending.length) {
      const s = pending.shift()!;
      plan.set(s, c.lecturerId);
      count.set(c.lecturerId, (count.get(c.lecturerId) ?? 0) + 1);
    }
  }

  // Round 2 — the remainder goes by desirability, as the candidate limits are meant to express:
  // the most desirable candidate takes extra students until they hit their ceiling, then the next.
  // Load only breaks ties, so candidates of *equal* desirability still end up sharing evenly
  // rather than one of them being filled to the brim first.
  while (pending.length) {
    const open = byDesirability.filter((c) => (count.get(c.lecturerId) ?? 0) < capacity(c));
    if (!open.length) {
      issues.push({ kind: 'unfilled', workloadId: w.id,
        message: `${w.label}: ${pending.length} студент(ів) не розподілено — вичерпано максимальні кількості студентів у кандидатів.` });
      break;
    }
    open.sort((a, b) => b.desirability - a.desirability
      || (count.get(a.lecturerId)! - (a.minStudents ?? 0)) - (count.get(b.lecturerId)! - (b.minStudents ?? 0))
      || a.lecturerId.localeCompare(b.lecturerId));
    const c = open[0];
    const s = pending.shift()!;
    plan.set(s, c.lecturerId);
    count.set(c.lecturerId, (count.get(c.lecturerId) ?? 0) + 1);
  }

  // Individual work still consumes the lecturer's hours.
  for (const c of w.candidates) {
    const n = count.get(c.lecturerId) ?? 0;
    const load = loads.get(c.lecturerId);
    if (n > 0 && load) load.hours += w.hours * n;
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
