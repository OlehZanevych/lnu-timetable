/**
 * Per-lecturer workload statistics for a department: how many academic hours each lecturer actually
 * carries, split by kind of work and by mandatory/elective discipline, and how that compares with
 * the limits set for them.
 *
 * Framework-free for the same reason as `workload-generator.ts` — it is pure arithmetic over plain
 * objects, so it can be unit-tested directly, and both the department's summary table and the
 * per-lecturer drill-down read from one implementation rather than two that can drift.
 *
 * **Hours accounting matches the generator exactly**: when several lecturers deliver one item each
 * of them accrues the *full* hours (parallel subgroups, not a shared stream), and individual work
 * costs `hours × students supervised`. If that convention ever changes, it has to change in both
 * files — see WORKLOAD-GENERATION.md §2.
 */

export type StatHourType = 'LECTURE' | 'PRACTICAL' | 'LAB' | 'CONSULTATION' | 'ASSESSMENT' | 'INDEPENDENT_WORK';

/** The kinds of work shown as their own column; INDEPENDENT_WORK never reaches a lecturer. */
export const STAT_HOUR_TYPES: StatHourType[] = ['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT'];

/** Only these are broken down by mandatory/elective — the others aren't tied to a discipline kind. */
export const SPLIT_HOUR_TYPES = ['LECTURE', 'PRACTICAL', 'LAB'] as const;
export type SplitHourType = (typeof SPLIT_HOUR_TYPES)[number];

export const isMandatoryCourse = (courseType: string) => courseType === 'MANDATORY';
export const isElectiveCourse = (courseType: string) =>
  courseType === 'ELECTIVE' || courseType === 'ELECTIVE_GROUP';

/** One workload as the statistics need it — flattened from the loaded department tree. */
export interface StatWorkload {
  workloadId: string;
  hours: number;
  hourType: string;
  courseId: string;
  courseName: string;
  courseType: string;
  semester: number;
  specialtyName: string;
  teachingFormat: string;
  /** Lecturers assigned; each accrues the full hours. */
  lecturerIds: string[];
  /** INDIVIDUALLY only: lecturerId → students supervised, which multiplies their hours. */
  studentsByLecturer?: Record<string, number>;
  /** Academic groups, for the detail view. */
  groupNames: string[];
  /** True when the workload hangs off a combined item. */
  combined?: boolean;
}

/** One line of a lecturer's detailed breakdown. */
export interface StatItem {
  workloadId: string;
  courseName: string;
  courseType: string;
  semester: number;
  specialtyName: string;
  hourType: string;
  /** Hours this lecturer accrues from this workload (already multiplied for individual work). */
  hours: number;
  teachingFormat: string;
  groupNames: string[];
  students?: number;
  combined?: boolean;
}

export interface LecturerStats {
  lecturerId: string;
  name: string;
  totalHours: number;
  /** hourType → hours. */
  byHourType: Record<string, number>;
  /** hourType → hours, restricted to mandatory disciplines. */
  mandatoryByHourType: Record<string, number>;
  /** hourType → hours, restricted to elective disciplines. */
  electiveByHourType: Record<string, number>;
  /** The lecturer's own MIN_HOURS_PER_YEAR, or null when unset. */
  minHours: number | null;
  /** The lecturer's own MAX_HOURS_PER_YEAR, or null when unset. */
  maxHours: number | null;
  /** maxHours, or the global default when they set none. */
  effectiveMaxHours: number | null;
  /** True when effectiveMaxHours comes from the global default rather than their own constraint. */
  maxIsDefault: boolean;
  /**
   * Signed distance from the allowed band, in academic hours: negative when below the minimum,
   * positive when above the maximum, 0 when within. Exactly what the report is meant to show
   * ("-6" / "+6"), so the sign carries the meaning rather than a separate flag.
   */
  deviation: number;
  /**
   * Distinct disciplines counted the way `MAX_COURSES` counts them — i.e. only those with
   * LECTURE, PRACTICAL or LAB hours. Consultations and assessment work consume hours but are not
   * a discipline the lecturer "teaches" for constraint purposes, so counting them here would make
   * this figure disagree with the limit it is meant to be read against.
   */
  distinctCourses: number;
  /** Every workload this lecturer carries, for the drill-down. */
  items: StatItem[];
}

export interface StatsInput {
  workloads: StatWorkload[];
  lecturers: { id: string; name: string; constraints: Record<string, number> }[];
  defaultMaxHoursPerYear: number | null;
}

const emptyByType = (): Record<string, number> =>
  Object.fromEntries(STAT_HOUR_TYPES.map((t) => [t, 0]));

/**
 * Builds one row per lecturer, in the given order. A lecturer with no assignments still gets a row
 * — a zero-hour lecturer is precisely what a department head is looking for.
 */
export function computeStats(input: StatsInput): LecturerStats[] {
  const { defaultMaxHoursPerYear } = input;
  const byLecturer = new Map<string, LecturerStats>();
  const coursesSeen = new Map<string, Set<string>>();

  for (const l of input.lecturers) {
    const limit = (name: string): number | null => {
      const v = l.constraints[name];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const maxOwn = limit('MAX_HOURS_PER_YEAR');
    byLecturer.set(l.id, {
      lecturerId: l.id,
      name: l.name,
      totalHours: 0,
      byHourType: emptyByType(),
      mandatoryByHourType: emptyByType(),
      electiveByHourType: emptyByType(),
      minHours: limit('MIN_HOURS_PER_YEAR'),
      maxHours: maxOwn,
      effectiveMaxHours: maxOwn ?? defaultMaxHoursPerYear,
      maxIsDefault: maxOwn === null && defaultMaxHoursPerYear !== null,
      deviation: 0,
      distinctCourses: 0,
      items: []
    });
    coursesSeen.set(l.id, new Set());
  }

  for (const w of input.workloads) {
    for (const lecturerId of w.lecturerIds) {
      const s = byLecturer.get(lecturerId);
      if (!s) continue;   // assigned but not a lecturer of this department

      // Individual work is charged per student supervised; everything else at the item's full hours.
      const students = w.studentsByLecturer?.[lecturerId];
      const hours = w.teachingFormat === 'INDIVIDUALLY'
        ? w.hours * (students ?? 0)
        : w.hours;

      s.totalHours += hours;
      if (s.byHourType[w.hourType] !== undefined) s.byHourType[w.hourType] += hours;
      if (isMandatoryCourse(w.courseType) && s.mandatoryByHourType[w.hourType] !== undefined) {
        s.mandatoryByHourType[w.hourType] += hours;
      }
      if (isElectiveCourse(w.courseType) && s.electiveByHourType[w.hourType] !== undefined) {
        s.electiveByHourType[w.hourType] += hours;
      }
      // Only counted hour types contribute to the discipline count — see LecturerStats.distinctCourses.
      if ((SPLIT_HOUR_TYPES as readonly string[]).includes(w.hourType)) {
        coursesSeen.get(lecturerId)!.add(w.courseId);
      }

      s.items.push({
        workloadId: w.workloadId,
        courseName: w.courseName,
        courseType: w.courseType,
        semester: w.semester,
        specialtyName: w.specialtyName,
        hourType: w.hourType,
        hours,
        teachingFormat: w.teachingFormat,
        groupNames: w.groupNames,
        students,
        combined: w.combined
      });
    }
  }

  for (const s of byLecturer.values()) {
    s.distinctCourses = coursesSeen.get(s.lecturerId)!.size;
    s.deviation = deviationOf(s.totalHours, s.minHours, s.effectiveMaxHours);
    // Semester first, then discipline: how a workload sheet is read on paper.
    s.items.sort((a, b) => a.semester - b.semester
      || a.courseName.localeCompare(b.courseName, 'uk')
      || a.hourType.localeCompare(b.hourType));
  }

  return input.lecturers.map((l) => byLecturer.get(l.id)!);
}

/**
 * How far outside the allowed band a total sits. Below the minimum is negative, above the maximum
 * positive, inside (or unconstrained) is 0. A lecturer can't be both, so one number suffices.
 */
export function deviationOf(total: number, min: number | null, max: number | null): number {
  if (min !== null && total < min) return total - min;
  if (max !== null && total > max) return total - max;
  return 0;
}

/** Column totals for the department, so the summary table can carry a footer row. */
export function totalsOf(rows: LecturerStats[]) {
  const acc = {
    totalHours: 0,
    byHourType: emptyByType(),
    mandatoryByHourType: emptyByType(),
    electiveByHourType: emptyByType(),
    overloaded: 0,
    underloaded: 0
  };
  for (const r of rows) {
    acc.totalHours += r.totalHours;
    for (const t of STAT_HOUR_TYPES) {
      acc.byHourType[t] += r.byHourType[t] ?? 0;
      acc.mandatoryByHourType[t] += r.mandatoryByHourType[t] ?? 0;
      acc.electiveByHourType[t] += r.electiveByHourType[t] ?? 0;
    }
    if (r.deviation > 0) acc.overloaded++;
    else if (r.deviation < 0) acc.underloaded++;
  }
  return acc;
}
