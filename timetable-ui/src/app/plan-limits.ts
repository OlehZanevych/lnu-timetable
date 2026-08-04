/**
 * The numeric limits a curriculum is measured against — every one of them a row in
 * `global_properties`, editable on «Глобальні властивості», and none of them hard-coded in the code
 * that applies them.
 *
 * Framework-free, like the plan modules that consume it: `parsePlanLimits` takes the plain
 * name/value pairs the settings table returns and hands back a typed object, so the screens, the
 * printed sheets and a Node test all read one set of numbers.
 *
 * ── Why these are settings and not constants ────────────────────────────────────────────────────
 *
 * Some of these figures come from the Закон України «Про вищу освіту» (обсяг кредиту, обсяг
 * освітньої програми за ступенем, частка вибіркових компонентів), and some are the settled practice
 * of ЗВО (дисциплін і екзаменів у семестрі). Neither kind belongs in a source file: the statutory
 * ones change when the law is amended — ст. 62 ч. 1 п. 15 was rewritten by Закон № 3642-IX in 2024
 * — and the practice ones differ between institutions by design, since ст. 32 leaves the form of
 * the освітній процес to each ЗВО. A закладу that must apply a different figure should change a
 * setting, not the code.
 *
 * **A cleared limit is not a limit.** `null` means the administrator emptied the field, and every
 * check that rests on it is then dropped from the screen and from the printed «Відповідність»
 * table — a document must not carry a verdict against a rule nobody has put in force. Only
 * {@link PlanLimits.hoursPerEctsCredit} cannot be cleared: it is arithmetic (обсяг = кредити ·
 * годин), not a rule, and every total in both documents is built on it.
 */

/** Раw `global_properties` rows, as the settings query returns them. */
export interface GlobalPropertyValue {
  name: string;
  value: string;
}

export interface DegreeCreditRange {
  min: number | null;
  max: number | null;
}

export interface PlanLimits {
  /** Годин в одному кредиті ЄКТС. Never null — the totals are computed from it. */
  hoursPerEctsCredit: number;
  /** Кредитів ЄКТС на навчальний рік; null drops the year-load check. */
  creditsPerAcademicYear: number | null;
  /** Допустиме відхилення від річного обсягу, у кредитах. */
  creditsPerYearTolerance: number;
  /** Мінімальна частка вибіркових компонентів, у відсотках; null drops that check. */
  minElectiveSharePercent: number | null;
  /** Найбільше освітніх компонентів в одному семестрі; null drops that check. */
  maxCoursesPerSemester: number | null;
  /** Найбільше екзаменів в одному семестрі; null drops that check. */
  maxExamsPerSemester: number | null;
  /** Обсяг освітньої програми за освітнім ступенем; a missing entry drops the volume check. */
  creditsByDegree: Record<string, DegreeCreditRange>;
}

/** `specialties.degree` → the property-name suffix its credit range is stored under. */
export const DEGREE_PROPERTY_SUFFIX: Record<string, string> = {
  JUNIOR_BACHELOR: 'junior_bachelor',
  BACHELOR: 'bachelor',
  MASTER: 'master',
  PHD: 'phd'
  // DOCTOR_OF_SCIENCE has no освітня складова of a fixed volume, so it carries no range.
};

/**
 * What the checks fall back to when the settings table has not been read yet — the figures
 * `data.sql` seeds, so a screen rendered before the settings arrive shows the same numbers it will
 * a moment later rather than flickering between two sets.
 */
export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  hoursPerEctsCredit: 30,
  creditsPerAcademicYear: 60,
  creditsPerYearTolerance: 3,
  minElectiveSharePercent: 25,
  maxCoursesPerSemester: 8,
  maxExamsPerSemester: 5,
  creditsByDegree: {
    JUNIOR_BACHELOR: { min: 120, max: 120 },
    BACHELOR:        { min: 180, max: 240 },
    MASTER:          { min: 90,  max: 120 },
    PHD:             { min: 30,  max: 60 }
  }
};

/** Every `global_properties` name this module reads, for the settings page to group and label. */
export const PLAN_LIMIT_PROPERTIES = [
  'hours_per_ects_credit',
  'credits_per_academic_year',
  'credits_per_year_tolerance',
  'min_elective_share_percent',
  'max_courses_per_semester',
  'max_exams_per_semester',
  ...Object.values(DEGREE_PROPERTY_SUFFIX).flatMap((s) => [`min_credits_${s}`, `max_credits_${s}`])
] as const;

/**
 * A blank, absent or unparseable value reads as «не встановлено» rather than as zero: a limit of
 * nought would fail every plan, which is the opposite of what clearing a field means.
 */
const optionalNumber = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Folds the settings rows into typed limits, falling back per field rather than wholesale. */
export function parsePlanLimits(properties: GlobalPropertyValue[] | null | undefined): PlanLimits {
  if (!properties?.length) return DEFAULT_PLAN_LIMITS;

  const byName = new Map(properties.map((p) => [p.name, p.value]));
  const read = (name: string) => optionalNumber(byName.get(name));

  const creditsByDegree: Record<string, DegreeCreditRange> = {};
  for (const [degree, suffix] of Object.entries(DEGREE_PROPERTY_SUFFIX)) {
    const min = read(`min_credits_${suffix}`);
    const max = read(`max_credits_${suffix}`);
    // A degree with neither bound set simply has no range, and its volume check is dropped.
    if (min !== null || max !== null) creditsByDegree[degree] = { min, max };
  }

  const hoursPerCredit = read('hours_per_ects_credit');
  return {
    // The one figure with no "unset" state: clearing it would leave every total undefined.
    hoursPerEctsCredit: hoursPerCredit !== null && hoursPerCredit > 0
      ? hoursPerCredit
      : DEFAULT_PLAN_LIMITS.hoursPerEctsCredit,
    creditsPerAcademicYear: read('credits_per_academic_year'),
    creditsPerYearTolerance: read('credits_per_year_tolerance') ?? 0,
    minElectiveSharePercent: read('min_elective_share_percent'),
    maxCoursesPerSemester: read('max_courses_per_semester'),
    maxExamsPerSemester: read('max_exams_per_semester'),
    creditsByDegree
  };
}
