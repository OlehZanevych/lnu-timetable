# The printable workload calculation (PDF)

The **«Завантажити PDF»** button on the "Оцінка навантаження" tab (`/department/{id}`) produces the
document *«РОЗРАХУНОК НАВЧАЛЬНОГО НАВАНТАЖЕННЯ науково-педагогічного працівника на 20\_\_/20\_\_
навчальний рік»* — the annual teaching-load calculation for one academic staff member.

The document is built **entirely on the client**: not one byte goes to the server, and the file is
handed to the browser as a `Blob`. The code is `pdf-writer.ts` (the engine), `workload-report.ts`
(the document itself) and `pdf-fonts.ts` (font loading and file delivery).

> Ukrainian is kept throughout this document for anything that is *printed* — headings, column
> captions, statutory wording — and for the names of laws and orders. Those strings are literals, not
> descriptions, and translating them here would misrepresent what the sheet says. Everything that
> explains or argues is in English.

---

## 1. Legal basis

**There is no single nationwide form.** What the document does rest on:

| What | Source | How it shows up in the sheet |
| --- | --- | --- |
| The 36-hour working week of academic staff, and a ceiling of **600 hours** of teaching load per full post per academic year | Закон України «Про вищу освіту», **ст. 56** | the «Підстава» line on the title page; «Максимальний обсяг навантаження, год» among the summary figures |
| Time norms are set by the institution itself | наказ МОН **№ 187 від 16.02.2022** repealed наказ МОН № 450 від 07.08.2002 | the document **does not cite** № 450; the ceilings come from `lecturer_workload_constraints` / `default_max_hours_per_year` |
| Layout of organisational and administrative documents | **ДСТУ 4163:2020** | the ЗАТВЕРДЖУЮ approval block, margins, typeface, page numbering, signature form |

> **Do not cite наказ № 450.** It has been repealed since 2022. The correct basis is ст. 56 of the
> Law «Про вищу освіту» together with the institution's own regulation on time norms.

The shape of the form is the common denominator of the regulations currently in force at КПІ
ім. Сікорського (forms К-2 and К-4-Б(К)), ЗНУ, ХНЕУ ім. Кузнеця, ХНУМГ ім. Бекетова and ТНПУ: all
five share the same header, the same split by half-year, the same summary rows and the same
signature block. ЛНУ ім. І. Франка does not publish a form of its own — the 2026–2030 collective
agreement carries only the 36-hour-week norm — so what is reproduced here is that sector-wide
standard.

## 2. Layout (ДСТУ 4163:2020)

| Parameter | Value | Where in the code |
| --- | --- | --- |
| Page | A4 **landscape**, 297 × 210 mm | `A4_LANDSCAPE` |
| Margins | left 30, right 10, top 20, bottom 20 mm | `MARGINS` |
| Typeface | Liberation Serif — metrically compatible with Times New Roman | `public/fonts/` |
| Type size | 8.5–14 pt: body text 10.5–11, title 14, tables 8.5–10 | per section |
| Approval block | «ЗАТВЕРДЖУЮ» in the top right corner of the first sheet (реквізит 16) | `drawApprovalGrif` |
| Signature | «Власне ім'я ПРІЗВИЩЕ» — **the standard does not provide for initials** | `drawSignatures` |
| Page numbers | centred in the top margin, **the first sheet is not numbered** | `drawPageFurniture` |

Landscape orientation is forced by the nine-column «Склад навчального навантаження» table: on
portrait A4 it is unreadable. ДСТУ does not forbid landscape, and every institution with a wide form
does the same.

## 3. Structure of the document

### Sheet 1 — the title page

```
                                        ЗАТВЕРДЖУЮ
                                        Проректор з науково-педагогічної роботи
                                        Львівського національного університету
                                        імені Івана Франка
                                        ___________   _______________________
                                          (підпис)     (Власне ім'я ПРІЗВИЩЕ)
                                        «___» ____________ 20___ р.

                 МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ
        ЛЬВІВСЬКИЙ НАЦІОНАЛЬНИЙ УНІВЕРСИТЕТ ІМЕНІ ІВАНА ФРАНКА
                        <Факультет>
                    Кафедра <назва>

              РОЗРАХУНОК НАВЧАЛЬНОГО НАВАНТАЖЕННЯ
       науково-педагогічного працівника на 2026/2027 навчальний рік

  ┌─────────────────────┬──────────────┬──────────────┬──────────────┐
  │ Прізвище, ім'я, …   │ <ПІБ>        │ Кафедра      │ <кафедра>    │
  │ Посада              │ <посада>     │ Факультет    │ <факультет>  │
  │ Науковий ступінь    │ <ступінь>    │ Навчальний рік│ 2026/2027   │
  └─────────────────────┴──────────────┴──────────────┴──────────────┘

  Підстава: стаття 56 Закону України «Про вищу освіту» — …
```

The calculation **always** starts on a fresh sheet, as it does on the paper forms: the reader finds
the tables in the same place regardless of how long the document turned out.

### Section 1 — Зведені показники навчального навантаження

Total hours for the year · of which first and second half-year · number of disciplines · number of
load items · minimum volume · maximum volume (marked «(типовий)» when it comes from
`default_max_hours_per_year` rather than from a ceiling set for this particular lecturer) ·
deviation from the permitted volume, printed as «у межах допустимого обсягу», «+N (перевищення)» or
«−N (недовантаження)».

### Section 2 — Розподіл годин за видами навчальної роботи

A "discipline category × kind of work" matrix: Лекції, Практичні, Лабораторні, Консультації,
Контрольні заходи, Разом — given separately for all disciplines, for the mandatory ones and for the
elective ones.

### Section 3 — Склад навчального навантаження

Two tables, one per half-year, each with its own subtotal, followed by a «ВСЬОГО ЗА НАВЧАЛЬНИЙ РІК»
row:

| № з/п | Курс | Навчальна дисципліна | Тип дисципліни | Спеціальність (освітня програма) | Вид навчальної роботи | Формат проведення | Академічні групи / студенти | Годин |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

A half-year is printed **even when it is empty** («У цьому півріччі позицій навантаження немає») —
that imbalance is precisely what the "Оцінка навантаження" tab exists to show, and quietly hiding it
is not an option. Rows are ordered by course year, then by discipline (Ukrainian alphabet,
`compareUk`), then by kind of work in the canonical `STAT_HOUR_TYPES` order — lectures → practicals →
labs → consultations → assessments — the same order in which section 2 lists them.

### The signature block

The minutes of the department meeting, then three signatures — head of department, dean of faculty,
and the staff member — and the date. The block is never split across a page boundary.

## 4. What was deliberately left out

- **«Відповідність обмеженням»**, by explicit request. Those bounds
  (`lecturer_workload_constraints`) are an internal planning instrument of this system, not a
  property of the load that anyone approves with a signature. The minimum and maximum hours did stay
  in the summary figures: without them the deviation means nothing.
- **Ставка / частка ставки** (the fraction of a post held) and the planned load for that fraction —
  the data model has no such field (`Lecturer` stores `position` and `academicDegree`, and nothing
  else).
- **Вчене звання** (academic title) — `academicDegree` is a scientific degree, not a title.
- **«План / факт» columns**, as КПІ's form К-2 has — the system stores the plan only.

Each of these is a field on `Lecturer` plus a column in `schema.sql`, not a redesign of the document.

## 5. Technical decisions

### Why a hand-written engine rather than jsPDF or pdfmake

First, the project has no runtime dependencies, and every algorithm in it is hand-written
(`workload-generator.ts`, `workload-stats.ts`, `sort.ts`) — 300 kB of library for the sake of one
button is out of proportion. Second, a library would not have removed the hard part anyway: **the
fourteen standard PDF fonts cover Latin-1 only**, so a Ukrainian document needs an embedded Unicode
font whichever route you take.

### How `pdf-writer.ts` works

- `TtfFont.parse()` reads `head`, `hhea`, `hmtx`, `maxp` and `cmap` (formats 4, 6 and 12) and scales
  every metric to 1000 units per em — PDF's glyph space.
- The font is embedded as a `CIDFontType2` under `Identity-H` encoding: text in the content stream is
  a sequence of two-byte glyph identifiers, not of characters. That is why a `ToUnicode` CMap is
  generated alongside it — without one the document cannot be selected, searched or copied from.
- Coordinates are **millimetres from the top-left corner**; the conversion to points from the
  bottom-left happens in exactly one place, so no layout layer above it ever has to think about it.
- Streams are not compressed: `FlateDecode` would require either a hand-written deflate or
  `CompressionStream`, and at a font size of ~16 kB the saving is not worth the complexity. A typical
  document is 60–90 kB.
- `drawTable` moves a row whole to the next page and repeats the header; `keepTogether`, for short
  tables that read as a single figure, moves the entire table instead.

### Fonts

`public/fonts/LiberationSerif-{Regular,Bold}.ttf` are **subsets** (Latin, Cyrillic, and the
punctuation actually needed): ~16 kB per weight instead of ~340 kB. They are fetched on the first
export and cached for the session, so a user who never exports pays nothing. Licence: SIL OFL. The
command to regenerate them is in the
[README](README.md#printable-workload-calculation-pdf-writerts-workload-reportts-pdf-fontsts).

A character outside the subset is emitted as `.notdef` (an empty box) rather than breaking
generation.

### Testing

`workload-report.ts` and `pdf-writer.ts` depend on neither Angular nor the DOM, so the document
renders under Node from plain objects — which is how the layout, the page breaks, an empty load and a
120-item case were all checked. The output is validated with `qpdf --check`, and `pdftotext`
confirms that the Cyrillic extracts correctly.
