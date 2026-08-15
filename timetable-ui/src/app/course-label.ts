/**
 * How a discipline is written on screen: its name, then its `course_tags` in parentheses.
 *
 * The tags exist because a name alone does not identify a course to the people reading these
 * screens — «Іноземна мова» taught in English and «Іноземна мова» taught in German are two rows in
 * `courses`, two entries in the plan, and two different lecturers' workloads, and without the tag
 * beside the name the two are indistinguishable in every list that shows one. So the label, not the
 * bare name, is what the UI renders wherever a course is named.
 *
 * A course may additionally be restricted to one semester (`courses.semester`), and that value is
 * written first inside the same parentheses — «Вибіркова дисципліна 5 (семестр 5, англійською)».
 * It is the same question as the tags answer, asked of a група вибіркових: which slot of the plan
 * is this, out of several with near-identical names.
 *
 * This module is pure — no Angular, no GraphQL, no I/O — for the same reason the other thirteen are
 * (see the README's *The pure modules*): it is one formatting rule, it is applied in about twenty
 * places, and three of those had already grown their own private copy of it before this file
 * existed.
 *
 * **The PDF sheets deliberately do not use it.** «Навчальний план», «Робочий навчальний план»,
 * «Розрахунок навчального навантаження» and «Розклад занять» are documents with column widths fixed
 * by their own layout rules, and several of them are read as approved paper; they keep printing the
 * bare `name`. That is why the modules feeding both a screen and a sheet — `curriculum-plan`,
 * `working-curriculum-plan`, `workload-stats`, `timetable-grid` — carry the label in a field *beside*
 * the raw name rather than replacing it. Changing that would silently rewrite the documents.
 */

/** One row of `course_tags` as the schema returns it. */
export interface CourseTagRef {
  tag: string;
  /** Present only where the caller selected it — a nested-list save needs it to update in place
   *  rather than insert a duplicate beside the row it is about to delete. */
  id?: string;
}

/** Tags arrive either as the raw relation (`tags { tag }`) or already flattened to strings. */
export type CourseTagInput = CourseTagRef | string | null | undefined;

/** The GraphQL selection to add wherever a course is fetched for display. */
export const COURSE_LABEL_SELECTION = 'semester tags { tag }';

/** Flattens either shape to plain strings, dropping empties. */
export function courseTagNames(tags?: readonly CourseTagInput[] | null): string[] {
  return (tags ?? [])
    .map((t) => (typeof t === 'string' ? t : t?.tag))
    .filter((t): t is string => !!t && t.trim().length > 0);
}

/**
 * `courses.semester`, as it is written inside the parentheses: `"семестр 5"`, or `''` when the
 * course is not restricted to one — which is every course until somebody says otherwise.
 *
 * Accepts a string because GraphQL numbers arrive through form fields and `Record<string, any>`
 * payloads as often as they arrive typed, and a `'5'` that silently rendered nothing would be a
 * bug nobody sees. Anything that is not a positive integer reads as "not set" rather than throwing:
 * this is a label, and a label is not the place to discover bad data.
 */
function semesterPart(semester?: number | string | null): string {
  if (semester === null || semester === undefined || semester === '') return '';
  const n = Number(semester);
  return Number.isFinite(n) && n > 0 ? `семестр ${n}` : '';
}

/**
 * `"Бази даних (англійською)"` — or just `"Бази даних"` when the course has no tags. The
 * parentheses are omitted entirely rather than left empty, which is why every caller goes through
 * here instead of interpolating them at the render site.
 *
 * A course restricted to one semester (`courses.semester`) names it **first**, before the tags:
 * `"Вибіркова дисципліна 5 (семестр 5, англійською)"`. It goes inside the same parentheses rather
 * than beside them because it answers the same question the tags answer — *which* «Вибіркова
 * дисципліна 5» is this, out of the several a degreeProgram may carry — and because a second bracketed
 * group after the first reads as a footnote rather than as part of the name.
 *
 * The argument is optional and separate from the tags, so a caller that has not selected
 * `courses.semester` renders exactly what it rendered before rather than a wrong label; the flip
 * side is that adding a course to a new screen means selecting the column as well as the tags. See
 * {@link COURSE_LABEL_SELECTION}.
 */
export function courseLabel(
  name: string | null | undefined,
  tags?: readonly CourseTagInput[] | null,
  semester?: number | string | null
): string {
  const base = name ?? '—';
  const parts = [semesterPart(semester), ...courseTagNames(tags)].filter(Boolean);
  return parts.length ? `${base} (${parts.join(', ')})` : base;
}
