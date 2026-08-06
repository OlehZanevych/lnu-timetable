/**
 * The arithmetic of a specialty's **робочий навчальний план**: which department delivers which
 * block of hours, to which groups, in what format — and what that adds up to for each кафедра.
 *
 * Framework-free, like `curriculum-plan.ts` and `workload-stats.ts`: plain objects in, plain
 * objects out, so the read-only «Робочі навчальні плани» page, the printed sheet and a Node test
 * all read one set of numbers.
 *
 * ── What a робочий навчальний план is, and what it is not ──────────────────────────────────────
 *
 * The РНП has **no legal definition in force**. The only state act that ever defined it —
 * «Положення про організацію навчального процесу у вищих навчальних закладах», наказ МО України
 * № 161 від 02.06.1993 — said one sentence about it («для конкретизації планування навчального
 * процесу на кожний навчальний рік складається робочий навчальний план, що затверджується
 * керівником вищого закладу освіти») and **втратило чинність**: наказ МОН № 1310 від 13.11.2014.
 * The Закон України «Про вищу освіту» does not use the term; ст. 10 ч. 4 speaks of the навчальний
 * план and of **індивідуальні** навчальні плани на кожний навчальний рік. The Ліцензійні умови
 * (ПКМУ № 1187) name a «робочий навчальний план» for дошкільна and загальна середня освіта but
 * ask вищі заклади only for the навчальний план; the НАЗЯВО accreditation rules do not mention it
 * at all.
 *
 * So everything this module models is **institutional practice**, and the practice is consistent:
 * a РНП is the курс's part of the навчальний план for one academic year, plus the one thing the
 * навчальний план does not carry — **which кафедра delivers what** (ЗНУ, Положення про розрахунок
 * навантаження, п. 2.10: «закріплення навчальних дисциплін за відповідними кафедрами … фіксується
 * в робочих навчальних планах»). It is in turn the source document for кафедральне навантаження
 * (КПІ ім. Сікорського, Положення про планування педнавантаження 2022: «підставою для планування
 * навчального навантаження … є відповідні витяги з робочих навчальних планів»).
 *
 * Норми часу, which turn plan hours into teaching hours, are **also** institutional now: наказ МОН
 * № 450 від 07.08.2002 втратив чинність (наказ МОН № 187 від 16.02.2022). This module therefore
 * projects department hours by **this system's own rule**, the one `workload-stats.ts` already
 * applies when the workloads exist — see {@link plannedHoursOf}.
 */

import { PlanCourse, PlanHourType, PLAN_HOUR_TYPES, ComplianceCheck, fmtNumber }
  from './curriculum-plan';
import { PlanLimits, DEFAULT_PLAN_LIMITS } from './plan-limits';
import { compareUk } from './sort';

/** Hour types a кафедра can be made responsible for; INDEPENDENT_WORK is the student's own time. */
export const DELIVERABLE_HOUR_TYPES =
  ['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT'] as const;

export type DeliverableHourType = (typeof DELIVERABLE_HOUR_TYPES)[number];

const isDeliverable = (t: string): t is DeliverableHourType =>
  (DELIVERABLE_HOUR_TYPES as readonly string[]).includes(t);

// ── Input ───────────────────────────────────────────────────────────────────

export interface WorkingPlanGroup {
  id: string;
  name: string;
  /** `academic_groups.students_count`, or null when it was never entered. */
  studentsCount: number | null;
}

/** One `working_curriculum_items` row: a кафедра taking a block of hours for some groups. */
export interface WorkingPlanPositionInput {
  id: string;
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  /** Raw `working_curriculum_items.teaching_format`. */
  teachingFormat: string;
  /** The elective actually chosen, when the curriculum item's course is an ELECTIVE_GROUP. */
  electiveCourseName?: string | null;
  groups: WorkingPlanGroup[];
}

export interface WorkingPlanHoursInput {
  id: string;
  hourType: string;
  hours: number;
  positions: WorkingPlanPositionInput[];
}

export interface WorkingPlanItemInput {
  id: string;
  semester: number;
  controlForm: string;
  ectsCredits: number;
  course: PlanCourse | null;
  hours: WorkingPlanHoursInput[];
}

// ── Output ──────────────────────────────────────────────────────────────────

/** A кафедра's share of one discipline, named by the kinds of work it takes. */
export interface RowDepartment {
  departmentId: string;
  departmentName: string;
  hourTypes: DeliverableHourType[];
}

/** One delivery position — the line a витяг з РНП carries. */
export interface WorkingPosition {
  id: string;
  semester: number;
  courseYear: number;
  courseName: string;
  courseType: string;
  hourType: DeliverableHourType;
  /** Hours the curriculum item plans for this kind of work. */
  hours: number;
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  teachingFormat: string;
  groupNames: string[];
  /** Students across its groups; 0 when no group carries a count. */
  students: number;
  /** Hours the кафедра is projected to teach for this position — see {@link plannedHoursOf}. */
  plannedHours: number;
}

/** One discipline of the year, as the main РНП table prints it. */
export interface WorkingPlanRow {
  id: string;
  /** `courses.id` behind {@link name} — what the table links to. Blank when the item names none. */
  courseId: string;
  name: string;
  courseType: string;
  semester: number;
  courseYear: number;
  controlForm: string;
  credits: number;
  hours: Record<PlanHourType, number>;
  contactHours: number;
  otherContactHours: number;
  independentHours: number;
  independentDerived: boolean;
  totalHours: number;
  hoursImbalance: number;
  departments: RowDepartment[];
  groupNames: string[];
  /** Kinds of work with planned hours but no кафедра assigned — the gaps a РНП exists to close. */
  unassignedHourTypes: DeliverableHourType[];
}

export interface DepartmentLoad {
  departmentId: string;
  departmentName: string;
  positions: number;
  /** Distinct disciplines, counted the way `workload-stats.ts` counts them: teaching work only. */
  courses: number;
  /** Plan hours by kind of work — what the навчальний план allots, not what is taught. */
  byHourType: Record<DeliverableHourType, number>;
  planHours: number;
  /** Projected teaching hours — plan hours multiplied out over lecturers and students. */
  plannedHours: number;
}

export interface WorkingPlanTotals {
  items: number;
  credits: number;
  hours: number;
  contactHours: number;
  independentHours: number;
  byHourType: Record<PlanHourType, number>;
}

export interface WorkingPlanCoverage {
  /** Blocks of deliverable hours the curriculum plans for this year. */
  required: number;
  /** Of those, blocks with at least one кафедра assigned. */
  covered: number;
  /** Positions with no academic group named. */
  positionsWithoutGroups: number;
  /** INDIVIDUALLY positions whose groups carry no student count — their hours cannot be projected. */
  individualWithoutStudents: number;
}

export interface WorkingCurriculumPlan {
  /** Course years present in the source data, ascending — what the курс filter offers. */
  courseYears: number[];
  /** The course year this plan is scoped to, or null for the whole specialty. */
  courseYear: number | null;
  rows: WorkingPlanRow[];
  positions: WorkingPosition[];
  departments: DepartmentLoad[];
  totals: WorkingPlanTotals;
  /** Projected teaching hours across every кафедра. */
  plannedHours: number;
  coverage: WorkingPlanCoverage;
  checks: ComplianceCheck[];
}

// ── Building it ─────────────────────────────────────────────────────────────

/**
 * Hours a кафедра is projected to teach for one position.
 *
 * There is no state норма to apply — наказ МОН № 450 від 07.08.2002 втратив чинність (наказ МОН
 * № 187 від 16.02.2022) — so this deliberately reproduces **the rule this system already uses**
 * once the workloads exist (`workload-stats.ts`, and `workload-generator.ts` behind it): several
 * lecturers on one position each accrue the *full* hours, because that models parallel subgroups
 * rather than a shared stream; individual work costs `hours × students supervised`. Projecting the
 * РНП by any other rule would make this sheet disagree with the «Розрахунок навчального
 * навантаження» signed off from the same data.
 */
export function plannedHoursOf(
  hours: number, teachingFormat: string, lecturerCount: number, students: number): number {
  if (teachingFormat === 'INDIVIDUALLY') return hours * students;
  return hours * Math.max(1, lecturerCount || 1);
}

const emptyHourMap = (): Record<PlanHourType, number> =>
  Object.fromEntries(PLAN_HOUR_TYPES.map((t) => [t, 0])) as Record<PlanHourType, number>;

const emptyDeliverableMap = (): Record<DeliverableHourType, number> =>
  Object.fromEntries(DELIVERABLE_HOUR_TYPES.map((t) => [t, 0])) as Record<DeliverableHourType, number>;

const courseYearOf = (semester: number): number => Math.ceil(semester / 2);

/**
 * Folds the loaded tree into the plan a document can be printed from.
 *
 * `courseYear` scopes it to one курс, because a робочий навчальний план is drawn up **for one
 * academic year** — that is the one thing every ЗВО положення agrees on. Pass null to take the
 * whole specialty, which is useful on screen and honest in print as long as the sheet says so.
 */
export function buildWorkingCurriculumPlan(
  items: WorkingPlanItemInput[], courseYear: number | null,
  limits: PlanLimits = DEFAULT_PLAN_LIMITS): WorkingCurriculumPlan {

  const courseYears = [...new Set(items.map((i) => courseYearOf(i.semester)))]
    .filter((y) => Number.isFinite(y) && y > 0)
    .sort((a, b) => a - b);

  const scoped = items
    .filter((i) => courseYear === null || courseYearOf(i.semester) === courseYear)
    .sort((a, b) => a.semester - b.semester
      || compareUk(a.course?.name ?? '', b.course?.name ?? ''));

  const rows: WorkingPlanRow[] = [];
  const positions: WorkingPosition[] = [];
  const coverage: WorkingPlanCoverage = {
    required: 0, covered: 0, positionsWithoutGroups: 0, individualWithoutStudents: 0
  };

  for (const item of scoped) {
    const hours = emptyHourMap();
    for (const block of item.hours ?? []) {
      if ((PLAN_HOUR_TYPES as readonly string[]).includes(block.hourType)) {
        hours[block.hourType as PlanHourType] += Math.max(0, Number(block.hours) || 0);
      }
    }

    const contactHours = DELIVERABLE_HOUR_TYPES.reduce((sum, t) => sum + hours[t], 0);
    const classHours = hours.LECTURE + hours.PRACTICAL + hours.LAB;
    const credits = Math.max(0, Number(item.ectsCredits) || 0);
    const normativeHours = credits * limits.hoursPerEctsCredit;
    // Same derivation as the навчальний план: гр. «самостійна робота» = обсяг − контактні години.
    const independentDerived = hours.INDEPENDENT_WORK === 0 && normativeHours > contactHours;
    const independentHours = independentDerived
      ? normativeHours - contactHours
      : hours.INDEPENDENT_WORK;

    const byDepartment = new Map<string, RowDepartment>();
    const groupNames = new Set<string>();
    const unassigned: DeliverableHourType[] = [];

    for (const block of item.hours ?? []) {
      if (!isDeliverable(block.hourType)) continue;
      const blockHours = Math.max(0, Number(block.hours) || 0);
      if (blockHours <= 0) continue;

      coverage.required += 1;
      const blockPositions = block.positions ?? [];
      if (!blockPositions.length) { unassigned.push(block.hourType); continue; }
      coverage.covered += 1;

      for (const p of blockPositions) {
        const names = (p.groups ?? []).map((g) => g.name);
        names.forEach((n) => groupNames.add(n));
        const students = (p.groups ?? []).reduce((sum, g) => sum + (g.studentsCount ?? 0), 0);
        if (!names.length) coverage.positionsWithoutGroups += 1;
        if (p.teachingFormat === 'INDIVIDUALLY' && students === 0) {
          coverage.individualWithoutStudents += 1;
        }

        const seen = byDepartment.get(p.departmentId);
        if (seen) {
          if (!seen.hourTypes.includes(block.hourType)) seen.hourTypes.push(block.hourType);
        } else {
          byDepartment.set(p.departmentId, {
            departmentId: p.departmentId,
            departmentName: p.departmentName,
            hourTypes: [block.hourType]
          });
        }

        positions.push({
          id: p.id,
          semester: item.semester,
          courseYear: courseYearOf(item.semester),
          // An elective delivered inside a group of electives is named by what is actually taught.
          courseName: p.electiveCourseName
            ? `${item.course?.name ?? '—'}: ${p.electiveCourseName}`
            : (item.course?.name ?? '—'),
          courseType: item.course?.courseType ?? '',
          hourType: block.hourType,
          hours: blockHours,
          departmentId: p.departmentId,
          departmentName: p.departmentName,
          lecturerCount: p.lecturerCount,
          teachingFormat: p.teachingFormat,
          groupNames: names,
          students,
          plannedHours: plannedHoursOf(blockHours, p.teachingFormat, p.lecturerCount, students)
        });
      }
    }

    rows.push({
      id: item.id,
      courseId: item.course?.id ?? '',
      name: item.course?.name ?? '—',
      courseType: item.course?.courseType ?? '',
      semester: item.semester,
      courseYear: courseYearOf(item.semester),
      controlForm: item.controlForm,
      credits,
      hours,
      contactHours,
      otherContactHours: contactHours - classHours,
      independentHours,
      independentDerived,
      totalHours: Math.max(normativeHours, contactHours + independentHours),
      hoursImbalance: normativeHours - (contactHours + independentHours),
      departments: [...byDepartment.values()].sort((a, b) =>
        compareUk(a.departmentName, b.departmentName)),
      groupNames: [...groupNames].sort(compareUk),
      unassignedHourTypes: unassigned
    });
  }

  const totals: WorkingPlanTotals = {
    items: rows.length,
    credits: rows.reduce((sum, r) => sum + r.credits, 0),
    hours: rows.reduce((sum, r) => sum + r.totalHours, 0),
    contactHours: rows.reduce((sum, r) => sum + r.contactHours, 0),
    independentHours: rows.reduce((sum, r) => sum + r.independentHours, 0),
    byHourType: emptyHourMap()
  };
  for (const row of rows) {
    for (const t of DELIVERABLE_HOUR_TYPES) totals.byHourType[t] += row.hours[t];
    totals.byHourType.INDEPENDENT_WORK += row.independentHours;
  }

  const departments = buildDepartmentLoads(positions);
  const plannedHours = departments.reduce((sum, d) => sum + d.plannedHours, 0);

  return {
    courseYears,
    courseYear,
    rows,
    positions: positions.sort((a, b) =>
      compareUk(a.departmentName, b.departmentName)
      || a.semester - b.semester
      || compareUk(a.courseName, b.courseName)
      || DELIVERABLE_HOUR_TYPES.indexOf(a.hourType) - DELIVERABLE_HOUR_TYPES.indexOf(b.hourType)),
    departments,
    totals,
    plannedHours,
    coverage,
    checks: buildChecks(rows, totals, coverage, positions, courseYear, limits)
  };
}

function buildDepartmentLoads(positions: WorkingPosition[]): DepartmentLoad[] {
  const byId = new Map<string, DepartmentLoad>();
  const coursesSeen = new Map<string, Set<string>>();

  for (const p of positions) {
    let load = byId.get(p.departmentId);
    if (!load) {
      load = {
        departmentId: p.departmentId,
        departmentName: p.departmentName,
        positions: 0,
        courses: 0,
        byHourType: emptyDeliverableMap(),
        planHours: 0,
        plannedHours: 0
      };
      byId.set(p.departmentId, load);
      coursesSeen.set(p.departmentId, new Set());
    }
    load.positions += 1;
    load.byHourType[p.hourType] += p.hours;
    load.planHours += p.hours;
    load.plannedHours += p.plannedHours;
    // Matches LecturerStats.distinctCourses: only teaching work makes a discipline "taught".
    if (p.hourType === 'LECTURE' || p.hourType === 'PRACTICAL' || p.hourType === 'LAB') {
      coursesSeen.get(p.departmentId)!.add(p.courseName);
    }
  }

  const loads = [...byId.values()];
  for (const load of loads) load.courses = coursesSeen.get(load.departmentId)!.size;
  return loads.sort((a, b) => compareUk(a.departmentName, b.departmentName));
}

function buildChecks(rows: WorkingPlanRow[], totals: WorkingPlanTotals,
                     coverage: WorkingPlanCoverage, positions: WorkingPosition[],
                     courseYear: number | null, limits: PlanLimits): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];

  // 1. The whole point of a РНП: every block of contact hours has a кафедра behind it. Not tied to
  //    a настройка — a plan is either complete or it is not.
  const gaps = coverage.required - coverage.covered;
  checks.push({
    key: 'DEPARTMENT_COVERAGE',
    title: 'Закріплення контактних годин за кафедрами',
    norm: 'усі блоки годин',
    source: 'усталена практика ЗВО',
    value: coverage.required ? `${coverage.covered} з ${coverage.required}` : '—',
    statutory: false,
    status: !coverage.required ? 'unknown' : gaps ? 'violation' : 'ok',
    verdict: !coverage.required
      ? 'позицій навчального плану немає'
      : gaps
        ? `${gaps} блок(ів) без кафедри — навантаження за ними не сформується`
        : 'закріплено повністю'
  });

  // 2. A position with no group cannot become a class: the schedule has nobody to seat.
  checks.push({
    key: 'POSITION_GROUPS',
    title: 'Академічні групи в позиціях робочого плану',
    norm: 'кожна позиція має групи',
    source: 'усталена практика ЗВО',
    value: positions.length ? `${positions.length - coverage.positionsWithoutGroups} з ${positions.length}` : '—',
    statutory: false,
    status: !positions.length ? 'unknown' : coverage.positionsWithoutGroups ? 'warning' : 'ok',
    verdict: !positions.length
      ? 'позицій робочого плану немає'
      : coverage.positionsWithoutGroups
        ? `${coverage.positionsWithoutGroups} позиц. без академічних груп`
        : 'групи вказано в усіх позиціях'
  });

  // 3. Річне навантаження — only meaningful when the sheet really covers one academic year, and
  //    only when someone has said what a year should hold.
  if (limits.creditsPerAcademicYear !== null) {
    const target = limits.creditsPerAcademicYear;
    const tolerance = Math.max(0, limits.creditsPerYearTolerance);
    const gap = Math.abs(totals.credits - target);
    checks.push({
      key: 'YEAR_LOAD',
      title: 'Навантаження навчального року, кредитів ЄКТС',
      norm: `як правило, ${fmtNumber(target)}`,
      source: 'ст. 1 п. 14 Закону України «Про вищу освіту»',
      value: totals.credits ? fmtNumber(totals.credits) : '—',
      statutory: true,
      ...(courseYear === null
        ? { status: 'unknown' as const,
            verdict: 'план охоплює всі курси, а не один навчальний рік' }
        : !totals.credits
          ? { status: 'unknown' as const, verdict: 'позицій немає' }
          : gap <= tolerance
            ? { status: 'ok' as const,
                verdict: `близько до орієнтиру в ${fmtNumber(target)} кредитів ЄКТС` }
            : { status: 'warning' as const,
                verdict: `${totals.credits < target ? 'менше' : 'більше'} за орієнтир у ` +
                         `${fmtNumber(target)} кредитів ЄКТС на ${fmtNumber(gap)}` })
    });
  }

  // 4. Обсяг кредиту в годинах — inherited from the навчальний план, checked here because a РНП
  //    that does not close cannot produce a correct workload either.
  const perCredit = fmtNumber(limits.hoursPerEctsCredit);
  const unbalanced = rows.filter((r) => r.hoursImbalance !== 0);
  checks.push({
    key: 'HOURS_PER_CREDIT',
    title: 'Обсяг годин на один кредит ЄКТС',
    norm: `${perCredit} годин`,
    source: 'ст. 1 п. 14 Закону України «Про вищу освіту»',
    value: !rows.length ? '—'
      : unbalanced.length ? `${unbalanced.length} позиц. з розбіжністю`
      : 'узгоджено в усіх позиціях',
    statutory: true,
    status: !rows.length ? 'unknown' : unbalanced.length ? 'warning' : 'ok',
    verdict: !rows.length
      ? 'позицій немає'
      : unbalanced.length
        ? `сума годин не збігається з кредитами · ${perCredit}: ` +
          unbalanced.slice(0, 3).map((r) => r.name).join(', ') +
          (unbalanced.length > 3 ? ` та ще ${unbalanced.length - 3}` : '')
        : `кожна позиція закривається кредитами · ${perCredit}`
  });

  // 5. Only worth printing where individual work is actually planned.
  if (positions.some((p) => p.teachingFormat === 'INDIVIDUALLY')) {
    checks.push({
      key: 'INDIVIDUAL_CONTINGENT',
      title: 'Контингент для індивідуальної роботи',
      norm: 'кількість студентів у групах',
      source: 'усталена практика ЗВО',
      value: coverage.individualWithoutStudents
        ? `${coverage.individualWithoutStudents} позиц. без контингенту`
        : 'вказано',
      statutory: false,
      status: coverage.individualWithoutStudents ? 'warning' : 'ok',
      verdict: coverage.individualWithoutStudents
        ? 'години цих позицій не спроєктовано: індивідуальна робота рахується за студентами'
        : 'години індивідуальної роботи спроєктовано за контингентом'
    });
  }

  return checks;
}
