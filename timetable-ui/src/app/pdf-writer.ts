/**
 * A minimal, dependency-free PDF writer that runs in the browser.
 *
 * Framework-free for the same reason as `workload-generator.ts` and `workload-stats.ts` — it is
 * pure byte assembly over plain data, so it can be unit-tested and even run under Node against a
 * font file, and it keeps the project's "no external dependencies" line: no jsPDF, no pdfmake.
 *
 * Why it embeds a font at all: every PDF viewer ships the fourteen standard fonts, but all of them
 * are Latin-1 only. A Ukrainian document cannot be written with them, so the only way to produce a
 * correct PDF is to embed a Unicode-capable TrueType face as a CID font — that is what
 * {@link TtfFont} parses and what {@link PdfDocument} writes out as a `CIDFontType2` descendant
 * under `Identity-H` encoding. Text is therefore written as raw glyph ids, and a `ToUnicode` CMap
 * is emitted alongside so the result stays selectable, searchable and copy-pasteable.
 *
 * Coordinates are **millimetres measured from the top-left corner of the page**, because that is
 * how the page-margin rules the documents must satisfy are written (ДСТУ 4163:2020: ліве 30 мм,
 * праве 10 мм, верхнє і нижнє по 20 мм). Font sizes stay in typographic points, as in Word. The
 * conversion to PDF's bottom-left points happens in exactly one place, {@link PdfDocument.op}'s
 * callers, so no layout code ever has to think about it.
 *
 * Streams are written uncompressed. `FlateDecode` would need either a hand-written deflate or
 * `CompressionStream`, and with a subset font of ~16 KB the saving does not pay for the complexity.
 */

// ── Units ───────────────────────────────────────────────────────────────────

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

/** Millimetres → typographic points. */
export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;
/** Typographic points → millimetres. */
export const ptToMm = (pt: number): number => (pt * MM_PER_INCH) / PT_PER_INCH;

export type RGB = readonly [number, number, number];
export type Align = 'left' | 'center' | 'right';

const BLACK: RGB = [0, 0, 0];

/** PDF wants plain decimals; `toFixed` alone would litter the stream with trailing zeros. */
const num = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

// ── TrueType parsing ────────────────────────────────────────────────────────

const tagOf = (v: number): string =>
  String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);

/**
 * Just enough of a TrueType file to embed it and measure text with it: the glyph ids behind each
 * code point (`cmap`), the advance width of each glyph (`hmtx`), and the handful of numbers a PDF
 * font descriptor demands. The file itself is kept verbatim — it is what gets embedded.
 *
 * All metrics are normalised to the PDF glyph space of 1000 units per em, so callers never see
 * `unitsPerEm`.
 */
export class TtfFont {
  private constructor(
    /** The original file, embedded as-is in the `FontFile2` stream. */
    readonly data: Uint8Array,
    readonly postScriptName: string,
    readonly numGlyphs: number,
    readonly ascent: number,
    readonly descent: number,
    readonly capHeight: number,
    readonly bbox: readonly [number, number, number, number],
    private readonly cmap: Map<number, number>,
    private readonly advances: Uint16Array
  ) {}

  static parse(bytes: Uint8Array, postScriptName: string): TtfFont {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint32(0);
    if (version === 0x74746366) throw new Error('Шрифтові колекції (.ttc) не підтримуються');
    if (version === 0x4f54544f) {
      throw new Error('OpenType/CFF (.otf) не підтримується — потрібен TrueType (.ttf)');
    }

    const tables = new Map<string, { offset: number; length: number }>();
    const numTables = dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      tables.set(tagOf(dv.getUint32(p)), { offset: dv.getUint32(p + 8), length: dv.getUint32(p + 12) });
    }
    const need = (name: string) => {
      const t = tables.get(name);
      if (!t) throw new Error(`Шрифт не містить обов'язкової таблиці "${name}"`);
      return t;
    };

    const head = need('head').offset;
    const unitsPerEm = dv.getUint16(head + 18) || 1000;
    const scale = 1000 / unitsPerEm;
    const bbox = [
      Math.round(dv.getInt16(head + 36) * scale), Math.round(dv.getInt16(head + 38) * scale),
      Math.round(dv.getInt16(head + 40) * scale), Math.round(dv.getInt16(head + 42) * scale)
    ] as const;

    const numGlyphs = dv.getUint16(need('maxp').offset + 4);

    const hhea = need('hhea').offset;
    const ascent = Math.round(dv.getInt16(hhea + 4) * scale);
    const descent = Math.round(dv.getInt16(hhea + 6) * scale);
    const numberOfHMetrics = dv.getUint16(hhea + 34);

    // hmtx stores an advance only for the first numberOfHMetrics glyphs; the rest repeat the last
    // one (monospaced tails). Flattening it here means measuring text is a plain array lookup.
    const hmtx = need('hmtx').offset;
    const advances = new Uint16Array(numGlyphs);
    let last = 0;
    for (let g = 0; g < numGlyphs; g++) {
      if (g < numberOfHMetrics) last = dv.getUint16(hmtx + g * 4);
      advances[g] = Math.round(last * scale);
    }

    // Cap height is only present from OS/2 version 2 onwards; the ascender is a safe stand-in and
    // only affects how a viewer synthesises a substitute face, which cannot happen for an embedded
    // font anyway.
    let capHeight = ascent;
    const os2 = tables.get('OS/2');
    if (os2 && dv.getUint16(os2.offset) >= 2 && os2.length >= 90) {
      capHeight = Math.round(dv.getInt16(os2.offset + 88) * scale) || ascent;
    }

    return new TtfFont(bytes, postScriptName, numGlyphs, ascent, descent, capHeight, bbox,
                       parseCmap(dv, need('cmap').offset), advances);
  }

  /** Glyph id for a code point, or 0 (.notdef) when the face has no glyph for it. */
  glyphFor(codePoint: number): number {
    return this.cmap.get(codePoint) ?? 0;
  }

  /** Advance width of a glyph, in 1/1000 em. */
  advanceOf(glyphId: number): number {
    return this.advances[glyphId] ?? 0;
  }
}

function parseCmap(dv: DataView, base: number): Map<number, number> {
  const count = dv.getUint16(base + 2);
  let bestOffset = -1;
  let bestScore = -1;
  for (let i = 0; i < count; i++) {
    const p = base + 4 + i * 8;
    const platform = dv.getUint16(p);
    const encoding = dv.getUint16(p + 2);
    // Preference order: full Unicode, then BMP Unicode, then anything Unicode-ish.
    const score = platform === 3 && encoding === 10 ? 4
                : platform === 3 && encoding === 1 ? 3
                : platform === 0 ? 2
                : 0;
    if (score > bestScore) { bestScore = score; bestOffset = base + dv.getUint32(p + 4); }
  }
  if (bestOffset < 0) throw new Error('Шрифт не містить придатної таблиці cmap');

  const format = dv.getUint16(bestOffset);
  if (format === 4) return parseCmapFormat4(dv, bestOffset);
  if (format === 12) return parseCmapFormat12(dv, bestOffset);
  if (format === 6) return parseCmapFormat6(dv, bestOffset);
  throw new Error(`Формат cmap ${format} не підтримується`);
}

function parseCmapFormat4(dv: DataView, base: number): Map<number, number> {
  const map = new Map<number, number>();
  const segCount = dv.getUint16(base + 6) / 2;
  const endCodes = base + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;

  for (let s = 0; s < segCount; s++) {
    const end = dv.getUint16(endCodes + s * 2);
    const start = dv.getUint16(startCodes + s * 2);
    if (start > end || start === 0xffff) continue;
    const delta = dv.getInt16(idDeltas + s * 2);
    const rangeOffset = dv.getUint16(idRangeOffsets + s * 2);
    for (let c = start; c <= end; c++) {
      let gid: number;
      if (rangeOffset === 0) {
        gid = (c + delta) & 0xffff;
      } else {
        const at = idRangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
        if (at + 1 >= dv.byteLength) continue;
        gid = dv.getUint16(at);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid) map.set(c, gid);
    }
  }
  return map;
}

function parseCmapFormat6(dv: DataView, base: number): Map<number, number> {
  const map = new Map<number, number>();
  const first = dv.getUint16(base + 6);
  const count = dv.getUint16(base + 8);
  for (let i = 0; i < count; i++) {
    const gid = dv.getUint16(base + 10 + i * 2);
    if (gid) map.set(first + i, gid);
  }
  return map;
}

function parseCmapFormat12(dv: DataView, base: number): Map<number, number> {
  const map = new Map<number, number>();
  const groups = dv.getUint32(base + 12);
  for (let i = 0; i < groups; i++) {
    const p = base + 16 + i * 12;
    const start = dv.getUint32(p);
    const end = dv.getUint32(p + 4);
    const startGid = dv.getUint32(p + 8);
    for (let c = start; c <= end; c++) map.set(c, startGid + (c - start));
  }
  return map;
}

// ── Byte assembly ───────────────────────────────────────────────────────────

/** Accumulates the file. Everything PDF syntax needs is ASCII; binary goes in as raw bytes. */
class ByteSink {
  private chunks: Uint8Array[] = [];
  private len = 0;

  get length(): number { return this.len; }

  /** ASCII/Latin-1 text — PDF syntax, never user content (which is always written as hex). */
  push(text: string): void {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    this.raw(out);
  }

  raw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.len += bytes.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.len);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

/** A PDF text string holding non-ASCII: UTF-16BE with a byte-order mark, written as hex. */
const utf16Hex = (text: string): string => {
  let out = 'FEFF';
  for (let i = 0; i < text.length; i++) {
    out += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${out}>`;
};

// ── Document ────────────────────────────────────────────────────────────────

export interface PdfMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PdfDocumentOptions {
  widthMm: number;
  heightMm: number;
  margins: PdfMargins;
  /** Named faces, e.g. `{ regular, bold }`. The first one is the default. */
  fonts: Record<string, TtfFont>;
  defaultFont?: string;
  /** Body size, in typographic points. */
  defaultSize?: number;
  title?: string;
  author?: string;
  subject?: string;
  /** Fixed creation timestamp; passed in rather than read, so output stays reproducible in tests. */
  createdAt?: Date;
}

export interface TextOptions {
  x: number;
  /** Baseline position, in millimetres from the top of the page. */
  y: number;
  size?: number;
  font?: string;
  color?: RGB;
  align?: Align;
  /** Box the text is aligned within; required for `align: 'center' | 'right'`. */
  width?: number;
}

export interface ParagraphOptions extends Omit<TextOptions, 'y'> {
  /** Top edge of the block, in millimetres from the top of the page. */
  y: number;
  width: number;
  /** Multiple of the font size used as the line pitch. */
  lineHeight?: number;
}

export interface PdfTableColumn {
  title?: string;
  /** Millimetres. */
  width: number;
  align?: Align;
  headerAlign?: Align;
}

export interface PdfTableCell {
  text: string;
  align?: Align;
  font?: string;
  colSpan?: number;
  /**
   * How many *header* rows the cell occupies. Only meaningful inside
   * {@link PdfTableOptions.headerRows} — body rows are laid out one at a time and cannot span.
   */
  rowSpan?: number;
}

export type PdfCellInput = string | number | null | undefined | PdfTableCell;

export interface PdfTableRow {
  cells: PdfCellInput[];
  /** Renders the whole row in the bold face — totals, subtotals. */
  strong?: boolean;
  fill?: RGB;
}

export interface PdfTableOptions {
  x?: number;
  columns: PdfTableColumn[];
  rows: PdfTableRow[];
  /**
   * A header of several stacked rows whose cells may carry `colSpan` **and** `rowSpan`, so a column
   * group reads on paper the way it is spoken: «Кількість годин» over «Аудиторні заняття» over
   * «лекції / практичні / лабораторні». Given, it replaces the single row otherwise built from
   * `columns[].title`, and it is the block repeated after every page break.
   *
   * Cells are placed left to right into the first column each row still has free, so a cell spanned
   * into from the row above is simply not repeated — exactly as a merged cell is written out by
   * hand. Row heights come from the single-row cells; a spanning cell only stretches the last row it
   * touches, and only when what it already spans is too short for its text.
   */
  headerRows?: PdfTableRow[];
  size?: number;
  headerSize?: number;
  bodyFont?: string;
  headFont?: string;
  strongFont?: string;
  padX?: number;
  padY?: number;
  headerFill?: RGB;
  lineWidth?: number;
  lineColor?: RGB;
  showHeader?: boolean;
  /**
   * Moves the whole table to the next page rather than splitting it. For a short block that is read
   * as one figure — a summary, a breakdown matrix — a split is worse than a half-empty page.
   * Ignored when the table is taller than a page.
   */
  keepTogether?: boolean;
  /** Called after a page break, before the header row is repeated — for "продовження" captions. */
  onContinue?: () => void;
}

/** One placed cell of a multi-level header: where it sits and how many rows it owns. */
interface HeaderBox {
  text: string[];
  align: Align;
  font: string;
  x: number;
  width: number;
  row: number;
  rowSpan: number;
}

/** A laid-out multi-level header — measured once, painted on every page the table runs onto. */
interface HeaderGrid {
  boxes: HeaderBox[];
  rowHeights: number[];
  pitch: number;
  height: number;
}

interface FontEntry {
  key: string;
  font: TtfFont;
  resource: string;
  /** Glyphs actually drawn, glyph id → code point, for the ToUnicode CMap. */
  used: Map<number, number>;
}

/**
 * One PDF file under construction. Content is appended to the current page; {@link addPage} starts
 * a new one and resets the cursor to the top margin.
 */
export class PdfDocument {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly margins: PdfMargins;
  readonly defaultSize: number;

  private readonly fonts: FontEntry[] = [];
  private readonly defaultFontKey: string;
  private readonly pages: string[][] = [];
  private current = -1;
  private readonly meta: { title?: string; author?: string; subject?: string; createdAt: Date };

  /** Vertical cursor, in millimetres from the top of the page. Layout code advances it. */
  y = 0;

  constructor(options: PdfDocumentOptions) {
    const keys = Object.keys(options.fonts);
    if (!keys.length) throw new Error('Документ потребує принаймні одного шрифту');

    this.widthMm = options.widthMm;
    this.heightMm = options.heightMm;
    this.margins = options.margins;
    this.defaultSize = options.defaultSize ?? 11;
    this.defaultFontKey = options.defaultFont ?? keys[0];
    this.meta = {
      title: options.title, author: options.author, subject: options.subject,
      createdAt: options.createdAt ?? new Date()
    };
    keys.forEach((key, i) => {
      this.fonts.push({ key, font: options.fonts[key], resource: `F${i + 1}`, used: new Map() });
    });
    this.addPage();
  }

  /** Width between the left and right margins, in millimetres. */
  get contentWidth(): number {
    return this.widthMm - this.margins.left - this.margins.right;
  }

  /** The last y a line of content may occupy before it must move to the next page. */
  get contentBottom(): number {
    return this.heightMm - this.margins.bottom;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
    this.current = this.pages.length - 1;
    this.y = this.margins.top;
  }

  /**
   * Draws on an already-finished page — page numbers and running footers, which can only be written
   * once the total is known. The cursor and current page are restored afterwards.
   */
  onPage(index: number, draw: () => void): void {
    const previous = this.current;
    const previousY = this.y;
    this.current = index;
    try { draw(); } finally { this.current = previous; this.y = previousY; }
  }

  /** Moves the cursor down, starting a new page when the requested space would not fit. */
  space(mm: number): void {
    this.y += mm;
  }

  /** Starts a new page unless `neededMm` still fits below the cursor. */
  ensure(neededMm: number): boolean {
    if (this.y + neededMm <= this.contentBottom) return false;
    this.addPage();
    return true;
  }

  // ── Measurement ───────────────────────────────────────────────────────────

  /** Width of a single line, in millimetres. */
  textWidth(text: string, size = this.defaultSize, fontKey = this.defaultFontKey): number {
    const font = this.entry(fontKey).font;
    let units = 0;
    for (const ch of text) units += font.advanceOf(font.glyphFor(ch.codePointAt(0)!));
    return ptToMm((units * size) / 1000);
  }

  /** Line pitch for a size, in millimetres. */
  lineHeight(size = this.defaultSize, factor = 1.25): number {
    return ptToMm(size * factor);
  }

  /** Greedy word wrap. Explicit newlines are honoured; over-long words are broken by character. */
  wrap(text: string, widthMm: number, size = this.defaultSize, fontKey = this.defaultFontKey): string[] {
    const lines: string[] = [];
    for (const paragraph of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const pieces = this.splitWord(word, widthMm, size, fontKey);
        if (pieces.length > 1) {
          // A word that cannot fit on any line is broken outright, so it never joins with a space.
          if (line) lines.push(line);
          for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]);
          line = pieces[pieces.length - 1];
          continue;
        }
        const candidate = line ? `${line} ${word}` : word;
        if (!line || this.textWidth(candidate, size, fontKey) <= widthMm) line = candidate;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }

  private splitWord(word: string, widthMm: number, size: number, fontKey: string): string[] {
    if (this.textWidth(word, size, fontKey) <= widthMm) return [word];
    const pieces: string[] = [];
    let piece = '';
    for (const ch of word) {
      const candidate = piece + ch;
      if (piece && this.textWidth(candidate, size, fontKey) > widthMm) { pieces.push(piece); piece = ch; }
      else piece = candidate;
    }
    pieces.push(piece);
    return pieces;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  drawText(text: string, options: TextOptions): void {
    if (!text) return;
    const size = options.size ?? this.defaultSize;
    const entry = this.entry(options.font ?? this.defaultFontKey);

    let x = options.x;
    if (options.align && options.align !== 'left' && options.width != null) {
      const slack = options.width - this.textWidth(text, size, entry.key);
      x += options.align === 'center' ? slack / 2 : slack;
    }

    const [r, g, b] = options.color ?? BLACK;
    this.op(`${num(r)} ${num(g)} ${num(b)} rg`);
    this.op(`BT /${entry.resource} ${num(size)} Tf 1 0 0 1 ${num(mmToPt(x))} ` +
            `${num(mmToPt(this.heightMm - options.y))} Tm <${this.encode(entry, text)}> Tj ET`);
  }

  /** Wraps and draws a block of text; returns its height in millimetres. */
  drawParagraph(text: string, options: ParagraphOptions): number {
    const size = options.size ?? this.defaultSize;
    const fontKey = options.font ?? this.defaultFontKey;
    const pitch = this.lineHeight(size, options.lineHeight ?? 1.25);
    const lines = this.wrap(text, options.width, size, fontKey);
    lines.forEach((line, i) => {
      this.drawText(line, {
        ...options, font: fontKey, size,
        y: options.y + pitch * i + ptToMm(size * 0.82)
      });
    });
    return pitch * lines.length;
  }

  /** Wraps and draws a block at the cursor, advancing it. */
  writeParagraph(text: string, options: Omit<ParagraphOptions, 'x' | 'y' | 'width'> &
                                       Partial<Pick<ParagraphOptions, 'x' | 'y' | 'width'>> = {}): void {
    const x = options.x ?? this.margins.left;
    const width = options.width ?? this.contentWidth;
    this.y += this.drawParagraph(text, { ...options, x, width, y: this.y });
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, widthMm = 0.2, color: RGB = BLACK): void {
    const [r, g, b] = color;
    this.op(`${num(r)} ${num(g)} ${num(b)} RG ${num(mmToPt(widthMm))} w`);
    this.op(`${num(mmToPt(x1))} ${num(mmToPt(this.heightMm - y1))} m ` +
            `${num(mmToPt(x2))} ${num(mmToPt(this.heightMm - y2))} l S`);
  }

  drawRect(x: number, y: number, w: number, h: number,
           options: { fill?: RGB; stroke?: RGB; lineWidth?: number } = {}): void {
    if (!options.fill && !options.stroke) return;
    const rect = `${num(mmToPt(x))} ${num(mmToPt(this.heightMm - y - h))} ` +
                 `${num(mmToPt(w))} ${num(mmToPt(h))} re`;
    if (options.fill) {
      const [r, g, b] = options.fill;
      this.op(`${num(r)} ${num(g)} ${num(b)} rg`);
    }
    if (options.stroke) {
      const [r, g, b] = options.stroke;
      this.op(`${num(r)} ${num(g)} ${num(b)} RG ${num(mmToPt(options.lineWidth ?? 0.2))} w`);
    }
    this.op(`${rect} ${options.fill && options.stroke ? 'B' : options.fill ? 'f' : 'S'}`);
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  /**
   * Draws a bordered table at the cursor and advances it past the last row.
   *
   * Rows are laid out one at a time and a row that would cross the bottom margin moves whole to the
   * next page, where the header is repeated — a workload sheet is read column by column, so a
   * header-less continuation page would be unusable. A row taller than a whole page is drawn
   * anyway rather than looping forever.
   */
  drawTable(options: PdfTableOptions): void {
    const columns = options.columns;
    const size = options.size ?? 9;
    const headerSize = options.headerSize ?? size;
    const padX = options.padX ?? 1.6;
    const padY = options.padY ?? 1.3;
    const lineWidth = options.lineWidth ?? 0.2;
    const lineColor = options.lineColor ?? BLACK;
    const x0 = options.x ?? this.margins.left;
    const bodyFont = options.bodyFont ?? this.defaultFontKey;
    const headFont = options.headFont ?? bodyFont;
    const strongFont = options.strongFont ?? headFont;
    const showHeader = options.showHeader
      ?? (options.headerRows?.length ? true : columns.some((c) => c.title != null));

    const headerRow: PdfTableRow = {
      cells: columns.map((c) => ({ text: c.title ?? '', align: c.headerAlign ?? 'center' })),
      fill: options.headerFill
    };

    const measure = (row: PdfTableRow, isHeader: boolean) => {
      const cellSize = isHeader ? headerSize : size;
      const spans: { text: string[]; align: Align; font: string; x: number; width: number }[] = [];
      let index = 0;
      let x = x0;
      for (const raw of row.cells) {
        if (index >= columns.length) break;
        const cell: PdfTableCell = typeof raw === 'object' && raw !== null
          ? raw
          : { text: raw == null ? '' : String(raw) };
        const span = Math.max(1, Math.min(cell.colSpan ?? 1, columns.length - index));
        let width = 0;
        for (let k = 0; k < span; k++) width += columns[index + k].width;
        const font = cell.font ?? (isHeader ? headFont : row.strong ? strongFont : bodyFont);
        spans.push({
          text: this.wrap(cell.text, width - padX * 2, cellSize, font),
          align: cell.align ?? (isHeader ? (columns[index].headerAlign ?? 'center') : (columns[index].align ?? 'left')),
          font, x, width
        });
        index += span;
        x += width;
      }
      const pitch = this.lineHeight(cellSize, 1.2);
      const height = Math.max(...spans.map((s) => s.text.length)) * pitch + padY * 2;
      return { spans, pitch, height, cellSize };
    };

    const draw = (row: PdfTableRow, isHeader: boolean) => {
      const { spans, pitch, height, cellSize } = measure(row, isHeader);
      const fill = isHeader ? (row.fill ?? options.headerFill) : row.fill;
      const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);

      if (fill) this.drawRect(x0, this.y, totalWidth, height, { fill });
      this.drawRect(x0, this.y, totalWidth, height, { stroke: lineColor, lineWidth });
      for (const s of spans.slice(1)) this.drawLine(s.x, this.y, s.x, this.y + height, lineWidth, lineColor);

      for (const s of spans) {
        s.text.forEach((line, i) => {
          this.drawText(line, {
            x: s.x + padX, y: this.y + padY + pitch * i + ptToMm(cellSize * 0.82),
            size: cellSize, font: s.font, align: s.align, width: s.width - padX * 2
          });
        });
      }
      this.y += height;
    };

    // A multi-level header is laid out once — it depends only on the column widths — and the same
    // block is then painted on every page the table runs onto.
    const grid = options.headerRows?.length ? this.layoutHeaderGrid(options, columns, x0, padX, padY, headerSize, headFont) : null;
    const headerHeight = () => (grid ? grid.height : measure(headerRow, true).height);
    const paintHeader = () => {
      if (grid) this.drawHeaderGrid(grid, columns, x0, padX, headerSize, options.headerFill, lineColor, lineWidth);
      else draw(headerRow, true);
    };

    if (options.keepTogether) {
      const total = (showHeader ? headerHeight() : 0)
        + options.rows.reduce((sum, r) => sum + measure(r, false).height, 0);
      const pageHeight = this.contentBottom - this.margins.top;
      if (total <= pageHeight) this.ensure(total);
    }

    if (showHeader) {
      // Never strand a header at the very bottom of a page.
      if (this.y + headerHeight() + this.lineHeight(size, 1.2) > this.contentBottom) {
        this.addPage();
      }
      paintHeader();
    }

    for (const row of options.rows) {
      const { height } = measure(row, false);
      if (this.y + height > this.contentBottom && this.y > this.margins.top) {
        this.addPage();
        options.onContinue?.();
        if (showHeader) paintHeader();
      }
      draw(row, false);
    }
  }

  /**
   * Places every cell of a multi-level header on the column × header-row grid and works out how
   * tall each header row has to be. Pure geometry: nothing is drawn and the cursor does not move,
   * so the result can be measured for a page-break decision and reused on each continuation page.
   */
  private layoutHeaderGrid(options: PdfTableOptions, columns: PdfTableColumn[], x0: number,
                           padX: number, padY: number, headerSize: number,
                           headFont: string): HeaderGrid {
    const rows = options.headerRows ?? [];
    const pitch = this.lineHeight(headerSize, 1.2);
    const taken = rows.map(() => new Array<boolean>(columns.length).fill(false));
    const boxes: HeaderBox[] = [];
    // Running left edge of each column, so a cell's x is a lookup rather than a re-summation.
    const columnX: number[] = [];
    let at = x0;
    for (const c of columns) { columnX.push(at); at += c.width; }

    rows.forEach((row, r) => {
      let col = 0;
      for (const raw of row.cells) {
        while (col < columns.length && taken[r][col]) col++;
        if (col >= columns.length) break;
        const cell: PdfTableCell = typeof raw === 'object' && raw !== null
          ? raw
          : { text: raw == null ? '' : String(raw) };
        const colSpan = Math.max(1, Math.min(cell.colSpan ?? 1, columns.length - col));
        const rowSpan = Math.max(1, Math.min(cell.rowSpan ?? 1, rows.length - r));
        let width = 0;
        for (let k = 0; k < colSpan; k++) width += columns[col + k].width;
        const font = cell.font ?? headFont;
        boxes.push({
          text: this.wrap(cell.text, width - padX * 2, headerSize, font),
          align: cell.align ?? columns[col].headerAlign ?? 'center',
          font, x: columnX[col], width, row: r, rowSpan
        });
        for (let rr = r; rr < r + rowSpan; rr++) {
          for (let k = 0; k < colSpan; k++) taken[rr][col + k] = true;
        }
        col += colSpan;
      }
    });

    const rowHeights = rows.map(() => 0);
    for (const b of boxes) {
      if (b.rowSpan === 1) rowHeights[b.row] = Math.max(rowHeights[b.row], b.text.length * pitch + padY * 2);
    }
    // A row made up entirely of cells spanned into from above still needs a line of its own,
    // otherwise the levels below it collapse onto each other.
    for (let r = 0; r < rowHeights.length; r++) {
      if (rowHeights[r] === 0) rowHeights[r] = pitch + padY * 2;
    }
    for (const b of boxes) {
      if (b.rowSpan === 1) continue;
      const needed = b.text.length * pitch + padY * 2;
      let available = 0;
      for (let r = b.row; r < b.row + b.rowSpan; r++) available += rowHeights[r];
      // Only the last row it touches grows: widening an upper row would push down every sibling
      // group that shares it, for the sake of one long caption.
      if (needed > available) rowHeights[b.row + b.rowSpan - 1] += needed - available;
    }

    return { boxes, rowHeights, pitch, height: rowHeights.reduce((sum, h) => sum + h, 0) };
  }

  /** Paints a laid-out header grid at the cursor and advances past it. */
  private drawHeaderGrid(grid: HeaderGrid, columns: PdfTableColumn[], x0: number, padX: number,
                         headerSize: number, fill: RGB | undefined, lineColor: RGB,
                         lineWidth: number): void {
    const top = this.y;
    const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
    if (fill) this.drawRect(x0, top, totalWidth, grid.height, { fill });

    for (const b of grid.boxes) {
      let y = top;
      for (let r = 0; r < b.row; r++) y += grid.rowHeights[r];
      let height = 0;
      for (let r = b.row; r < b.row + b.rowSpan; r++) height += grid.rowHeights[r];
      this.drawRect(b.x, y, b.width, height, { stroke: lineColor, lineWidth });
      // Header captions sit in the middle of their box, the way a merged cell reads on paper —
      // a two-line group title beside a one-line column name should not hang from the top.
      const textTop = y + (height - b.text.length * grid.pitch) / 2;
      b.text.forEach((line, i) => {
        this.drawText(line, {
          x: b.x + padX, y: textTop + grid.pitch * i + ptToMm(headerSize * 0.82),
          size: headerSize, font: b.font, align: b.align, width: b.width - padX * 2
        });
      });
    }
    this.y = top + grid.height;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  render(): Uint8Array {
    const sink = new ByteSink();
    const offsets: number[] = [];
    // Object 0 is the head of the free list and never written.
    let nextId = 1;
    const reserve = () => nextId++;

    const write = (id: number, body: string, stream?: Uint8Array) => {
      offsets[id] = sink.length;
      sink.push(`${id} 0 obj\n${body}\n`);
      if (stream) {
        sink.push('stream\n');
        sink.raw(stream);
        sink.push('\nendstream\n');
      }
      sink.push('endobj\n');
    };

    const catalogId = reserve();
    const pagesId = reserve();
    const infoId = reserve();
    const pageIds = this.pages.map(() => reserve());
    const contentIds = this.pages.map(() => reserve());
    const fontIds = this.fonts.map(() => ({
      type0: reserve(), cid: reserve(), descriptor: reserve(), file: reserve(), toUnicode: reserve()
    }));

    sink.push('%PDF-1.7\n');
    // A comment of high bytes marks the file as binary for transfer tools that still care.
    sink.raw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const fontResources = this.fonts
      .map((f, i) => `/${f.resource} ${fontIds[i].type0} 0 R`)
      .join(' ');

    write(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (uk-UA) >>`);
    write(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
                   `/Count ${pageIds.length} >>`);

    const stamp = pdfDate(this.meta.createdAt);
    const info = ['<< /Producer (LNU Timetable)'];
    if (this.meta.title) info.push(`/Title ${utf16Hex(this.meta.title)}`);
    if (this.meta.author) info.push(`/Author ${utf16Hex(this.meta.author)}`);
    if (this.meta.subject) info.push(`/Subject ${utf16Hex(this.meta.subject)}`);
    info.push(`/CreationDate (${stamp}) /ModDate (${stamp}) >>`);
    write(infoId, info.join(' '));

    const mediaBox = `[0 0 ${num(mmToPt(this.widthMm))} ${num(mmToPt(this.heightMm))}]`;
    this.pages.forEach((ops, i) => {
      write(pageIds[i], `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ${mediaBox} ` +
                        `/Resources << /Font << ${fontResources} >> /ProcSet [/PDF /Text] >> ` +
                        `/Contents ${contentIds[i]} 0 R >>`);
      const body = latin1(ops.join('\n'));
      write(contentIds[i], `<< /Length ${body.length} >>`, body);
    });

    this.fonts.forEach((entry, i) => {
      const ids = fontIds[i];
      const font = entry.font;
      const name = `/${entry.font.postScriptName}`;

      write(ids.type0, `<< /Type /Font /Subtype /Type0 /BaseFont ${name} /Encoding /Identity-H ` +
                       `/DescendantFonts [${ids.cid} 0 R] /ToUnicode ${ids.toUnicode} 0 R >>`);

      const widths: string[] = [];
      for (let g = 0; g < font.numGlyphs; g++) widths.push(String(font.advanceOf(g)));
      write(ids.cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${name} ` +
                     `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
                     `/FontDescriptor ${ids.descriptor} 0 R /DW 1000 ` +
                     `/W [0 [${widths.join(' ')}]] /CIDToGIDMap /Identity >>`);

      write(ids.descriptor, `<< /Type /FontDescriptor /FontName ${name} /Flags 4 ` +
                            `/FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 ` +
                            `/Ascent ${font.ascent} /Descent ${font.descent} ` +
                            `/CapHeight ${font.capHeight} /StemV 80 /FontFile2 ${ids.file} 0 R >>`);

      write(ids.file, `<< /Length ${font.data.length} /Length1 ${font.data.length} >>`, font.data);

      const cmap = latin1(toUnicodeCMap(entry.used));
      write(ids.toUnicode, `<< /Length ${cmap.length} >>`, cmap);
    });

    const xrefAt = sink.length;
    sink.push(`xref\n0 ${nextId}\n`);
    sink.push('0000000000 65535 f \n');
    for (let id = 1; id < nextId; id++) {
      sink.push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
    }
    sink.push(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`);
    sink.push(`startxref\n${xrefAt}\n%%EOF\n`);

    return sink.toBytes();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private entry(key: string): FontEntry {
    const found = this.fonts.find((f) => f.key === key);
    if (!found) throw new Error(`Невідомий шрифт "${key}"`);
    return found;
  }

  private op(operator: string): void {
    this.pages[this.current].push(operator);
  }

  /**
   * Text under Identity-H is a run of two-byte glyph ids, not characters — which is also why the
   * glyphs used have to be remembered here, so the ToUnicode CMap can map them back.
   */
  private encode(entry: FontEntry, text: string): string {
    let out = '';
    for (const ch of text) {
      const codePoint = ch.codePointAt(0)!;
      const gid = entry.font.glyphFor(codePoint);
      if (gid && !entry.used.has(gid)) entry.used.set(gid, codePoint);
      out += gid.toString(16).toUpperCase().padStart(4, '0');
    }
    return out;
  }
}

const latin1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

const pdfDate = (d: Date): string => {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Maps embedded glyph ids back to Unicode so the PDF stays searchable and copy-pasteable. */
function toUnicodeCMap(used: Map<number, number>): string {
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
  const target = (codePoint: number) => {
    if (codePoint <= 0xffff) return hex4(codePoint);
    const v = codePoint - 0x10000;
    return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
  };

  const body: string[] = [];
  // The format caps a bfchar block at 100 entries.
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body.push(`${chunk.length} beginbfchar`);
    for (const [gid, cp] of chunk) body.push(`<${hex4(gid)}> <${target(cp)}>`);
    body.push('endbfchar');
  }

  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...body,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end'
  ].join('\n');
}
