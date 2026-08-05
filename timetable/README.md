# Timetable GraphQL Service

A reactive **Spring Boot + GraphQL + R2DBC** service for university course timetabling at
Ivan Franko National University of Lviv (LNU). It ships a small **config-driven framework**:
you describe entities with annotations and declare GraphQL types/queries/mutations in a
configuration class — **no controllers, services or repositories, and no `.gqls` files**.
The schema, optimized SQL handlers, and N+1-safe batched relation loading are all generated
at startup.

- `groupId` `org.lnu`, `artifactId` `timetable`, root package `org.lnu.timetable`
- Spring Boot 4.0.6, Java 25, WebFlux, Spring for GraphQL, R2DBC (PostgreSQL)
- JWT authentication + entity-scoped, cascading "modify" permissions for users/groups — see
  [Authentication & authorization](#authentication--authorization)

---

## Why this design

The original `deanery-2026-graphql` app required, for every entity, a hand-written
repository + service + controller + `.gqls` schema fragment. This service replaces all of
that with two things the developer writes:

1. an **annotated entity** (a POJO), and
2. a few **declarative lines** in a `GraphQLSchemaConfig`.

At startup the framework scans entities, builds the GraphQL schema programmatically, and
creates data fetchers that translate each GraphQL selection set into an **optimized SQL
query selecting only the requested columns** — batching sibling-row relation lookups via
`DataLoader` so nested queries don't degrade into N+1 SQL calls (see
[Avoiding N+1 queries](#avoiding-n1-queries-dataloader-batching)).

---

## Requirements

- **JDK 25** (the project targets `release 25`; Maven running on an older JDK fails with
  "release version 25 not supported"). On macOS:
  ```bash
  export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home
  ```
- **PostgreSQL** running on `localhost:5432` with a database named `lnu-timetable`.
- **Maven** on the `PATH` (`mvn`) — there is no `mvnw` wrapper checked in, so a local install is required.

---

## Database setup

```bash
# create database (psql from your PostgreSQL install)
createdb -h localhost -U postgres lnu-timetable
# load schema and seed data
psql -h localhost -U postgres -d lnu-timetable -f src/main/resources/db/schema.sql
psql -h localhost -U postgres -d lnu-timetable -f src/main/resources/db/data.sql
```

`schema.sql` starts with `DROP SCHEMA public CASCADE`, so it always recreates a clean
schema.

`data.sql` is no longer a pristine `pg_dump` of a hand-entered database: on top of the real LNU
structure it carries the **ФПМІ 2025/2026 timetable**, transcribed from the faculty's published
PDF sheets — 1428 `timetable_entries` over both halves of the year, with the rooms, room groups,
courses, curriculum items and `lecturer_workloads` they needed. Two things follow for anyone
querying it. `timetable_entries` has **no semester column** — the semester lives on the curriculum
item behind the workload — and both halves are loaded, so *any* query over the timetable must
filter by semester or autumn and spring classes will appear to share rooms. And a handful of
genuine clashes (four rooms, one group, three lecturers) are in the data because they are printed
that way on the sheets; they were left visible rather than silently patched.

### Configuration

Settings are split across two files in `src/main/resources`, and the split is by *what changes
between environments* rather than by subject:

| File | Holds |
|---|---|
| `application.properties` | what is the same everywhere — the connection URL and pool sizing, GraphiQL, `app.security.jwt-ttl-minutes`, and `spring.profiles.active=loc` |
| `application-loc.properties` | what is not — `spring.r2dbc.username`/`password`, `app.security.jwt-secret`, the R2DBC SQL/param debug logging (which is how the N+1 query problem described below was originally spotted), and `app.apollo-sandbox.enabled` |

The `loc` profile is activated from `application.properties` itself, so a local run needs nothing on
the command line, and both files are checked in with working development values. Anything in the
profile file can be overridden per run — `--spring.r2dbc.password=…`, `SPRING_R2DBC_PASSWORD=…`,
`SPRING_APPLICATION_JSON` — and `--spring.profiles.active=` drops the file altogether. See the root
README's *Running it as a single jar* for what a deployment should override.

`scripts/reset_db.sh`, `scripts/backup_data.sh` and `scripts/renumber_ids.sh` read both files
directly: the URL from the first, the credentials from the second. The connection is therefore
stated once and the scripts stay correct when it changes; all three fail with a named error if
either file, or either key, is missing.

---

## Run

```bash
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home mvn spring-boot:run
```

- GraphQL endpoint: `POST http://localhost:8080/graphql`
- GraphiQL (browser IDE): `http://localhost:8080/graphiql`
- `GET /` redirects to **Apollo Studio Sandbox** pointed at this service — while
  `app.apollo-sandbox.enabled` is `true`, which is what `application-loc.properties` sets. When it
  is anything else, that same path serves the built Angular client instead; see [Serving the
  frontend from this service](#serving-the-frontend-from-this-service)
- Apollo Federation `_service { sdl }` is served for schema introspection by gateways
- A permissive `CorsFilter` allows any origin/method — fine for local dev, tighten before
  deploying anywhere public
- Every operation except `login` requires an `Authorization: Bearer <jwt>` header — sign in via
  `mutation { login(email: "admin@lnu.edu.ua", password: "Admin#2026") { token } }` and pass the
  returned token, or see [Authentication & authorization](#authentication--authorization) for the
  full seeded credential list

Run tests (schema assembly):
```bash
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home mvn test
```

---

## Serving the frontend from this service

This service can carry the Angular client, so the whole system deploys as one jar.
`scripts/build-ui.sh` in the repository root builds `timetable-ui` and copies
`dist/timetable-ui/browser/` into `src/main/resources/static/`; `mvn package` then sweeps that into
`BOOT-INF/classes/static/` with no pom changes, because it is where Spring Boot serves classpath
static resources from. `static/` is build output and is git-ignored. `scripts/build-app.sh` does
both steps and refuses to report success unless the bundle really is inside the jar.

Two controllers share `/`, and exactly one of them is ever in the context:

| `app.apollo-sandbox.enabled` | Registered | `GET /` |
|---|---|---|
| `true` | `IndexController` | 303 to Apollo Studio Sandbox, aimed at this instance's `/graphql` |
| `false`, absent, or anything else | `FrontendController` | the client's `index.html` |

`@ConditionalOnBooleanProperty` is what expresses that — `havingValue = true` on one,
`havingValue = false, matchIfMissing = true` on the other. The two conditions partition every
possible value of the property, so `/` can never be owned by both or by neither.

The bundle's own files — `main-*.js`, `styles-*.css`, `favicon.ico`, `fonts/*.ttf` — are served by
Spring Boot's ordinary static resource handling, untouched. `FrontendController` exists for the one
thing that handling cannot do: answer a **deep link**. The Angular router owns `/faculty/3` and
`/e/course`, which are paths in the browser and files nowhere, so a reload or a pasted URL asks
this service for something that was never on disk. It answers those with `index.html` and lets the
router take over. Three rules keep it from swallowing anything else:

- every path segment is matched as `[^.]*`, so a request for any name containing a dot — every
  hashed asset, every font — does not match here and falls through to the resource handler, which
  still returns a real 404 when the file genuinely is missing rather than HTML where a script was
  asked for;
- `/graphql` and `/graphiql` belong to Spring for GraphQL's own `RouterFunction`, whose handler
  mapping is ordered `-1` — ahead of the order-`0` mapping that serves annotated controllers — so
  they are matched before these patterns are consulted at all;
- `produces = text/html` keeps it out of the way of anything negotiating for JSON.

The client asks for `/graphql` as a relative path (`GraphqlService`), so same-origin serving needs
no configuration on either side; `timetable-ui/src/proxy.conf.json` exists only because `ng serve`
runs on a port of its own.

---

## Domain model

The model follows the Ukrainian HEI / LNU structure and the UCTP model from the article
*"Adaptive Memetic Algorithm for University Course Timetabling"* (a *class requirement* =
lecturer + groups + periodicity; the schedule assigns it a day, slot, room and week parity).

| Entity | Table | Notes |
|---|---|---|
| `Building` | `buildings` | → faculties, rooms |
| `Faculty` | `faculties` | → building?, departments, specialties, rooms |
| `Department` (кафедра) | `departments` | → faculty, lecturers, courses |
| `Specialty` (спеціальність) | `specialties` | code, degree; → faculty, groups, curriculum items |
| `Course` (дисципліна) | `courses` | type (incl. `ELECTIVE_GROUP`/`ELECTIVE`); → faculty? *or* department? directly responsible for it, self-referential parent/child (an `ELECTIVE_GROUP` course's `childCourses` are its `ELECTIVE` options), M-N specialties this course may be added to a curriculum for (`course_specialties`), 1-N tags |
| `CourseTag` | `course_tags` | free-form label shown after the course's name (e.g. "англійською"); → course |
| `CurriculumItem` | `curriculum_items` | semester, control form, ECTS; → **specialty directly** (no separate `Curriculum`/`curricula` table — removed), course, hours |
| `CurriculumItemHours` | `curriculum_item_hours` | hour type (LECTURE/PRACTICAL/LAB/CONSULTATION/ASSESSMENT/INDEPENDENT_WORK) + count; → curriculum item, working curriculum items |
| `WorkingCurriculumItem` (робочий навчальний план) | `working_curriculum_items` | lecturer count, teaching format; → curriculum item hours, department, optional elective course, M-N academic groups, M-N combined working curriculum items |
| `CombinedWorkingCurriculumItem` | `combined_working_curriculum_items` | pure M-N hub, no scalar fields of its own; bundles several `WorkingCurriculumItem`s that share course/semester/hour-type (e.g. one shared lecture across specialties) so one `LecturerWorkload` can cover all of them at once; → M-N working curriculum items, workloads |
| `Lecturer` (викладач) | `lecturers` | position, degree; → department, workloads, workloadConstraints, timetableConstraints |
| `LecturerWorkloadConstraint` | `lecturer_workload_constraints` | one (type, value) workload restriction; no standalone queries/mutations — written through `Lecturer`'s `workloadConstraints` nested list; → lecturer |
| `LecturerTimetableConstraint` | `lecturer_timetable_constraints` | one *scheduling* restriction — when this lecturer may be given classes; no standalone queries/mutations — written through `Lecturer`'s `timetableConstraints` nested list; → lecturer. See [Scheduling constraints](#scheduling-constraints) |
| `LecturerWorkload` (**class requirement**) | `lecturer_workloads` | durationHours (academic hours, 1-4); → classStartTimeSet (which grid of bells its classes run on), M-N rooms + M-N roomGroups (where it may be held — the union, empty meaning unrestricted), M-N lecturers, M-N academicGroups, M-N combinedGroups, 1-N studentAssignments (INDIVIDUALLY only), *exactly one of* workingCurriculumItem / combinedWorkingCurriculumItem, timetable entries |
| `LecturerWorkloadCandidate` | `lecturer_workload_candidates` | a lecturer who *could* deliver a workload, scored 1-100 by desirability — the pool automatic generation picks from, distinct from the lecturers actually assigned; **has its own `create`/`update`/`delete` mutations** (no connection or `findById` query — it is read through `LecturerWorkload.candidates`) because it carries children of its own and nested lists only go one level deep, see [Declare the API](#declare-the-api-no-servicerepositorycontroller); → workload, lecturer, constraints |
| `LecturerWorkloadCandidateConstraint` | `lecturer_workload_candidate_constraints` | `MIN_STUDENTS` (desired) / `MAX_STUDENTS` (ceiling) for one candidate, used only by `INDIVIDUALLY`-taught items; no standalone queries/mutations — written through `LecturerWorkloadCandidate`'s `constraints` nested list; → candidate |
| `LecturerWorkloadStudent` | `lecturer_workload_students` | one lecturer↔student pairing of an `INDIVIDUALLY`-taught workload; no standalone queries/mutations — written through `LecturerWorkload`'s `studentAssignments` nested list; → workload, lecturer, student |
| `Student` | `students` | first/middle/last name (по батькові optional), record book number; → academic group |
| `AcademicGroup` (ПМі-31) | `academic_groups` | year, study form; → specialty, students, M-N combined groups, timetableConstraints |
| `AcademicGroupTimetableConstraint` | `academic_group_timetable_constraints` | as `LecturerTimetableConstraint`, for a group; written through `AcademicGroup`'s `timetableConstraints` nested list |
| `CombinedGroup` (об'єднана група) | `combined_groups` | M-N academic groups (electives) |
| `Room` (аудиторія) | `rooms` | capacity, kind; → faculty?, building?, timetableConstraints |
| `RoomTimetableConstraint` | `room_timetable_constraints` | as `LecturerTimetableConstraint`, for a room; written through `Room`'s `timetableConstraints` nested list |
| `RoomGroup` (група аудиторій) | `room_groups` | a named, reusable set of rooms a workload can point at instead of naming rooms one by one; scoped to a faculty *or* a department *or* neither (university-wide); → M-N rooms, M-N workloads |
| `ClassStartTimeSet` (розклад дзвінків) | `class_start_time_sets` | a named grid of start times; exactly one row is the university-wide default, and a faculty-scoped set can never be it; → faculty?, classStartTimes. (No reverse `workloads` field — the link is `LecturerWorkload.classStartTimeSet` only) |
| `ClassStartTime` (пара) | `class_start_times` | ordinal (unique *within its set*), start time (end time is derived from the workload's duration); → classStartTimeSet |
| `TimetableEntry` (**the schedule / "gene"**) | `timetable_entries` | dayOfWeek, weekParity; → workload, classStartTime, room |
| `AcademicDegree` | `academic_degrees` | name, abbreviation, level; → lecturers |

Relationships: one-to-one, one-to-many, many-to-one and many-to-many are all supported.
Notable unique constraints (`schema.sql`): `buildings.name`, `faculties.abbreviation`,
`departments.abbreviation`, `specialties(name, degree)`, `academic_groups.name`,
`lecturers.email`, `curriculum_items(course_id, specialty_id, semester)`,
`curriculum_item_hours(curriculum_item_id, hour_type)`, `course_tags(course_id, tag)`,
`lecturer_workload_students(lecturer_workload_id, student_id)` (within one workload a student has
exactly one supervising lecturer), `lecturer_workload_constraints(lecturer_id, constraint_type)`
(a constraint is set at most once per lecturer), `lecturer_workload_candidates(lecturer_workload_id,
lecturer_id)` (a lecturer is a candidate for a workload at most once, with `CHECK (desirability
BETWEEN 1 AND 100)`), `class_start_times(class_start_time_set_id, ordinal)` and
`(class_start_time_set_id, start_time)` (a set numbers its own periods 1..N and never lists one
clock time twice), and `room_groups_unique_name` / `class_start_time_sets_unique_name`, which are
unique within their scope via `COALESCE(faculty_id, 0)` (and `COALESCE(department_id, 0)`) so that
a faculty and one of its departments can each keep a group called "Комп'ютерні класи".

Seven of the *unique* indexes are **partial** — they carry a `WHERE`, so only the matching rows collide:
`class_start_time_sets_single_default` (`WHERE is_default`, which is how "at most one default in the
whole table" is expressed — a plain `UNIQUE (is_default)` would wrongly allow just one *non*-default
set as well), plus the `…_unique_single` / `…_unique_window` pair on each of the three
timetable-constraint tables, described in [Scheduling constraints](#scheduling-constraints).

(Five ordinary, non-unique indexes carry a `WHERE` too — the faculty/department scoping indexes on
`room_groups` and `class_start_time_sets`, and the two grantee indexes on `permissions` — but there
the predicate only narrows what is stored, it does not change what collides.)

> The house convention for "unique, treating NULL as a value" is `COALESCE(col, 0)` inside the
> index expression rather than `NULLS NOT DISTINCT` — `permissions_unique_grant` established it and
> the newer indexes follow, so all of them read the same way.

> **History note**: earlier versions of this service modeled a *curriculum* as its own
> entity (`Curriculum` / `curricula`, one per specialty) with `CurriculumItem` pointing at
> it. Since a specialty only ever has one curriculum, that indirection was removed —
> `CurriculumItem` now references `Specialty` directly via `specialty_id`.

### Enumerated columns

Native Postgres `ENUM` types back most classifier columns (see `@PgEnum` below). Two carry
ordering significance beyond their values, because `ORDER BY` on an enum column sorts by
*declaration* order, not alphabetically:

| Type | Values (in declaration order) |
|---|---|
| `hour_type` | `LECTURE`, `PRACTICAL`, `LAB`, `CONSULTATION`, `ASSESSMENT`, `INDEPENDENT_WORK` |
| `teaching_format` | `TOGETHER`, `SEPARATELY`, `INDIVIDUALLY` |
| `lecturer_workload_candidate_constraint_type` | `MIN_STUDENTS`, `MAX_STUDENTS` |
| `lecturer_workload_constraint_type` | `MIN`/`MAX_HOURS_PER_YEAR`, `MAX_COURSES`, `MIN`/`MAX_[LECTURE\|PRACTICAL\|LAB]_COURSES`, and `MIN`/`MAX_[MANDATORY\|ELECTIVE]_[LECTURE\|PRACTICAL\|LAB]_COURSES` (2 + 1 + 6 + 12 = 21 values) |
| `timetable_constraint_type` | `MAX_CLASSES_PER_DAY`, `NOT_BEFORE`, `NOT_AFTER`, `UNAVAILABLE` — shared by all three timetable-constraint tables |
| `control_form` | `EXAM`, `CREDIT`, `GRADED_CREDIT` |
| `course_type` | `MANDATORY`, `ELECTIVE_GROUP`, `ELECTIVE`, `OPTIONAL`, `INTERNSHIP`, `COURSE_PROJECT`, `COURSE_WORK`, `QUALIFICATION_WORK` |
| `week_parity` | `WEEKLY`, `NUMERATOR`, `DENOMINATOR` |
| `grantee_type` | `USER`, `GROUP` — which column of a `permissions` row is set |
| `study_form`, `degree`, `lecturer_position`, `room_kind`, `property_type` | see `schema.sql` |

`hour_type` is declared "contact teaching, then the contact work around it, then the student's own
time" precisely so `curriculumItemHoursConnection` (`.orderBy("hourType")`) lists an item's hours in
that reading order. Adding a value to an existing enum in a *populated* database therefore needs
`ALTER TYPE … ADD VALUE … AFTER '<existing>'` rather than a plain append, or the new value sorts
last regardless of where `schema.sql` declares it.

`teaching_format` decides how a `LecturerWorkload` is assigned:

- `TOGETHER` — one lecturer takes all the item's groups at once (a shared lecture stream);
- `SEPARATELY` — the groups are split between lecturers, each taking whole groups (this is the only
  format for which "об'єднані групи" apply);
- `INDIVIDUALLY` — a lecturer works one-to-one with each student (coursework consultations, say), so
  the workload carries explicit `lecturer_workload_students` pairings instead of academic groups,
  and its duration is always a single academic hour per student.

### Text collation

The database is very likely created with the `C.UTF-8` locale (the default on most installs), which
sorts text by raw byte value. For Cyrillic that is wrong in an immediately visible way: `І` is
U+0406 and `А` is U+0410, so every surname starting with І/Ї/Є sorts *before* А. `schema.sql`
therefore declares a named collation once and attaches it to the columns people actually read:

```sql
CREATE COLLATION ukrainian (provider = icu, locale = 'uk-UA');
...
last_name  VARCHAR(64) COLLATE ukrainian NOT NULL,
```

Because the collation lives on the *column*, a plain `ORDER BY last_name` — which is all the
generated SQL ever emits — sorts correctly, and any future `.orderBy(...)` on one of those columns
is right by default with no framework changes. It is applied to the name-like columns of
`buildings`, `faculties`, `departments`, `specialties`, `academic_degrees`, `lecturers`,
`academic_groups`, `combined_groups`, `students`, `courses`, `course_tags` and `rooms`, and
deliberately **not** to e-mail/phone/website/postal codes, record book numbers or the auth tables.

Requires a Postgres built with ICU (standard from v15); `schema.sql` carries a comment with the
`provider = libc, locale = 'uk_UA.utf8'` fallback. ICU collations are deterministic, so `UNIQUE`
indexes on collated columns keep working unchanged. The frontend pins the same alphabet
client-side — see its README's *Ukrainian sorting*.

### `global_properties` — outside the entity framework

`global_properties` (`name` VARCHAR **primary key**, `type` a `property_type` enum, `value`
VARCHAR) is a generic name/type/value store for system-wide settings. It deliberately has **no** annotated
`GlobalProperty` domain class: the whole framework (`EntityMetadataRegistry`,
`DynamicGraphQLSchemaBuilder`, `DynamicDataFetchers`, `R2dbcQueryEngine.selectOne`/`insert`/
`update`/`delete`) hardcodes the assumption that every entity has a `Long id` primary key, which
a `String`-keyed table can't satisfy. Rather than generalize that assumption across every
existing entity, the `GlobalProperty`/`GlobalPropertyQueries`/`GlobalPropertyMutations` GraphQL
types and their `list` / `globalProperty(name)` / `updateGlobalProperty(name, value)` fields are
hand-built directly in `DynamicGraphQLSchemaBuilder.buildGlobalPropertyTypes()` and wired to
hand-written fetchers in `DynamicDataFetchers` (`globalPropertyList()`, `globalProperty()`,
`updateGlobalProperty()`), following the same escape-hatch pattern already used for
`ConnectionPageInfo` and the Apollo Federation `_service` field. `R2dbcQueryEngine.updateWhere(table,
columnValues, whereColumn, whereValue)` — an `update()` variant keyed by an arbitrary column
instead of the conventional `id` — was added specifically to make `updateGlobalProperty` possible
without touching the generic `update()`/`selectOne()` methods every other entity relies on.

**What the table holds.** `data.sql` seeds nineteen rows, in two groups.

| Property | Seeded | What it governs |
|---|---|---|
| `academic_hour_duration_minutes` | 40 | length of one academic hour; every class end time in the client is computed from it |
| `semester_duration_weeks` | 16 | weeks in a semester; the schedule builder divides a workload's hours by it |
| `current_semester_parity` | `ODD` | which half-year is running; the default of every semester filter |
| `default_class_duration_hours` | 2 | what a new workload starts at |
| `default_max_hours_per_year` | 600 | annual teaching ceiling for a lecturer who sets none of their own |
| `hours_per_ects_credit` | 30 | hours in one ECTS credit — every curriculum total is built on it |
| `credits_per_academic_year` · `credits_per_year_tolerance` | 60 · 3 | the year's credit target and how far a plan may sit from it |
| `min_credits_*` / `max_credits_*` (`junior_bachelor`, `bachelor`, `master`, `phd`) | 120/120, 180/240, 90/120, 30/60 | the volume a programme of each degree must fall within |
| `min_elective_share_percent` | 25 | least share of a programme that must be elective |
| `max_courses_per_semester` · `max_exams_per_semester` | 8 · 5 | per-semester ceilings a plan is advised against |

The second group — everything from `hours_per_ects_credit` down — arrived when the client's
curriculum checks stopped being constants. The reason is worth recording on this side too, because
it constrains what the service may assume: **these figures are not invariants.** Some are statutory
and change when the law does (the elective quota was rewritten by Закон № 3642-IX in 2024); the rest
differ between institutions by design, since the Закон «Про вищу освіту» leaves the form of the
educational process to each institution. A **blank value is meaningful** — it means «не встановлено»,
and the
client drops the check that rests on it — so `updateGlobalProperty` accepts an empty string and must
keep accepting one. `global-properties-limits.sql` beside `data.sql` adds just this group with
`ON CONFLICT DO NOTHING`, for a database created before it existed.

Nothing in the service reads any of these: they are stored and served, and every one of them is
applied in the client. That is the same division as everywhere else — see *How the two halves divide
the work* in the root README.

### Join tables with no entity of their own

Several many-to-many links exist only as join tables, reached through a `@ManyToMany` field rather
than a `@GraphQLEntity` class of their own — they carry no columns beyond the two foreign keys, so
there is nothing to query or mutate directly:

| Join table | Links | Exposed as |
|---|---|---|
| `course_specialties` | `Course` ↔ `Specialty` | `Course.specialties`, `specialtyIds` input |
| `course_tags` *(has an entity)* | `Course` → `CourseTag` | nested list, see `CourseTag` |
| `combined_group_academic_groups` | `CombinedGroup` ↔ `AcademicGroup` | `CombinedGroup.academicGroups` |
| `working_curriculum_item_groups` | `WorkingCurriculumItem` ↔ `AcademicGroup` | `academicGroupIds` input |
| `combined_working_curriculum_item_members` | `CombinedWorkingCurriculumItem` ↔ `WorkingCurriculumItem` | `workingCurriculumItemIds` input |
| `lecturer_workload_lecturers` | `LecturerWorkload` ↔ `Lecturer` | `lecturerIds` input |
| `lecturer_workload_academic_groups` | `LecturerWorkload` ↔ `AcademicGroup` | `academicGroupIds` input |
| `lecturer_workload_combined_groups` | `LecturerWorkload` ↔ `CombinedGroup` | `combinedGroupIds` input |
| `lecturer_workload_rooms` | `LecturerWorkload` ↔ `Room` | `LecturerWorkload.rooms`, `roomIds` input |
| `lecturer_workload_room_groups` | `LecturerWorkload` ↔ `RoomGroup` | `LecturerWorkload.roomGroups`, `roomGroupIds` input |
| `room_group_rooms` | `RoomGroup` ↔ `Room` | `RoomGroup.rooms`, `roomIds` input |

Contrast the four tables that *do* have entities despite looking like join tables —
`lecturer_workload_students`, `lecturer_workload_candidates`,
`lecturer_workload_candidate_constraints` and `lecturer_workload_constraints`. Each carries data
beyond the pair of keys (a desirability score, a constraint value), which is exactly why it needs a
surrogate id and an entity rather than a `@ManyToMany`. The three timetable-constraint tables are
the same case again.

### Where a class may be held, and on which bells

Two questions about a `LecturerWorkload` that the timetable needs answered before a
`TimetableEntry` can be built, both stored on the workload rather than on the entry — they are
properties of the *class*, not of one of its weekly occurrences.

**Rooms.** A workload may name individual rooms (`lecturer_workload_rooms`), whole reusable room
groups (`lecturer_workload_room_groups`), or both. The eligible rooms are the **union** of the two
lists, and an **empty union means unrestricted** — the right default for the many ordinary classes
with no particular requirement, so restricting is opt-in. Both exist because both are natural: a
lecture that must happen in the one hall large enough for it names that hall, while a lab that can
run in any computer class points at the group and stays correct when a room is later added to it.

`room_groups` is modelled on `combined_groups`, down to the optional `purpose` note. A group may be
scoped so it is only offered where it makes sense — `faculty_id` set means that faculty's
departments, `department_id` set means one department, both `NULL` means university-wide — and the
two are mutually exclusive (`room_groups_scope_check`), since a department already determines its
faculty. The scope governs who may *reach for* the group, not what is in it: a department's group
routinely holds rooms owned by the faculty or by nobody.

**Bells.** Not every kind of class runs on the same grid — physical education usually starts on its
own so students can reach a sports hall and back, and an evening programme may shift the whole day
later. `class_start_times` therefore belong to a named `class_start_time_sets` row, and
`lecturer_workloads.class_start_time_set_id` (NOT NULL, `ON DELETE RESTRICT`) says which grid a
workload's classes run on. `ordinal` is unique *within* a set, so every set numbers its periods
1..N independently and two sets both legitimately have a "друга пара". Exactly one set is the
university-wide default, and a faculty-scoped set can never be it.

Moving the default is a whole-table operation, because `class_start_time_sets_single_default` is
checked per statement rather than deferred to commit:

```sql
UPDATE class_start_time_sets SET is_default = (id = :newId) WHERE is_default OR id = :newId;
```

Inserting a new default and only then clearing the old one fails, even inside one transaction — so
the frontend clears the outgoing set first and only then sets the incoming one.

**Neither rule is enforced on `timetable_entries`.** That a room is one the workload allows is a
set-membership test across two join tables, and that an entry's `class_start_time_id` belongs to
the workload's set is one join away; both are conditions a `CHECK` cannot see, so the scheduler (and
the UI, which only offers a block its own set's times) enforces them. The database guarantees only
what is structural — the foreign keys, the value ranges, and the cascades.

### Scheduling constraints

`lecturer_timetable_constraints`, `academic_group_timetable_constraints` and
`room_timetable_constraints` say **when, and how densely,** a lecturer, a group or a room may be
given classes. They do not describe a timetable; they restrict the ones a scheduler is allowed to
build, and are checked against a candidate `timetable_entries` row rather than stored on it.

The eight rules the faculty asked for are four kinds of restriction, each of which either applies to
every day or to one named day — so `day_of_week NULL` means "every day" and a value (1..7, Monday =
1, the same convention as `timetable_entries.day_of_week`) means "that day only". The payload is a
single `constraint_value` string whose meaning depends on `constraint_type`, the same arrangement
`global_properties` uses:

| `constraint_type` | `constraint_value` | Example | Meaning |
|---|---|---|---|
| `MAX_CLASSES_PER_DAY` | `N` | `'3'` | at most N classes |
| `NOT_BEFORE` | `HH:MM` | `'12:30'` | nothing may *start* before this |
| `NOT_AFTER` | `HH:MM` | `'17:00'` | nothing may *end* after this |
| `UNAVAILABLE` | `HH:MM-HH:MM` | `'13:10-14:00'` | nothing may overlap `[from, to)` |

Each form is pinned by a `CASE constraint_type WHEN … THEN constraint_value ~ '…'` check constraint
on every table, so the column can only ever hold a string the matching type knows how to read: a
count is canonical decimal (`'0'` is meaningful — "no classes at all on Friday" — while `'007'`
and `'-1'` are not), times are zero-padded 24-hour, and a window's two halves are separated by one
`-` and must run forwards. Reading it back is `constraint_value::int` for a count and
`left(…, 5)`/`right(…, 5)` for a window; because the times are zero-padded, plain string comparison
against `class_start_times.start_time` is chronological comparison with no cast either way.
`day_of_week` is deliberately *not* folded into the string — it selects which rows apply and has to
stay a column the scheduler can filter and index on.

**More specific wins.** A day-specific row *overrides* the every-day row of the same type for that
day rather than adding to it: `NOT_BEFORE 12:30` every day together with `NOT_BEFORE 09:00` on
Monday means Monday starts at 09:00 and the rest of the week at 12:30. Without that rule the two
could only ever contradict each other. `UNAVAILABLE` is the exception — its windows *accumulate*,
since several disjoint gaps in one day are a normal thing to want. The unique indexes say exactly
this: `…_unique_single` on `(subject_id, constraint_type, COALESCE(day_of_week, 0)) WHERE
constraint_type <> 'UNAVAILABLE'`, and `…_unique_window` on `(subject_id, COALESCE(day_of_week, 0),
constraint_value) WHERE constraint_type = 'UNAVAILABLE'`. A third, plain index on the subject column
covers "read every constraint of one lecturer", which spans both partial ones.

Two things a scheduler has to get right and the schema cannot:

- **Evaluating the time rules needs the *end* of a class**, which is stored nowhere: it is
  `class_start_times.start_time + lecturer_workloads.duration_hours ×` the
  `academic_hour_duration_minutes` global property. Only `NOT_BEFORE` can be answered from the start
  time alone.
- **`MAX_CLASSES_PER_DAY` counts per *calendar week*, not per row.** A `WEEKLY` entry falls in both
  weeks and `NUMERATOR`/`DENOMINATOR` in one each, so the cap has to hold for (`WEEKLY` +
  `NUMERATOR`) and for (`WEEKLY` + `DENOMINATOR`) separately. Counting all three together would
  reject a legal timetable that merely alternates two classes in one slot.

The last three types are one idea — a forbidden interval — and a scheduler is expected to normalise
them (`NOT_BEFORE` → `[00:00, from)`, `NOT_AFTER` → `[to, 24:00)`). They are kept separate anyway
because the intent is what the user typed and what an editing UI must show back; collapsing them
would turn "закінчувати о 17:00" into "не займати 17:00–24:00" the next time the row is read.

Every row is a **hard** restriction. Soft constraints would need a weight alongside, in the shape of
`lecturer_workload_candidates.desirability`, and are deliberately left out until there is a
scheduler that can trade them off.

**Why three tables rather than one with a nullable lecturer/group/room triple.** Each subject then
has a plain `NOT NULL` foreign key instead of an "exactly one of three is set" `CHECK`, the unique
indexes lose their `COALESCE` over the subject columns, and each table is indexed and queried on its
own. The cost is that the value rule is written out three times — the enum is shared, but adding a
constraint type means touching all three tables.

### Reading the current timetable

A scheduler needs the opposite of what a CRUD screen needs. A screen asks for "this faculty's
rows"; a scheduler asks for "everything that already occupies the rooms, the lecturers and the
groups this faculty is about to schedule into" — regardless of which faculty owns those classes.
Three id-list relation filters on `timetableEntryConnection` answer that, and one string filter
makes the answer mean anything.

| Argument | Type | Matches an entry whose… |
|---|---|---|
| `roomIds` | `[ID!]` | `room_id` is one of these |
| `lecturerIds` | `[ID!]` | workload has one of these lecturers (`lecturer_workload_lecturers`) |
| `academicGroupIds` | `[ID!]` | workload has one of these groups directly (`lecturer_workload_academic_groups`) **or** through a combined group (`lecturer_workload_combined_groups` -> `combined_group_academic_groups`) |
| `semesterParity` | `String` | curriculum item behind the workload has an odd (`'ODD'`) or even (`'EVEN'`) semester |
| `workloadId`, `roomId` | `ID` | plain column filters, for the single-row cases |

**`semesterParity` is not optional in practice.** `timetable_entries` has no semester column — the
semester lives on the curriculum item two joins behind the workload — and `data.sql` carries both
halves of the year at once. An unfiltered read therefore reports a room hosting an autumn class and
a spring class "at the same time", which is not a clash at all. The filter reaches the semester
through whichever target the workload has: `working_curriculum_item_id` directly, or the members of
`combined_working_curriculum_item_id`, the two coalesced.

**Why three separate filters rather than one.** Filter arguments compose with `AND`, and what a
scheduler wants here is `OR`: an entry matters if it uses one of my rooms *or* one of my lecturers
*or* one of my groups. Rather than invent an OR-combining filter syntax, the three are asked for
under three aliases in one request and merged by entry id on the client:

```graphql
query($parity: String, $rooms: [ID!], $lecturers: [ID!], $groups: [ID!]) {
  timetableEntries {
    byRoom:     timetableEntryConnection(limit: 5000, semesterParity: $parity, roomIds: $rooms)           { nodes { ...E } }
    byLecturer: timetableEntryConnection(limit: 5000, semesterParity: $parity, lecturerIds: $lecturers)   { nodes { ...E } }
    byGroup:    timetableEntryConnection(limit: 5000, semesterParity: $parity, academicGroupIds: $groups) { nodes { ...E } }
  }
}
```

where the shared selection `E` is what a conflict test needs and the row itself does not hold:

```graphql
id dayOfWeek weekParity
classStartTime { id startTime }
room { id }
workload {
  id durationHours
  lecturers { id }
  academicGroups { id }
  combinedGroups { academicGroups { id } }
}
```

The class's *end* is still nowhere in there. It is `classStartTime.startTime + workload.durationHours
* academic_hour_duration_minutes`, and the caller computes it — the same derivation the constraint
rules need (see above).

`lecturerConnection(facultyId:)` exists for the same consumer: it reads every lecturer of a faculty
together with their `timetableConstraints` in one request, rather than one request per department.

The only client of all this today is the frontend's schedule generator
([TIMETABLE-GENERATION.md](../timetable-ui/TIMETABLE-GENERATION.md)). The service itself neither
schedules nor validates what a scheduler writes back — see [Known
limitations](#known-limitations).

### Inputs for automatic workload generation

Four tables added for the generator, which lives entirely in the frontend
([WORKLOAD-GENERATION.md](../timetable-ui/WORKLOAD-GENERATION.md)) — the service only stores and
serves them:

| Table | Answers |
|---|---|
| `lecturer_workload_candidates` | *Who could deliver this workload, and how much do we want them to?* (1–100) |
| `lecturer_workload_candidate_constraints` | *For individual work, how many students should this candidate get?* (`MIN_STUDENTS` desired, `MAX_STUDENTS` ceiling) |
| `lecturer_workload_constraints` | *What may this lecturer be given overall?* — annual hours and distinct-course counts, by hour type and by mandatory/elective |
| `global_properties.default_max_hours_per_year` | *…and what applies when they set no annual ceiling of their own?* |

The service enforces none of these as scheduling rules; they are data the generator reads. The only
guarantees the database makes are structural — value ranges, uniqueness, and the cascades that keep
them from outliving their parents.

Worth knowing if you change any of these four tables: the generator's benchmark
([`timetable-ui/scripts/workload-bench`](../timetable-ui/scripts/workload-bench/README.md)) builds
synthetic departments **against exactly this shape**, and its independent validator re-implements the
constraint semantics of `lecturer_workload_constraints` straight from `schema.sql` rather than from
the generator. Adding a constraint type here means adding it there too, or the benchmark will keep
reporting full coverage of a set that has grown.

### `users` / `groups` / `permissions` — outside the entity framework

Like `global_properties`, the four auth tables have no `@GraphQLEntity` domain class — a `User`'s
`password_hash` must never be reachable through the fully-generic, selection-set-driven query
machinery, so `User`/`Group`/`PermissionGrant` are hand-built GraphQL types with hand-written
fetchers instead (see [Authentication & authorization](#authentication--authorization) below).

| Table | Notes |
|---|---|
| `users` | email (unique), first/last name, BCrypt `password_hash`, `must_change_password`, `is_active` |
| `groups` | name (unique), description |
| `user_groups` | `(user_id, group_id)` — a user may belong to any number of groups |
| `permissions` | a single grant: `grantee_type` (`USER`/`GROUP`) + exactly one of `user_id`/`group_id`, `resource_type` + `resource_id` (or `resource_type = 'GLOBAL'` with a `NULL` id for full admin access), `granted_by` |

### Permission cascade annotations on domain entities

Most domain classes carry class-level `@PermissionParent`/`@PermissionJoinParent` annotations
(see [Authentication & authorization](#authentication--authorization)) declaring which ancestor
entity a "modify" grant cascades down from. The resulting graph:

| Entity | Cascades down from (any one path is sufficient) |
|---|---|
| `Faculty` | `Building`? |
| `Department`, `Specialty` | `Faculty` |
| `Room` | `Faculty`?, `Building`? |
| `RoomTimetableConstraint` | `Room` |
| `RoomGroup` | `Faculty`?, `Department`? |
| `ClassStartTimeSet` | `Faculty`? |
| `ClassStartTime` | `ClassStartTimeSet` |
| `Course` | `Department`?, `Faculty`?, parent `Course`? (elective group → its options) |
| `CourseTag` | `Course` |
| `Lecturer` | `Department` |
| `LecturerWorkloadConstraint`, `LecturerTimetableConstraint` | `Lecturer` |
| `AcademicGroup` | `Specialty` |
| `AcademicGroupTimetableConstraint` | `AcademicGroup` |
| `CombinedGroup` | any member `AcademicGroup` (via `combined_group_academic_groups`) |
| `Student` | `AcademicGroup` |
| `CurriculumItem` | `Specialty`, `Course` |
| `CurriculumItemHours` | `CurriculumItem` |
| `WorkingCurriculumItem` | `Department`, `CurriculumItemHours`, elective `Course`? |
| `CombinedWorkingCurriculumItem` | any member `WorkingCurriculumItem` (via `combined_working_curriculum_item_members`) |
| `LecturerWorkload` | `WorkingCurriculumItem`?, `CombinedWorkingCurriculumItem`?, any linked `Lecturer`/`AcademicGroup`/`CombinedGroup` (join tables) |
| `LecturerWorkloadCandidate` | `LecturerWorkload` |
| `LecturerWorkloadCandidateConstraint` | `LecturerWorkloadCandidate` |
| `LecturerWorkloadStudent` | `LecturerWorkload` |
| `TimetableEntry` | `LecturerWorkload`, `Room` |
| `Building`, `AcademicDegree` | *(none — top-level; only an administrator can create/modify these)* |

`LecturerWorkload`'s rooms and room groups are deliberately **not** permission parents: being able
to modify a room, or the list of rooms in a group, must not confer the right to modify every
workload that happens to be allowed to use it. Its `ClassStartTimeSet` is left out for the same
reason.

`?` marks a `nullable = true` edge (the FK may be unset, in which case that path just doesn't
apply). Following these edges upward from any row yields the full set of resources whose grant
would cover it — e.g. a grant on a `Faculty` covers its `Department`s, `Specialty`s, `Room`s,
`Course`s, and — by walking further — every `Lecturer`, `AcademicGroup`, `CurriculumItem`,
`WorkingCurriculumItem`, `LecturerWorkload` and `TimetableEntry` beneath them, exactly matching the
cascade the product spec asked for.

---

## The framework

```
org.lnu.timetable.framework
├── annotation/    @GraphQLEntity, @Description, @Nullable, @PgEnum,
│                  @OneToOne, @OneToMany, @ManyToOne, @ManyToMany,
│                  @PermissionParent(s), @PermissionJoinParent(s) — see below
├── metadata/      EntityMetadataRegistry — scans @GraphQLEntity at startup,
│                  builds EntityMetadata (fields, columns, types, relations,
│                  resourceType, permissionParents, permissionJoinParents)
├── config/        GraphQLSchemaConfig + DSL: SchemaDefinition, TypeDefinition,
│                  QueryDefinition, MutationDefinition (create/update/delete,
│                  plus .nestedList(...) and .manyToMany(...) — see below)
├── schema/        DynamicGraphQLSchemaBuilder — builds GraphQLSchema from
│                  metadata + config; DataFetcherProvider
├── query/         R2dbcQueryEngine — table-driven optimized SQL: selectOne,
│                  selectList, selectWhere, count/countWhere, insert, update,
│                  delete, the by-arbitrary-column updateWhere / deleteWhere,
│                  insertJoinRow for many-to-many membership, plus the batched
│                  selectByIds / selectWhereIn / selectViaJoinTableBatch used
│                  by relation DataLoaders
└── runtime/       DynamicDataFetchers (query/connection/mutation/relation,
                   with per-request DataLoader batching), DynamicGraphQlConfiguration
                   (exposes the GraphQlSource bean)

org.lnu.timetable.security   — authentication/authorization; see below
```

### Define an entity

```java
@GraphQLEntity(table = "courses")
public class Course {
    private Long id;
    @Description("Discipline name") private String name;
    @PgEnum("course_type") @Description("MANDATORY, ELECTIVE_GROUP, ELECTIVE, …")
    private String courseType;
    @Nullable @ManyToOne(joinColumn = "department_id") private Department department;
}
```

Field → column names are derived `lowerCamel → lower_snake` (e.g. `ectsCredits` →
`ects_credits`). `@Description` text appears in the GraphQL schema. `@Nullable` makes a
field/relation optional; `@PgEnum("pg_type_name")` marks a `String` field backed by a native
Postgres `ENUM` column, so `R2dbcQueryEngine` adds the right `::type` cast on insert/update
(R2DBC otherwise binds it as a plain `VARCHAR`, which Postgres won't implicitly coerce).

### Declare the API (no service/repository/controller)

```java
@Component
public class CurriculumSchemaConfig implements GraphQLSchemaConfig {
    public void configure(SchemaDefinition s) {
        s.type(CurriculumItem.class)
            .fields("semester", "controlForm", "ectsCredits")
            .relation("specialty").relation("course").relation("hours");

        s.query("curriculumItemConnection").entity(CurriculumItem.class).connection()
            .orderBy("semester").filter("specialtyId", "specialty_id");
        s.query("curriculumItem").entity(CurriculumItem.class).findById();

        s.mutation("createCurriculumItem").entity(CurriculumItem.class).create()
            .inputFields("semester", "controlForm", "ectsCredits", "specialtyId", "courseId")
            .nestedList("hours", CurriculumItemHours.class, "curriculumItemId", "hourType", "hours")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
        // update/delete analogous
    }
}
```

`nullableRelation(...)` declares an optional to-one relation (e.g. a workload tied to either
an academic group *or* a combined group; an elective `WorkingCurriculumItem.course`).

**Nested lists are one level deep.** `createNestedLists`/`reconcileNestedLists` bind each child's
own scalar and FK columns; they do not recurse, so a child that itself owns a list needs its own
mutations. `LecturerWorkloadCandidate` is the case in point: it carries `constraints`
(`MIN_STUDENTS`/`MAX_STUDENTS`) as *its* nested list, and therefore has standalone
create/update/delete mutations rather than riding along on `LecturerWorkload`'s input payload — which
also keeps a single writer for those rows, since a nested list on the workload would reconcile (and
delete) candidates behind those mutations' back.

**Nested one-to-many children in one mutation** — `.nestedList(fieldName, childClass,
fkField, ...childInputFields)` lets a single `createCurriculumItem`/`updateCurriculumItem`
call also create/update/delete the item's `hours` rows: on create, every list item is
inserted with the FK pointed at the new parent; on update, an item with a matching `id`
updates that row, an item with no matching `id` inserts one, and any existing row not
referenced by the incoming list is deleted.

**Many-to-many membership in one mutation** — `.manyToMany(fieldName, joinTable, joinColumn,
inverseJoinColumn)` exposes a plain `[ID!]` input field (e.g. `academicGroupIds`) that
replaces the join-table membership wholesale on save:

```java
s.mutation("createWorkingCurriculumItem").entity(WorkingCurriculumItem.class).create()
    .inputFields("lecturerCount", "teachingFormat", "curriculumItemHoursId", "departmentId", "courseId")
    .manyToMany("academicGroupIds", "working_curriculum_item_groups", "working_curriculum_item_id", "academic_group_id")
    .errorStatus(/* … */);
```

On create, one join row is inserted per incoming id. On update, if the field is present, all
of the parent's existing join rows are deleted and replaced with one row per incoming id
(omit the field entirely to leave membership untouched).

**Filtering by a related table's column** — a plain `.filter(paramName, column)` only works
for a column that lives directly on the entity's own table. `CombinedWorkingCurriculumItem`
has no `department_id`/`faculty_id`/semester of its own — those only exist on its *members'*
`working_curriculum_items` — so filtering its connection by faculty, a list of departments, or
semester parity needs an `EXISTS (...)` subquery instead. `QueryDefinition.relationFilter(paramName,
condition)` / `.relationFilterList(...)` / `.relationFilterString(...)` declare exactly that: a
named, nullable GraphQL argument (exposed as `ID`, `[ID!]`, or `String` respectively) bound into a
raw SQL condition supplied by the caller:

```java
s.query("combinedWorkingCurriculumItemConnection").entity(CombinedWorkingCurriculumItem.class).connection()
    .relationFilterList("departmentIds",
        "EXISTS (SELECT 1 FROM combined_working_curriculum_item_members m " +
        "JOIN working_curriculum_items w ON w.id = m.working_curriculum_item_id " +
        "WHERE m.combined_working_curriculum_item_id = combined_working_curriculum_items.id " +
        "AND w.department_id = ANY(:departmentIds))")
    .relationFilterString("semesterParity", /* … an EXISTS through curriculum_item_hours/curriculum_items … */ "");
```

`condition` references the entity's own table unaliased (queries select from it without an
alias) and contains a named bind placeholder matching `paramName`. `R2dbcQueryEngine.RawFilter`
carries these alongside the plain `Filter` records through `selectList`/`countWhere`, and
`ID_LIST` arguments are bound as a `Long[]` for `= ANY(:paramName)`. The same mechanism now backs
`facultyId` filtering on both `workingCurriculumItemConnection` and
`combinedWorkingCurriculumItemConnection` (through their department), and `semesterParity`
filtering on both (through `curriculum_items.semester`), so the frontend's schedule builder can
ask the database for "everything this faculty needs to schedule this semester" in two queries
instead of fetching every working curriculum item in the system and filtering client-side.

The same mechanism scopes the two "people" connections to a faculty, neither of which has a
`faculty_id` column of its own:

| Connection | Argument | Reached through |
|---|---|---|
| `academicGroupConnection` | `facultyId` | `academic_groups.specialty_id → specialties.faculty_id` |
| `combinedGroupConnection` | `facultyId` | `combined_group_academic_groups → academic_groups → specialties.faculty_id` |
| `workingCurriculumItemConnection` | `facultyId`, `semesterParity` | `working_curriculum_items.department_id → departments.faculty_id`; `curriculum_item_hours → curriculum_items.semester` |
| `combinedWorkingCurriculumItemConnection` | `facultyId`, `departmentIds`, `semesterParity` | member `working_curriculum_items` |
| `lecturerConnection` | `facultyId` | `lecturers.department_id → departments.faculty_id` |
| `timetableEntryConnection` | `roomIds`, `lecturerIds`, `academicGroupIds`, `semesterParity` | `timetable_entries.room_id`; the workload's `lecturer_workload_lecturers`; its academic groups *and* its combined groups' members; the semester of the curriculum item behind the workload (single or combined) |

The last row is what lets a client read the *current* state of the timetable around one faculty.
The three id-list filters are declared separately rather than as one OR-ed condition because filters
compose with **AND**: a caller asks for each slice under its own alias in a single request and
merges them client-side, which is exactly what the frontend's schedule generator does. And
`semesterParity` is not optional in practice — `timetable_entries` has no semester column and both
halves of the year are loaded at once, so an unfiltered read reports room clashes that do not
exist.

`combinedGroupConnection`'s `facultyId` matches when **any** member academic group belongs to the
faculty, so a combined group spanning two faculties appears under both — which is the point of
combining them. `EXISTS` (rather than a join in the filter) is also what keeps a group with several
matching members from being returned more than once.

Filter arguments compose: the frontend's faculty page passes `facultyId` *and* an optional
`specialtyId`, so clearing its specialty sub-filter narrows to "every group of this faculty"
instead of widening to every group in the university.

### Where each entity is declared

The four `*SchemaConfig` classes are the whole API surface — 28 entities, one `configure<Entity>`
method each, split by subject area:

| Config class | Entities declared |
|---|---|
| `OrganizationSchemaConfig` | `Building`, `Faculty`, `Department`, `Specialty`, `Room`, `RoomTimetableConstraint`\*, `RoomGroup` |
| `CurriculumSchemaConfig` | `Course`, `CourseTag`\*, `CurriculumItem`, `CurriculumItemHours`, `WorkingCurriculumItem`, `CombinedWorkingCurriculumItem` |
| `PeopleSchemaConfig` | `AcademicDegree`, `Lecturer`, `LecturerWorkloadConstraint`\*, `LecturerTimetableConstraint`\*, `Student`, `AcademicGroup`, `AcademicGroupTimetableConstraint`\*, `CombinedGroup` |
| `SchedulingSchemaConfig` | `LecturerWorkload`, `LecturerWorkloadStudent`\*, `LecturerWorkloadCandidate`\*\*, `LecturerWorkloadCandidateConstraint`\*, `ClassStartTimeSet`, `ClassStartTime`, `TimetableEntry` |

Twenty of them get the full set — `<entity>Connection` + `<entity>` + `create`/`update`/`delete`.
The exceptions are all children written through a parent:

- \* **type-only** (`s.type(...)` with no queries or mutations): registered so a parent's relation
  field resolves, but written exclusively through that parent's `.nestedList(...)` —
  `CourseTag` through `Course.tags`, `LecturerWorkloadConstraint` through
  `Lecturer.workloadConstraints`, `LecturerWorkloadStudent` through
  `LecturerWorkload.studentAssignments`, `LecturerWorkloadCandidateConstraint` through
  `LecturerWorkloadCandidate.constraints`, and the three `*TimetableConstraint`s through
  `Lecturer`/`AcademicGroup`/`Room`'s `timetableConstraints`. The last three are worth a word: a
  subject's scheduling rules are only meaningful *as a set* — a day-specific rule overrides the
  every-day one — so they have to be read and written together, and the nested list's
  "anything not sent is deleted" reconciliation is exactly the semantics that needs;
- \*\* **mutations without queries**: `LecturerWorkloadCandidate` is read through
  `LecturerWorkload.candidates` but written through its own three mutations, because it is the one
  child that has children of its own.

A new `*SchemaConfig` needs no registration beyond `@Component` — every implementation is injected
as `List<GraphQLSchemaConfig>` and applied at startup.

### Generated GraphQL shape

Queries/mutations are grouped per entity, matching the original deanery API:

```graphql
query {
  faculties { facultyConnection(limit: 1000, offset: 0) { nodes { id name } pageInfo { total hasNextPage nextPageOffset } } }
  departments { department(id: 1) { id name faculty { id name } } }
}
mutation {
  faculties { createFaculty(faculty: { name: "…" }) { isSuccess errorStatus data { id } } }
}
```

### The query catalogue

Every generated connection, with the ordering it applies and the arguments it accepts. Unmarked
arguments are plain column filters (`.filter`); the ones marked (r) are `EXISTS` relation filters
(`.relationFilter` / `.relationFilterList` / `.relationFilterString`, described under *Declare the
API* above). Every connection also takes `limit` and `offset` and returns
`{ nodes, pageInfo { total hasNextPage nextPageOffset } }`, and every entity listed here also has a
single-row `<entity>(id:)` query.

| Connection | Ordered by | Arguments |
|---|---|---|
| `buildingConnection` | `name` | — |
| `facultyConnection` | `name` | — |
| `departmentConnection` | `name` | `facultyId` |
| `specialtyConnection` | `code` | `facultyId` |
| `roomConnection` | `number` | `facultyId`, `buildingId` |
| `roomGroupConnection` | `name` | `facultyId`, `departmentId` |
| `academicDegreeConnection` | `level` | — |
| `lecturerConnection` | `lastName` | `departmentId`, `facultyId` (r) |
| `studentConnection` | `lastName` | `academicGroupId` |
| `academicGroupConnection` | `name` | `specialtyId`, `facultyId` (r) |
| `combinedGroupConnection` | `name` | `facultyId` (r) |
| `courseConnection` | `name` | `departmentId`, `facultyId`, `specialtyId` (r) |
| `curriculumItemConnection` | `semester` | `specialtyId`, `courseId` |
| `curriculumItemHoursConnection` | `hourType` | `curriculumItemId` |
| `workingCurriculumItemConnection` | `id` | `departmentId`, `facultyId` (r), `semesterParity` (r) |
| `combinedWorkingCurriculumItemConnection` | `id` | `facultyId` (r), `departmentIds` (r), `semesterParity` (r) |
| `lecturerWorkloadConnection` | `id` | — |
| `classStartTimeSetConnection` | `name` | `facultyId` |
| `classStartTimeConnection` | `ordinal` | `classStartTimeSetId` |
| `timetableEntryConnection` | `dayOfWeek` | `workloadId`, `roomId`, `roomIds` (r), `lecturerIds` (r), `academicGroupIds` (r), `semesterParity` (r) |

Eight entities are missing from this table on purpose, and the omission is the design rather than a
gap: `CourseTag`, `LecturerWorkloadConstraint`, `LecturerTimetableConstraint`,
`AcademicGroupTimetableConstraint`, `RoomTimetableConstraint`, `LecturerWorkloadStudent` and
`LecturerWorkloadCandidateConstraint` are read through their parent's relation field and written
through its `.nestedList(...)`, and `LecturerWorkloadCandidate` is read through
`LecturerWorkload.candidates` while being written through mutations of its own. See [Where each
entity is declared](#where-each-entity-is-declared).

`curriculumItemConnection`'s `courseId` exists for one screen: the client's discipline page asks
«where is this course taught?», and `Course` carries no `curriculumItems` relation to walk — its
`@OneToMany` fields are `childCourses` and `tags` only. Adding the filter was cheaper and narrower
than adding a relation, which would have appeared on every `Course` selection in the schema.

Note also what `lecturerWorkloadConnection` does *not* offer: no `departmentId` or `facultyId`. In
practice nothing reaches for workloads flatly — they are always read through the working (or
combined) curriculum item that owns them, which is where the department and faculty live.

### Optimized field selection

Each fetcher reads the GraphQL selection set and selects **only** the requested columns,
e.g. `department(id:1){ id name faculty{ id name } }` runs:

```sql
SELECT id AS "id", name AS "name", faculty_id AS "facultyId" FROM departments WHERE id = $1
SELECT id AS "id", name AS "name" FROM faculties WHERE id = $1
```

---

## Authentication & authorization

Users never self-register. An administrator creates an account (`createUser`) with a temporary
password; the account is forced to change it (`must_change_password = TRUE`) before it can do
anything else. Authentication is a stateless JWT (`io.jsonwebtoken`/jjwt) carrying only the user
id as its subject — no roles or permissions are baked into the token, so revoking a user's access
(deactivating the account, or removing a permission grant) takes effect on their *next* request
rather than waiting for the token to expire. Passwords are hashed with BCrypt
(`spring-security-crypto` only — this project does **not** pull in full Spring Security, since
authorization here is entity-scoped rather than the role/URL-based model that framework is built
around).

### Request flow

1. `AuthenticationGraphQlInterceptor` (a `WebGraphQlInterceptor`) reads the `Authorization: Bearer
   <jwt>` header of every request, resolves it to a `Principal` (id, email, name,
   `mustChangePassword`) via `JwtService`/`PermissionRepository`, and places it on the GraphQL
   context. A missing/invalid/expired token simply leaves the request anonymous rather than
   rejecting it outright — this keeps `login` reachable through the same `/graphql` endpoint,
   while every other field enforces its own requirement.
2. `AuthorizingDataFetcherProvider` wraps the generic `DynamicDataFetchers` and is the
   `DataFetcherProvider` actually wired into `DynamicGraphQLSchemaBuilder` (via
   `DynamicGraphQlConfiguration`) — the schema builder itself has no authorization awareness.
   It enforces two rules for every reflectively-generated query/mutation:
   - any operation requires a signed-in caller (reads are open to any authenticated user);
   - `create`/`update`/`delete` mutations additionally require "modify" permission on the target
     (or, for creates, on whichever declared parent the new row is being attached to) — see
     `PermissionService` below.
3. Hand-rolled operations (`login`, `me`, `changePassword`, `createUser`, group/permission
   management) bypass this decorator entirely — they're wired directly in
   `DynamicGraphQLSchemaBuilder.buildAuthTypes()`/`registerAuthFetchers()`, the same escape-hatch
   pattern used for `GlobalProperty` (see above), so a `User`'s password hash is never reachable
   through the generic, selection-set-driven machinery.

### The security package

`org.lnu.timetable.security` is eleven classes, and it is worth knowing which of them decides what:

| Class | Role |
|---|---|
| `AuthenticationGraphQlInterceptor` | reads `Authorization: Bearer <jwt>` on every request, resolves it to a `Principal` and puts it on the GraphQL context; an absent or invalid token leaves the request anonymous rather than failing it, which is what keeps `login` reachable through the same endpoint |
| `JwtService` | issues and parses the HS256 tokens, which carry only the user id |
| `Principal` | record — id, email, first/last name, `mustChangePassword` |
| `AuthorizingDataFetcherProvider` | wraps `DynamicDataFetchers` and is what the schema builder actually receives; enforces "signed in" on every generated field and "may modify" on every generated mutation |
| `PermissionService` | the decision point: `canModify`, `canCreate`, `canManageGrantsOn` |
| `PermissionGraphRepository` | the three raw reads `PermissionService` walks the permission graph with — `fetchForeignKeys`, `fetchJoinParentIds`, `fetchLabel` |
| `ResourceRef` | record — one `(resourceType, resourceId)` node of that ancestry |
| `PermissionRepository` | everything else the auth tables need: users, groups, memberships, grants |
| `AuthDataFetchers` | the twenty-odd hand-written fetchers behind `login`, `me`, `changePassword`, `users`, `groups`, `canModifyResources`, `grantsForResource` and the grant/membership mutations |
| `SecurityBeansConfig` | one bean: the BCrypt `PasswordEncoder` |
| `GraphQlAuthException` | reported as a GraphQL error inside a 200 response, matching how the rest of this API reports problems |

The split between `PermissionGraphRepository` and `PermissionRepository` follows the two questions
being asked: one walks *domain* tables along annotation-declared edges and knows nothing about
users, the other reads the *auth* tables and knows nothing about the domain.

### The permission model

A grant (`permissions` table) names a `resource_type` — an entity's simple class name in
`UPPER_SNAKE_CASE`, e.g. `FACULTY`, derived the same way both sides of the stack independently
compute it (`EntityMetadata#resourceType()` on the backend via Guava's `CaseFormat`, `toResourceType()`
in the frontend) — plus a `resource_id`, or the special `resource_type = 'GLOBAL'` (`resource_id`
`NULL`) for full-access admin grants. "Modify" permission on a resource means update, delete, *and*
the right to create new child rows underneath it (and to modify those children in turn) — exactly
the cascade the product spec asked for (e.g. a grant on a `Faculty` also covers its `Department`s,
`Specialty`s, `Room`s, `Course`s, and transitively everything beneath those).

That cascade is declared, not hardcoded, via two repeatable class-level annotations in
`org.lnu.timetable.framework.annotation`:

```java
@GraphQLEntity(table = "departments")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id")
public class Department { ... }

@GraphQLEntity(table = "combined_groups")
@PermissionJoinParent(value = AcademicGroup.class,
    joinTable = "combined_group_academic_groups",
    selfColumn = "combined_group_id", parentColumn = "academic_group_id")
public class CombinedGroup { ... }
```

`@PermissionParent` covers a direct foreign key on the entity's own table; `@PermissionJoinParent`
covers an ancestor reached through a many-to-many join table (e.g. a `LecturerWorkload` is also
covered by a grant on any `Lecturer` assigned to it). Either may be repeated
(`@PermissionParents`/`@PermissionJoinParents`) when an entity has more than one path to an
ancestor — coverage through *any one* declared path is enough. See [Permission cascade
annotations on domain entities](#permission-cascade-annotations-on-domain-entities) above for the
full graph as actually declared across the domain model.

`PermissionService` (`org.lnu.timetable.security`) is the central decision point:

- `canModify(userId, entityClass, id)` walks **up** from the row (cheaper than walking down from
  every grant) along the declared edges, up to a depth of 15 (`MAX_DEPTH`, guarding against an
  accidental annotation cycle), collecting every ancestor `(resourceType, id)` pair reachable —
  then checks whether the user (directly, or via any group they belong to) holds a grant on any
  one of them, or a `GLOBAL` grant.
- `canCreate(userId, entityClass, input)` does the same starting from whichever
  `@PermissionParent` foreign keys are present in the proposed input, since the row doesn't exist
  yet to walk up from. An entity with no applicable parent reference in the input (e.g. a
  top-level `Building`, or an optional-FK entity created with none of its FKs set) can then only be
  created by an administrator.
- `canManageGrantsOn(userId, resourceType, resourceId)` is the delegation rule: **you can only
  grant (or revoke) access to a scope you already hold yourself.** A user with modify permission
  on a `Faculty` can grant that same `Faculty` — or anything beneath it — to another user or
  group; they cannot grant access to an unrelated faculty, or promote anyone to `GLOBAL`
  admin unless they're a `GLOBAL` admin themselves.

### GraphQL API

| Field | Kind | Notes |
|---|---|---|
| `login(email, password)` | mutation | returns a JWT + whether the account must change its password |
| `me` | query | the signed-in `CurrentUser` (profile, `isAdmin`, groups, effective permissions), or `null` |
| `changePassword(currentPassword, newPassword)` | mutation | minimum 8 characters; clears `mustChangePassword` |
| `createUser(email, firstName, lastName, temporaryPassword)` | mutation | **admin-only**; the created account must change its password on first login |
| `setUserActive(userId, active)` | mutation | **admin-only**; deactivates/reactivates an account |
| `users` | query | **admin-only**; all accounts |
| `createGroup(name, description)`, `addUserToGroup`/`removeUserFromGroup` | mutation | **admin-only** group management |
| `groups` | query | any authenticated user |
| `grantPermission(granteeType, userId\|groupId, resourceType, resourceId)` | mutation | delegatable — see `canManageGrantsOn` above |
| `revokePermission(permissionId)` | mutation | same delegation check, resolved from the grant's own resource |
| `canModifyResources(resourceType, resourceIds)` | query | given candidate ids of one type, returns the subset the caller may modify — what the frontend uses to hide edit/delete buttons |
| `grantsForResource(resourceType, resourceId)` | query | lists who currently has access on a resource; requires the caller to already be able to manage grants there |

All admin-only fields fail with a `GraphQlAuthException` for non-admins; unauthenticated calls to
anything except `login` fail the same way with "You must be signed in to do this."

### Configuration & seed data

`app.security.jwt-secret` (≥32 bytes for HS256) lives in `application-loc.properties` and
`app.security.jwt-ttl-minutes` (default 720 = 12 hours) in `application.properties` — see
[Configuration](#configuration). The checked-in secret is a generated dev-only value, and the `loc`
profile is active inside the packaged jar as well, so **override it before deploying anywhere
real** — `--app.security.jwt-secret=…`, `APP_SECURITY_JWTSECRET`, or `SPRING_APPLICATION_JSON`.

`data.sql` seeds two groups ("Деканат ФПМіІ", "Завідувачі кафедр") and three accounts for local
testing:

| Email | Password | Role |
|---|---|---|
| `admin@lnu.edu.ua` | `Admin#2026` | `GLOBAL` admin grant, no forced password change |
| `dean.fpmi@lnu.edu.ua` | `Temp#12345` | member of "Деканат ФПМіІ" (holds a `FACULTY` grant); must change password on first login |
| `o.melnyk@lnu.edu.ua` | `Temp#12345` | direct `DEPARTMENT` grant; must change password on first login |

---

## Avoiding N+1 queries (DataLoader batching)

Because a GraphQL relation field's data fetcher is invoked **once per parent row**, a naive
implementation issues one SQL query per row for every relation a query touches. With a
nested query like `curriculumItems → hours → workingCurriculumItems → department/course`,
that used to fan out into dozens of tiny queries per page load, visible in the R2DBC debug
logs (enabled via `application-loc.properties`) as a wall of near-identical
`SELECT id FROM faculties WHERE id = $1` calls.

`DynamicDataFetchers.relation(...)` now resolves every relation field (to-one, to-many,
many-to-many) through a per-request `org.dataloader.DataLoader`:

- One `DataLoader` is registered per `(ownerGraphQLType, relationField)` pair — e.g.
  `"WorkingCurriculumItem.department"` — the first time that relation is built (at
  schema-build/startup time, via Spring's `BatchLoaderRegistry` bean), never per request.
- Instead of querying immediately, the data fetcher calls `loader.load(key, cols)` (`cols`
  is the resolved column list for that field occurrence, passed as the loader's *key
  context*). All calls made to the same loader within one GraphQL execution tick — i.e. by
  every sibling row requesting that relation — are automatically batched by graphql-java's
  dataloader dispatching (this graphql-java version dispatches automatically whenever a
  `DataLoaderRegistry` is present; no extra instrumentation wiring needed) into **one** SQL
  call:
  - many-to-one / one-to-one → `R2dbcQueryEngine.selectByIds` (`WHERE id = ANY(:ids)`)
  - one-to-many → `selectWhereIn` (`WHERE fk_column = ANY(:ids)`, paired with the owning fk
    value so rows can be grouped back per parent)
  - many-to-many → `selectViaJoinTableBatch` (a single join-table query for every parent id)
- Rows come back grouped per requested key (`Map<key, row>` or `Map<key, List<row>>`), so
  every sibling gets its slice without a second round trip.

This is entirely transparent to `GraphQLSchemaConfig` classes and to clients — the generated
schema and the queries you send are unchanged; only the number of SQL round trips drops.

---

## Adding a new entity (the whole workflow)

1. Create the annotated POJO in `org.lnu.timetable.domain`.
2. Add its table to `src/main/resources/db/schema.sql` (and seed rows to `data.sql`).
3. Add a `type` + queries + mutations block in the relevant `*SchemaConfig` (or a new one,
   registered as a `@Component` implementing `GraphQLSchemaConfig` — all of them are picked
   up automatically via `List<GraphQLSchemaConfig>` injection).
4. Restart — the schema, SQL handlers and relation batch loaders are regenerated
   automatically.

---

## Repository layout

```
timetable/
├── pom.xml
├── src/main/java/org/lnu/timetable/
│   ├── TimetableApplication.java
│   ├── config/       the four GraphQLSchemaConfig classes — Organization, Curriculum,
│   │                 People, Scheduling — which are the whole "API definition"
│   │                 (which entity lives in which: "Where each entity is declared")
│   ├── domain/       annotated POJOs, one per @GraphQLEntity table
│   ├── framework/    the config-driven engine (see The framework above)
│   ├── security/     JWT + PermissionService (see Authentication & authorization)
│   ├── controller/   IndexController redirects / to Apollo Sandbox; FrontendController
│   │                 serves the built Angular client — one or the other, never both
│   │                 (see Serving the frontend from this service)
│   └── filter/       CorsFilter
├── src/main/resources/
│   ├── application.properties       what is the same in every environment
│   ├── application-loc.properties   the 'loc' profile: credentials, JWT secret, SQL
│   │                                logging, the "/" toggle (see Configuration)
│   ├── static/                      the built Angular client, put here by
│   │                                ../scripts/build-ui.sh — git-ignored build output
│   └── db/
│       ├── schema.sql     DDL; starts with DROP SCHEMA public CASCADE
│       └── data.sql       pg_dump-style seed: the real LNU structure plus the
│                          transcribed ФПМІ 2025/2026 timetable (see Database setup)
├── src/test/java/…/SchemaBuildTest.java   assembles the whole GraphQL schema and
│                                          asserts on the printed SDL — the fastest
│                                          check that a schema-config change is valid
└── scripts/
    ├── reset_db.sh        drop + re-apply schema.sql then data.sql (reads the URL from
    │                      application.properties, the credentials from
    │                      application-loc.properties)
    ├── backup_data.sh     dump the current database back out over data.sql
    ├── renumber_ids.sh    compact id sequences in data.sql after manual editing
    ├── generate_data.py   synthetic seed generator (predates the real-data import)
    └── lnu_import/        two-stage real-data pipeline: scrape_lnu.py crawls
                           lnu.edu.ua into data/*.json, build_sql.py turns that into
                           generated/data.sql, validate_sql.py checks it independently.
                           Has its own README.
```

The repository root carries two more scripts, `scripts/build-ui.sh` and `scripts/build-app.sh`,
which package this service and the Angular client into a single deployable jar — see [Serving the
frontend from this service](#serving-the-frontend-from-this-service).

Because `schema.sql`/`data.sql` are applied by hand (see [Known
limitations](#known-limitations)), `scripts/reset_db.sh` is the usual way to pick up a schema
change: it is a one-command equivalent of the two `psql` invocations in [Database
setup](#database-setup).

---

## Known limitations

- **`schema.sql`/`data.sql` are applied manually, not on startup.** Unlike a Flyway/Liquibase
  setup, nothing re-runs them when the app boots — see [Database setup](#database-setup). After
  pulling a change that touches either file, you must re-run both against your local database
  yourself, or requests against the new/changed columns fail with a Postgres "column ... does
  not exist" error (surfaced as a generic `BadSqlGrammarException` / "bad SQL grammar" message,
  which doesn't make the real cause obvious). `scripts/reset_db.sh` does both steps in one
  command. Note that this makes every schema change destructive by default: a change that only
  *adds* a column or an enum value can be applied in place with `ALTER TABLE`/`ALTER TYPE`
  instead, but nothing in the repo tracks which of those you have already run.
- **`spring.profiles.active=loc` is compiled into the jar.** A packaged deployment therefore still
  loads `application-loc.properties` — its dev credentials, its DEBUG SQL logging (every statement
  and every bound parameter, including the ones behind `login`), and `app.apollo-sandbox.enabled=true`,
  which leaves `/` redirecting to Apollo Sandbox rather than serving the client. Each has to be
  overridden per run, or the profile switched off with `--spring.profiles.active=`. Convenient for
  `mvn spring-boot:run`, a trap for anything else; a `prod` profile file would be the tidier answer.
- **`FrontendController` matches at most three path segments.** Every client route fits today
  (`/faculty/:id` is the deepest), but a deeper one added later would 404 on reload until another
  pattern is added there. It is a fixed list of patterns rather than a catch-all precisely so that
  requests for real files keep falling through to the static resource handler — see [Serving the
  frontend from this service](#serving-the-frontend-from-this-service).
- **The `ukrainian` collation needs a Postgres built with ICU** (standard from v15). On a build
  without it, `schema.sql` fails at `CREATE COLLATION` — substitute the `provider = libc,
  locale = 'uk_UA.utf8'` variant noted at that line, which in turn needs that locale generated
  on the host. Collation is part of the column definition, so an existing database does not pick
  it up until it is rebuilt (or each column is `ALTER`ed); until then, Cyrillic still sorts by
  byte value. See [Text collation](#text-collation).
- The entity framework hardcodes a `Long id` primary key for every entity (`EntityMetadataRegistry`,
  the GraphQL `id: ID!` field, `R2dbcQueryEngine.selectOne`/`insert`/`update`/`delete`). The one
  table that doesn't fit — `global_properties`, keyed by `name` — is handled by a fully hand-rolled
  schema/fetcher slice instead of a generic generalization; see [global_properties — outside the
  entity framework](#global_properties--outside-the-entity-framework). A second string-keyed (or
  composite-keyed) entity would need the same treatment, not a `@GraphQLEntity` annotation.
- **A `CHECK`-constraint failure is reported as if a related row were missing.**
  `DynamicDataFetchers`' generic error handler maps any `DataIntegrityViolationException` — which is
  also what a foreign-key violation throws — to whichever declared error status *contains* the
  substring `"NOT_FOUND"`, so it cannot distinguish the two. `lecturer_workloads.duration_hours`
  (`CHECK … BETWEEN 1 AND 4`) surfaces as `LECTURERWORKLOAD_NOT_FOUND`; a malformed
  `constraint_value` on any of the three timetable-constraint tables surfaces as its parent's
  `RELATED_NOT_FOUND`; `room_groups_scope_check` and `class_start_time_sets_default_scope_check`
  behave the same way. In practice each is only reachable by bypassing the UI, which validates the
  same rules client-side and blocks the save — but a direct API caller gets a message that names
  the wrong problem. Distinguishing them would mean inspecting the Postgres `SQLSTATE`
  (`23514` check vs. `23503` foreign key) in that handler.
- **Nothing checks a `TimetableEntry` against the rules that govern it.** Its room may be outside
  the union its workload allows, its `class_start_time_id` may belong to a different set than the
  workload's, and it may sit inside an `UNAVAILABLE` window or past a `NOT_AFTER` — the database
  accepts all three. Every one of these is a condition one or two joins away (and the time rules
  additionally need a class *end* time, which is derived, not stored), so they belong to a scheduler
  and to the UI. There is still no scheduler *in this service*: the one that exists lives in the
  sibling frontend project (see
  [TIMETABLE-GENERATION.md](../timetable-ui/TIMETABLE-GENERATION.md)), applies all of these rules as
  hard filters, and this service only stores what it decides. An entry written by any other client —
  or by the same tab's manual per-block form — is still accepted unchecked.
- **`roomGroupConnection`'s and `classStartTimeSetConnection`'s `facultyId` filters match the column
  exactly**, so they return only that faculty's rows — not the university-wide ones (`faculty_id IS
  NULL`) a caller almost always wants as well. Clients that need both fetch unfiltered and narrow
  client-side, which is what `LecturerWorkloadList` does. A relation filter with an
  `IS NULL OR = :facultyId` condition would fix it at the source.
- Not every many-to-many relation is wired for mutation yet — `CombinedGroup ↔
  AcademicGroup` membership is queryable but still read-only through the generated
  mutations (seed it via `data.sql` or direct SQL). `WorkingCurriculumItem ↔ AcademicGroup`
  demonstrates the pattern (`.manyToMany(...)`); applying it to `CombinedGroup` would be a
  small, mechanical change.
- Query/mutation namespace pluralization is a naive suffix rule (`+s`, or `y → ies`) — it
  mishandles a name that already ends in "s", e.g. `CurriculumItemHours` becomes the
  namespace `curriculumItemHourss` (double s) rather than something more natural.
- Connections are offset/limit only (`pageInfo.total` / `hasNextPage` / `nextPageOffset`) —
  no cursor-based pagination.
- **JWTs are stateless and not revocable individually.** `login` issues a token valid for
  `app.security.jwt-ttl-minutes` (default 12h); there's no refresh-token flow, and no server-side
  session to invalidate on logout — a leaked token keeps working until it expires. Deactivating
  the account (`setUserActive`) or revoking a permission grant takes effect immediately on the
  *next* request, but the token itself remains "valid" until it expires.
- `lecturer_workload_students` is only meaningful when the workload's working curriculum item is
  `INDIVIDUALLY`-taught, but nothing in the database enforces that: the pairings hang off
  `lecturer_workloads`, whose teaching format is two hops away (via `curriculum_item_hours` →
  `working_curriculum_items`), so a `TOGETHER` workload could be given pairings through the API.
  The frontend force-clears them whenever the format is anything else; a CHECK constraint can't
  express the rule without a trigger or a denormalized column.
- Only one permission level exists: **modify** (update + delete + create/modify children). There's
  no separate read-restriction — any authenticated user can query any entity; permission grants
  only govern which edit/delete buttons the frontend shows and which mutations succeed.
- `grantsForResource` requires already knowing the exact `resourceType`/`resourceId` to audit — 
  there's no single query that lists every grant in the system across all resource types.
- The ancestor-closure check in `PermissionService.ancestryOf` walks the permission graph with one
  SQL round trip per edge (via sequential/parallel reactive composition, capped at depth 15) rather
  than a single recursive CTE. Fine at this project's scale; a much larger entity graph or
  permission volume would want that consolidated into one query.
