/**
 * The printable «РОБОЧИЙ НАВЧАЛЬНИЙ ПЛАН» of a specialty for one academic year — the sheet a
 * навчальний відділ files and a кафедра plans its load from, built from exactly the rows the
 * «Робочі навчальні плани» tab shows.
 *
 * Framework-free, like `curriculum-report.ts`: it takes the plan `working-curriculum-plan.ts`
 * computed plus a pair of fonts and returns PDF bytes, so it renders under Node in a test as
 * easily as in the browser, and does no arithmetic beyond summing what it prints.
 *
 * ── Why the document looks the way it does ─────────────────────────────────────────────────────
 *
 * **The РНП has no legal definition in force, and never had a state template.** The one act that
 * defined it — наказ МО України № 161 від 02.06.1993 — devoted a single sentence to it and was
 * repealed by наказ МОН № 1310 від 13.11.2014. The Закон України «Про вищу освіту» does not use
 * the term at all: ст. 10 ч. 4 knows the навчальний план and the **індивідуальний** навчальний план
 * на кожний навчальний рік. The Ліцензійні умови (ПКМУ № 1187) require a робочий навчальний план
 * of дошкільні and загальноосвітні закладів but ask ЗВО only for the навчальний план, and the
 * НАЗЯВО accreditation rules (наказ МОН № 977) do not mention it. **Do not present this sheet as a
 * document required by law.** It is an internal planning document, and the note under its title
 * says so.
 *
 * What the practice of ЗВО does agree on, and what is reproduced here:
 *
 *   • the РНП is drawn up **for one academic year** and concretises the навчальний план
 *     (ЗНУ: «деталізує особливості підготовки … у поточному навчальному році»; ОНТУ: «похідний
 *     документ … розробляється на кожний навчальний рік»; ХНМУ: «на кожний навчальний рік
 *     (семестр)»);
 *   • its one indispensable addition to the навчальний план is **the кафедра behind each block of
 *     hours** (ЗНУ, п. 2.10: «закріплення навчальних дисциплін за відповідними кафедрами …
 *     фіксується в робочих навчальних планах»);
 *   • it is the **source document for кафедральне навантаження** (КПІ, Положення про планування
 *     педнавантаження 2022: «підставою для планування навчального навантаження … є відповідні
 *     витяги з робочих навчальних планів»), which is why sections 3 and 4 exist;
 *   • it is approved above the faculty — проректор або вчена рада ЗВО + наказ ректора — and
 *     погоджується by the навчальний відділ, the декан and the випускова кафедра.
 *
 * The **hours a кафедра is projected to teach** are not derivable from any state норма: наказ МОН
 * № 450 від 07.08.2002 втратив чинність (наказ МОН № 187 від 16.02.2022), and норми часу are set
 * by each ЗВО. Section 4 therefore states its rule in the document itself, and that rule is the
 * one `workload-stats.ts` already applies, so this sheet and the «Розрахунок навчального
 * навантаження» cannot disagree.
 *
 * Typography follows ДСТУ 4163:2020 as far as it reaches — the standard governs організаційно-
 * розпорядчу документацію, and a планово-навчальний document borrows it through the institution's
 * own інструкція з діловодства rather than by direct force. Landscape А4 is practice, not a rule:
 * the standard is silent on orientation and merely allows А3 for documents with tables.
 */

import { CONTROL_FORM_OPTIONS, DEGREE_OPTIONS, STUDY_FORM_OPTIONS, TEACHING_FORMAT_OPTIONS }
  from './entities';
import { ComplianceCheck, PlanHourType, fmtNumber, fmtOrDash } from './curriculum-plan';
import {
  DELIVERABLE_HOUR_TYPES, DepartmentLoad, WorkingCurriculumPlan, WorkingPosition
} from './working-curriculum-plan';
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

const HOUR_TYPE_LABELS: Record<PlanHourType, string> = {
  LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
  CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи',
  INDEPENDENT_WORK: 'Самостійна робота'
};

/** Short forms, for the кафедра column where the kinds of work are named inside a cell. */
const HOUR_TYPE_SHORT: Record<string, string> = {
  LECTURE: 'лекції', PRACTICAL: 'практичні', LAB: 'лабораторні',
  CONSULTATION: 'консультації', ASSESSMENT: 'контрольні заходи'
};

const label = (options: { value: string; label: string }[], v: string): string =>
  options.find((o) => o.value === v)?.label ?? v;

const degreeLabel = (v: string): string => label(DEGREE_OPTIONS, v) || '—';
const controlFormLabel = (v: string): string => label(CONTROL_FORM_OPTIONS, v);
const teachingFormatLabel = (v: string): string => label(TEACHING_FORMAT_OPTIONS, v);
const studyFormLabel = (v: string): string => label(STUDY_FORM_OPTIONS, v);

export interface WorkingCurriculumReportInput {
  /** The plan as computed by `buildWorkingCurriculumPlan` — the same object the tab renders. */
  plan: WorkingCurriculumPlan;
  specialtyCode: string;
  specialtyName: string;
  /** Raw `specialties.degree` enum value. */
  degree: string;
  facultyName: string;
  /** Raw `academic_groups.study_form` values found among the specialty's groups. */
  studyForms: string[];
  /** Passed in rather than read, so the same input always yields the same bytes. */
  generatedAt: Date;
  fonts: { regular: TtfFont; bold: TtfFont };
}

/** «Робочий_навчальний_план_126_курс-3_2026-2027.pdf» — code first, so a folder sorts usefully. */
export function workingCurriculumReportFileName(
  code: string, courseYear: number | null, academicYear: string): string {
  const safe = (text: string) => text.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-|-$/g, '');
  const scope = courseYear === null ? 'усі-курси' : `курс-${courseYear}`;
  return `Робочий_навчальний_план_${safe(code) || 'спеціальність'}_${scope}_${academicYear.replace('/', '-')}.pdf`;
}

const fmtDate = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

export function buildWorkingCurriculumReport(input: WorkingCurriculumReportInput): Uint8Array {
  const { plan, fonts } = input;
  const academicYear = academicYearLabel(input.generatedAt);
  const scope = plan.courseYear === null ? 'усі курси' : `${plan.courseYear} курс`;

  const doc = new PdfDocument({
    ...A4_LANDSCAPE,
    margins: MARGINS,
    fonts: { regular: fonts.regular, bold: fonts.bold },
    defaultFont: 'regular',
    defaultSize: 11,
    title: `Робочий навчальний план — ${input.specialtyCode} ${input.specialtyName} — ` +
           `${scope} — ${academicYear}`,
    author: UNIVERSITY_NAME,
    subject: `${degreeLabel(input.degree)}, ${input.facultyName}`,
    createdAt: input.generatedAt
  });

  const grifBottom = drawApprovalGrif(doc, academicYear);
  doc.y = doc.margins.top;
  const letterheadBottom = drawLetterhead(doc, input);
  doc.y = Math.max(grifBottom, letterheadBottom);

  drawTitle(doc, academicYear);
  drawIdentity(doc, input, academicYear, scope);
  drawLegalBasis(doc);

  doc.addPage();

  drawSummary(doc, plan);
  drawPlanTable(doc, plan);
  drawDepartmentPositions(doc, plan);
  drawDepartmentLoads(doc, plan);
  drawCompliance(doc, plan);
  drawNotes(doc, plan);
  drawSignatures(doc);
  drawPageFurniture(doc, input, academicYear, scope);

  return doc.render();
}

// ── Sheet 1 ─────────────────────────────────────────────────────────────────

/**
 * Practice splits between «ЗАТВЕРДЖУЮ Проректор» (ОНТУ, ДДПУ) and «ЗАТВЕРДЖЕНО Вченою радою +
 * наказ ректора» (ХНМУ, КрНУ). Both are valid ДСТУ 4163:2020 grifs; the second is reproduced
 * because it is what the real published РНП carry, with the проректор's approval line kept beside
 * it so an institution using the first form has it on the page.
 */
function drawApprovalGrif(doc: PdfDocument, academicYear: string): number {
  const boxWidth = 104;
  const x = doc.margins.left + doc.contentWidth - boxWidth;
  const size = 10;
  const pitch = doc.lineHeight(size, 1.2);
  const lines: { text: string; bold?: boolean }[] = [
    { text: 'ЗАТВЕРДЖУЮ', bold: true },
    { text: 'Проректор з науково-педагогічної роботи' },
    { text: 'Львівського національного університету' },
    { text: 'імені Івана Франка' },
    { text: '' },
    { text: '______________   ________________________' }
  ];
  lines.forEach((line, i) => {
    doc.drawText(line.text, {
      x, y: doc.y + pitch * i + 3.2, size, font: line.bold ? 'bold' : 'regular', width: boxWidth
    });
  });
  let y = doc.y + pitch * lines.length;
  doc.drawText('(підпис)', { x: x + 2, y: y + 2.4, size: 8, color: MUTED });
  doc.drawText('(Власне ім’я ПРІЗВИЩЕ)', { x: x + 34, y: y + 2.4, size: 8, color: MUTED });
  y += pitch;
  doc.drawText('«___» ____________ 20___ р.', { x, y: y + 3.2, size });
  y += pitch * 1.6;
  doc.drawText(`Уведено в дію з ${academicYear} навчального року`,
               { x, y: y + 3.2, size: 9, color: MUTED });
  return y + pitch + 4;
}

/** Returns the y the letterhead ends at, so the caller can clear both it and the гриф beside it. */
function drawLetterhead(doc: PdfDocument, input: WorkingCurriculumReportInput): number {
  const left = doc.margins.left;
  const width = doc.contentWidth - 112;
  const centred = (text: string, size: number, font: 'regular' | 'bold') => {
    if (!text.trim()) return;
    doc.y += doc.drawParagraph(text, { x: left, y: doc.y, width, size, font, align: 'center' });
  };
  centred(MINISTRY_NAME, 10.5, 'regular');
  centred(UNIVERSITY_NAME.toUpperCase(), 11.5, 'bold');
  doc.space(2);
  centred(input.facultyName, 10.5, 'regular');
  return doc.y;
}

function drawTitle(doc: PdfDocument, academicYear: string): void {
  doc.space(8);
  const left = doc.margins.left;
  const width = doc.contentWidth;
  doc.y += doc.drawParagraph('РОБОЧИЙ НАВЧАЛЬНИЙ ПЛАН',
                             { x: left, y: doc.y, width, size: 16, font: 'bold', align: 'center' });
  doc.y += doc.drawParagraph(`на ${academicYear} навчальний рік`,
                             { x: left, y: doc.y, width, size: 12, align: 'center' });
  doc.space(6);
}

function drawIdentity(doc: PdfDocument, input: WorkingCurriculumReportInput,
                      academicYear: string, scope: string): void {
  const plan = input.plan;
  const key = (text: string) => ({ text, font: 'regular' });
  const value = (text: string) => ({ text: text || '—', font: 'bold' as const });

  const studyForm = input.studyForms.length
    ? [...new Set(input.studyForms)].map(studyFormLabel).join(', ')
    : '';
  const groups = [...new Set(plan.rows.flatMap((r) => r.groupNames))];

  doc.drawTable({
    x: doc.margins.left + 16,
    columns: [{ width: 56 }, { width: 108 }, { width: 42 }, { width: 19 }],
    showHeader: false,
    size: 10,
    padY: 1.6,
    keepTogether: true,
    rows: [
      { cells: [key('Спеціальність'), value(`${input.specialtyCode} ${input.specialtyName}`.trim()),
                key('Навчальний рік'), value(academicYear)] },
      { cells: [key('Освітній ступінь'), value(degreeLabel(input.degree)),
                key('Позицій'), value(String(plan.totals.items))] },
      { cells: [key('Факультет'), value(input.facultyName),
                key('Кредитів ЄКТС'), value(fmtNumber(plan.totals.credits))] },
      { cells: [key('Форма здобуття освіти'), value(studyForm),
                key('Годин'), value(fmtNumber(plan.totals.hours))] },
      { cells: [key('Охоплення плану'), value(scope),
                key('Кафедр'), value(String(plan.departments.length))] },
      { cells: [key('Академічні групи'), value(groups.join(', ')),
                { text: '' }, { text: '' }] }
    ]
  });
  doc.space(6);
}

function drawLegalBasis(doc: PdfDocument): void {
  doc.writeParagraph(
    'Робочий навчальний план — внутрішній документ закладу вищої освіти. Єдиної державної форми ' +
    'немає, і чинне законодавство його не унормовує: наказ МО України № 161 від 02.06.1993, який ' +
    'єдиний його визначав, втратив чинність згідно з наказом МОН № 1310 від 13.11.2014, а Закон ' +
    'України «Про вищу освіту» (ст. 10 ч. 4) знає навчальний план та індивідуальні навчальні ' +
    'плани здобувачів. Форму документа заклад визначає самостійно (ст. 32, ст. 47 ч. 2). ' +
    'Успадковані від практики ЗВО ознаки, відтворені тут: план складається на один навчальний ' +
    'рік, конкретизує навчальний план і закріплює дисципліни за кафедрами, і є підставою для ' +
    'планування навчального навантаження кафедр.',
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

const empty = (doc: PdfDocument, text: string): void => {
  doc.writeParagraph(text, { size: 10, color: MUTED });
  doc.space(6);
};

// ── 1. Зведені показники ────────────────────────────────────────────────────

function drawSummary(doc: PdfDocument, plan: WorkingCurriculumPlan): void {
  sectionHeading(doc, '1. Зведені показники робочого навчального плану');

  if (!plan.rows.length) { empty(doc, 'Позицій навчального плану ще немає.'); return; }

  const row = (title: string, value: string, strong = false): PdfTableRow => ({
    cells: [title, { text: value, align: 'center' }],
    strong, fill: strong ? SUBTOTAL_FILL : undefined
  });
  const gaps = plan.coverage.required - plan.coverage.covered;

  doc.drawTable({
    x: doc.margins.left + 26,
    columns: [
      { title: 'Показник', width: 145, align: 'left' },
      { title: 'Значення', width: 60, align: 'center' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 10,
    keepTogether: true,
    rows: [
      row('Освітніх компонентів у плані', String(plan.totals.items), true),
      row('Кредитів ЄКТС', fmtNumber(plan.totals.credits)),
      row('Годин усього', fmtNumber(plan.totals.hours)),
      row('у тому числі контактних', fmtNumber(plan.totals.contactHours)),
      row('у тому числі самостійна робота', fmtNumber(plan.totals.independentHours)),
      row('Кафедр, залучених до викладання', String(plan.departments.length)),
      row('Позицій робочого плану', String(plan.positions.length)),
      row('Блоків годин закріплено за кафедрами',
          plan.coverage.required ? `${plan.coverage.covered} з ${plan.coverage.required}` : '—',
          gaps > 0),
      row('Планових годин навчального навантаження кафедр', fmtNumber(plan.plannedHours), true)
    ]
  });
  doc.space(7);
}

// ── 2. План освітнього процесу ──────────────────────────────────────────────

/**
 * The РНП table proper: the курс's part of the навчальний план, plus the column that makes it a
 * *робочий* plan — «Кафедра, що забезпечує викладання». Where a discipline is split between
 * departments, the cell names each one with the kinds of work it took, which is how a paper РНП
 * writes it rather than repeating the discipline on two lines.
 */
function drawPlanTable(doc: PdfDocument, plan: WorkingCurriculumPlan): void {
  sectionHeading(doc, '2. План освітнього процесу', 80);

  if (!plan.rows.length) { empty(doc, 'Позицій навчального плану ще немає.'); return; }

  // Millimetres, summing to the 257 mm between the margins of a landscape А4 sheet.
  const columns = [
    { title: '№ з/п', width: 9, align: 'center' as const },
    { title: 'Освітній компонент', width: 48, align: 'left' as const },
    { title: 'Семестр', width: 14, align: 'center' as const },
    { title: 'Форма контролю', width: 19, align: 'center' as const },
    { title: 'Кредитів ЄКТС', width: 15, align: 'center' as const },
    { title: 'усього', width: 13, align: 'center' as const },
    { title: 'лекції', width: 12, align: 'center' as const },
    { title: 'практичні', width: 16, align: 'center' as const },
    { title: 'лабораторні', width: 18, align: 'center' as const },
    { title: 'консультації, контрольні заходи', width: 20, align: 'center' as const },
    { title: 'самостійна робота', width: 17, align: 'center' as const },
    { title: 'Кафедра, що забезпечує викладання', width: 38, align: 'left' as const },
    { title: 'Академічні групи', width: 18, align: 'left' as const }
  ];

  const headerRows: PdfTableRow[] = [
    {
      cells: [
        { text: '№ з/п', rowSpan: 2 },
        { text: 'Освітній компонент (навчальна дисципліна)', rowSpan: 2 },
        { text: 'Семестр', rowSpan: 2 },
        { text: 'Форма контролю', rowSpan: 2 },
        { text: 'Кредитів ЄКТС', rowSpan: 2 },
        { text: 'Кількість годин', colSpan: 6 },
        { text: 'Кафедра, що забезпечує викладання', rowSpan: 2 },
        { text: 'Академічні групи', rowSpan: 2 }
      ]
    },
    {
      cells: [
        { text: 'усього' }, { text: 'лекції' }, { text: 'практичні' }, { text: 'лабораторні' },
        { text: 'консультації, контрольні заходи' }, { text: 'самостійна робота' }
      ]
    }
  ];

  const rows: PdfTableRow[] = [];
  let ordinal = 0;
  let currentYear: number | null = null;

  for (const item of plan.rows) {
    // A sheet covering several курси still reads as one document per year, so each year is
    // announced rather than silently interleaved.
    if (plan.courseYear === null && item.courseYear !== currentYear) {
      currentYear = item.courseYear;
      rows.push({
        cells: [{ text: `${currentYear} КУРС`, colSpan: 13, align: 'left' }],
        strong: true, fill: HEADER_FILL
      });
    }

    ordinal += 1;
    rows.push({
      cells: [
        { text: String(ordinal), align: 'center' },
        item.name,
        { text: String(item.semester), align: 'center' },
        { text: controlFormLabel(item.controlForm), align: 'center' },
        { text: fmtNumber(item.credits), align: 'center' },
        { text: fmtNumber(item.totalHours), align: 'center' },
        { text: fmtOrDash(item.hours.LECTURE), align: 'center' },
        { text: fmtOrDash(item.hours.PRACTICAL), align: 'center' },
        { text: fmtOrDash(item.hours.LAB), align: 'center' },
        { text: fmtOrDash(item.otherContactHours), align: 'center' },
        { text: fmtOrDash(item.independentHours), align: 'center' },
        departmentsCell(item.departments, item.unassignedHourTypes),
        item.groupNames.length ? item.groupNames.join(', ') : '—'
      ]
    });
  }

  const t = plan.totals;
  rows.push({
    cells: [
      { text: 'РАЗОМ', colSpan: 4, align: 'right' },
      { text: fmtNumber(t.credits), align: 'center' },
      { text: fmtNumber(t.hours), align: 'center' },
      { text: fmtOrDash(t.byHourType.LECTURE), align: 'center' },
      { text: fmtOrDash(t.byHourType.PRACTICAL), align: 'center' },
      { text: fmtOrDash(t.byHourType.LAB), align: 'center' },
      { text: fmtOrDash(t.byHourType.CONSULTATION + t.byHourType.ASSESSMENT), align: 'center' },
      { text: fmtOrDash(t.independentHours), align: 'center' },
      { text: '' }, { text: '' }
    ],
    strong: true, fill: TOTAL_FILL
  });

  doc.drawTable({
    columns, headerRows, rows,
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 8,
    headerSize: 8,
    padX: 1.2,
    onContinue: () => {
      doc.y += doc.drawParagraph('2. План освітнього процесу (продовження)', {
        x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
      });
      doc.space(1);
    }
  });
  doc.space(7);
}

/**
 * «Кафедра прикладної математики (лекції); Кафедра інформатики (лабораторні)» — but only naming
 * the kinds of work when there is more than one department to tell apart, since on the common case
 * of a single кафедра the qualification is noise.
 */
function departmentsCell(departments: { departmentName: string; hourTypes: string[] }[],
                         unassigned: string[]): { text: string } {
  const parts = departments.map((d) => departments.length > 1
    ? `${d.departmentName} (${d.hourTypes.map((t) => HOUR_TYPE_SHORT[t] ?? t).join(', ')})`
    : d.departmentName);
  if (unassigned.length) {
    parts.push(`не закріплено: ${unassigned.map((t) => HOUR_TYPE_SHORT[t] ?? t).join(', ')}`);
  }
  return { text: parts.join('; ') || 'не закріплено' };
}

// ── 3. Розподіл позицій за кафедрами ────────────────────────────────────────

/**
 * The витяг з РНП, one row per delivery position, grouped by кафедра — this is the form in which a
 * department actually receives its share of the plan (КПІ: «витяги з робочих навчальних планів»),
 * and the only place the формат проведення and the контингент appear.
 */
function drawDepartmentPositions(doc: PdfDocument, plan: WorkingCurriculumPlan): void {
  sectionHeading(doc, '3. Розподіл позицій робочого плану за кафедрами', 70);

  if (!plan.positions.length) {
    empty(doc, 'Жодна позиція навчального плану ще не закріплена за кафедрою.');
    return;
  }

  const columns = [
    { title: '№ з/п', width: 9, align: 'center' as const },
    { title: 'Курс', width: 12, align: 'center' as const },
    { title: 'Семестр', width: 14, align: 'center' as const },
    { title: 'Освітній компонент', width: 68, align: 'left' as const },
    { title: 'Вид роботи', width: 24, align: 'left' as const },
    { title: 'Формат проведення', width: 26, align: 'left' as const },
    { title: 'Академічні групи', width: 38, align: 'left' as const },
    { title: 'Студентів', width: 16, align: 'center' as const },
    { title: 'Годин за планом', width: 20, align: 'center' as const },
    { title: 'Планових годин кафедри', width: 30, align: 'center' as const }
  ];

  const rows: PdfTableRow[] = [];
  let currentDepartment: string | null = null;
  let ordinal = 0;
  let departmentPositions: WorkingPosition[] = [];

  const flush = () => {
    if (!departmentPositions.length) return;
    rows.push({
      cells: [
        { text: 'Разом за кафедрою', colSpan: 8, align: 'right' },
        { text: fmtNumber(departmentPositions.reduce((s, p) => s + p.hours, 0)), align: 'center' },
        { text: fmtNumber(departmentPositions.reduce((s, p) => s + p.plannedHours, 0)), align: 'center' }
      ],
      strong: true, fill: SUBTOTAL_FILL
    });
    departmentPositions = [];
  };

  for (const p of plan.positions) {
    if (p.departmentId !== currentDepartment) {
      flush();
      currentDepartment = p.departmentId;
      ordinal = 0;
      rows.push({
        cells: [{ text: p.departmentName.toUpperCase(), colSpan: 10, align: 'left' }],
        strong: true, fill: HEADER_FILL
      });
    }
    ordinal += 1;
    departmentPositions.push(p);
    rows.push({
      cells: [
        { text: String(ordinal), align: 'center' },
        { text: String(p.courseYear), align: 'center' },
        { text: String(p.semester), align: 'center' },
        p.courseName,
        HOUR_TYPE_LABELS[p.hourType],
        p.lecturerCount > 1
          ? `${teachingFormatLabel(p.teachingFormat)} · ${p.lecturerCount} викл.`
          : teachingFormatLabel(p.teachingFormat),
        p.groupNames.length ? p.groupNames.join(', ') : '—',
        { text: p.students ? String(p.students) : '—', align: 'center' },
        { text: fmtNumber(p.hours), align: 'center' },
        { text: fmtNumber(p.plannedHours), align: 'center' }
      ]
    });
  }
  flush();

  rows.push({
    cells: [
      { text: 'УСЬОГО ЗА РОБОЧИМ ПЛАНОМ', colSpan: 8, align: 'right' },
      { text: fmtNumber(plan.positions.reduce((s, p) => s + p.hours, 0)), align: 'center' },
      { text: fmtNumber(plan.plannedHours), align: 'center' }
    ],
    strong: true, fill: TOTAL_FILL
  });

  doc.drawTable({
    columns, rows,
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 8,
    headerSize: 8,
    padX: 1.2,
    onContinue: () => {
      doc.y += doc.drawParagraph('3. Розподіл позицій робочого плану за кафедрами (продовження)', {
        x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
      });
      doc.space(1);
    }
  });
  doc.space(7);
}

// ── 4. Розрахунок годин навчального навантаження кафедр ─────────────────────

function drawDepartmentLoads(doc: PdfDocument, plan: WorkingCurriculumPlan): void {
  sectionHeading(doc, '4. Розрахунок годин навчального навантаження кафедр', 70);

  if (!plan.departments.length) {
    empty(doc, 'Кафедр, закріплених за цим планом, ще немає.');
    return;
  }

  const cells = (load: DepartmentLoad) =>
    DELIVERABLE_HOUR_TYPES.map((t) => ({ text: fmtOrDash(load.byHourType[t]), align: 'center' as const }));

  const rows: PdfTableRow[] = plan.departments.map((load) => ({
    cells: [
      load.departmentName,
      { text: String(load.positions), align: 'center' },
      { text: String(load.courses), align: 'center' },
      ...cells(load),
      { text: fmtNumber(load.planHours), align: 'center' },
      { text: fmtNumber(load.plannedHours), align: 'center' }
    ]
  }));

  const total = (pick: (l: DepartmentLoad) => number) =>
    plan.departments.reduce((sum, l) => sum + pick(l), 0);

  rows.push({
    cells: [
      'Разом',
      { text: String(total((l) => l.positions)), align: 'center' },
      { text: '', align: 'center' },
      ...DELIVERABLE_HOUR_TYPES.map((t) => ({
        text: fmtOrDash(total((l) => l.byHourType[t])), align: 'center' as const
      })),
      { text: fmtNumber(total((l) => l.planHours)), align: 'center' },
      { text: fmtNumber(plan.plannedHours), align: 'center' }
    ],
    strong: true, fill: TOTAL_FILL
  });

  doc.drawTable({
    columns: [
      { title: 'Кафедра', width: 60, align: 'left' },
      { title: 'Позицій', width: 17, align: 'center' },
      { title: 'Дисциплін', width: 20, align: 'center' },
      { title: 'Лекції', width: 18, align: 'center' },
      { title: 'Практичні', width: 22, align: 'center' },
      { title: 'Лабораторні', width: 24, align: 'center' },
      { title: 'Консультації', width: 24, align: 'center' },
      { title: 'Контрольні заходи', width: 24, align: 'center' },
      { title: 'Годин за планом', width: 22, align: 'center' },
      { title: 'Планових годин навантаження', width: 26, align: 'center' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 8.5,
    headerSize: 8,
    keepTogether: true,
    rows
  });
  doc.space(4);

  doc.writeParagraph(
    'Планові години навантаження обчислено за правилом цієї системи: позицію, яку веде кілька ' +
    'викладачів, кожен із них проводить у повному обсязі (паралельні підгрупи, а не спільний ' +
    'потік), а індивідуальна робота коштує «години · кількість студентів». Державних норм часу ' +
    'немає — наказ МОН № 450 від 07.08.2002 втратив чинність згідно з наказом МОН № 187 від ' +
    '16.02.2022, і норми часу встановлює заклад вищої освіти. Це те саме правило, за яким ' +
    'обчислюється «Розрахунок навчального навантаження науково-педагогічного працівника», тож два ' +
    'документи не можуть розійтися.',
    { size: 8.5, color: MUTED });
  doc.space(7);
}

// ── 5. Відповідність та повнота ─────────────────────────────────────────────

const STATUS_MARK: Record<ComplianceCheck['status'], string> = {
  ok: 'відповідає', warning: 'до уваги', violation: 'НЕ ВИКОНАНО', unknown: 'не визначено'
};

function drawCompliance(doc: PdfDocument, plan: WorkingCurriculumPlan): void {
  sectionHeading(doc, '5. Відповідність та повнота робочого плану', 76);

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
        `${STATUS_MARK[check.status]} — ${check.verdict}`
      ],
      strong: check.status === 'violation',
      fill: check.status === 'violation' ? SUBTOTAL_FILL : undefined
    }))
  });
  doc.space(4);

  doc.writeParagraph(
    'Показники зі статутною нормою перевіряються за Законом України «Про вищу освіту»; решта — за ' +
    'усталеною практикою закладів вищої освіти, тож відхилення від них не є порушенням ' +
    'законодавства. Сам робочий навчальний план законодавством не унормовано. Числові межі задано ' +
    'в налаштуваннях системи, тому джерело норми наведено окремою колонкою.',
    { size: 8.5, color: MUTED });
  doc.space(7);
}

// ── Примітки ────────────────────────────────────────────────────────────────

function drawNotes(doc: PdfDocument, plan: WorkingCurriculumPlan): void {
  const derived = plan.rows.filter((r) => r.independentDerived).length;

  const notes = [
    'Загальний обсяг кожного освітнього компонента обчислено як кредити ЄКТС, помножені на 30 ' +
    'годин (ст. 1 п. 14 Закону України «Про вищу освіту»).',
    'Колонка «Кафедра, що забезпечує викладання» подає закріплення з розділу 3; де дисципліну ' +
    'ведуть кілька кафедр, поряд із назвою зазначено види робіт.'
  ];
  if (plan.courseYear === null) {
    notes.push(
      'План сформовано за всіма курсами спеціальності, а не за одним навчальним роком: розділи 1, ' +
      '2 і 4 підсумовують усі курси разом.');
  }
  if (derived) {
    notes.push(
      `Години самостійної роботи, не задані явно (${derived} позиц.), обчислено як різницю ` +
      'загального обсягу та контактних годин.');
  }
  if (plan.coverage.required > plan.coverage.covered) {
    notes.push(
      `Блоків годин без закріпленої кафедри: ${plan.coverage.required - plan.coverage.covered}. ` +
      'Навантаження за ними не потрапляє в розділи 3 і 4 і не сформується автоматично.');
  }

  doc.ensure(20 + notes.length * 7);
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
 * Practice puts the навчальний відділ first and the кафедра last — the chain a РНП is visaed down,
 * as opposed to the навчальний план's, which begins at the гарант освітньої програми. ДСТУ
 * 4163:2020 writes a signature as «Власне ім'я ПРІЗВИЩЕ».
 */
function drawSignatures(doc: PdfDocument): void {
  doc.ensure(58);

  const left = doc.margins.left;
  const signatureX = left + 118;
  const nameX = left + 175;
  const pitch = 11;

  doc.drawText('ПОГОДЖЕНО', { x: left, y: doc.y, size: 10.5, font: 'bold' });
  doc.y += pitch;

  const roles = [
    'Начальник навчального відділу',
    'Декан факультету',
    'Гарант освітньої програми',
    'Завідувач випускової кафедри'
  ];
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

function drawPageFurniture(doc: PdfDocument, input: WorkingCurriculumReportInput,
                           academicYear: string, scope: string): void {
  const stamp = `Сформовано автоматично ${fmtDate(input.generatedAt)} · ${SYSTEM_NAME}`;
  const trail = `${input.specialtyCode} ${input.specialtyName} · ${scope} · ${academicYear} н. р.`;
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
