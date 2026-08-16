# `lnu_import` — real LNU data → `data.sql`

A two-stage pipeline that replaces the synthetic `data.sql` with the real
structure of Ivan Franko National University of Lviv, scraped from
<https://lnu.edu.ua/structure/faculties> and the individual faculty sites.

```
scrape_lnu.py  ──►  data/*.json  ──►  build_sql.py  ──►  generated/data.sql
                                                             │
                                            validate_sql.py ─┘  (independent check)
```

Stage 1 only *collects*; stage 2 only *transforms*. Keeping them apart means a
crawl (hours of HTTP) is paid once, and the SQL can then be regenerated in a
second while the id-allocation or elective rules are being tweaked.

```bash
pip install -r requirements.txt

python3 scrape_lnu.py                 # crawl every faculty (cached, resumable)
python3 build_sql.py                  # data/ -> generated/data.sql
python3 validate_sql.py generated/data.sql
```

---

## Stage 1 — `scrape_lnu.py`

### What it walks

| Page | Used for |
|---|---|
| `lnu.edu.ua/structure/faculties` | `buildings`, `faculties` (name, site, e-mail, phone, address) |
| `<site>/about/departments` | links to each department page |
| `<site>/department/<slug>` | `departments` — full name, abbreviation, e-mail, phone |
| `<site>/about/staff` | every employee grouped **under their department heading**, with position and e-mail |
| `<site>/employee/<slug>` | `lecturers` — first/middle/last name, e-mail, position, academic degree |
| `<site>/academics/bachelor`, `/master` | `degree_programs` — code, name, degree (from the URL), curriculum page links |
| `<site>/academics/<degree>/<plan>` | curriculum rows: semester, hours per type, control form, elective groups |
| `<site>/course/<slug>` | course type, owning department, and the lecture/practical/lab tables with lecturers and academic groups |

> **On "Співробітники"**: each department's staff tab is a *view* of the
> faculty-wide `/about/staff` page, which already groups every employee under a
> `<h2>` linking to their department. Reading it once per faculty gives the same
> mapping for a fraction of the requests; the department page's own
> `/employee/` links are still used as a fallback for themes that lack it.

### Ordering

`priority_faculties.txt` lists the sites to process first, in order; everything
else follows in the order it appears on the university structure page.

```
ami.lnu.edu.ua
new.mmf.lnu.edu.ua
electronics.lnu.edu.ua
physics.lnu.edu.ua
econom.lnu.edu.ua
```

A priority host that is not on the structure page is logged and skipped.

### Options

| Flag | Meaning |
|---|---|
| `-o, --out DIR` | JSON output directory (default `./data`) |
| `--priority-file FILE` | the ordering file above |
| `--faculties a,b` | crawl only these hosts |
| `--limit-faculties N` | stop after N faculties — handy for a first pass |
| `--cache-dir DIR` / `--no-cache` | on-disk HTTP cache (default `./.cache`) |
| `--offline ROOT` | read `ROOT/<host>/<path>.html` instead of the network |
| `--delay S` | politeness delay between downloads (default 0.3 s) |
| `--skip-lecturer-pages` | don't open each `/employee/` page (much faster, loses academic degrees) |
| `-v`, `--log-file F` | debug logging / tee the log to a file |

The cache is what makes this practical: the full crawl is tens of thousands of
requests, and a re-run after a parser fix costs no network at all. Interrupting
with `Ctrl-C` still writes whatever has been collected.

### Output

`faculties.json` (buildings + faculties), `departments.json`, `lecturers.json`,
`degree_programs.json`, `curricula.json`, `courses.json`, plus `manifest.json` with
counts, HTTP statistics and every warning raised during the run.

Each record carries a `match_key` / `department_key` — the name folded to
lower case with punctuation and a leading "Кафедра" removed — because the same
department is written three different ways across the network
("Дискретного аналізу та інтелектуальних систем" on the listing page,
"Кафедра дискретного аналізу…" on the staff page, "алгебри, топології та основ
математики" on a course page).

---

## Stage 2 — `build_sql.py`

Assigns every id from 1 in insertion order and writes one `INSERT` per row, in
an order that satisfies the foreign keys, followed by the matching `setval`
calls. Nothing from the existing `data.sql` is read.

**Organisation first, curricula second.** `buildings → faculties → departments
→ degree_programs → lecturers` are all generated and indexed by name *before* any
curriculum is walked. That is what lets an AMI course page that says
"Кафедра: алгебри, топології та основ математики" resolve to a **Mechmat**
department, and a lecturer link on an AMI course page resolve to a Mechmat
`lecturers` row.

### How each table is filled

| Table | Source |
|---|---|
| `buildings` | faculty addresses, de-duplicated on a punctuation-insensitive key so "вул. Університетська 1" and "вул. Університетська, 1" are one building |
| `faculties` | structure page; abbreviations from the known LNU set (ФПМіІ, ММФ, …) |
| `departments` | department pages; abbreviation = "К" + initials ("Кафедра дискретного аналізу та інтелектуальних систем" → КДАІС) |
| `degree_programs` | `/academics/<degree>` headings, e.g. `014.09` + `Середня освіта (Інформатика)` + `BACHELOR` |
| `lecturers` | employee pages; `position` from "Посада:", `academic_degree_id` from "Науковий ступінь:" (кандидат → 1, доктор філософії → 2, доктор наук → 3) |
| `academic_groups` | group names on course pages; the programme is the one whose curriculum mentions the group in the most distinct courses, with a master/bachelor tie-break for "…м" groups |
| `courses` | one row per course page, plus a `ДВ` parent per elective row |
| `course_degree_programs` | every degree programme whose curriculum contains the course |
| `course_tags` | the two tags on each `ДВ` group (see below) |
| `curriculum_items` | one per (degree programme, course, semester); ECTS and control form from the course page's "Навчальний план" table when the curriculum row doesn't say |
| `curriculum_item_hours` | the Лекцій / Лаб. / Практ. columns |
| `working_curriculum_items` | one per hours row; `TOGETHER` when a single class block covers all groups, `SEPARATELY` when the course page lists a row per group; for a `ДВ` item, one per child elective with `course_id` set to it |
| `working_curriculum_item_groups` | the groups of *that* programme named on the course page |
| `combined_working_curriculum_items` (+ members) | working items sharing course + semester + hour type + hours across degree programmes — the "one shared lecture" case |
| `lecturer_workloads` (+ lecturers, + groups) | one per combined item, or per class block for a `SEPARATELY` item; `duration_hours` from `default_class_duration_hours` |
| `academic_degrees`, `class_start_times`, `global_properties` | fixed seed values |

### Elective groups

A curriculum row like

> Дисципліна на вибір 1: **Динамічна теорія інформації** · **Моделі статистичного навчання**

becomes:

```sql
INSERT INTO public.courses (id, name, course_type, ...) VALUES (13, 'ДВ', 'ELECTIVE_GROUP', ...);
INSERT INTO public.course_tags (id, course_id, tag) VALUES (5, 13, 'середня освіта (інформатика)');
INSERT INTO public.course_tags (id, course_id, tag) VALUES (6, 13, 'семестр 2');
INSERT INTO public.courses (id, name, course_type, ..., parent_course_id) VALUES (14, 'Динамічна теорія інформації', 'ELECTIVE', ..., 13);
INSERT INTO public.courses (id, name, course_type, ..., parent_course_id) VALUES (15, 'Моделі статистичного навчання', 'ELECTIVE', ..., 13);
```

The two tags are the programme name (lower-cased) and `семестр <n>`, matching
the `'прикладна математика'` / `'семестр 7'` convention.

### Options

| Flag | Meaning |
|---|---|
| `-i, --in DIR` | JSON directory from stage 1 (default `./data`) |
| `-o, --out FILE` | SQL file (default `./generated/data.sql`) |
| `--no-auth` | omit the seeded users/groups/permissions |
| `--no-check` | skip the constraint self-check |

By default the script also emits three seeded accounts
(`admin@lnu.edu.ua` / `Admin#2026`, plus `dean.fpmi@lnu.edu.ua` and
`o.melnyk@lnu.edu.ua` / `Temp#12345`) with the same BCrypt hashes, so the
application is usable straight after loading. `--no-auth` drops them.

**This no longer matches the checked-in `data.sql`, which seeds only the
administrator** — the other two accounts, their group memberships and the
`DEPARTMENT` grant were removed by hand. Regenerating `data.sql` from this
pipeline therefore brings them back. The generated `INSERT` also predates
`users.lecturer_id` / `users.student_id`, which is harmless (both are nullable,
so the rows load and the accounts are simply linked to nobody), but it means the
pipeline cannot seed the person link «Мій кабінет» reads. Both are one edit in
`build_sql.py`'s `auth_block`, and neither is a reason to avoid re-running the
scrape — just re-apply the account decisions afterwards.

More has accumulated in the checked-in dump since, and none of it comes from
here: the «Волонтери — наповнення даних» group and its nineteen `FACULTY` grants
(seeded by `V12`), the empty `group_invitations` block, and — most easily missed
— the `flyway_schema_history` rows recording V1…V12 as applied. Without those
last ones a freshly loaded database re-runs every migration on the next start.
Each is written to be a no-op on a second run, so nothing breaks; but the dump
this pipeline writes is a database *before* the migrations rather than after
them, which is a different starting point from the one the READMEs describe.

The same caveat applies to ids in general: `departments`, `lecturers` and
`degree_programs` in the checked-in `data.sql` have been renumbered by hand since
this pipeline last wrote it (the кафедра/викладачі/освітні програми of прикладна
математика were moved to the low ids), so a regenerated file will not agree with
it row for row.

The self-check runs before the file is written and reports foreign keys, unique
keys, enum labels, `CHECK` constraints and `VARCHAR` widths; violations set exit
code 2 (the file is still written so it can be inspected).

---

## Verification

`validate_sql.py` re-reads the *files* rather than the builder's memory, so it
also catches rendering mistakes:

1. parses `data.sql` with the real PostgreSQL grammar via `pglast`;
2. reads `schema.sql` for tables, columns, enums, NOT NULLs and unique keys;
3. replays every `INSERT` in file order — a foreign key pointing at a row that
   has not been inserted *yet* fails, exactly as `psql -f` would.

Both scripts were run end-to-end against the offline fixtures in `tests/`:

```
$ python3 tests/make_fixtures.py
$ python3 scrape_lnu.py --offline tests/fixtures --out tests/sample_output
$ python3 build_sql.py -i tests/sample_output -o tests/sample_output/data.sql
$ python3 validate_sql.py tests/sample_output/data.sql

PostgreSQL grammar: OK (281 statements parsed by pglast)
PASSED — every INSERT satisfies the schema's columns, types, enums, widths,
         NOT NULLs, unique keys and foreign keys (in file order).
```

`tests/fixtures/` mirrors the real markup (same headings, same table shapes,
same `rowspan`s) for AMI and Mechmat, and deliberately includes the awkward
cases: an AMI course owned by a Mechmat department, a lecturer link crossing
faculties, a lecture shared by two degree programmes that must be merged into a
combined working item, an elective row that must become a `ДВ` group, and a
faculty whose site has no `/about/departments` at all.

`tests/sample_output/` holds the JSON and SQL that run produced, as a worked
example of the format.

---

## Applying the result

```bash
psql -h localhost -U postgres -d lnu-timetable -f ../../src/main/resources/db/schema.sql
psql -h localhost -U postgres -d lnu-timetable -f generated/data.sql
```

Or write straight over the checked-in seed:

```bash
python3 build_sql.py -o ../../src/main/resources/db/data.sql
```

---

## Known limitations

- **Group → degree programme is inferred, not stated.** Course pages list group names
  but never say which programme a group belongs to. The builder votes across
  curricula and logs every ambiguous case (`group … is claimed by N degree programmes`);
  review those in the UI if they matter.
- **A shared elective child is duplicated.** `courses.parent_course_id` is
  single-valued, so an elective offered by two degree programmes produces one child
  row per `ДВ` group rather than one shared row.
- **`rooms`, `students`, `timetable_entries` are not generated** — the faculty
  sites don't publish them. Their sequences are reset to 1.
- **Themes differ.** Parsing is heading- and table-shape driven rather than
  class-name driven, but a faculty that lays out its curriculum as a PDF or an
  image yields nothing; every such case is counted in `manifest.json`'s
  `warnings`.
- **`INDEPENDENT_WORK` hours** are stored when a curriculum lists them but never
  produce working curriculum items — there is no class to schedule.
- Semester numbers are taken verbatim from the curriculum page, so a master plan
  numbers its semesters 1–3 rather than 9–11.
