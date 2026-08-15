/**
 * The arithmetic of a degreeProgram's навчальний план: what the plan adds up to, how it splits between
 * the parts a Ukrainian plan is read in, and where it departs from what the law and the usual
 * practice of a ЗВО require.
 *
 * Framework-free, like `workload-stats.ts` and `workload-generator.ts` — it takes plain objects and
 * returns plain objects, so the screen, the PDF and a Node test all read the same numbers and
 * cannot disagree. `curriculum-report.ts` renders what this module computes and does no arithmetic
 * of its own beyond summing the rows it prints.
 *
 * ── What is law here and what is practice ───────────────────────────────────────────────────────
 *
 * There is **no state template** for a навчальний план. The one that existed — додатки до наказу
 * МО України № 161 від 02.06.1993 — втратив чинність (наказ МОН № 1310 від 13.11.2014), and since
 * then the form of the document is a matter of the institution's autonomy (ст. 32 Закону України
 * «Про вищу освіту»), exercised through its own положення про організацію освітнього процесу
 * (ст. 47 ч. 2). What *is* binding is the content:
 *
 *   • ст. 1 п. 14 — обсяг одного кредиту ЄКТС становить **30 годин**; навантаження навчального року
 *     за денною формою — **як правило, 60 кредитів**;
 *   • ст. 5     — обсяг освітньої програми: молодший бакалавр 120, бакалавр 180–240,
 *     магістр 90–120 (ОНП — 120), освітня складова доктора філософії 30–60 кредитів ЄКТС;
 *   • ст. 62 ч. 1 п. 15 (у редакції Закону № 3642-IX від 23.04.2024) — вибіркові **освітні
 *     компоненти** не менш як **25 %** обсягу освітньої програми (10 % для спеціальностей, що
 *     передбачають доступ до професій з додатковим регулюванням);
 *   • ст. 36 ч. 2 п. 8 — навчальний план **затверджує вчена рада** закладу.
 *
 * The rest — не більше 8 дисциплін у семестрі, 3–5 екзаменів у сесію — is settled practice
 * (it descends from наказ МОН № 47 від 26.01.2015, whose own force was limited to 2015/2016) and is
 * reported here as an advisory, never as a failure.
 */

import { PlanLimits, DEFAULT_PLAN_LIMITS } from './plan-limits';
import { compareUk } from './sort';

// ── Norms ───────────────────────────────────────────────────────────────────
//
// Every figure a plan is measured against now lives in `global_properties` and arrives as a
// {@link PlanLimits} — see `plan-limits.ts` for why none of them is a constant here any more.

/** Кількість годин, які студент проводить у контакті з викладачем, за видами. */
export const CONTACT_HOUR_TYPES = ['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT'] as const;

/** Аудиторні заняття у вузькому сенсі — саме вони мають власні колонки навчального плану. */
export const CLASS_HOUR_TYPES = ['LECTURE', 'PRACTICAL', 'LAB'] as const;

/** Every kind of hour a curriculum item can carry, in the order a plan lists them. */
export const PLAN_HOUR_TYPES =
  ['LECTURE', 'PRACTICAL', 'LAB', 'CONSULTATION', 'ASSESSMENT', 'INDEPENDENT_WORK'] as const;

export type PlanHourType = (typeof PLAN_HOUR_TYPES)[number];

// ── Input ───────────────────────────────────────────────────────────────────

export interface PlanCourse {
  id: string;
  name: string;
  /** Raw `courses.course_type` enum value. */
  courseType: string;
  /** Free-form labels shown after the name, e.g. «англійською». */
  tags?: string[];
  /**
   * `courses.semester` — the one semester this discipline may be planned for, or null/absent for
   * the great majority of courses, which may be planned for any. Carried here for the same reason
   * `tags` is: `working-curriculum-plan` names disciplines on screen as well as on paper, and the
   * label needs it. Nothing in the plan *arithmetic* reads it — the semester a position is actually
   * in is `PlanItemInput.semester`, which is what every total is grouped by.
   */
  semester?: number | null;
}

/** One `curriculum_items` row with its `curriculum_item_hours` already folded into a map. */
export interface PlanItemInput {
  id: string;
  semester: number;
  /** Raw `curriculum_items.control_form` enum value. */
  controlForm: string;
  ectsCredits: number;
  course: PlanCourse | null;
  hours: Partial<Record<PlanHourType, number>>;
}

// ── Sections ────────────────────────────────────────────────────────────────

export type PlanSectionKey =
  'MANDATORY' | 'ELECTIVE' | 'COURSE_WORK' | 'INTERNSHIP' | 'ATTESTATION' | 'OPTIONAL';

/**
 * The parts a Ukrainian навчальний план is divided into, in the order they are printed, with the
 * prefix each part numbers its components by (ОК 1, ВК 1, …) — the code a curriculum item is
 * referred to by everywhere else in the освітня програма.
 */
export const PLAN_SECTIONS: readonly {
  key: PlanSectionKey; title: string; code: string; countsTowardsProgramme: boolean;
}[] = [
  { key: 'MANDATORY',   title: 'Обов’язкові компоненти освітньої програми', code: 'ОК', countsTowardsProgramme: true },
  { key: 'ELECTIVE',    title: 'Вибіркові компоненти освітньої програми',   code: 'ВК', countsTowardsProgramme: true },
  { key: 'COURSE_WORK', title: 'Курсові роботи (проєкти)',                  code: 'КР', countsTowardsProgramme: true },
  { key: 'INTERNSHIP',  title: 'Практична підготовка',                      code: 'ПП', countsTowardsProgramme: true },
  { key: 'ATTESTATION', title: 'Атестація',                                 code: 'А',  countsTowardsProgramme: true },
  // Факультативи are outside the освітня програма by definition: they carry no credits towards it,
  // so counting them would inflate the denominator the 25 % вибірковості is measured against.
  { key: 'OPTIONAL',    title: 'Факультативні дисципліни (поза обсягом освітньої програми)', code: 'Ф', countsTowardsProgramme: false }
];

/** `courses.course_type` → the part of the plan an item belongs in. */
const SECTION_OF_COURSE_TYPE: Record<string, PlanSectionKey> = {
  MANDATORY:          'MANDATORY',
  ELECTIVE_GROUP:     'ELECTIVE',
  ELECTIVE:           'ELECTIVE',
  COURSE_WORK:        'COURSE_WORK',
  COURSE_PROJECT:     'COURSE_WORK',
  INTERNSHIP:         'INTERNSHIP',
  QUALIFICATION_WORK: 'ATTESTATION',
  OPTIONAL:           'OPTIONAL'
};

/** An item whose course is missing or of an unknown type is read as обов'язкова, never dropped. */
export const sectionOf = (courseType: string | undefined): PlanSectionKey =>
  SECTION_OF_COURSE_TYPE[courseType ?? ''] ?? 'MANDATORY';

// ── Output ──────────────────────────────────────────────────────────────────

export interface PlanRow {
  id: string;
  /** «ОК 12» — position within its section, which is how the освітня програма refers to it. */
  code: string;
  /**
   * The `courses.name`, bare. There is no tagged counterpart here on purpose: nothing renders a
   * `PlanRow`'s discipline name — «Навчальні плани» builds its table from the raw curriculum items
   * (and labels them itself), and the summary above it shows totals — so the only consumer of this
   * field is the printed «Навчальний план», which prints names bare. See `course-label.ts`.
   */
  name: string;
  courseType: string;
  semester: number;
  /** Raw control form; the sheet turns it into a semester number in the right column. */
  controlForm: string;
  credits: number;
  /** Hours as stored, by kind. */
  hours: Record<PlanHourType, number>;
  /** Лекції + практичні + лабораторні. */
  classHours: number;
  /** Консультації + контрольні заходи. */
  otherContactHours: number;
  /** Усі контактні години. */
  contactHours: number;
  /** Самостійна робота — as stored, or derived (see {@link PlanRow.independentDerived}). */
  independentHours: number;
  /**
   * True when самостійна робота was not stored and had to be computed as the difference between
   * the normative volume (кредити · 30) and the contact hours — the way гр. 14 of a paper plan is
   * filled in. Reported in the document's примітки rather than silently passed off as stored data.
   */
  independentDerived: boolean;
  /** Загальний обсяг: кредити · 30, widened if the stored hours already exceed it. */
  totalHours: number;
  /** Кредити · 30 minus what the hours actually add up to; non-zero means the row does not close. */
  hoursImbalance: number;
}

export interface PlanTotals {
  items: number;
  credits: number;
  hours: number;
  byHourType: Record<PlanHourType, number>;
  classHours: number;
  contactHours: number;
  independentHours: number;
  exams: number;
  credited: number;
}

export interface PlanSection {
  key: PlanSectionKey;
  title: string;
  code: string;
  countsTowardsProgramme: boolean;
  rows: PlanRow[];
  totals: PlanTotals;
}

export interface PlanSemester {
  semester: number;
  /** Math.ceil(semester / 2) — the course year the semester falls in. */
  courseYear: number;
  /** 1 for the first half-year of that course year, 2 for the second. */
  halfYear: 1 | 2;
  totals: PlanTotals;
  courseWorks: number;
}

export type ComplianceStatus = 'ok' | 'warning' | 'violation' | 'unknown';

/** Stable identifiers, so a template can pick one check out without matching its title text. */
export type ComplianceCheckKey =
  'PROGRAMME_VOLUME' | 'ELECTIVE_SHARE' | 'HOURS_PER_CREDIT' | 'YEAR_LOAD'
  | 'COURSES_PER_SEMESTER' | 'EXAMS_PER_SEMESTER'
  | 'DEPARTMENT_COVERAGE' | 'POSITION_GROUPS' | 'INDIVIDUAL_CONTINGENT';

export interface ComplianceCheck {
  key: ComplianceCheckKey;
  /** What is being checked, in the words the plan uses. */
  title: string;
  /**
   * The норма itself, as a bare figure — «180–240 кредитів ЄКТС», «не менш як 25 %». It carries no
   * citation, because the figure now comes from `global_properties` and an administrator may have
   * changed it: quoting an article beside a value the institution set would misattribute it.
   */
  norm: string;
  /**
   * Where the норма comes from — a statute article, or «усталена практика ЗВО». **Printed only**,
   * beside the норма in the «Відповідність» table of a signed sheet; the screens show `norm` alone.
   */
  source: string;
  value: string;
  status: ComplianceStatus;
  verdict: string;
  /** True when the requirement is binding law rather than settled practice. */
  statutory: boolean;
}

export interface CurriculumPlan {
  sections: PlanSection[];
  /** Everything inside the освітня програма — факультативи excluded. */
  programme: PlanTotals;
  mandatory: PlanTotals;
  elective: PlanTotals;
  /** Every semester that carries at least one item, in teaching order. */
  semesters: PlanSemester[];
  /** Highest semester in the plan; 0 when it is empty. */
  lastSemester: number;
  /** Semesters spanned, as a count of academic years — Math.ceil(lastSemester / 2). */
  years: number;
  /** Частка вибіркових компонентів обсягу освітньої програми, 0–1; null when the plan is empty. */
  electiveShare: number | null;
  checks: ComplianceCheck[];
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Integers plain, fractions with the decimal comma Ukrainian documents are set in. */
export const fmtNumber = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');

/** A number that is meaningfully absent prints as a dash, not as a nought. */
export const fmtOrDash = (v: number): string => (v ? fmtNumber(v) : '—');

/** «25,0 %» — the decimal comma again, and a non-breaking space before the sign. */
export const fmtShare = (share: number): string => `${(share * 100).toFixed(1).replace('.', ',')} %`;

// ── Building it ─────────────────────────────────────────────────────────────

const emptyHourMap = (): Record<PlanHourType, number> =>
  Object.fromEntries(PLAN_HOUR_TYPES.map((t) => [t, 0])) as Record<PlanHourType, number>;

const emptyTotals = (): PlanTotals => ({
  items: 0, credits: 0, hours: 0, byHourType: emptyHourMap(),
  classHours: 0, contactHours: 0, independentHours: 0, exams: 0, credited: 0
});

const accumulate = (totals: PlanTotals, row: PlanRow): void => {
  totals.items += 1;
  totals.credits += row.credits;
  totals.hours += row.totalHours;
  for (const t of CONTACT_HOUR_TYPES) totals.byHourType[t] += row.hours[t];
  // Самостійна робота comes from the row, not from `hours`: a derived value has to be counted the
  // same way the row's own total counts it, or the columns stop adding up to «Усього годин».
  totals.byHourType.INDEPENDENT_WORK += row.independentHours;
  totals.classHours += row.classHours;
  totals.contactHours += row.contactHours;
  totals.independentHours += row.independentHours;
  if (row.controlForm === 'EXAM') totals.exams += 1;
  else if (row.controlForm === 'CREDIT' || row.controlForm === 'GRADED_CREDIT') totals.credited += 1;
};

const buildRow = (item: PlanItemInput, code: string, hoursPerCredit: number): PlanRow => {
  const hours = emptyHourMap();
  for (const t of PLAN_HOUR_TYPES) hours[t] = Math.max(0, Number(item.hours?.[t] ?? 0) || 0);

  const classHours = CLASS_HOUR_TYPES.reduce((sum, t) => sum + hours[t], 0);
  const contactHours = CONTACT_HOUR_TYPES.reduce((sum, t) => sum + hours[t], 0);
  const credits = Math.max(0, Number(item.ectsCredits ?? 0) || 0);
  const normativeHours = credits * hoursPerCredit;

  // Самостійна робота is what is left of the credit once the contact hours are taken out — the
  // arithmetic a paper plan does in its own гр. 14. Only derived when nothing is stored: an
  // explicit zero entered by hand is a statement, and overriding it would hide a data error.
  const independentDerived = hours.INDEPENDENT_WORK === 0 && normativeHours > contactHours;
  const independentHours = independentDerived ? normativeHours - contactHours : hours.INDEPENDENT_WORK;
  const totalHours = Math.max(normativeHours, contactHours + independentHours);

  return {
    id: item.id,
    code,
    name: item.course?.name ?? '—',
    courseType: item.course?.courseType ?? '',
    semester: item.semester,
    controlForm: item.controlForm,
    credits,
    hours,
    classHours,
    otherContactHours: contactHours - classHours,
    contactHours,
    independentHours,
    independentDerived,
    totalHours,
    hoursImbalance: normativeHours - (contactHours + independentHours)
  };
};

/**
 * Folds a degreeProgram's curriculum items into the plan a document can be printed from.
 *
 * Rows are ordered the way a plan is read: by semester, then by name in the Ukrainian alphabet
 * (`compareUk`, never a raw `localeCompare` — see `sort.ts`), and numbered within their section, so
 * a component keeps the same code no matter which other sections happen to be empty.
 */
export function buildCurriculumPlan(items: PlanItemInput[], degree: string,
                                    limits: PlanLimits = DEFAULT_PLAN_LIMITS): CurriculumPlan {
  const byKey = new Map<PlanSectionKey, PlanItemInput[]>();
  for (const item of items) {
    const key = sectionOf(item.course?.courseType);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }

  const sections: PlanSection[] = PLAN_SECTIONS.map((meta) => {
    const ordered = (byKey.get(meta.key) ?? []).slice().sort((a, b) =>
      a.semester - b.semester || compareUk(a.course?.name ?? '', b.course?.name ?? ''));
    const rows = ordered.map((item, i) =>
      buildRow(item, `${meta.code} ${i + 1}`, limits.hoursPerEctsCredit));
    const totals = emptyTotals();
    for (const row of rows) accumulate(totals, row);
    return { ...meta, rows, totals };
  });

  const sectionOfKey = (key: PlanSectionKey) => sections.find((s) => s.key === key)!;
  const programme = emptyTotals();
  for (const section of sections) {
    if (!section.countsTowardsProgramme) continue;
    for (const row of section.rows) accumulate(programme, row);
  }

  const allRows = sections.flatMap((s) => (s.countsTowardsProgramme ? s.rows : []));
  const semesters: PlanSemester[] = [];
  for (const semester of [...new Set(allRows.map((r) => r.semester))].sort((a, b) => a - b)) {
    const totals = emptyTotals();
    let courseWorks = 0;
    for (const row of allRows) {
      if (row.semester !== semester) continue;
      accumulate(totals, row);
      if (sectionOf(row.courseType) === 'COURSE_WORK') courseWorks += 1;
    }
    semesters.push({
      semester,
      courseYear: Math.ceil(semester / 2),
      halfYear: semester % 2 === 1 ? 1 : 2,
      totals,
      courseWorks
    });
  }

  const lastSemester = semesters.length ? semesters[semesters.length - 1].semester : 0;
  const years = Math.ceil(lastSemester / 2);
  const mandatory = sectionOfKey('MANDATORY').totals;
  const elective = sectionOfKey('ELECTIVE').totals;
  const electiveShare = programme.credits > 0 ? elective.credits / programme.credits : null;

  return {
    sections, programme, mandatory, elective, semesters, lastSemester, years, electiveShare,
    checks: buildChecks({ sections, programme, elective, semesters, years, electiveShare, degree, limits })
  };
}

/** «180–240 кредитів ЄКТС» · «120 кредитів ЄКТС» · «не менше 30 кредитів ЄКТС» — a bare figure. */
function rangeLabel(range: { min: number | null; max: number | null }): string {
  const { min, max } = range;
  if (min !== null && max !== null) {
    return min === max ? `${fmtNumber(min)} кредитів ЄКТС` : `${fmtNumber(min)}–${fmtNumber(max)} кредитів ЄКТС`;
  }
  if (min !== null) return `не менше ${fmtNumber(min)} кредитів ЄКТС`;
  return `не більше ${fmtNumber(max!)} кредитів ЄКТС`;
}

function buildChecks(input: {
  sections: PlanSection[];
  programme: PlanTotals;
  elective: PlanTotals;
  semesters: PlanSemester[];
  years: number;
  electiveShare: number | null;
  degree: string;
  limits: PlanLimits;
}): ComplianceCheck[] {
  const { programme, semesters, years, electiveShare, limits } = input;
  const checks: ComplianceCheck[] = [];

  // Every check below is emitted only when the limit behind it is set. A limit an administrator
  // cleared is not a limit, and a sheet must not carry a verdict against a rule nobody put in force.

  // 1. Обсяг освітньої програми, за освітнім ступенем.
  const range = limits.creditsByDegree[input.degree];
  if (range && (range.min !== null || range.max !== null)) {
    const below = range.min !== null && programme.credits < range.min;
    const above = range.max !== null && programme.credits > range.max;
    checks.push({
      key: 'PROGRAMME_VOLUME',
    title: 'Обсяг освітньої програми, кредитів ЄКТС',
      norm: rangeLabel(range),
      source: 'ст. 5 Закону України «Про вищу освіту»',
      value: fmtNumber(programme.credits),
      statutory: true,
      ...(programme.credits === 0
        ? { status: 'unknown' as const, verdict: 'план порожній' }
        : below
          ? { status: 'violation' as const,
              verdict: `бракує ${fmtNumber(range.min! - programme.credits)} кредитів ЄКТС` }
          : above
            ? { status: 'violation' as const,
                verdict: `перевищення на ${fmtNumber(programme.credits - range.max!)} кредитів ЄКТС` }
            : { status: 'ok' as const, verdict: 'у межах допустимого обсягу' })
    });
  }

  // 2. Частка вибіркових компонентів.
  if (limits.minElectiveSharePercent !== null) {
    const minShare = limits.minElectiveSharePercent / 100;
    const needed = Math.ceil(minShare * programme.credits);
    checks.push({
      key: 'ELECTIVE_SHARE',
      title: 'Частка вибіркових освітніх компонентів',
      norm: `не менш як ${fmtNumber(limits.minElectiveSharePercent)} %`,
      source: 'ст. 62 ч. 1 п. 15 Закону України «Про вищу освіту»',
      value: electiveShare === null ? '—' : fmtShare(electiveShare),
      statutory: true,
      ...(electiveShare === null
        ? { status: 'unknown' as const, verdict: 'план порожній' }
        : electiveShare + 1e-9 >= minShare
          ? { status: 'ok' as const,
              verdict: `мінімум виконано (${fmtNumber(input.elective.credits)} з ${fmtNumber(needed)} потрібних кредитів)` }
          : { status: 'violation' as const,
              verdict: `бракує ${fmtNumber(needed - input.elective.credits)} кредитів вибіркових компонентів` })
    });
  }

  // 3. Обсяг кредиту в годинах, позиція за позицією: the plan closes only if every row does.
  //    Never dropped — this figure has no "unset" state, since the totals are computed from it.
  const programmeRows = input.sections.flatMap((s) => (s.countsTowardsProgramme ? s.rows : []));
  const unbalanced = programmeRows.filter((r) => r.hoursImbalance !== 0);
  const perCredit = fmtNumber(limits.hoursPerEctsCredit);
  checks.push({
    key: 'HOURS_PER_CREDIT',
    title: 'Обсяг годин на один кредит ЄКТС',
    norm: `${perCredit} годин`,
    source: 'ст. 1 п. 14 Закону України «Про вищу освіту»',
    value: !programmeRows.length ? '—'
      : unbalanced.length ? `${unbalanced.length} позиц. з розбіжністю`
      : 'узгоджено в усіх позиціях',
    statutory: true,
    status: !programmeRows.length ? 'unknown' : unbalanced.length ? 'warning' : 'ok',
    verdict: !programmeRows.length
      ? 'план порожній'
      : unbalanced.length
        ? `сума годин не збігається з кредитами · ${perCredit}: ` +
          unbalanced.slice(0, 4).map((r) => r.code).join(', ') +
          (unbalanced.length > 4 ? ` та ще ${unbalanced.length - 4}` : '')
        : `кожна позиція закривається кредитами · ${perCredit}`
  });

  // 4. Річне навантаження — an orientation figure, so a departure from it is «до уваги».
  if (limits.creditsPerAcademicYear !== null) {
    const target = limits.creditsPerAcademicYear;
    const tolerance = Math.max(0, limits.creditsPerYearTolerance);
    const perYear = years > 0 ? programme.credits / years : 0;
    const gap = Math.abs(perYear - target);
    checks.push({
      key: 'YEAR_LOAD',
      title: 'Навантаження навчального року, кредитів ЄКТС',
      norm: `як правило, ${fmtNumber(target)}`,
      source: 'ст. 1 п. 14 Закону України «Про вищу освіту»',
      value: years > 0 ? fmtNumber(Math.round(perYear * 10) / 10) : '—',
      statutory: true,
      status: years === 0 ? 'unknown' : gap <= tolerance ? 'ok' : 'warning',
      verdict: years === 0
        ? 'план порожній'
        : gap <= tolerance
          ? `близько до орієнтиру в ${fmtNumber(target)} кредитів ЄКТС`
          : `${perYear < target ? 'менше' : 'більше'} за орієнтир у ${fmtNumber(target)} ` +
            `кредитів ЄКТС на ${fmtNumber(Math.round(gap * 10) / 10)}`
    });
  }

  // 5–6. Practice, not law: reported so a plan can be tuned, never as a failure.
  if (limits.maxCoursesPerSemester !== null) {
    const cap = limits.maxCoursesPerSemester;
    const busiest = semesters.reduce<PlanSemester | null>(
      (worst, s) => (!worst || s.totals.items > worst.totals.items ? s : worst), null);
    checks.push({
      key: 'COURSES_PER_SEMESTER',
      title: 'Найбільше освітніх компонентів у семестрі',
      norm: `не більше ${fmtNumber(cap)}`,
      source: 'усталена практика ЗВО',
      value: busiest ? `${busiest.totals.items} (семестр ${busiest.semester})` : '—',
      statutory: false,
      status: !busiest ? 'unknown' : busiest.totals.items <= cap ? 'ok' : 'warning',
      verdict: !busiest ? 'план порожній'
        : busiest.totals.items <= cap ? 'у межах установленої межі' : 'понад установлену межу'
    });
  }

  if (limits.maxExamsPerSemester !== null) {
    const cap = limits.maxExamsPerSemester;
    const mostExams = semesters.reduce<PlanSemester | null>(
      (worst, s) => (!worst || s.totals.exams > worst.totals.exams ? s : worst), null);
    checks.push({
      key: 'EXAMS_PER_SEMESTER',
      title: 'Найбільше екзаменів у семестрі',
      norm: `не більше ${fmtNumber(cap)}`,
      source: 'усталена практика ЗВО',
      value: mostExams ? `${mostExams.totals.exams} (семестр ${mostExams.semester})` : '—',
      statutory: false,
      status: !mostExams ? 'unknown' : mostExams.totals.exams <= cap ? 'ok' : 'warning',
      verdict: !mostExams ? 'план порожній'
        : mostExams.totals.exams <= cap ? 'у межах установленої межі' : 'понад установлену межу'
    });
  }

  return checks;
}
