/**
 * The printable «НАВЧАЛЬНИЙ ПЛАН» of a specialty — the sheet a вчена рада approves and a
 * навчальний відділ files, built from exactly the rows the «Навчальні плани» tab shows.
 *
 * Framework-free, like `workload-report.ts`: it takes the plan `curriculum-plan.ts` computed plus a
 * pair of fonts and returns PDF bytes, so it renders under Node in a test as easily as in the
 * browser. It does no arithmetic of its own beyond summing what it prints, so the document and the
 * screen cannot disagree.
 *
 * ── Why the document looks the way it does ─────────────────────────────────────────────────────
 *
 * **There is no state template for a навчальний план, and has not been since 2014.** The single
 * national form lived in the appendices to «Положення про організацію навчального процесу у вищих
 * навчальних закладах» (наказ МО України № 161 від 02.06.1993), which **втратив чинність** —
 * наказ МОН № 1310 від 13.11.2014, зареєстрований в Мін'юсті 21.11.2014 за № 1485/26262. Since
 * then the layout is a matter of institutional autonomy (ст. 32 Закону України «Про вищу освіту»),
 * exercised through the institution's own положення про організацію освітнього процесу
 * (ст. 47 ч. 2). **Do not cite наказ № 161** — nothing here does.
 *
 * What the law does fix is the *content*, and every one of these is either printed or checked:
 *
 *   • ст. 1 п. 14 — 1 кредит ЄКТС = 30 годин; рік за денною формою — як правило, 60 кредитів;
 *   • ст. 5      — обсяг ОП: 120 / 180–240 / 90–120 / 30–60 кредитів за ступенем;
 *   • ст. 62 ч. 1 п. 15 (ред. Закону № 3642-IX від 23.04.2024) — вибіркові **освітні компоненти**
 *     не менш як 25 % обсягу освітньої програми;
 *   • ст. 36 ч. 2 п. 8 — план **затверджує вчена рада**, and that is why the sheet carries
 *     «ЗАТВЕРДЖЕНО / Вченою радою … протокол № __» (реквізит «гриф затвердження» for a collegial
 *     body) rather than a bare «ЗАТВЕРДЖУЮ» over one signature, with «ВВЕДЕНО В ДІЮ наказом
 *     ректора» beside it as ЗВО actually do it.
 *
 * The *shape* — розділи «Обов'язкові / Вибіркові компоненти ОП», «Практична підготовка»,
 * «Атестація»; the column set of «План освітнього процесу»; the зведені дані за семестрами; the
 * chain of signatures ending at гарант освітньої програми — is the common denominator of the
 * current положення of ЗНУ, ОНТУ, ХНЕУ ім. Кузнеця, НУ «Чернігівська політехніка» and КрНУ, and of
 * the plans ЛНУ ім. І. Франка publishes per programme. That practice, not a repealed order, is what
 * is reproduced.
 *
 * Typography follows ДСТУ 4163:2020 — Times-metric serif (Liberation Serif), береги 30/10/20/20 мм,
 * page number in the middle of the top margin from the second sheet, signatures as «Власне ім'я
 * ПРІЗВИЩЕ» (ініціали стандартом більше не передбачені). The sheet is landscape А4 because
 * «План освітнього процесу» carries fifteen columns under a three-level header; the standard does
 * not forbid it, and every published plan is laid out that way.
 */

import { DEGREE_OPTIONS, STUDY_FORM_OPTIONS } from './entities';
import {
  ComplianceCheck, CurriculumPlan, PLAN_HOUR_TYPES, PlanHourType, PlanSection, PlanSemester,
  PlanTotals, fmtNumber, fmtOrDash, fmtShare
} from './curriculum-plan';
import { PdfDocument, PdfTableRow, RGB, TtfFont } from './pdf-writer';
import { SYSTEM_NAME, UNIVERSITY_NAME, academicYearLabel } from './workload-report';

const MINISTRY_NAME = 'МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ';

const A4_LANDSCAPE = { widthMm: 297, heightMm: 210 };
/** ДСТУ 4163:2020, п. 5: ліве 30 мм, праве 10 мм, верхнє та нижнє по 20 мм. */
const MARGINS = { top: 20, right: 10, bottom: 20, left: 30 };

const HEADER_FILL: RGB = [0.93, 0.94, 0.96];
const SUBTOTAL_FILL: RGB = [0.965, 0.97, 0.98];
const TOTAL_FILL: RGB = [0.9, 0.92, 0.95];
const MUTED: RGB = [0.42, 0.45, 0.5];

/** Рівень Національної рамки кваліфікацій (ПКМУ № 1341 у ред. ПКМУ № 519 від 25.06.2020). */
const NQF_LEVEL: Record<string, string> = {
  JUNIOR_BACHELOR: '5', BACHELOR: '6', MASTER: '7', PHD: '8', DOCTOR_OF_SCIENCE: '9'
};

/** How ст. 5 names each рівень вищої освіти, for the реквізити block. */
const EDUCATION_LEVEL: Record<string, string> = {
  JUNIOR_BACHELOR:   'початковий рівень (короткий цикл) вищої освіти',
  BACHELOR:          'перший (бакалаврський) рівень вищої освіти',
  MASTER:            'другий (магістерський) рівень вищої освіти',
  PHD:               'третій (освітньо-науковий) рівень вищої освіти',
  DOCTOR_OF_SCIENCE: 'науковий рівень вищої освіти'
};

const HOUR_TYPE_LABELS: Record<PlanHourType, string> = {
  LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
  CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи',
  INDEPENDENT_WORK: 'Самостійна робота'
};

export const degreeLabel = (v: string): string =>
  DEGREE_OPTIONS.find((o) => o.value === v)?.label ?? v ?? '—';

const studyFormLabel = (v: string): string =>
  STUDY_FORM_OPTIONS.find((o) => o.value === v)?.label ?? v;

export interface CurriculumReportInput {
  /** The plan as computed by `buildCurriculumPlan` — the same object the tab renders its summary from. */
  plan: CurriculumPlan;
  specialtyCode: string;
  specialtyName: string;
  /** Raw `specialties.degree` enum value. */
  degree: string;
  facultyName: string;
  /**
   * Raw `academic_groups.study_form` values found among the specialty's groups. One value names the
   * form of study; several are listed; none leaves the row for a hand to fill in, since the model
   * records the form per group rather than per specialty.
   */
  studyForms: string[];
  /** Passed in rather than read, so the same input always yields the same bytes. */
  generatedAt: Date;
  fonts: { regular: TtfFont; bold: TtfFont };
}

/** «Навчальний_план_126_бакалавр_2026-2027.pdf» — code first, so a folder of these sorts usefully. */
export function curriculumReportFileName(code: string, degree: string, academicYear: string): string {
  const safe = (text: string) => text.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-|-$/g, '');
  const parts = [safe(code) || 'спеціальність', safe(degreeLabel(degree).toLowerCase()),
                 academicYear.replace('/', '-')];
  return `Навчальний_план_${parts.join('_')}.pdf`;
}

const fmtDate = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

/** «4 роки» / «1 рік 6 місяців» — a semester is half a year, so an odd count carries six months. */
const durationLabel = (lastSemester: number): string => {
  if (!lastSemester) return '—';
  const years = Math.floor(lastSemester / 2);
  const halves = lastSemester % 2;
  const yearWord = years % 10 === 1 && years % 100 !== 11 ? 'рік'
                 : years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 12 || years % 100 > 14) ? 'роки'
                 : 'років';
  const parts: string[] = [];
  if (years) parts.push(`${years} ${yearWord}`);
  if (halves) parts.push('6 місяців');
  return `${parts.join(' ')} (${lastSemester} семестрів)`;
};

export function buildCurriculumReport(input: CurriculumReportInput): Uint8Array {
  const { plan, fonts } = input;
  const academicYear = academicYearLabel(input.generatedAt);

  const doc = new PdfDocument({
    ...A4_LANDSCAPE,
    margins: MARGINS,
    fonts: { regular: fonts.regular, bold: fonts.bold },
    defaultFont: 'regular',
    defaultSize: 11,
    title: `Навчальний план — ${input.specialtyCode} ${input.specialtyName} — ${academicYear}`,
    author: UNIVERSITY_NAME,
    subject: `${degreeLabel(input.degree)}, ${input.facultyName}`,
    createdAt: input.generatedAt
  });

  // Гриф and letterhead share the top of the sheet — the гриф in the right corner (ДСТУ 4163:2020),
  // the letterhead centred on what is left of the width beside it.
  const grifBottom = drawApprovalGrif(doc, academicYear);
  doc.y = doc.margins.top;
  const letterheadBottom = drawLetterhead(doc, input);
  doc.y = Math.max(grifBottom, letterheadBottom);

  drawTitle(doc);
  drawIdentity(doc, input, academicYear);
  drawLegalBasis(doc);

  // The plan itself always starts on its own sheet, as it does on paper: a reader finds the tables
  // in the same place regardless of how long the реквізити block came out.
  doc.addPage();

  drawProgrammeSummary(doc, plan);
  drawSemesterSummary(doc, plan);
  drawPlanTable(doc, plan);
  drawHourTypeBreakdown(doc, plan);
  drawCompliance(doc, plan);
  drawNotes(doc, plan);
  drawSignatures(doc);
  drawPageFurniture(doc, input, academicYear);

  return doc.render();
}

// ── Sheet 1 ─────────────────────────────────────────────────────────────────

/**
 * ДСТУ 4163:2020 puts the гриф затвердження in the top right corner of the first sheet. A навчальний
 * план is approved by a **collegial body** — ст. 36 ч. 2 п. 8 gives that to the вчена рада — so the
 * form is «ЗАТВЕРДЖЕНО» plus the act, not «ЗАТВЕРДЖУЮ» over one post; the order that puts it into
 * effect is named beside it, which is how ЗВО actually issue a plan.
 */
function drawApprovalGrif(doc: PdfDocument, academicYear: string): number {
  const boxWidth = 104;
  const x = doc.margins.left + doc.contentWidth - boxWidth;
  const size = 10;
  const pitch = doc.lineHeight(size, 1.2);
  const lines: { text: string; bold?: boolean }[] = [
    { text: 'ЗАТВЕРДЖЕНО', bold: true },
    { text: 'Вченою радою Львівського національного' },
    { text: 'університету імені Івана Франка' },
    { text: 'протокол № _____ від «___» __________ 20___ р.' },
    { text: '' },
    { text: 'ВВЕДЕНО В ДІЮ', bold: true },
    { text: 'наказом ректора від «___» __________ 20___ р. № ____' },
    { text: '' },
    { text: `Введено в дію з ${academicYear} навчального року` }
  ];
  lines.forEach((line, i) => {
    doc.drawText(line.text, {
      x, y: doc.y + pitch * i + 3.2, size, font: line.bold ? 'bold' : 'regular', width: boxWidth
    });
  });
  return doc.y + pitch * lines.length + 4;
}

/** Returns the y the letterhead ends at, so the caller can clear both it and the гриф beside it. */
function drawLetterhead(doc: PdfDocument, input: CurriculumReportInput): number {
  const left = doc.margins.left;
  // The гриф occupies the right third of the sheet, so the letterhead is centred on what is left.
  const width = doc.contentWidth - 112;
  const centred = (text: string, size: number, font: 'regular' | 'bold') => {
    if (!text.trim()) return;   // an unnamed faculty leaves no gap, rather than a blank line
    doc.y += doc.drawParagraph(text, { x: left, y: doc.y, width, size, font, align: 'center' });
  };
  centred(MINISTRY_NAME, 10.5, 'regular');
  centred(UNIVERSITY_NAME.toUpperCase(), 11.5, 'bold');
  doc.space(2);
  centred(input.facultyName, 10.5, 'regular');
  return doc.y;
}

function drawTitle(doc: PdfDocument): void {
  doc.space(8);
  const left = doc.margins.left;
  const width = doc.contentWidth;
  doc.y += doc.drawParagraph('НАВЧАЛЬНИЙ ПЛАН',
                             { x: left, y: doc.y, width, size: 16, font: 'bold', align: 'center' });
  doc.y += doc.drawParagraph('підготовки здобувачів вищої освіти',
                             { x: left, y: doc.y, width, size: 12, align: 'center' });
  doc.space(6);
}

function drawIdentity(doc: PdfDocument, input: CurriculumReportInput, academicYear: string): void {
  const plan = input.plan;
  const label = (text: string) => ({ text, font: 'regular' });
  const value = (text: string) => ({ text: text || '—', font: 'bold' as const });

  const studyForm = input.studyForms.length
    ? [...new Set(input.studyForms)].map(studyFormLabel).join(', ')
    : '';

  doc.drawTable({
    x: doc.margins.left + 16,
    columns: [{ width: 56 }, { width: 108 }, { width: 42 }, { width: 19 }],
    showHeader: false,
    size: 10,
    padY: 1.6,
    keepTogether: true,
    rows: [
      { cells: [label('Галузь знань'), value(fieldOfStudyLabel(input.specialtyCode)),
                label('Рівень НРК'), value(NQF_LEVEL[input.degree] ?? '')] },
      { cells: [label('Спеціальність'), value(`${input.specialtyCode} ${input.specialtyName}`.trim()),
                label('Семестрів'), value(plan.lastSemester ? String(plan.lastSemester) : '')] },
      { cells: [label('Освітній ступінь'), value(degreeLabel(input.degree)),
                label('Курсів'), value(plan.years ? String(plan.years) : '')] },
      { cells: [label('Рівень вищої освіти'), value(EDUCATION_LEVEL[input.degree] ?? ''),
                label('Кредитів ЄКТС'), value(fmtNumber(plan.programme.credits))] },
      { cells: [label('Факультет'), value(input.facultyName),
                label('Годин'), value(fmtNumber(plan.programme.hours))] },
      { cells: [label('Форма здобуття освіти'), value(studyForm),
                label('Рік'), value(academicYear)] },
      { cells: [label('Строк навчання'), value(durationLabel(plan.lastSemester)),
                { text: '' }, { text: '' }] }
    ]
  });
  doc.space(6);
}

/**
 * A specialty code carries its галузь знань in its own prefix — «126» sits under «12», and a code
 * from the new list of ПКМУ № 1021 від 30.08.2024 under a letter («І7.01» under «І»). The branch
 * *names*, though, live in that постанова and in ПКМУ № 266/2015 before it, and this system stores
 * neither. Printing the prefix is honest; inventing a name from a table that goes stale the next
 * time the Cabinet amends the list is not, so the row is left for a hand to complete when the code
 * says nothing.
 */
function fieldOfStudyLabel(specialtyCode: string): string {
  const code = (specialtyCode ?? '').trim();
  return (code.match(/^\d{2}/) ?? code.match(/^[А-ЯҐЄІЇA-Z]\d?/) ?? [''])[0];
}

function drawLegalBasis(doc: PdfDocument): void {
  doc.writeParagraph(
    'Підстава: Закон України «Про вищу освіту» — обсяг одного кредиту ЄКТС становить 30 годин, ' +
    'навантаження навчального року за денною формою становить, як правило, 60 кредитів ЄКТС ' +
    '(ст. 1 п. 14); обсяг освітньої програми визначено ст. 5; вибіркові освітні компоненти ' +
    'становлять не менш як 25 відсотків обсягу освітньої програми (ст. 62 ч. 1 п. 15); навчальний ' +
    'план затверджує вчена рада закладу вищої освіти (ст. 36 ч. 2 п. 8). Форму документа заклад ' +
    'вищої освіти визначає самостійно (ст. 32, ст. 47 ч. 2): єдиного державного зразка немає — ' +
    'наказ МО України № 161 від 02.06.1993 втратив чинність згідно з наказом МОН № 1310 від ' +
    '13.11.2014.',
    { size: 9, color: MUTED });
}

// ── Section headings ────────────────────────────────────────────────────────

function sectionHeading(doc: PdfDocument, text: string, minSpace = 26): void {
  doc.ensure(minSpace);
  doc.y += doc.drawParagraph(text, {
    x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 12, font: 'bold'
  });
  doc.space(1.5);
}

// ── 1. Зведені показники ────────────────────────────────────────────────────

function drawProgrammeSummary(doc: PdfDocument, plan: CurriculumPlan): void {
  sectionHeading(doc, '1. Зведені показники освітньої програми');

  if (!plan.sections.some((s) => s.rows.length)) {
    doc.writeParagraph('Позицій навчального плану ще немає.', { size: 10, color: MUTED });
    doc.space(6);
    return;
  }

  const share = (totals: PlanTotals) =>
    plan.programme.credits > 0 ? fmtShare(totals.credits / plan.programme.credits) : '—';

  const row = (title: string, credits: string, hours: string, part: string,
               strong = false): PdfTableRow => ({
    cells: [title, { text: credits, align: 'center' }, { text: hours, align: 'center' },
            { text: part, align: 'center' }],
    strong, fill: strong ? SUBTOTAL_FILL : undefined
  });

  const rows: PdfTableRow[] = [];
  for (const section of plan.sections) {
    if (!section.rows.length) continue;
    rows.push(row(section.title, fmtNumber(section.totals.credits), fmtNumber(section.totals.hours),
                  section.countsTowardsProgramme ? share(section.totals) : '—'));
  }
  rows.push(row('УСЬОГО ЗА ОСВІТНЬОЮ ПРОГРАМОЮ', fmtNumber(plan.programme.credits),
                fmtNumber(plan.programme.hours), plan.programme.credits ? '100,0 %' : '—', true));

  doc.drawTable({
    x: doc.margins.left + 14,
    columns: [
      { title: 'Складова освітньої програми', width: 128, align: 'left' },
      { title: 'Кредитів ЄКТС', width: 34, align: 'center' },
      { title: 'Годин', width: 34, align: 'center' },
      { title: 'Частка обсягу ОП', width: 33, align: 'center' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 10,
    keepTogether: true,
    rows
  });
  doc.space(4);

  doc.writeParagraph(
    'Факультативні дисципліни до обсягу освітньої програми не входять і в частці не враховуються.',
    { size: 8.5, color: MUTED });
  doc.space(6);
}

// ── 2. Зведені дані за семестрами ───────────────────────────────────────────

function drawSemesterSummary(doc: PdfDocument, plan: CurriculumPlan): void {
  sectionHeading(doc, '2. Зведені дані за семестрами', 60);

  if (!plan.semesters.length) {
    doc.writeParagraph('Позицій навчального плану ще немає.', { size: 10, color: MUTED });
    doc.space(6);
    return;
  }

  const semesterRow = (s: PlanSemester): PdfTableRow => ({
    cells: [
      { text: String(s.semester), align: 'center' },
      { text: String(s.courseYear), align: 'center' },
      { text: s.halfYear === 1 ? 'перше' : 'друге', align: 'center' },
      { text: String(s.totals.items), align: 'center' },
      { text: fmtNumber(s.totals.credits), align: 'center' },
      { text: fmtNumber(s.totals.hours), align: 'center' },
      { text: fmtNumber(s.totals.contactHours), align: 'center' },
      { text: fmtNumber(s.totals.independentHours), align: 'center' },
      { text: fmtOrDash(s.totals.exams), align: 'center' },
      { text: fmtOrDash(s.totals.credited), align: 'center' },
      { text: fmtOrDash(s.courseWorks), align: 'center' }
    ]
  });

  const p = plan.programme;
  const rows: PdfTableRow[] = plan.semesters.map(semesterRow);
  rows.push({
    cells: [
      { text: 'Разом', colSpan: 3, align: 'right' },
      { text: String(p.items), align: 'center' },
      { text: fmtNumber(p.credits), align: 'center' },
      { text: fmtNumber(p.hours), align: 'center' },
      { text: fmtNumber(p.contactHours), align: 'center' },
      { text: fmtNumber(p.independentHours), align: 'center' },
      { text: fmtOrDash(p.exams), align: 'center' },
      { text: fmtOrDash(p.credited), align: 'center' },
      { text: fmtOrDash(plan.semesters.reduce((sum, s) => sum + s.courseWorks, 0)), align: 'center' }
    ],
    strong: true, fill: TOTAL_FILL
  });

  doc.drawTable({
    columns: [
      { title: 'Семестр', width: 20, align: 'center' },
      { title: 'Курс', width: 16, align: 'center' },
      { title: 'Півріччя', width: 22, align: 'center' },
      { title: 'Освітніх компонентів', width: 26, align: 'center' },
      { title: 'Кредитів ЄКТС', width: 24, align: 'center' },
      { title: 'Годин усього', width: 24, align: 'center' },
      { title: 'Контактних годин', width: 25, align: 'center' },
      { title: 'Самостійна робота', width: 26, align: 'center' },
      { title: 'Екзаменів', width: 24, align: 'center' },
      { title: 'Заліків', width: 24, align: 'center' },
      { title: 'Курсових робіт', width: 26, align: 'center' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 9,
    headerSize: 8.5,
    keepTogether: true,
    rows
  });
  doc.space(7);
}

// ── 3. План освітнього процесу ──────────────────────────────────────────────

/**
 * The main table. Fifteen columns under a three-level header — «Кількість годин» over «Аудиторні
 * (контактні) заняття» over «лекції / практичні / лабораторні» — which is the column set the
 * published plans of ЗНУ, ОНТУ, ХНЕУ and КрНУ share, minus the per-semester weekly-hours block
 * those add on the right (this system plans hours per semester, not per week: the weekly figure
 * belongs to the розклад, which the timetable pages already build).
 */
function drawPlanTable(doc: PdfDocument, plan: CurriculumPlan): void {
  sectionHeading(doc, '3. План освітнього процесу', 80);

  // Millimetres, summing to the 257 mm between the margins of a landscape А4 sheet. Each numeric
  // column is wide enough for the longest *word* of its own caption at `headerSize`, so no heading
  // is ever broken mid-word — «лаборато / рні» in a printed plan reads as a defect, and the
  // writer's wrapper breaks an over-long word by character rather than overflowing the cell.
  const columns = [
    { title: '№ з/п', width: 9, align: 'center' as const },
    { title: 'Код', width: 14, align: 'center' as const },
    { title: 'Освітній компонент', width: 62, align: 'left' as const },
    { title: 'Семестр', width: 14, align: 'center' as const },
    { title: 'екзамен', width: 13, align: 'center' as const },
    { title: 'залік', width: 10, align: 'center' as const },
    { title: 'диф. залік', width: 11, align: 'center' as const },
    { title: 'Кредитів ЄКТС', width: 15, align: 'center' as const },
    { title: 'усього', width: 13, align: 'center' as const },
    { title: 'усього', width: 13, align: 'center' as const },
    { title: 'лекції', width: 12, align: 'center' as const },
    { title: 'практичні', width: 16, align: 'center' as const },
    { title: 'лабораторні', width: 18, align: 'center' as const },
    { title: 'консультації, контрольні заходи', width: 20, align: 'center' as const },
    { title: 'самостійна робота', width: 17, align: 'center' as const }
  ];

  const headerRows: PdfTableRow[] = [
    {
      cells: [
        { text: '№ з/п', rowSpan: 3 },
        { text: 'Код', rowSpan: 3 },
        { text: 'Освітній компонент (навчальна дисципліна)', rowSpan: 3 },
        { text: 'Семестр', rowSpan: 3 },
        { text: 'Форма підсумкового контролю (семестр)', colSpan: 3 },
        { text: 'Кредитів ЄКТС', rowSpan: 3 },
        { text: 'Кількість годин', colSpan: 7 }
      ]
    },
    {
      cells: [
        { text: 'екзамен', rowSpan: 2 },
        { text: 'залік', rowSpan: 2 },
        { text: 'диф. залік', rowSpan: 2 },
        { text: 'усього', rowSpan: 2 },
        { text: 'аудиторні (контактні) заняття', colSpan: 5 },
        { text: 'самостійна робота', rowSpan: 2 }
      ]
    },
    {
      cells: [
        { text: 'усього' }, { text: 'лекції' }, { text: 'практичні' }, { text: 'лабораторні' },
        { text: 'консультації, контрольні заходи' }
      ]
    }
  ];

  const controlCell = (row: { controlForm: string; semester: number }, form: string) =>
    ({ text: row.controlForm === form ? String(row.semester) : '', align: 'center' as const });

  const rows: PdfTableRow[] = [];
  let ordinal = 0;

  const visible = plan.sections.filter((s) => s.rows.length);
  for (const section of visible) {
    // «УСЬОГО ЗА ОСВІТНЬОЮ ПРОГРАМОЮ» closes the sections it actually sums, before the
    // факультативи that lie outside the programme are listed — otherwise the grand total reads as
    // if it had skipped the section directly above it.
    if (!section.countsTowardsProgramme && ordinal > 0) {
      rows.push(totalsRow('УСЬОГО ЗА ОСВІТНЬОЮ ПРОГРАМОЮ', plan.programme, TOTAL_FILL));
    }

    rows.push({
      cells: [{ text: sectionTitle(plan, section, visible.indexOf(section) + 1), colSpan: 15, align: 'left' }],
      strong: true, fill: HEADER_FILL
    });

    for (const item of section.rows) {
      ordinal += 1;
      rows.push({
        cells: [
          { text: String(ordinal), align: 'center' },
          { text: item.code, align: 'center' },
          item.name,
          { text: String(item.semester), align: 'center' },
          controlCell(item, 'EXAM'),
          controlCell(item, 'CREDIT'),
          controlCell(item, 'GRADED_CREDIT'),
          { text: fmtNumber(item.credits), align: 'center' },
          { text: fmtNumber(item.totalHours), align: 'center' },
          { text: fmtOrDash(item.contactHours), align: 'center' },
          { text: fmtOrDash(item.hours.LECTURE), align: 'center' },
          { text: fmtOrDash(item.hours.PRACTICAL), align: 'center' },
          { text: fmtOrDash(item.hours.LAB), align: 'center' },
          { text: fmtOrDash(item.otherContactHours), align: 'center' },
          { text: fmtOrDash(item.independentHours), align: 'center' }
        ]
      });
    }

    rows.push(totalsRow(`Разом за розділом «${section.title}»`, section.totals, SUBTOTAL_FILL));
  }

  if (!rows.length) {
    doc.writeParagraph('Позицій навчального плану ще немає.', { size: 10, color: MUTED });
    doc.space(6);
    return;
  }

  // A plan with no факультативи has not had its grand total emitted by the loop above.
  if (visible.every((s) => s.countsTowardsProgramme)) {
    rows.push(totalsRow('УСЬОГО ЗА ОСВІТНЬОЮ ПРОГРАМОЮ', plan.programme, TOTAL_FILL));
  }

  doc.drawTable({
    columns,
    headerRows,
    rows,
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 8.5,
    headerSize: 8,
    padX: 1.2,
    onContinue: () => {
      doc.y += doc.drawParagraph('3. План освітнього процесу (продовження)', {
        x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
      });
      doc.space(1);
    }
  });
  doc.space(7);
}

/** «2. Вибіркові компоненти освітньої програми — 60 кредитів ЄКТС (30,3 % обсягу ОП)». */
function sectionTitle(plan: CurriculumPlan, section: PlanSection, index: number): string {
  const suffix = section.countsTowardsProgramme && plan.programme.credits > 0
    ? ` — ${creditsLabel(section.totals.credits)} ` +
      `(${fmtShare(section.totals.credits / plan.programme.credits)} обсягу ОП)`
    : ` — ${creditsLabel(section.totals.credits)}`;
  return `${index}. ${section.title.toUpperCase()}${suffix}`;
}

/** «1 кредит ЄКТС» / «3 кредити ЄКТС» / «60 кредитів ЄКТС» — Ukrainian numeral agreement. */
function creditsLabel(credits: number): string {
  const n = Math.abs(Math.round(credits));
  const ones = n % 10;
  const tens = n % 100;
  const word = tens >= 11 && tens <= 14 ? 'кредитів'
             : ones === 1 ? 'кредит'
             : ones >= 2 && ones <= 4 ? 'кредити'
             : 'кредитів';
  return `${fmtNumber(credits)} ${word} ЄКТС`;
}

function totalsRow(title: string, totals: PlanTotals, fill: RGB): PdfTableRow {
  return {
    cells: [
      { text: title, colSpan: 7, align: 'right' },
      { text: fmtNumber(totals.credits), align: 'center' },
      { text: fmtNumber(totals.hours), align: 'center' },
      { text: fmtOrDash(totals.contactHours), align: 'center' },
      { text: fmtOrDash(totals.byHourType.LECTURE), align: 'center' },
      { text: fmtOrDash(totals.byHourType.PRACTICAL), align: 'center' },
      { text: fmtOrDash(totals.byHourType.LAB), align: 'center' },
      { text: fmtOrDash(totals.byHourType.CONSULTATION + totals.byHourType.ASSESSMENT), align: 'center' },
      { text: fmtOrDash(totals.independentHours), align: 'center' }
    ],
    strong: true, fill
  };
}

// ── 4. Розподіл годин за видами роботи ──────────────────────────────────────

function drawHourTypeBreakdown(doc: PdfDocument, plan: CurriculumPlan): void {
  // The table below moves whole (`keepTogether`), so the heading has to reserve room for it too —
  // a heading alone at the foot of a page, with its table overleaf, reads as an accident.
  sectionHeading(doc, '4. Розподіл годин за видами навчальної роботи', 68);

  const cells = (totals: PlanTotals) =>
    PLAN_HOUR_TYPES.map((t) => ({ text: fmtOrDash(totals.byHourType[t]), align: 'center' as const }));

  const row = (title: string, totals: PlanTotals, strong = false): PdfTableRow => ({
    cells: [title, ...cells(totals), { text: fmtNumber(totals.hours), align: 'center' }],
    strong, fill: strong ? SUBTOTAL_FILL : undefined
  });

  const rows: PdfTableRow[] = [row('Усі компоненти освітньої програми', plan.programme, true)];
  for (const section of plan.sections) {
    if (!section.rows.length || !section.countsTowardsProgramme) continue;
    rows.push(row(`у тому числі ${section.title.toLowerCase()}`, section.totals));
  }

  doc.drawTable({
    columns: [
      { title: 'Складова освітньої програми', width: 74, align: 'left' },
      ...PLAN_HOUR_TYPES.map((t) => ({ title: HOUR_TYPE_LABELS[t], width: 26, align: 'center' as const })),
      { title: 'Разом', width: 27, align: 'center' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 9,
    headerSize: 8.5,
    keepTogether: true,
    rows
  });
  doc.space(7);
}

// ── 5. Відповідність нормативним вимогам ────────────────────────────────────

const STATUS_MARK: Record<ComplianceCheck['status'], string> = {
  ok: 'відповідає', warning: 'до уваги', violation: 'НЕ ВІДПОВІДАЄ', unknown: 'не визначено'
};

function drawCompliance(doc: PdfDocument, plan: CurriculumPlan): void {
  sectionHeading(doc, '5. Відповідність нормативним вимогам', 76);

  doc.drawTable({
    columns: [
      { title: 'Показник', width: 62, align: 'left' },
      { title: 'Норма', width: 40, align: 'left' },
      // The норма is a setting now; the article it descends from is stated beside it rather than
      // inside it, so the figure is never mistaken for a quotation.
      { title: 'Підстава норми', width: 55, align: 'left' },
      { title: 'За планом', width: 34, align: 'center' },
      { title: 'Висновок', width: 66, align: 'left' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 8.5,
    headerSize: 8.5,
    keepTogether: true,
    rows: plan.checks.map((check) => ({
      cells: [
        check.title,
        check.norm,
        check.source,
        { text: check.value, align: 'center' },
        // The verdict leads with what it is, so a failure is found by scanning one column rather
        // than by comparing a value against a norm on every line.
        `${STATUS_MARK[check.status]} — ${check.verdict}`
      ],
      strong: check.status === 'violation',
      fill: check.status === 'violation' ? SUBTOTAL_FILL : undefined
    }))
  });
  doc.space(4);

  doc.writeParagraph(
    'Показники зі статутною нормою перевіряються за Законом України «Про вищу освіту»; останні — ' +
    'за усталеною практикою закладів вищої освіти, тож відхилення від них не є порушенням ' +
    'законодавства. Самі числові межі задано в налаштуваннях системи, тому джерело норми наведено ' +
    'окремою колонкою.',
    { size: 8.5, color: MUTED });
  doc.space(7);
}

// ── Примітки ────────────────────────────────────────────────────────────────

function drawNotes(doc: PdfDocument, plan: CurriculumPlan): void {
  const derived = plan.sections
    .flatMap((s) => s.rows)
    .filter((r) => r.independentDerived).length;

  const notes = [
    'Загальний обсяг кожного освітнього компонента обчислено як кредити ЄКТС, помножені на 30 ' +
    'годин (ст. 1 п. 14 Закону України «Про вищу освіту»).',
    'Форма підсумкового контролю позначається номером семестру у відповідній колонці.'
  ];
  if (derived) {
    notes.push(
      `Години самостійної роботи, не задані явно (${derived} позиц.), обчислено як різницю ` +
      'загального обсягу та контактних годин — так, як заповнюється відповідна графа паперового ' +
      'плану.');
  }
  notes.push(
    'Курсові роботи (проєкти), практики та атестація подані окремими розділами, оскільки в моделі ' +
    'даних вони є самостійними освітніми компонентами, а не ознакою дисципліни.');

  doc.ensure(20 + notes.length * 6);
  doc.y += doc.drawParagraph('Примітки', {
    x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10.5, font: 'bold'
  });
  doc.space(1);
  notes.forEach((note, i) => {
    doc.writeParagraph(`${i + 1}. ${note}`, { size: 9, color: MUTED });
    doc.space(1);
  });
  doc.space(6);
}

// ── Signatures ──────────────────────────────────────────────────────────────

/**
 * The chain of visas a plan actually collects. ДСТУ 4163:2020 writes a signature as «Власне ім'я
 * ПРІЗВИЩЕ» — ініціали стандартом більше не передбачені. The block never breaks across a page.
 */
function drawSignatures(doc: PdfDocument): void {
  doc.ensure(64);

  const left = doc.margins.left;
  const signatureX = left + 118;
  const nameX = left + 175;
  const roles = [
    'Гарант освітньої програми',
    'Завідувач випускової кафедри',
    'Декан факультету',
    'Начальник навчального відділу',
    'Проректор з науково-педагогічної роботи'
  ];
  const pitch = 11;

  roles.forEach((role, i) => {
    const y = doc.y + pitch * i;
    doc.drawText(role, { x: left, y, size: 10.5 });
    doc.drawText('___________________', { x: signatureX, y, size: 10.5 });
    doc.drawText('_______________________________', { x: nameX, y, size: 10.5 });
  });
  const captionY = doc.y + pitch * roles.length - 4.5;
  doc.drawText('(підпис)', { x: signatureX, y: captionY, size: 8, color: MUTED, align: 'center', width: 36 });
  doc.drawText('(Власне ім’я ПРІЗВИЩЕ)',
               { x: nameX, y: captionY, size: 8, color: MUTED, align: 'center', width: 55 });

  doc.y += pitch * roles.length + 6;
  doc.drawText('«____» ________________ 20___ р.', { x: left, y: doc.y, size: 10.5 });
  doc.y += 8;
}

// ── Running page furniture ──────────────────────────────────────────────────

/**
 * Page numbers and the origin note, added once the total is known. ДСТУ 4163:2020 puts the number
 * in the middle of the top margin and leaves the first sheet unnumbered.
 */
function drawPageFurniture(doc: PdfDocument, input: CurriculumReportInput, academicYear: string): void {
  const stamp = `Сформовано автоматично ${fmtDate(input.generatedAt)} · ${SYSTEM_NAME}`;
  const trail = `${input.specialtyCode} ${input.specialtyName} · ` +
                `${degreeLabel(input.degree).toLowerCase()} · ${academicYear} н. р.`;
  for (let page = 0; page < doc.pageCount; page++) {
    doc.onPage(page, () => {
      if (page > 0) {
        doc.drawText(String(page + 1), {
          x: doc.margins.left, y: 12, size: 10, align: 'center', width: doc.contentWidth
        });
      }
      doc.drawText(stamp, { x: doc.margins.left, y: doc.heightMm - 9, size: 7.5, color: MUTED });
      doc.drawText(trail, {
        x: doc.margins.left, y: doc.heightMm - 9, size: 7.5, color: MUTED,
        align: 'right', width: doc.contentWidth
      });
    });
  }
}
