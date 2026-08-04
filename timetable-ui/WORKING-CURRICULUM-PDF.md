# The printable working curriculum (PDF)

The **«Завантажити PDF»** button on the "Робочі навчальні плани" tab (`/specialty/{id}`) produces the
document *«РОБОЧИЙ НАВЧАЛЬНИЙ ПЛАН на 20\_\_/20\_\_ навчальний рік»* — the working curriculum for the
selected specialty and course year.

The document is built **entirely on the client**: not one byte goes to the server, and the file is
handed to the browser as a `Blob`. The code is `pdf-writer.ts` (the engine),
`working-curriculum-plan.ts` (the arithmetic and the checks), `working-curriculum-report.ts` (the
document itself) and `pdf-fonts.ts` (fonts and file delivery).

> Ukrainian is kept throughout this document for anything that is *printed* on the sheet, for UI
> labels, and for the names of laws and orders. Those strings are literals, not descriptions.
> Everything that explains or argues is in English.

---

## 1. Legal basis

### The working curriculum is **not regulated** by legislation at all

This is the most important thing to know about the document, and it holds more strongly than the
equivalent conclusion about the [curriculum](CURRICULUM-PDF.md).

| Source | What it says about the working curriculum |
| --- | --- |
| **Наказ МО України № 161 від 02.06.1993** (Положення про організацію навчального процесу у ВНЗ) | The only act that ever defined the working curriculum, and in a single sentence: «для конкретизації планування навчального процесу на кожний навчальний рік складається робочий навчальний план, що затверджується керівником вищого закладу освіти». No form, no columns, no deadlines. **Repealed** by наказ МОН № 1310 від 13.11.2014 (registered 21.11.2014 under № 1485/26262) |
| **Закон України «Про вищу освіту» № 1556-VII** | Does **not use** the term «робочий навчальний план» at all. Ст. 10 ч. 4 knows the curriculum and the students' **individual** study plans for each academic year |
| **Ліцензійні умови, ПКМУ № 1187 від 30.12.2015** | Require a «робочий навчальний план» of **pre-school** (п. 57–58) and **general secondary** (п. 42) education. Of higher education institutions they require only «освітню програму, навчальний план» (п. 10 пп. 5). This is a choice by the legislator, not an omission |
| **Положення про акредитацію ОП, наказ МОН № 977 від 11.07.2019** | Does not contain the term. Accreditation is applied for with the programme and the curriculum |
| **Лист МОН № 1/9-126 від 13.03.2015** | The only mention of the working curriculum in a ministry act after 2014 — as the document into which «несуттєві зміни» may be entered without re-approving the curriculum. **A letter is not a normative act** |

> **Do not present this sheet as a document required by law.** It is internal. The line under the
> title says so outright.

⚠️ **A trap for dissertation work.** Some legislation aggregators (vnz.org.ua, vk24.ua) print, inside
ст. 10 ч. 4 of the Law «Про вищу освіту», a sentence about the working curriculum — a verbatim quote
from the repealed наказ № 161. The tell is the obsolete «вищий навчальний заклад» in place of «заклад
вищої освіти». The official collections (kodeksy.com.ua, urst.com.ua) do not carry that phrase. Check
against `zakon.rada.gov.ua`.

### What is reproduced instead

Settled institutional practice, which turns out to be remarkably consistent:

| Feature | Source |
| --- | --- |
| Drawn up **for one academic year**, elaborating the curriculum | ЗНУ, п. 1.3: «деталізує особливості підготовки … у поточному навчальному році»; ОНТУ, п. 1.4.11: «похідний документ … розробляється на кожний навчальний рік»; ХНМУ, п. 3.2.8 |
| The one thing it adds to the curriculum is **a department against each block of hours** | ЗНУ, Положення про розрахунок навантаження, п. 2.10: «закріплення навчальних дисциплін за відповідними кафедрами … фіксується в **робочих навчальних планах**» |
| It is **the basis for planning departmental workload** | КПІ ім. Сікорського, Положення про планування педнавантаження 2022: «підставою для планування навчального навантаження … є відповідні **витяги з робочих навчальних планів**» |
| Approved **above faculty level** — a vice-rector or the academic council plus a rector's order; countersigned by the academic affairs unit, the dean and the department | ОНТУ п. 5.10; ДДПУ п. 1.9; КрНУ пп. 1.15–1.16; ХНМУ (a real 2025/26 working curriculum) |
| Drafted in spring, refined after admissions | ОНТУ — by 1 March; КПІ — by 1 July, refined by 15 September; ЗНУ — the volume of load fixed by rector's order no later than 10 September |

### A correction to the common picture of the working curriculum

Columns for "streams / groups / subgroups / lecturer name" are **not** typical columns of a working
curriculum: in none of the regulations examined are they confirmed as columns of the main table.
Individuals appear later — in staff individual plans and teaching-load cards. The classic working
curriculum is "this year's curriculum **plus a department column**", while groups, teaching format
and student numbers live in the **витяг з РНП**, the extract a department receives in order to
calculate its load.

That is why the document is split: **section 2** is the classic working curriculum with a department
column; **section 3** is the extract, where each item is a row of its own with format and student
numbers; **section 4** is the summary the extract exists for. The real ХНМУ 2025/2026 working
curriculum, incidentally, has no department column at all — proof that even the basic set of columns
is not universal.

### Time norms

The planned departmental hours do not follow from any state norm: **наказ МОН № 450 від 07.08.2002
has been repealed** (наказ МОН № 187 від 16.02.2022, registered 03.03.2022 under № 281/37617), and
time norms are set by the institution itself. The document therefore **states its own rule outright**
in section 4 — see [Department planned hours](#department-planned-hours).

> This inconsistency is alive and documented: ЗНУ's regulation **in its 2024 revision** still cites
> наказ № 450 as the basis of its time norms, two years after it was repealed; КПІ cites «Норми
> часу…, затверджені наказом МОН» with no number at all. ХНЕУ (2023 revision) already states its own
> norms correctly. Usable material for a dissertation.

## 2. Layout

The same as in the [curriculum](CURRICULUM-PDF.md#2-layout-дсту-41632020): landscape A4, margins
30/10/20/20 mm, Liberation Serif, page numbering from the second sheet, and the signature form
«Власне ім'я ПРІЗВИЩЕ».

The caveat about whether ДСТУ 4163:2020 applies is stronger still here: the standard governs
organisational and administrative documentation, a working curriculum is a planning-and-teaching
document, and standards in Ukraine are voluntary under the Law «Про стандартизацію» unless a
normative act references them directly. It is applied (a) through the institution's own
records-management instruction, and (b) so that two sheets from one system do not look like they come
from different eras. **Landscape orientation is practice, not a norm**: the standard says nothing
about orientation and merely permits A3 «для документів із таблицями».

The approval block is «ЗАТВЕРДЖУЮ Проректор» rather than the curriculum's «ЗАТВЕРДЖЕНО Вченою
радою»: a working curriculum is approved by an official on the submission of the academic affairs
unit, whereas a curriculum is approved by a collegial body under the express norm of ст. 36 ч. 2
п. 8. Practice is divided here (ХНМУ and КрНУ use the second form), so both ДСТУ forms are defensible
— the one reproduced is the one described by the ОНТУ and ДДПУ regulations.

## 3. Structure of the document

### Sheet 1 — the title page

The ЗАТВЕРДЖУЮ block in the top right corner, the letterhead МОН → ЛНУ → faculty, the title «РОБОЧИЙ
НАВЧАЛЬНИЙ ПЛАН на 20\_\_/20\_\_ навчальний рік», a table of header fields (specialty, degree,
faculty, mode of study, coverage of the plan, academic groups · academic year, items, credits, hours,
departments) and a «Підстава» paragraph stating that the document is internal.

### Section 1 — Зведені показники робочого навчального плану

Educational components · credits · hours (total / contact / independent work) · departments · working
curriculum items · **blocks of hours assigned to departments** · planned departmental load hours.

### Section 2 — План освітнього процесу

The classic working curriculum. Thirteen columns under a two-level header:

| № з/п | Освітній компонент | Семестр | Форма контролю | Кредитів ЄКТС | Кількість годин: усього · лекції · практичні · лабораторні · консультації, контрольні заходи · самостійна робота | **Кафедра, що забезпечує викладання** | Академічні групи |
| --- | --- | --- | --- | --- | --- | --- | --- |

Where a discipline is taught by **several departments**, the cell names each one with its kinds of
work («Кафедра програмування (лекції); Кафедра інформатики (лабораторні)»); where there is no
department, it reads «не закріплено: контрольні заходи». The breakdown by kind of work appears only
when there is more than one department: in the ordinary single-department case it would be noise.

When "усі курси" is selected, each course year is announced by a «N КУРС» heading row.

### Section 3 — Розподіл позицій робочого плану за кафедрами

The extract: one row per working curriculum item, grouped by department, with a subtotal under each.

| № з/п | Курс | Семестр | Освітній компонент | Вид роботи | Формат проведення | Академічні групи | Студентів | Годин за планом | Планових годин кафедри |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

This is the only place where the teaching format and the student numbers are visible — and it is
exactly what a department receives in order to plan its load.

### Section 4 — Розрахунок годин навчального навантаження кафедр

One row per department: items · disciplines · hours by kind of work · hours per plan · **planned load
hours**.

#### Department planned hours

These are computed by **this system's own rule**, named in the document itself:

```
a TOGETHER / SEPARATELY item → hours · number of lecturers
an INDIVIDUALLY item         → hours · number of students
```

This is exactly what `workload-stats.ts` does once the load has been assigned: several lecturers on
one item means parallel subgroups, so each delivers the full volume, and individual work costs
"hours · students". Projecting the working curriculum by any other rule would mean disagreeing with
the [workload calculation](WORKLOAD-PDF.md), which is signed off on the same data.

"Disciplines" are counted the same way as `LecturerStats.distinctCourses`: lectures, practicals and
labs only — consultations consume hours but do not make a discipline "taught".

### Section 5 — Відповідність та повнота робочого плану

Up to five checks. The numeric bounds come from `global_properties` (see
[CURRICULUM-PDF.md](CURRICULUM-PDF.md)), and a check whose bound has been cleared does not appear in
the table. The first two have no bound — the plan is either complete or it is not. The fifth appears
only when the plan contains individual work:

| Check | Norm | Status |
| --- | --- | --- |
| Contact hours assigned to departments | all blocks | practice |
| Academic groups on items | every item has groups | practice |
| Annual load, ЄКТС credits | as a rule 60 (ст. 1 п. 14) | **law** |
| Hours per ЄКТС credit | 30 hours (ст. 1 п. 14) | **law** |
| Student numbers for individual work | the number of students in the groups | practice |

The first is the only one that can return «НЕ ВИКОНАНО»: a block of hours with no department means no
workload will be generated from it, which is the whole reason a working curriculum is drawn up. The
third only means anything when the sheet really does cover one academic year, so under "усі курси" it
honestly reports «не визначено».

### The signature block

ПОГОДЖЕНО: head of the academic affairs unit · dean of faculty · programme guarantor · head of the
graduating department. The order is the reverse of the curriculum's — a working curriculum is
countersigned from the top down, starting at the academic affairs unit, whereas a curriculum starts
at the programme guarantor.

> The programme guarantor in the signature block of a **working curriculum** is not directly
> confirmed by any regulation examined (the guarantor appears on curricula, programmes and syllabi).
> It was kept as a familiar element; an institution that does not use it there deletes one line in
> `drawSignatures`.

## 4. What was deliberately left out

- **The academic-year calendar** (the Т/Е/П/К week grid) and the **time budget in weeks** — the
  system stores neither weeks, nor examination sessions, nor holidays. That is a new table in
  `schema.sql`.
- **Hours per week** — a column confirmed on real working curricula (УУ, Додаток А), but it needs the
  number of weeks in a semester, which the model does not have.
- **Lecturer names** — deliberately: by practice they do not belong on a working curriculum, and the
  system has them on the department pages anyway. The "Навантаження викладачів" tab is where they
  appear.
- **A link to the year of intake or cohort.** `Specialty` stores neither an admission year nor
  student numbers by year, so the "academic year" in the title is taken from the generation date and
  the course year is chosen by hand with a filter. Because of that, a sheet covering "усі курси" is
  not a working curriculum in the usual sense, and the document says so in its notes.
- **Streams as an entity of their own.** The model knows academic groups and teaching format, from
  which a stream follows, but does not store it: a «Разом» lecture given to several groups is one
  stream by construction.

## 5. Technical decisions

The same as in the [curriculum](CURRICULUM-PDF.md#5-technical-decisions): arithmetic
(`working-curriculum-plan.ts`) separate from layout (`working-curriculum-report.ts`), a hand-written
`pdf-writer.ts`, Liberation Serif subsets, and a multi-level header via `headerRows`.

Two differences are worth knowing.

**Course year is a parameter, not data.** `buildWorkingCurriculumPlan(items, courseYear)` takes the
course year as its second argument; `null` means "all years". The filter on the page and the scope of
the document are one and the same argument, so the printed sheet always matches what was on screen.

**Independent work** is derived the same way as in the curriculum: `credits · 30 − contact hours`,
when `INDEPENDENT_WORK` is not given explicitly. Both documents have to produce the same figure for
the same item.

### Testing

Both modules are free of Angular and the DOM, so the document renders under Node from plain objects.
It was checked against five sets: a single-year plan, all years, an empty plan, a plan with no
department assignment anywhere, and a plan of 90 disciplines and 221 items. Beyond the layout and the
page breaks, the invariants checked are:

- the hours per plan by department equal the sum over the items;
- the planned hours by department equal the plan's total;
- the hours by kind of work reconcile with each department's subtotal;
- the course year of every row equals `ceil(semester / 2)`;
- filtering by course year only narrows — it never adds items or hours;
- blocks with no department are counted, not quietly lost;
- the hour-projection rule agrees with `workload-stats.ts` in all four cases.

The output is validated with `qpdf --check`, and `pdftotext` confirms that the Cyrillic extracts
correctly.
