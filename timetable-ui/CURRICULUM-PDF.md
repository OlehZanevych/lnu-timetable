# The printable curriculum (PDF)

The **«Завантажити PDF»** button on the "Навчальні плани" tab (`/specialty/{id}`) produces the
document *«НАВЧАЛЬНИЙ ПЛАН підготовки здобувачів вищої освіти»* — the curriculum of the selected
specialty.

The document is built **entirely on the client**: not one byte goes to the server, and the file is
handed to the browser as a `Blob`. The code is `pdf-writer.ts` (the engine), `curriculum-plan.ts`
(the arithmetic and the checks), `curriculum-report.ts` (the document itself) and `pdf-fonts.ts`
(font loading and file delivery).

> Ukrainian is kept throughout this document for anything that is *printed* on the sheet — headings,
> column captions, statutory wording — and for the names of laws and orders. Those strings are
> literals, not descriptions, and translating them here would misrepresent what the sheet says.
> Everything that explains or argues is in English.

---

## 1. Legal basis

### There is no single state-mandated curriculum form — and has not been since 2014

The one form there ever was lived in the annexes to the «Положення про організацію навчального
процесу у вищих навчальних закладах», approved by **наказ МО України № 161 від 02.06.1993**. That
order has been **repealed** — наказ МОН **№ 1310 від 13.11.2014**, registered with the Ministry of
Justice on 21.11.2014 under № 1485/26262.

> **Do not cite наказ № 161**, and do not reproduce its annexes as a "standard form". Since then the
> form of the document has been a matter of institutional autonomy (**ст. 32** of the Law «Про вищу
> освіту»), exercised through the institution's own regulation on the organisation of the
> educational process (**ст. 47 ч. 2**). There is no state-level regulation on the organisation of
> the educational process either.

**Наказ МОН № 47 від 26.01.2015** is likewise not cited: by its own title it concerned the drafting
of curricula **for the 2015/2016 academic year**. That is where the "canonical" figures come from —
no more than 16 disciplines per year, 3–5 examinations per session, contact hours at 33–50 % of a
credit — so the document presents them as **settled institutional practice**, not as a norm.

### The numeric bounds are settings, not constants

None of the figures below is hard-coded. Every one of them is a `global_properties` row, edited on
the "Глобальні властивості" page: the size of a credit, the size of a programme at each degree, the
share of electives, and the ceilings on disciplines and examinations per semester. The reason is
simple: the statutory figures change with the law (ст. 62 ч. 1 п. 15 was rewritten by Закон
№ 3642-IX in 2024), and the practice figures differ between institutions by the very logic of
ст. 32. An institution operating under a different bound changes a setting, not the code.

**A blank bound is not a bound.** A cleared field means "not set", and the check that stands on it
disappears from the screen and from section 5 of the document alike: a signed sheet should not carry
a verdict about a rule nobody put in place. There is one exception — «Годин в одному кредиті ЄКТС»,
which is arithmetic rather than a rule, and which every total rests on.

On screen the norm is shown as a **bare figure**, with no article reference: the value is now set by
the institution, and a citation next to it would attribute to the law what the institution decided.
In the document the article stays, as a separate «Підстава норми» column beside the figure itself.

### What is actually a norm — and where it shows up in the document

| What | Source | How it shows up |
| --- | --- | --- |
| One ЄКТС credit is **30 hours**; a full-time year is **as a rule 60 credits** | ст. 1 п. 14 | the «Усього годин» column; the «Підстава» line; checks 3 and 4 |
| Programme volume: молодший бакалавр **120**, бакалавр **180–240**, магістр **90–120** (ОНП — 120), the taught component of a доктор філософії programme **30–60** | ст. 5 | the «Кредитів ЄКТС» field; check 1 |
| Elective **educational components** — **not less than 25 %** of programme volume | ст. 62 ч. 1 п. 15, as amended by Закон **№ 3642-IX від 23.04.2024** | section 1; the «Вибіркові компоненти» section heading; check 2 |
| A curriculum is **approved by the academic council** of the institution | ст. 36 ч. 2 п. 8 | the «ЗАТВЕРДЖЕНО / Вченою радою … протокол № __» approval block |
| The credit volume of a particular specialty, the minimum volume of practical training, and the forms of attestation | the higher education standard (ст. 10) | not checked: the system does not store standards |
| Document layout | **ДСТУ 4163:2020** | margins, typeface, page numbering, signature form |

Three changes that **Закон № 3642-IX** (in force from 16.08.2024) made to ст. 62 ч. 1 п. 15, all of
them accounted for: «навчальних дисциплін» became «**освітніх компонентів**» (so elective practical
training now counts towards the 25 %); the base of the calculation changed from «для даного рівня
вищої освіти» to «**передбачених освітньою програмою**» (that is, 25 % of the programme's actual
volume); and a **10 %** threshold appeared for specialties giving access to professions under
additional regulation.

> The 10 % threshold is **not implemented**: the system does not store a flag for a regulated
> specialty. The check always measures against 25 %, and for a regulated specialty its verdict
> should be read as "the stricter lower bound was applied". That is a field on `specialties` plus a
> column in `schema.sql`, not a redesign of the document.

### The approval block: why «ЗАТВЕРДЖЕНО» and not «ЗАТВЕРДЖУЮ»

ДСТУ 4163:2020 distinguishes two approval blocks: approval by an official («ЗАТВЕРДЖУЮ» + position +
signature) and approval by a **collegial body** («ЗАТВЕРДЖЕНО» + name of the act + date + number). A
curriculum is approved by the academic council, a collegial body (ст. 36 ч. 2 п. 8), so the second
form applies. Beside it stands «ВВЕДЕНО В ДІЮ наказом ректора», because that is how institutions
bring a curriculum into force (ОНТУ, КрНУ and ХНМУ all do the same). This is what distinguishes the
document from the [workload calculation](WORKLOAD-PDF.md), which one official signs and which
therefore carries «ЗАТВЕРДЖУЮ».

### The shape of the form itself

The common denominator of the regulations in force at ЗНУ, ОНТУ, ХНЕУ ім. С. Кузнеця, НУ
«Чернігівська політехніка» and КрНУ, and of the curricula published by ЛНУ ім. І. Франка: the
sections «Обов'язкові / Вибіркові компоненти ОП», «Практична підготовка» and «Атестація»; the «План
освітнього процесу» columns under a multi-level header; summary data by semester; and the chain of
signatures from the programme guarantor up to the vice-rector.

## 2. Layout (ДСТУ 4163:2020)

| Parameter | Value | Where in the code |
| --- | --- | --- |
| Page | A4 **landscape**, 297 × 210 mm | `A4_LANDSCAPE` |
| Margins | left 30, right 10, top 20, bottom 20 mm | `MARGINS` |
| Typeface | Liberation Serif — metrically compatible with Times New Roman | `public/fonts/` |
| Type size | title 16, header fields 10, tables 8–9, notes 8.5–9 | per section |
| Approval block | top right corner of the first sheet (реквізит 16) | `drawApprovalGrif` |
| Signature | «Власне ім'я ПРІЗВИЩЕ» — **the standard does not provide for initials** | `drawSignatures` |
| Page numbers | centred in the top margin, **the first sheet is not numbered** | `drawPageFurniture` |

Landscape orientation is forced by the fifteen-column «План освітнього процесу» under a
**three-level** header: on portrait A4 it is unreadable. ДСТУ does not forbid landscape, and every
published curriculum is set that way.

Strictly speaking, ДСТУ 4163:2020 covers **organisational and administrative** documentation, while a
curriculum is a planning-and-teaching document. The standard is applied here because (a) through the
institution's own records-management instruction it extends to the "approval block" and "signature"
elements anyway, and (b) it is the same standard the neighbouring workload calculation is set to, and
two forms from one system should not look like they come from different eras.

## 3. Structure of the document

### Sheet 1 — the title page

```
   МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ         ЗАТВЕРДЖЕНО
ЛЬВІВСЬКИЙ НАЦІОНАЛЬНИЙ УНІВЕРСИТЕТ            Вченою радою Львівського національного
        ІМЕНІ ІВАНА ФРАНКА                     університету імені Івана Франка
          <Факультет>                          протокол № ____ від «___» ______ 20__ р.

                                               ВВЕДЕНО В ДІЮ
                                               наказом ректора від «___» ______ 20__ р. № ___

                          НАВЧАЛЬНИЙ ПЛАН
                 підготовки здобувачів вищої освіти

  ┌──────────────────────┬───────────────────┬─────────────────┬───────┐
  │ Галузь знань         │ <шифр>            │ Рівень НРК      │ 6     │
  │ Спеціальність        │ <код> <назва>     │ Семестрів       │ 8     │
  │ Освітній ступінь     │ <ступінь>         │ Курсів          │ 4     │
  │ Рівень вищої освіти  │ перший (бакалавр…)│ Кредитів ЄКТС   │ 240   │
  │ Факультет            │ <факультет>       │ Годин           │ 7200  │
  │ Форма здобуття освіти│ Денна             │ Рік             │ 2026/…│
  │ Строк навчання       │ 4 роки (8 семестр)│                 │       │
  └──────────────────────┴───────────────────┴─────────────────┴───────┘

  Підстава: Закон України «Про вищу освіту» — …
```

The plan **always** starts on a fresh sheet, as it does on the paper forms.

### Section 1 — Зведені показники освітньої програми

One row per component that is actually present (mandatory, elective, course work, practical training,
attestation, optional subjects) with its credits, hours and share of programme volume, and a «УСЬОГО
ЗА ОСВІТНЬОЮ ПРОГРАМОЮ» total.

### Section 2 — Зведені дані за семестрами

Semester · course year · half-year · educational components · credits · total hours · contact hours ·
independent work · examinations · credit tests · course works, plus a «Разом» row. This is the table
that makes an imbalance between semesters visible, and it is where the last two checks of section 5
come from.

### Section 3 — План освітнього процесу

The main table, fifteen columns under a three-level header:

| № з/п | Код | Освітній компонент | Семестр | Форма підсумкового контролю (семестр): екзамен · залік · диф. залік | Кредитів ЄКТС | Кількість годин: усього · аудиторні (усього · лекції · практичні · лабораторні · консультації, контрольні заходи) · самостійна робота |
| --- | --- | --- | --- | --- | --- | --- |

The form of assessment is marked by the **semester number** in the matching column — the way it is
done on paper, rather than by a word.

Rows are grouped into sections in `PLAN_SECTIONS` order, each with its own subtotal, and every
component carries the code of its part (**ОК 1**, **ВК 1**, **КР 1**, **ПП 1**, **А 1**, **Ф 1**) —
the same code the educational programme refers to it by. Within a section, rows run by semester and
then by name in the Ukrainian alphabet (`compareUk`).

The «УСЬОГО ЗА ОСВІТНЬОЮ ПРОГРАМОЮ» total stands **before** the optional-subjects section, because it
does not include them: optional subjects lie outside programme volume and enter neither the total nor
the denominator of the 25 %.

Course works, practical training and attestation are given as separate **sections** rather than as
columns, because in the data model they are `Course` records in their own right with their own
`course_type`, not an attribute of a discipline. On the forms that inherited their look from наказ
№ 161 these are columns — but there a course work has no credits of its own, and here it does.

### Section 4 — Розподіл годин за видами навчальної роботи

A "programme component × kind of work" matrix: lectures, practicals, labs, consultations,
assessments, independent work, total — for all components and for each component group separately.

### Section 5 — Відповідність нормативним вимогам

Up to six checks — exactly those whose bounds are set in the settings: programme volume (ст. 5), the
share of electives (ст. 62 ч. 1 п. 15), hours per credit (ст. 1 п. 14, per item), annual load (ст. 1
п. 14), the largest number of components in a semester and the largest number of examinations in a
semester. The first four are **law**, the last two are **settled practice**, and the document says so
outright, so that a deviation from them does not read as a violation.

There are four columns: the indicator, the **norm** (the bare figure from the settings), the **basis**
of that norm (an article, or «усталена практика ЗВО»), and the verdict. A check whose bound has been
cleared does not appear in the table at all.

A breach of a statutory norm is set in bold with a shaded background — and is shown **on screen** as
well, under the tab heading (without the article reference), not only in the PDF.

### The signature block

Programme guarantor · head of the graduating department · dean of faculty · head of the academic
affairs unit · vice-rector for academic affairs, and the date. The block is never split across a page
boundary.

## 4. What was deliberately left out

- **The academic-year calendar** (the Т/Е/П/К week grid) and the **summary time budget in weeks** —
  the system stores neither weeks of theoretical instruction, nor examination sessions, nor holidays.
  That is a new table in `schema.sql`, not a matter of layout.
- **Weekly hours by semester** — the right-hand block of columns on the classic form. The system
  plans hours per semester; the weekly figure belongs to the timetable, which the "Формування
  розкладу" pages build.
- **The name of the field of knowledge** — the document carries only the code. The names live in
  ПКМУ № 266/2015 and, for intakes from 2025, in the new list under ПКМУ № 1021 від 30.08.2024; the
  system stores neither, and a hard-coded table would go stale with the next revision of the list.
- **The name and ЄДЕБО identifier of the educational programme**, the **educational and professional
  qualifications**, and the **year of intake** — there are no such fields: `Specialty` stores `code`,
  `name`, `degree` and a faculty, and nothing else. The model does not distinguish an educational
  programme from a specialty, although наказ МОН № 1734 від 31.12.2025 insists they are different
  things.
- **The competence / programme learning outcome matrix** — part of the educational programme, not of
  the curriculum.
- **The 10 % elective threshold** for regulated professions — see above.

Each of these is a field on `Specialty` (or a new table) plus a column in `schema.sql`, not a
redesign of the document.

## 5. Technical decisions

### Discipline names are printed bare

On screen a discipline is named with its `course_tags` in parentheses — «Іноземна мова
(англійською)» — because two rows of a table can otherwise carry the same name and mean different
courses. **This sheet prints the bare `courses.name`.**

The split is deliberate and is enforced at the source, not here: the row objects these documents are
built from carry both forms, and the printing code reads the bare one. A tag is a disambiguator for
someone scanning a list, not part of what the discipline is called; a printed form is read one line
at a time, its column widths are measured for the stored name, and the tag text would push against
them for no reader who needs it. See *Naming a discipline* in
[`timetable-ui/README.md`](./README.md) for the rule and `course-label.ts` for the one function that
applies it.

Here the split does not exist at all: a `PlanRow` carries the bare name and **no tagged counterpart**,
because nothing renders one. «Навчальні плани» builds its on-screen table from the raw curriculum
items and labels them itself, and the summary above it shows only totals — so this sheet is the
field's one consumer, and one form is all it needs.

### Arithmetic separate from layout

`curriculum-plan.ts` knows nothing about PDF, and `curriculum-report.ts` computes nothing beyond the
totals of the rows it prints. So the same `buildCurriculumPlan()` feeds both the on-screen summary
and the document: they cannot disagree. It is the same split as `workload-stats.ts` /
`workload-report.ts`.

### Independent work that is not in the data

When `INDEPENDENT_WORK` is not given on an item, its independent-work hours are computed as
`credits · 30 − contact hours` — exactly the arithmetic used to fill that column in on a paper plan.
An explicitly entered **zero** is not overridden: it is an assertion rather than an absence, and
substituting for it would hide an error in the data. How many items were computed rather than read is
stated in the document's notes.

### The three-level table header

`drawTable` can take a header of several rows: `headerRows`, with `colSpan` **and** `rowSpan` on the
cells. Cells are laid out left to right into the first free column of each row, so a cell that is
spanned into from above is simply not repeated — the same way a merged cell is written by hand. Row
heights are set by the single-row cells; a spanning cell stretches only the **last** row it occupies,
and only when it is short of space, since otherwise a long group heading would push all its
neighbours out of shape. The header block is measured once and redrawn on every page the table
continues onto.

The widths of the numeric columns are chosen so that the **longest word** of each column's own
caption fits whole: a mid-word break («лаборато / рні») reads as a defect on a printed plan, and the
engine's hyphenator cuts an over-long word letter by letter rather than letting it escape the cell.

### Fonts and engine

The same as in the workload calculation — see
[WORKLOAD-PDF.md, section 5](WORKLOAD-PDF.md#5-technical-decisions): a hand-written `pdf-writer.ts`
instead of jsPDF or pdfmake, `CIDFontType2` under `Identity-H`, a `ToUnicode` CMap, and ~16 kB
Liberation Serif subsets fetched on the first export. A character outside the subset is emitted as
`.notdef` rather than breaking generation — which is why the document contains neither `≥` nor `×`:
it uses «не менш як» and `·` throughout.

### Testing

`curriculum-plan.ts` and `curriculum-report.ts` depend on neither Angular nor the DOM, so the
document renders under Node from plain objects. It was checked against four sets: a full bachelor's
plan of 42 items, an empty plan, a three-item plan, and a 120-item plan spanning 11 semesters. Beyond
the layout and the page breaks, the invariants checked are the ones without which the document would
be lying:

- the credits of the sections sum to the programme volume;
- the credits of the semesters sum to the programme volume;
- contact hours plus independent work equal «Усього годин»;
- the distribution by kind of work (section 4) reconciles with that same total;
- no optional subject has leaked into a programme section or into its totals.

The output is validated with `qpdf --check`, and `pdftotext` confirms that the Cyrillic extracts
correctly.
