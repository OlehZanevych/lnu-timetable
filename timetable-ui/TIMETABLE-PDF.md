# The printable class timetable (PDF)

The **«Завантажити PDF»** button on four tabs — "Розклад факультету" (`/faculty/{id}`), "Розклад
кафедри" (`/department/{id}`), "Розклад" on the lecturer page (`/lecturer/{id}`) and "Розклад" on the
room page (`/room/{id}`) — produces the class timetable of the subject in question.

The document is built **entirely on the client**. The code is `pdf-writer.ts` (the engine),
`timetable-grid.ts` (the grid), `timetable-report.ts` (the document itself) and `pdf-fonts.ts` (fonts
and file delivery).

> Ukrainian is kept throughout this document for anything that is *printed* on the sheet, for UI
> labels, and for the names of laws and orders. Those strings are literals, not descriptions.
> Everything that explains or argues is in English.

---

## 1. Legal basis

### The class timetable has no legal existence

This is the least regulated document in the system — less regulated even than the [working
curriculum](WORKING-CURRICULUM-PDF.md), which was at least defined once, by an order that has since
been repealed.

| Source | What it says about the class timetable |
| --- | --- |
| **Закон України «Про вищу освіту» № 1556-VII** | Does **not contain the word «розклад» at all**. Ст. 62 (rights of students) does not mention it; ст. 79 (openness) is a general norm with no enumeration |
| **Закон України «Про освіту» № 2145-VIII, ст. 30** | Ч. 2 gives a **closed list** of what an institution must publish on its website: statute, licences, structure, staff, educational programmes, licensed intake, language, vacancies, facilities, dormitories, quality monitoring, annual report, admission rules, fees. **The timetable is not on the list** |
| **Ліцензійні умови, ПКМУ № 1187** | Do not contain the word «розклад»; п. 29 refers back to ст. 30 of the Law «Про освіту» — a closed loop |
| **Наказ МО України № 161 від 02.06.1993** | The source of every "canonical" figure: п. 3.2 — kinds of classes; п. 4.1 — the academic hour is «як правило, 45 хвилин», the teaching day is at most 9 academic hours and the week at most 54; п. 4.2 — «навчальні заняття тривають дві академічні години … і проводяться за розкладом». **Repealed** by наказ МОН № 1310 від 13.11.2014 |

> **No law obliges an institution to publish its timetable at all.** Since 2022 a number of
> institutions have gone the other way and withdrawn theirs from public view «з міркувань безпеки»
> (ЦНТУ among them), and that is legally possible precisely because no such obligation exists.

### There is no sanitary regulation for higher education

ДСанПіН 5.5.2.008-01 and the Санітарний регламент (наказ МОЗ № 2205 від 25.09.2020) apply to
**general secondary education**. Higher education has no equivalent. So the length of a class, the
breaks, the number of classes per day and a student's weekly contact hours are **100 % institutional
norms**, and the spread is real:

| What | Spread | Examples |
| --- | --- | --- |
| Academic hour | 40 or 45 min | ЛНУ, ЗНУ — 40; КПІ, Грінченка, ХАІ, ДБТУ — 45 |
| Length of one class («пара») | 70–95 min | ОНУ — 80 with no break; ЛНУ, НУБіП — 80; КПІ — 95 |
| Classes per day | at most 3…4 | ОНУ — at most 6 contact hours (3 classes); КПІ — «до 4, але можливі винятки» |
| Weekly contact hours (bachelor / master) | 16–30 / at most 18 | ЗНУ — 24–26 / 16–18; ОНУ — 16–24 / at most 16; НУБіП — 24–30 by year |
| Publication deadline | 3 or 10 days before the semester | ЗНУ, ДБТУ — 3; КПІ, ЧНУ — 10 |

Which is why the one number this document actually needs — **the length of the academic hour** — is
read from `global_properties` rather than assumed.

## 2. One sheet is approved, three are not

This is the central decision in the document, and it rests on a single predicate, `isOfficial(kind)`.

| Sheet | Formal apparatus | Why |
| --- | --- | --- |
| **Faculty** | «ЗАТВЕРДЖУЮ» approval block · letterhead МОН → institution → faculty · «ПОГОДЖЕНО» countersignature · signature block | The timetable by academic group is the one institutions publish and approve |
| **Department** | none | Institutions deliver lecturer timetables as a web service rather than as a sheet: at ЛНУ that is «ПС-Розклад» and the faculty pages, at КПІ it is schedule.kpi.ua |
| **Lecturer** | none | the same |
| **Room** | none | The room timetable is an internal instrument of the dispatch office and the academic affairs unit; КПІ does not even offer a filter by room |

The reference sheets carry the line **«Довідковий документ. Затвердженню не підлягає»** instead,
plus a note pointing at the faculty timetable as the one that is approved. Printing an approval block
on a sheet nobody approves is not a harmless decoration — it is an assertion that an approval
happened when it did not.

### Who approves the faculty sheet

The dominant signatory is the **проректор з науково-педагогічної роботи** (ЗНУ п. 5.4.2, ОНУ п. 5.4,
ДБТУ п. 7.9, ХНУ ім. Каразіна, ЛНМУ). The dean is not the approver but the compiler-signatory. The
countersignature is by the **начальник навчального відділу** — that is how ХНУ ім. Каразіна prints
it. Countersignature by a trade union or a student council appears in **none** of the regulations
examined and in no real PDF.

## 3. Layout

What is reproduced is what ЛНУ ім. І. Франка **actually publishes** — checked against current sheets
from the faculty of applied mathematics and informatics and from the economics and philosophy
faculties.

### Grid (faculty, department)

Rows are **day of week → class slot** (a Roman numeral plus a time range); columns are **academic
groups** (faculty) or **lecturers** (department). One sheet per course year, not per group.

A cell reads in the order ЛНУ uses:

```
DISCIPLINE (in capitals)
kind of class, room
position and surname of the lecturer
```

A biweekly class is marked `[Чисельник]` / `[Знаменник]` at the start, because two of them share one
cell. The order inside the cell is fixed: чисельник before знаменник, so that a reader comparing two
weeks always finds them the same way round.

An empty day is not printed at all; neither is an empty slot, so a five-class day does not produce
eight rows of dashes. Columns beyond what landscape A4 will hold move to the next sheet: a timetable
squeezed down to six-point type is not a document anyone reads.

### List (lecturer, room)

A sheet about a **single** subject is set as a list rather than as one tall column:

| День | Пара | Час | Тиждень | Навчальна дисципліна | Вид заняття | Аудиторія | Академічні групи |
| --- | --- | --- | --- | --- | --- | --- | --- |

The last column names **the other side**: on a lecturer's sheet those are the groups, on a room's
sheet the lecturer and the groups. Someone reading a personal timetable wants "when and where" in
order, not a grid with one column filled in.

### Bell schedule and room legend

ЛНУ embeds the time in the «Пара» column, and so does this sheet — but a compact list is added below
the grid, `I — 08:30–09:50 · II — …`: a reader checking one class should not have to scan the whole
table. The room legend is printed whenever there is more than one room: at ЛНУ it is indispensable,
because a room number on its own does not say which building it is in.

### Presentation

The same as on the other three sheets: landscape A4, margins 30/10/20/20 mm, Liberation Serif, page
numbering from the second sheet, and the signature form «Власне ім'я ПРІЗВИЩЕ» (ДСТУ 4163:2020). ЛНУ
is inconsistent here itself — the ПМІ faculty already writes «Іван ДИЯК» while economics still writes
«(Р.В. Михайлишин)»; the standard's form was taken.

The caveat about whether ДСТУ 4163:2020 applies at all is stronger here than in any of the other
three documents: the standard governs organisational and administrative documentation, and a
timetable is neither organisational, nor administrative, nor informational-analytical. It is used as
a stylistic reference for the layout elements, and no more than that.

## 4. Abbreviations

There is no unified standard — three institutions checked give three systems:

| Kind | ЛНУ | ХНУ ім. Каразіна | КПІ |
| --- | --- | --- | --- |
| Lecture | `лекція` | `(Л)` | `Лек` |
| Practical | `практ.` | `(Пр)` | `Прак` |
| Lab | `лаб.` | — | `Лаб` |
| Seminar | `сем.` | `(Сем)` | — |

The ЛНУ forms are used (`HOUR_TYPE_SHORT` in `timetable-grid.ts`), because it is ЛНУ's system.
Positions are abbreviated the way ЛНУ timetables abbreviate them: `проф.`, `доц.`, `ст. викл.`,
`викл.`, `ас.` (`POSITION_SHORT`).

## 5. What was deliberately left out

- **Two shifts.** ЛП and КПІ allow a second shift (slots 5–8 after 14:50); the model knows only a set
  of start times, and a shift cannot be derived from that.
- **Different bell schedules for different buildings**, as МНАУ has. `ClassStartTimeSet` is attached
  to a faculty, not to a building.
- **A reference to the order** that brought the timetable into force — ХНУ ім. Каразіна prints
  «наказ 0401-483 від 24.09.2024» — and a **qualified electronic signature**. Both are fields the
  model does not have.
- **Subgroups.** At ЛП «чисельник/знаменник» denotes subgroups rather than weeks — a semantic trap.
  Here it always means week parity, as `timetable_entries.week_parity` does.

## 6. Technical decisions

### One grid for four screens and the document

`timetable-grid.ts` is a pure function,
`buildTimetableGrid(entries, { columnMode, academicHourMinutes })`. `columnMode` decides what runs
along the horizontal, and with it which of the four documents this is: `group` — the timetable a
faculty publishes; `lecturer` — the departmental one; `room` — the room one; `single` — a single
subject. The same object feeds both `TimetableView` on screen and `timetable-report.ts` in the PDF,
so a timetable rendered four ways is not four opportunities to disagree.

A class lands in **every column it belongs to**: a lecture given to three groups occupies three cells
of the group grid. That is what makes the printed sheet readable down a group's column — and it is
how the published ones look.

### Semester

`timetable_entries` **has no semester of its own** — it sits two joins away, on the curriculum item.
So each of the four screens filters by `semesterParity` (a relational filter on the backend), with
the default taken from `current_semester_parity`. Without it autumn and spring overlap and rooms look
doubly booked — exactly the flaw the older `/timetable` page has.

### Testing

`timetable-grid.ts` and `timetable-report.ts` are free of Angular and the DOM, so they render under
Node. They were checked against five sets: a faculty (6 groups), a department (4 lecturers), a
lecturer, a room, and an empty timetable. Beyond the layout, the invariants checked are:

- every class lands in the grid exactly once per column it belongs to — or is reported as unplaced,
  but never disappears silently;
- a shared lecture appears in the column of every group it is taught to;
- the end time follows the academic-hour setting (40 min → 09:50, 45 min → 10:00);
- changing `columnMode` does not change the number of classes, only how they are grouped;
- чисельник is listed before знаменник in a shared cell.

The output is validated with `qpdf --check`; `pdftotext` confirms that the Cyrillic extracts
correctly.
