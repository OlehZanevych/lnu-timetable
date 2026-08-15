/**
 * The printable «Розрахунок навчального навантаження науково-педагогічного працівника» — the paper
 * form a department head signs, built from exactly the numbers the assessment page shows.
 *
 * Framework-free, like `workload-stats.ts` and `workload-generator.ts`: it takes plain data plus a
 * pair of fonts and returns PDF bytes, so it can be rendered under Node in a test as easily as in
 * the browser. Everything it needs is already computed by {@link computeStats}; it does no
 * arithmetic of its own beyond summing rows, so the document and the screen cannot disagree.
 *
 * ── Why the document looks the way it does ─────────────────────────────────────────────────────
 *
 * There is no single national template. The legal footing is Закон України «Про вищу освіту»,
 * ст. 56 — 36-годинний робочий тиждень and a ceiling of 600 годин навчального навантаження на
 * ставку за навчальний рік. The old наказ МОН № 450 від 07.08.2002, which used to prescribe норми
 * часу centrally, **втратив чинність** (наказ МОН № 187 від 16.02.2022), so each ЗВО now sets its
 * own норми by an internal положення — which is why nothing here cites № 450. What has survived is
 * the *shape* of the document, near-identical across КПІ (форми К-2 / К-4-Б), ЗНУ, ХНЕУ, ХНУМГ and
 * ТНПУ, and that shape is what is reproduced:
 *
 *   • гриф ЗАТВЕРДЖУЮ у правому верхньому куті першого аркуша (реквізит 16, ДСТУ 4163:2020);
 *   • шапка: МОН України → назва ЗВО → факультет → кафедра;
 *   • ідентифікація працівника: ПІБ, посада, науковий ступінь, кафедра, факультет, навчальний рік;
 *   • зведені показники з нормою на ставку та відхиленням;
 *   • розподіл годин за видами навчальної роботи, окремо обов'язкові та вибіркові дисципліни;
 *   • склад навантаження за півріччями, кожне з власним підсумком, і всього за рік;
 *   • блок підписів: засідання кафедри (протокол), завідувач, декан, сам працівник.
 *
 * Typography follows ДСТУ 4163:2020: Times-metric serif (Liberation Serif), 12–14 pt, береги
 * ліве 30 / праве 10 / верхнє 20 / нижнє 20 мм, номер сторінки посередині верхнього берега з
 * другого аркуша, підпис як «Власне ім'я ПРІЗВИЩЕ» (ініціали стандартом більше не передбачені).
 * The sheet is landscape А4 because the «Склад навантаження» table carries nine columns.
 *
 * «Відповідність обмеженням» is deliberately **not** included: those bounds are an internal
 * planning aid of this system, not a reviewable attribute of the workload itself.
 */

import {
  HALF_YEARS, HALF_YEAR_TITLES, courseTypeLabel, courseYearOf, halfYearOf, positionLabel
} from './entities';
import { PdfDocument, PdfTableRow, RGB, TtfFont } from './pdf-writer';
import { compareUk } from './sort';
import { LecturerStats, STAT_HOUR_TYPES } from './workload-stats';

/** Position of a kind of work in the order the document presents them; unknown kinds sort last. */
const hourTypeOrder = (hourType: string): number => {
  const at = (STAT_HOUR_TYPES as readonly string[]).indexOf(hourType);
  return at < 0 ? STAT_HOUR_TYPES.length : at;
};

/** Hour-type headings, in the order `STAT_HOUR_TYPES` lists them. */
const HOUR_TYPE_LABELS: Record<string, string> = {
  LECTURE: 'Лекції', PRACTICAL: 'Практичні', LAB: 'Лабораторні',
  CONSULTATION: 'Консультації', ASSESSMENT: 'Контрольні заходи',
  INDEPENDENT_WORK: 'Самостійна робота'
};

const TEACHING_FORMAT_LABELS: Record<string, string> = {
  TOGETHER: 'Разом', SEPARATELY: 'Окремо', INDIVIDUALLY: 'Індивідуально'
};

export const UNIVERSITY_NAME = 'Львівський національний університет імені Івана Франка';

/**
 * What the footer of every generated sheet names as its origin.
 *
 * Shared rather than repeated: this module once said «система обліку навчального навантаження» while
 * the other three said «система планування освітнього процесу», and four copies of a string are
 * four chances for a set of documents from one system to look like documents from four.
 */
export const SYSTEM_NAME = 'система планування освітнього процесу ЛНУ';
const MINISTRY_NAME = 'МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ';

const A4_LANDSCAPE = { widthMm: 297, heightMm: 210 };
/** ДСТУ 4163:2020, п. 5: ліве 30 мм, праве 10 мм, верхнє та нижнє по 20 мм. */
const MARGINS = { top: 20, right: 10, bottom: 20, left: 30 };

const HEADER_FILL: RGB = [0.93, 0.94, 0.96];
const SUBTOTAL_FILL: RGB = [0.965, 0.97, 0.98];
const MUTED: RGB = [0.42, 0.45, 0.5];

export interface WorkloadReportInput {
  /** The lecturer's computed workload — the same row the assessment page renders. */
  stats: LecturerStats;
  facultyName: string;
  departmentName: string;
  /** Raw `lecturers.position` enum value, or '' when unset. */
  position: string;
  /** Academic degree name, or '' when unset. */
  academicDegree: string;
  /** The global `default_max_hours_per_year`, used to caption a borrowed ceiling. */
  defaultMaxHours: number | null;
  /** Passed in rather than read, so the same input always yields the same bytes. */
  generatedAt: Date;
  fonts: { regular: TtfFont; bold: TtfFont };
}

/**
 * The academic year a date falls in, as «2025/2026». Ukrainian academic years start on 1 вересня;
 * серпень is already counted as the new year because that is when навантаження is being planned
 * and signed off (до 31 серпня — засідання кафедри).
 */
export const academicYearLabel = (date: Date): string => {
  const start = date.getMonth() >= 7 ? date.getFullYear() : date.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

/** «Навантаження_Мельник_2025-2026.pdf» — surname first, so a folder of these sorts usefully. */
export const workloadReportFileName = (lecturerName: string, academicYear: string): string => {
  const surname = (lecturerName.trim().split(/\s+/)[0] || 'викладач').replace(/[\\/:*?"<>|]/g, '');
  return `Навантаження_${surname}_${academicYear.replace('/', '-')}.pdf`;
};

const fmtHours = (v: number): string =>
  Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');

const fmtDate = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

/** «Кафедра прикладної математики», without doubling a name that already carries the word. */
const departmentLine = (name: string): string =>
  /^кафедр/i.test(name.trim()) ? name.trim() : `Кафедра ${name.trim()}`;

export function buildLecturerWorkloadReport(input: WorkloadReportInput): Uint8Array {
  const { stats, fonts } = input;
  const academicYear = academicYearLabel(input.generatedAt);

  const doc = new PdfDocument({
    ...A4_LANDSCAPE,
    margins: MARGINS,
    fonts: { regular: fonts.regular, bold: fonts.bold },
    defaultFont: 'regular',
    defaultSize: 11,
    title: `Розрахунок навчального навантаження — ${stats.name} — ${academicYear}`,
    author: UNIVERSITY_NAME,
    subject: `${departmentLine(input.departmentName)}, ${input.facultyName}`,
    createdAt: input.generatedAt
  });

  const left = doc.margins.left;
  const width = doc.contentWidth;

  drawApprovalGrif(doc, left, width);
  drawLetterhead(doc, left, width, input);
  drawTitle(doc, left, width, academicYear);
  drawIdentity(doc, input, academicYear);
  drawLegalBasis(doc);

  // The first sheet is the титульна сторінка of the form — гриф, шапка, назва, дані працівника.
  // The calculation itself always starts on its own page, as it does in the paper forms this
  // follows, so a reader always finds the tables in the same place regardless of how long they run.
  doc.addPage();

  drawSummary(doc, input);
  drawHourTypeBreakdown(doc, stats);
  drawPositions(doc, stats);
  drawSignatures(doc);
  drawPageFurniture(doc, input);

  return doc.render();
}

// ── Page 1 heading ──────────────────────────────────────────────────────────

function drawApprovalGrif(doc: PdfDocument, left: number, width: number): void {
  const boxWidth = 100;
  const x = left + width - boxWidth;
  const size = 10;
  const pitch = doc.lineHeight(size, 1.2);
  const lines = [
    'ЗАТВЕРДЖУЮ',
    'Проректор з науково-педагогічної роботи',
    'Львівського національного університету',
    'імені Івана Франка',
    '',
    '______________   ________________________'
  ];
  lines.forEach((line, i) => {
    doc.drawText(line, {
      x, y: doc.y + pitch * i + 3.2, size,
      font: i === 0 ? 'bold' : 'regular', width: boxWidth
    });
  });
  doc.drawText('(підпис)', { x: x + 2, y: doc.y + pitch * lines.length + 2.4, size: 8, color: MUTED });
  doc.drawText('(Власне ім’я ПРІЗВИЩЕ)',
               { x: x + 34, y: doc.y + pitch * lines.length + 2.4, size: 8, color: MUTED });
  doc.drawText('«___» ____________ 20___ р.',
               { x, y: doc.y + pitch * (lines.length + 1) + 3.2, size });
  doc.y += pitch * (lines.length + 2);
}

function drawLetterhead(doc: PdfDocument, left: number, width: number,
                        input: WorkloadReportInput): void {
  doc.space(4);
  const centred = (text: string, size: number, font: 'regular' | 'bold') => {
    if (!text.trim()) return;   // an unnamed faculty leaves no gap, rather than a blank line
    doc.y += doc.drawParagraph(text, { x: left, y: doc.y, width, size, font, align: 'center' });
  };
  centred(MINISTRY_NAME, 11, 'regular');
  centred(UNIVERSITY_NAME.toUpperCase(), 12, 'bold');
  doc.space(2);
  centred(input.facultyName, 11, 'regular');
  centred(input.departmentName.trim() ? departmentLine(input.departmentName) : '', 11, 'regular');
}

function drawTitle(doc: PdfDocument, left: number, width: number, academicYear: string): void {
  doc.space(6);
  doc.y += doc.drawParagraph('РОЗРАХУНОК НАВЧАЛЬНОГО НАВАНТАЖЕННЯ',
                             { x: left, y: doc.y, width, size: 14, font: 'bold', align: 'center' });
  doc.y += doc.drawParagraph(
    `науково-педагогічного працівника на ${academicYear} навчальний рік`,
    { x: left, y: doc.y, width, size: 12, align: 'center' });
  doc.space(5);
}

function drawIdentity(doc: PdfDocument, input: WorkloadReportInput, academicYear: string): void {
  const label = (text: string) => ({ text, font: 'regular' });
  const value = (text: string) => ({ text: text || '—', font: 'bold' as const });

  doc.drawTable({
    columns: [
      { width: 55 }, { width: 73 }, { width: 55 }, { width: 74 }
    ],
    showHeader: false,
    size: 10.5,
    bodyFont: 'regular',
    padY: 1.8,
    rows: [
      { cells: [label('Прізвище, ім’я, по батькові'), value(input.stats.name),
                label('Кафедра'), value(input.departmentName)] },
      { cells: [label('Посада'), value(input.position ? positionLabel(input.position) : ''),
                label('Факультет'), value(input.facultyName)] },
      { cells: [label('Науковий ступінь'), value(input.academicDegree),
                label('Навчальний рік'), value(academicYear)] }
    ]
  });
  doc.space(7);
}

/**
 * The norm the whole calculation is measured against. Наказ МОН № 450 від 07.08.2002 is not cited:
 * it втратив чинність (наказ МОН № 187 від 16.02.2022), and норми часу are now set by each ЗВО.
 */
function drawLegalBasis(doc: PdfDocument): void {
  doc.writeParagraph(
    'Підстава: стаття 56 Закону України «Про вищу освіту» — робочий час науково-педагогічного ' +
    'працівника становить 36 годин на тиждень, максимальне навчальне навантаження на одну ставку ' +
    'не може перевищувати 600 годин на навчальний рік. Норми часу для планування й обліку ' +
    'навчальної роботи встановлює заклад вищої освіти.',
    { size: 9.5, color: MUTED });
}

// ── Section 1: summary ──────────────────────────────────────────────────────

function sectionHeading(doc: PdfDocument, text: string, minSpace = 24): void {
  doc.ensure(minSpace);
  doc.y += doc.drawParagraph(text, {
    x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 12, font: 'bold'
  });
  doc.space(1.5);
}

function halfYearHours(stats: LecturerStats, half: 1 | 2): number {
  return stats.items
    .filter((i) => halfYearOf(i.semester) === half)
    .reduce((sum, i) => sum + i.hours, 0);
}

function drawSummary(doc: PdfDocument, input: WorkloadReportInput): void {
  const s = input.stats;
  sectionHeading(doc, '1. Зведені показники навчального навантаження');

  const ceilingNote = s.maxHours === null && s.effectiveMaxHours !== null ? ' (типовий)' : '';
  const deviation = s.deviation === 0
    ? 'у межах допустимого обсягу'
    : s.deviation > 0
      ? `+${fmtHours(s.deviation)} (перевищення)`
      : `${fmtHours(s.deviation)} (недовантаження)`;

  const row = (label: string, value: string, strong = false): PdfTableRow =>
    ({ cells: [label, { text: value, align: 'center' }], strong, fill: strong ? SUBTOTAL_FILL : undefined });

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
      row('Усього годин навчального навантаження за рік', fmtHours(s.totalHours), true),
      row('у тому числі за перше півріччя', fmtHours(halfYearHours(s, 1))),
      row('у тому числі за друге півріччя', fmtHours(halfYearHours(s, 2))),
      row('Кількість навчальних дисциплін', String(s.distinctCourses)),
      row('Кількість позицій навантаження', String(s.items.length)),
      row('Мінімальний обсяг навантаження, год',
          s.minHours === null ? 'не встановлено' : fmtHours(s.minHours)),
      row('Максимальний обсяг навантаження, год',
          s.effectiveMaxHours === null ? 'не встановлено' : fmtHours(s.effectiveMaxHours) + ceilingNote),
      row('Відхилення від допустимого обсягу', deviation, s.deviation !== 0)
    ]
  });
  doc.space(8);
}

// ── Section 2: hours by kind of work ────────────────────────────────────────

function drawHourTypeBreakdown(doc: PdfDocument, stats: LecturerStats): void {
  sectionHeading(doc, '2. Розподіл годин за видами навчальної роботи');

  const cells = (by: Record<string, number>) =>
    STAT_HOUR_TYPES.map((t) => ({ text: by[t] ? fmtHours(by[t]) : '—', align: 'center' as const }));
  const sum = (by: Record<string, number>) =>
    STAT_HOUR_TYPES.reduce((acc, t) => acc + (by[t] ?? 0), 0);

  doc.drawTable({
    columns: [
      { title: 'Категорія дисциплін', width: 62, align: 'left' },
      ...STAT_HOUR_TYPES.map((t) => ({ title: HOUR_TYPE_LABELS[t] ?? t, width: 33, align: 'center' as const })),
      { title: 'Разом', width: 30, align: 'center' }
    ],
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 10,
    keepTogether: true,
    rows: [
      {
        cells: ['Усі дисципліни', ...cells(stats.byHourType),
                { text: fmtHours(stats.totalHours), align: 'center' }],
        strong: true, fill: SUBTOTAL_FILL
      },
      {
        cells: ['у тому числі обов’язкові', ...cells(stats.mandatoryByHourType),
                { text: fmtHours(sum(stats.mandatoryByHourType)), align: 'center' }]
      },
      {
        cells: ['у тому числі вибіркові', ...cells(stats.electiveByHourType),
                { text: fmtHours(sum(stats.electiveByHourType)), align: 'center' }]
      }
    ]
  });
  doc.space(6);
}

// ── Section 3: every position ───────────────────────────────────────────────

function drawPositions(doc: PdfDocument, stats: LecturerStats): void {
  // A heading followed by two or three rows before a page break reads as an accident; the section
  // only starts here if a meaningful part of the first table comes with it.
  sectionHeading(doc, '3. Склад навчального навантаження', 70);

  const columns = [
    { title: '№ з/п', width: 10, align: 'center' as const },
    { title: 'Курс', width: 11, align: 'center' as const },
    { title: 'Навчальна дисципліна', width: 60, align: 'left' as const },
    { title: 'Тип дисципліни', width: 26, align: 'left' as const },
    { title: 'Освітня програма', width: 50, align: 'left' as const },
    { title: 'Вид навчальної роботи', width: 25, align: 'left' as const },
    { title: 'Формат проведення', width: 27, align: 'left' as const },
    { title: 'Академічні групи / студенти', width: 33, align: 'left' as const },
    { title: 'Годин', width: 15, align: 'center' as const }
  ];

  for (const half of HALF_YEARS) {
    // Same rows as the screen, but ordered by the canonical kind-of-work sequence rather than by
    // the enum's spelling, so a sheet reads лекції → практичні → лабораторні → консультації →
    // контрольні заходи, exactly as section 2 above lists them.
    const items = stats.items
      .filter((i) => halfYearOf(i.semester) === half)
      .sort((a, b) => a.semester - b.semester
        || compareUk(a.courseName, b.courseName)
        || hourTypeOrder(a.hourType) - hourTypeOrder(b.hourType));
    const hours = items.reduce((sum, i) => sum + i.hours, 0);

    doc.ensure(30);
    doc.y += doc.drawParagraph(`${HALF_YEAR_TITLES[half]}`, {
      x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 11, font: 'bold'
    });
    doc.space(1);

    if (!items.length) {
      doc.writeParagraph('У цьому півріччі позицій навантаження немає.', { size: 10, color: MUTED });
      doc.space(5);
      continue;
    }

    const rows: PdfTableRow[] = items.map((item, i) => ({
      cells: [
        { text: String(i + 1), align: 'center' },
        { text: String(courseYearOf(item.semester)), align: 'center' },
        item.combined ? `${item.courseName} (об’єднана позиція)` : item.courseName,
        courseTypeLabel(item.courseType),
        item.degreeProgramName || '—',
        HOUR_TYPE_LABELS[item.hourType] ?? item.hourType,
        TEACHING_FORMAT_LABELS[item.teachingFormat] ?? item.teachingFormat,
        item.teachingFormat === 'INDIVIDUALLY' && item.students !== undefined
          ? `${item.students} студент(ів)`
          : (item.groupNames.length ? item.groupNames.join(', ') : '—'),
        { text: fmtHours(item.hours), align: 'center' }
      ]
    }));
    rows.push({
      cells: [
        { text: `Разом за ${half === 1 ? 'перше' : 'друге'} півріччя`, colSpan: 8, align: 'right' },
        { text: fmtHours(hours), align: 'center' }
      ],
      strong: true, fill: SUBTOTAL_FILL
    });

    doc.drawTable({
      columns, rows,
      headerFill: HEADER_FILL,
      headFont: 'bold',
      strongFont: 'bold',
      size: 8.5,
      headerSize: 8.5,
      onContinue: () => {
        doc.y += doc.drawParagraph(`${HALF_YEAR_TITLES[half]} (продовження)`, {
          x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
        });
        doc.space(1);
      }
    });
    doc.space(5);
  }

  doc.ensure(20);
  doc.drawTable({
    x: doc.margins.left + doc.contentWidth - 130,
    columns: [{ width: 100, align: 'right' }, { width: 30, align: 'center' }],
    showHeader: false,
    size: 11,
    bodyFont: 'bold',
    rows: [{
      cells: ['ВСЬОГО ЗА НАВЧАЛЬНИЙ РІК, год', fmtHours(stats.totalHours)],
      strong: true, fill: HEADER_FILL
    }]
  });
  doc.space(9);
}

// ── Signatures ──────────────────────────────────────────────────────────────

function drawSignatures(doc: PdfDocument): void {
  // The block is meaningless split across a page break, so it moves whole.
  doc.ensure(56);

  const left = doc.margins.left;
  // The кафедра and факультет are named in the letterhead; repeating them here would need the
  // genitive case, which cannot be derived reliably from a stored nominative name.
  doc.writeParagraph(
    'Розглянуто і затверджено на засіданні кафедри,\n' +
    'протокол № ______ від «____» ________________ 20___ р.',
    { size: 10.5 });
  doc.space(9);

  const signatureX = left + 118;
  const nameX = left + 175;
  const rows = ['Завідувач кафедри', 'Декан факультету', 'Науково-педагогічний працівник'];
  const pitch = 11;
  rows.forEach((label, i) => {
    const y = doc.y + pitch * i;
    doc.drawText(label, { x: left, y, size: 10.5 });
    doc.drawText('___________________', { x: signatureX, y, size: 10.5 });
    doc.drawText('_______________________________', { x: nameX, y, size: 10.5 });
  });
  const captionY = doc.y + pitch * rows.length - 4.5;
  doc.drawText('(підпис)', { x: signatureX, y: captionY, size: 8, color: MUTED, align: 'center', width: 36 });
  doc.drawText('(Власне ім’я ПРІЗВИЩЕ)',
               { x: nameX, y: captionY, size: 8, color: MUTED, align: 'center', width: 55 });

  doc.y += pitch * rows.length + 6;
  doc.drawText('«____» ________________ 20___ р.', { x: left, y: doc.y, size: 10.5 });
  doc.y += 8;
}

// ── Running page furniture ──────────────────────────────────────────────────

/**
 * Page numbers and the origin note, added once the page count is known. ДСТУ 4163:2020 puts the
 * number in the middle of the top margin and leaves the first sheet unnumbered.
 */
function drawPageFurniture(doc: PdfDocument, input: WorkloadReportInput): void {
  const stamp = `Сформовано автоматично ${fmtDate(input.generatedAt)} · ${SYSTEM_NAME}`;
  for (let page = 0; page < doc.pageCount; page++) {
    doc.onPage(page, () => {
      if (page > 0) {
        doc.drawText(String(page + 1), {
          x: doc.margins.left, y: 12, size: 10, align: 'center', width: doc.contentWidth
        });
      }
      doc.drawText(stamp, { x: doc.margins.left, y: doc.heightMm - 9, size: 7.5, color: MUTED });
      doc.drawText(`${input.stats.name} · ${academicYearLabel(input.generatedAt)} н. р.`, {
        x: doc.margins.left, y: doc.heightMm - 9, size: 7.5, color: MUTED,
        align: 'right', width: doc.contentWidth
      });
    });
  }
}
