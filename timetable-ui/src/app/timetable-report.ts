/**
 * The printable «РОЗКЛАД ЗАНЯТЬ» — the sheet a faculty publishes for its groups and a кафедра works
 * from for its lecturers, built from exactly the grid the screen shows.
 *
 * Framework-free, like the other three report modules: a {@link TimetableGrid} plus a pair of fonts
 * in, PDF bytes out.
 *
 * ── Why the document looks the way it does ─────────────────────────────────────────────────────
 *
 * **The розклад занять is the least regulated document in this system — it has no legal existence
 * at all.** The term does not appear in the Закон України «Про вищу освіту»; ст. 30 ч. 2 Закону
 * «Про освіту», which lists what a заклад освіти must publish on its website, does not include it;
 * the Ліцензійні умови (ПКМУ № 1187) name a розклад only for дошкільна and загальна середня освіта.
 * Its familiar rules — академічна година 45 хв, пара = дві академічні години, навчальний день ≤ 9
 * годин — are п. 3.2 and п. 4.1–4.2 of наказ МО України № 161 від 02.06.1993, **repealed** by наказ
 * МОН № 1310 від 13.11.2014 and since copied into ЗВО положення by hand. **Do not present this
 * sheet as required by law.**
 *
 * ── One sheet is approved; three are reference prints ─────────────────────────────────────────
 *
 * Only the **faculty** timetable is a document anyone signs. That matches both the practice and the
 * reason for it: what ЗВО publish and approve is the розклад of academic groups (ЗНУ п. 5.4.2, ОНУ
 * п. 5.4, ДБТУ п. 7.9 all place approval with the проректор з науково-педагогічної роботи), while
 * the **викладацький розклад** is served from a web service rather than issued on paper — ЛНУ's own
 * «ПС-Розклад» and the faculty pages generate it on demand — and the **аудиторний розклад** is an
 * internal instrument of the диспетчерська and навчальний відділ that is not published at all (КПІ
 * does not even expose a room filter).
 *
 * So {@link isOfficial} splits the output in two. The faculty sheet carries the whole apparatus —
 * гриф ЗАТВЕРДЖУЮ, the МОН → ЗВО → факультет letterhead, ПОГОДЖЕНО and a signature block. The
 * department, lecturer and room sheets carry none of it: a compact heading, the timetable, the
 * bells, and a line saying the sheet is довідковий. Printing a гриф on a sheet nobody approves
 * would not be a harmless flourish — it would assert an approval that never happened.
 *
 * A sheet with **one subject** (a lecturer, a room) is also laid out as a **list** rather than a
 * one-column grid: a single column stretched across a landscape sheet is not a convenient thing to
 * read, and what such a reader wants is «коли і де», in order.
 *
 * What is reproduced is the layout ЛНУ ім. І. Франка actually publishes, verified against the
 * current sheets of ф-т прикладної математики та інформатики, економічний and філософський
 * факультети:
 *
 *   • **rows are день → пара** (Roman numeral plus its time span), **columns are academic groups** —
 *     one sheet per курс, not one per group;
 *   • a cell reads **ДИСЦИПЛІНА → вид заняття → аудиторія → посада і прізвище викладача**;
 *   • the гриф is «ЗАТВЕРДЖУЮ / Проректор», left unfilled for signature, and the декан signs at the
 *     foot — the проректор approves, the декан submits (ЗНУ п. 5.4.2, ОНУ п. 5.4, ДБТУ п. 7.9 all
 *     put approval with the проректор з науково-педагогічної роботи);
 *   • «ПОГОДЖЕНО / Начальник навчального відділу», as ХНУ ім. Каразіна prints it — the only real
 *     погодження found; no ЗВО visas a розклад with the профспілка or студрада;
 *   • a **legend of rooms**, because ЛНУ's sheets carry one and a room number alone does not say
 *     which building it is in.
 *
 * Signatures follow ДСТУ 4163:2020 — «Власне ім'я ПРІЗВИЩЕ», no initials. ЛНУ itself is
 * inconsistent here (ПМІ already writes «Іван ДИЯК», економічний still «(Р.В. Михайлишин)»); the
 * standard's form is used.
 */

import { WEEK_PARITY_OPTIONS } from './entities';
import { fmtNumber } from './curriculum-plan';
import {
  DAY_NAMES, GridEntry, TimetableGrid, dayIsEmpty, gridCell
} from './timetable-grid';
import { PdfDocument, PdfTableRow, RGB, TtfFont } from './pdf-writer';
import { SYSTEM_NAME, UNIVERSITY_NAME, academicYearLabel } from './workload-report';

const MINISTRY_NAME = 'МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ';

const A4_LANDSCAPE = { widthMm: 297, heightMm: 210 };
const MARGINS = { top: 20, right: 10, bottom: 20, left: 30 };

const HEADER_FILL: RGB = [0.93, 0.94, 0.96];
const DAY_FILL: RGB = [0.9, 0.92, 0.95];
const MUTED: RGB = [0.42, 0.45, 0.5];

/** What the sheet is a timetable *of* — which decides its title, columns and signature block. */
export type TimetableReportKind = 'FACULTY' | 'DEPARTMENT' | 'LECTURER' | 'ROOM' | 'ACADEMIC_GROUP';

export interface TimetableReportInput {
  kind: TimetableReportKind;
  /** The grid the screen is showing — same object, so the two cannot disagree. */
  grid: TimetableGrid;
  /** «Факультет прикладної математики та інформатики» / «Кафедра програмування» / a name. */
  subjectName: string;
  /** The faculty this belongs to, for the letterhead; blank for a university-wide sheet. */
  facultyName: string;
  /** ODD / EVEN. Every sheet covers exactly one half-year; anything else is read as ODD. */
  semesterParity: string;
  generatedAt: Date;
  fonts: { regular: TtfFont; bold: TtfFont };
}

const parityLabel = (v: string): string =>
  WEEK_PARITY_OPTIONS.find((o) => o.value === v)?.label ?? v;

/**
 * Whether this sheet is a document that gets approved, or a reference print.
 *
 * Only the faculty timetable is approved — see the note at the top of this file. Everything the
 * apparatus consists of (гриф, letterhead, підписи) hangs off this one predicate, so the two kinds
 * of output cannot drift apart.
 */
export const isOfficial = (kind: TimetableReportKind): boolean => kind === 'FACULTY';

const KIND_TITLE: Record<TimetableReportKind, string> = {
  FACULTY: 'РОЗКЛАД ЗАНЯТЬ', DEPARTMENT: 'РОЗКЛАД ЗАНЯТЬ КАФЕДРИ',
  LECTURER: 'РОЗКЛАД ЗАНЯТЬ ВИКЛАДАЧА', ROOM: 'РОЗКЛАД ЗАЙНЯТОСТІ АУДИТОРІЇ',
  ACADEMIC_GROUP: 'РОЗКЛАД ЗАНЯТЬ АКАДЕМІЧНОЇ ГРУПИ'
};

/** What runs across the top of the sheet, named for its own header cell. */
const KIND_COLUMN_TITLE: Record<TimetableReportKind, string> = {
  FACULTY: 'Академічні групи', DEPARTMENT: 'Викладачі',
  LECTURER: 'Заняття', ROOM: 'Заняття', ACADEMIC_GROUP: 'Заняття'
};

const fmtDate = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

/** «Розклад_занять_ФПМІ_2026-2027.pdf» */
export function timetableReportFileName(
  kind: TimetableReportKind, subjectName: string, academicYear: string): string {
  const safe = subjectName.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const prefix = kind === 'ROOM' ? 'Розклад_аудиторії'
               : kind === 'LECTURER' ? 'Розклад_викладача'
               : kind === 'DEPARTMENT' ? 'Розклад_кафедри'
               : kind === 'ACADEMIC_GROUP' ? 'Розклад_групи'
               : 'Розклад_занять';
  return `${prefix}_${safe || 'розклад'}_${academicYear.replace('/', '-')}.pdf`;
}

export function buildTimetableReport(input: TimetableReportInput): Uint8Array {
  const { grid, fonts } = input;
  const academicYear = academicYearLabel(input.generatedAt);

  const doc = new PdfDocument({
    ...A4_LANDSCAPE,
    margins: MARGINS,
    fonts: { regular: fonts.regular, bold: fonts.bold },
    defaultFont: 'regular',
    defaultSize: 11,
    title: `${KIND_TITLE[input.kind]} — ${input.subjectName} — ${academicYear}`,
    author: UNIVERSITY_NAME,
    subject: input.facultyName || UNIVERSITY_NAME,
    createdAt: input.generatedAt
  });

  const official = isOfficial(input.kind);

  if (official) {
    drawApprovalGrif(doc);
    drawLetterhead(doc, input);
  } else {
    drawReferenceHeading(doc, input);
  }
  drawTitle(doc, input, academicYear, official);

  // A sheet about one lecturer or one room reads better as a list than as a single tall column.
  if (grid.columns.length > 1) drawGrid(doc, input);
  else drawList(doc, input);

  drawBells(doc, grid);
  drawRoomLegend(doc, grid);
  drawNotes(doc, input);
  if (official) drawSignatures(doc, input);
  drawPageFurniture(doc, input, academicYear);

  return doc.render();
}

// ── Heading ─────────────────────────────────────────────────────────────────

/**
 * ЛНУ prints this unfilled, for a wet signature — «Затверджую / Проректор / ____ / "__" ____ 20__».
 * Reproduced as such rather than naming a post-holder the system does not store.
 */
function drawApprovalGrif(doc: PdfDocument): void {
  const boxWidth = 92;
  const x = doc.margins.left + doc.contentWidth - boxWidth;
  const size = 10;
  const pitch = doc.lineHeight(size, 1.2);
  const lines: { text: string; bold?: boolean }[] = [
    { text: 'ЗАТВЕРДЖУЮ', bold: true },
    { text: 'Проректор з науково-педагогічної роботи' },
    { text: '' },
    { text: '____________   ____________________' }
  ];
  lines.forEach((line, i) => {
    doc.drawText(line.text, {
      x, y: doc.y + pitch * i + 3.2, size, font: line.bold ? 'bold' : 'regular', width: boxWidth
    });
  });
  let y = doc.y + pitch * lines.length;
  doc.drawText('(підпис)', { x: x + 2, y: y + 2.4, size: 7.5, color: MUTED });
  doc.drawText('(Власне ім’я ПРІЗВИЩЕ)', { x: x + 32, y: y + 2.4, size: 7.5, color: MUTED });
  doc.drawText('«___» ____________ 20___ р.', { x, y: y + pitch + 3.2, size });
  doc.y = doc.margins.top;
}

function drawLetterhead(doc: PdfDocument, input: TimetableReportInput): void {
  const left = doc.margins.left;
  const width = doc.contentWidth - 100;
  const centred = (text: string, size: number, font: 'regular' | 'bold') => {
    if (!text.trim()) return;
    doc.y += doc.drawParagraph(text, { x: left, y: doc.y, width, size, font, align: 'center' });
  };
  centred(MINISTRY_NAME, 10, 'regular');
  centred(UNIVERSITY_NAME.toUpperCase(), 11, 'bold');
  if (input.facultyName) { doc.space(1.5); centred(input.facultyName, 10, 'regular'); }
  doc.y = Math.max(doc.y, doc.margins.top + 30);
}

/**
 * One quiet line naming where the sheet came from. No ministry, no гриф — this is a print-out, and
 * dressing it as an issued document would misrepresent it.
 */
function drawReferenceHeading(doc: PdfDocument, input: TimetableReportInput): void {
  const origin = [UNIVERSITY_NAME, input.facultyName].filter(Boolean).join(' · ');
  doc.writeParagraph(origin, { size: 9, color: MUTED });
  doc.space(2);
}

function drawTitle(doc: PdfDocument, input: TimetableReportInput, academicYear: string,
                   official: boolean): void {
  doc.space(official ? 5 : 1);
  const left = doc.margins.left;
  const width = doc.contentWidth;
  doc.y += doc.drawParagraph(KIND_TITLE[input.kind],
                             { x: left, y: doc.y, width, size: official ? 14 : 13,
                               font: 'bold', align: official ? 'center' : 'left' });

  // 'EVEN' or anything else: a sheet always covers one half-year (see TimetableView.parityOptions),
  // and a heading that named the whole year would be describing a grid that cannot be produced.
  const half = input.semesterParity === 'EVEN' ? 'ІІ семестр' : 'І семестр';
  const subtitle = [input.subjectName, `${half} ${academicYear} навчального року`]
    .filter(Boolean).join(' · ');
  doc.y += doc.drawParagraph(subtitle, {
    x: left, y: doc.y, width, size: official ? 11.5 : 10.5, align: official ? 'center' : 'left'
  });
  if (!official) {
    doc.space(1);
    doc.y += doc.drawParagraph('Довідковий документ. Затвердженню не підлягає.',
                               { x: left, y: doc.y, width, size: 8.5, color: MUTED });
  }
  doc.space(5);
}

// ── The grid ────────────────────────────────────────────────────────────────

/**
 * Day and пара down the side, the chosen dimension across the top — the ЛНУ layout. Columns are
 * split across sheets when there are more of them than a landscape А4 can carry legibly, because a
 * розклад squeezed to six-point type is not a document anyone reads.
 */
function drawGrid(doc: PdfDocument, input: TimetableReportInput): void {
  const grid = input.grid;

  if (!grid.slots.length || !grid.columns.length) {
    doc.writeParagraph('Занять у розкладі ще немає.', { size: 10, color: MUTED });
    doc.space(6);
    return;
  }

  // Millimetres. День and Пара are fixed; what is left is shared by the subject columns.
  const dayWidth = 20;
  const slotWidth = 24;
  const available = doc.contentWidth - dayWidth - slotWidth;
  // A column narrower than this cannot hold «ПРОГРАМУВАННЯ» at 6.5 pt without breaking mid-word.
  const minColumnWidth = 30;
  const perSheet = Math.max(1, Math.floor(available / minColumnWidth));

  const batches: typeof grid.columns[] = [];
  for (let i = 0; i < grid.columns.length; i += perSheet) {
    batches.push(grid.columns.slice(i, i + perSheet));
  }

  batches.forEach((batch, index) => {
    if (index > 0) {
      doc.addPage();
      doc.y += doc.drawParagraph(`${KIND_TITLE[input.kind]} (продовження)`, {
        x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 11, font: 'bold'
      });
      doc.space(2);
    }

    const columnWidth = available / batch.length;
    const columns = [
      { title: 'День', width: dayWidth, align: 'center' as const },
      { title: 'Пара', width: slotWidth, align: 'center' as const },
      ...batch.map((c) => ({ title: c.label, width: columnWidth, align: 'left' as const }))
    ];

    const headerRows: PdfTableRow[] = [
      {
        cells: [
          { text: 'День', rowSpan: 2 },
          { text: 'Пара', rowSpan: 2 },
          { text: KIND_COLUMN_TITLE[input.kind], colSpan: batch.length }
        ]
      },
      { cells: batch.map((c) => ({ text: c.label })) }
    ];

    const rows: PdfTableRow[] = [];
    for (const day of grid.days) {
      if (dayIsEmpty(grid, day)) continue;   // a day nobody teaches on is not a row
      let first = true;
      for (const slot of grid.slots) {
        const cells = batch.map((c) => ({ text: cellText(gridCell(grid, day, slot.ordinal, c.id)) }));
        // A пара with nothing in it anywhere on this sheet is dropped, so a five-пара day does not
        // print eight rows of dashes.
        if (cells.every((c) => !c.text)) continue;
        rows.push({
          cells: [
            { text: first ? DAY_NAMES[day] ?? String(day) : '', align: 'center', font: 'bold' },
            { text: `${slot.roman}\n${slot.startTime}–${slot.endTime}`, align: 'center' },
            ...cells
          ],
          fill: first ? DAY_FILL : undefined
        });
        first = false;
      }
    }

    if (!rows.length) {
      doc.writeParagraph('Занять у розкладі ще немає.', { size: 10, color: MUTED });
      doc.space(6);
      return;
    }

    doc.drawTable({
      columns, headerRows, rows,
      headerFill: HEADER_FILL,
      headFont: 'bold',
      strongFont: 'bold',
      size: 7,
      headerSize: 7.5,
      padX: 1.1,
      padY: 1.1,
      onContinue: () => {
        doc.y += doc.drawParagraph(`${KIND_TITLE[input.kind]} (продовження)`, {
          x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
        });
        doc.space(1);
      }
    });
    doc.space(5);
  });

  if (grid.unplaced.length) {
    doc.writeParagraph(
      `Не розміщено в сітці: ${grid.unplaced.length} занять (немає часу початку або ` +
      'групи / викладача / аудиторії, за якими будується колонка).',
      { size: 8.5, color: MUTED });
    doc.space(4);
  }
}

/**
 * A sheet about a single subject, as a list rather than a grid: день · пара · час · дисципліна ·
 * вид · аудиторія · with whoever the other party is. A lecturer reading their own timetable wants
 * «коли і де» in order, and one column stretched across a landscape sheet gives them neither.
 */
function drawList(doc: PdfDocument, input: TimetableReportInput): void {
  const grid = input.grid;
  const column = grid.columns[0];

  if (!grid.slots.length || !column) {
    doc.writeParagraph('Занять у розкладі ще немає.', { size: 10, color: MUTED });
    doc.space(6);
    return;
  }

  // The far column names the other party: a lecturer's sheet lists the groups they teach, a room's
  // sheet the lecturer using it — neither needs to be told what it is itself.
  const otherTitle = input.kind === 'ROOM' ? 'Викладач і групи'
                   : input.kind === 'ACADEMIC_GROUP' ? 'Викладач'
                   : 'Академічні групи';
  const columns = [
    { title: 'День', width: 24, align: 'left' as const },
    { title: 'Пара', width: 12, align: 'center' as const },
    { title: 'Час', width: 24, align: 'center' as const },
    { title: 'Тиждень', width: 24, align: 'center' as const },
    { title: 'Навчальна дисципліна', width: 72, align: 'left' as const },
    { title: 'Вид заняття', width: 24, align: 'left' as const },
    { title: 'Аудиторія', width: 22, align: 'left' as const },
    { title: otherTitle, width: 55, align: 'left' as const }
  ];

  const rows: PdfTableRow[] = [];
  for (const day of grid.days) {
    if (dayIsEmpty(grid, day)) continue;
    let first = true;
    for (const slot of grid.slots) {
      for (const e of gridCell(grid, day, slot.ordinal, column.id)) {
        const other = input.kind === 'ROOM'
          ? [e.lecturers.map((l) => l.withPosition).join(', '), e.groupNames].filter(Boolean).join(' · ')
          : input.kind === 'ACADEMIC_GROUP'
            ? e.lecturers.map((l) => l.withPosition).join(', ')
            : e.groupNames;
        rows.push({
          cells: [
            { text: first ? DAY_NAMES[day] ?? String(day) : '', font: first ? 'bold' : undefined },
            { text: slot.roman, align: 'center' },
            { text: `${slot.startTime}–${slot.endTime}`, align: 'center' },
            { text: e.weekParity && e.weekParity !== 'WEEKLY' ? parityLabel(e.weekParity) : 'щотижня',
              align: 'center' },
            e.courseName,
            e.hourTypeShort || '—',
            e.roomLabel || '—',
            other || '—'
          ],
          fill: first ? DAY_FILL : undefined
        });
        first = false;
      }
    }
  }

  if (!rows.length) {
    doc.writeParagraph('Занять у розкладі ще немає.', { size: 10, color: MUTED });
    doc.space(6);
    return;
  }

  doc.drawTable({
    columns, rows,
    headerFill: HEADER_FILL,
    headFont: 'bold',
    strongFont: 'bold',
    size: 8.5,
    headerSize: 8.5,
    onContinue: () => {
      doc.y += doc.drawParagraph(`${KIND_TITLE[input.kind]} (продовження)`, {
        x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
      });
      doc.space(1);
    }
  });
  doc.space(6);

  if (grid.unplaced.length) {
    doc.writeParagraph(
      `Не розміщено: ${grid.unplaced.length} занять без часу початку.`,
      { size: 8.5, color: MUTED });
    doc.space(4);
  }
}

/**
 * One cell, in the order ЛНУ prints it: discipline, kind of class, room, then the lecturers with
 * their posts. A biweekly class is prefixed with its half of the fortnight, since two of them share
 * the cell.
 */
function cellText(entries: GridEntry[]): string {
  return entries.map((e) => {
    const head = e.weekParity && e.weekParity !== 'WEEKLY' ? `[${parityLabel(e.weekParity)}] ` : '';
    const parts = [
      `${head}${e.courseName.toUpperCase()}`,
      [e.hourTypeShort, e.roomLabel].filter(Boolean).join(', '),
      e.lecturers.map((l) => l.withPosition).join(', ')
    ].filter(Boolean);
    return parts.join('\n');
  }).join('\n———\n');
}

// ── Сітка дзвінків ──────────────────────────────────────────────────────────

/**
 * ЛНУ carries the bell times inside the «Пара» column rather than as a separate block, and this
 * sheet does too — but a compact restatement is printed underneath, because a reader checking a
 * single class should not have to scan the grid to learn when пара IV runs.
 */
function drawBells(doc: PdfDocument, grid: TimetableGrid): void {
  if (!grid.slots.length) return;
  doc.ensure(18);
  const line = grid.slots
    .map((s) => `${s.roman} — ${s.startTime}–${s.endTime}`)
    .join(' · ');
  doc.writeParagraph(`Розклад дзвінків: ${line}`, { size: 8.5 });
  doc.space(3);
}

function drawRoomLegend(doc: PdfDocument, grid: TimetableGrid): void {
  if (grid.rooms.length < 2) return;
  doc.ensure(16);
  doc.writeParagraph(
    'Аудиторії: ' + grid.rooms.map((r) => r.label).join(' · '),
    { size: 8, color: MUTED });
  doc.space(4);
}

function drawNotes(doc: PdfDocument, input: TimetableReportInput): void {
  const grid = input.grid;
  const biweekly = grid.entries.filter((e) => e.weekParity && e.weekParity !== 'WEEKLY').length;
  const notes: string[] = [];
  if (biweekly) {
    notes.push('Заняття, позначені [Чисельник] або [Знаменник], проводяться через тиждень; ' +
               'решта — щотижня.');
  }
  if (isOfficial(input.kind)) {
    notes.push('Розклад занять — внутрішній документ закладу вищої освіти: законодавство не ' +
               'встановлює ні його форми, ні обов’язку оприлюднення. Порядок складання та строки ' +
               'доведення до відома учасників освітнього процесу визначає заклад.');
  } else {
    // Said plainly, because a sheet that looks like a document but is not one is worse than a
    // plain print-out: it invites someone to treat it as authoritative.
    notes.push('Аркуш сформовано для довідки. Він не затверджується і не погоджується: ' +
               'затвердженню підлягає розклад занять факультету, складений за академічними ' +
               'групами. Актуальні дані — у системі планування освітнього процесу.');
  }
  if (input.kind === 'ROOM') {
    notes.push('Аркуш показує зайнятість аудиторії — це робочий інструмент навчального відділу ' +
               'та диспетчерської, а не розклад, що оприлюднюється для здобувачів.');
  }
  if (input.kind === 'LECTURER') {
    notes.push('Персональний розклад викладача формується із наявного навантаження та може ' +
               'змінюватися разом із розкладом факультету.');
  }
  if (input.kind === 'ACADEMIC_GROUP') {
    // The same rows as the approved faculty sheet, cut to one column. Saying so is the point: a
    // student printing their own timetable should know which sheet is the one that governs.
    notes.push('Аркуш показує заняття однієї академічної групи, вибрані з розкладу факультету. ' +
               'Затверджується розклад факультету загалом; за розбіжності чинним є він.');
  }

  doc.ensure(14 + notes.length * 6);
  doc.y += doc.drawParagraph('Примітки', {
    x: doc.margins.left, y: doc.y, width: doc.contentWidth, size: 10, font: 'bold'
  });
  doc.space(1);
  notes.forEach((note, i) => {
    doc.writeParagraph(`${i + 1}. ${note}`, { size: 8.5, color: MUTED });
    doc.space(1);
  });
  doc.space(5);
}

// ── Signatures ──────────────────────────────────────────────────────────────

/** The декан (or завідувач кафедри) submits; the навчальний відділ visas; the проректор approves. */
function drawSignatures(doc: PdfDocument, input: TimetableReportInput): void {
  doc.ensure(46);

  const left = doc.margins.left;
  const signatureX = left + 118;
  const nameX = left + 175;
  const pitch = 11;

  doc.drawText('ПОГОДЖЕНО', { x: left, y: doc.y, size: 10.5, font: 'bold' });
  doc.y += pitch;

  const roles = input.kind === 'DEPARTMENT'
    ? ['Начальник навчального відділу', 'Декан факультету', 'Завідувач кафедри']
    : ['Начальник навчального відділу', 'Декан факультету'];

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

function drawPageFurniture(doc: PdfDocument, input: TimetableReportInput, academicYear: string): void {
  const stamp = `Сформовано автоматично ${fmtDate(input.generatedAt)} · ${SYSTEM_NAME}`;
  const classes = input.grid.entries.length;
  const trail = `${input.subjectName} · ${academicYear} н. р. · ${fmtNumber(classes)} занять`;
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
