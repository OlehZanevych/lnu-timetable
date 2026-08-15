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
| `application.properties` | what is the same everywhere — the connection URL and pool sizing, the `spring.flyway.*` block (see [Migrations](#migrations-flyway)), GraphiQL, `app.security.jwt-ttl-minutes`, and `spring.profiles.active=loc` |
| `application-loc.properties` | what is not — `spring.r2dbc.username`/`password`, `app.security.jwt-secret`, the R2DBC SQL/param debug logging (which is how the N+1 query problem described below was originally spotted), and `app.apollo-sandbox.enabled` |

The `loc` profile is activated from `application.properties` itself, so a local run needs nothing on
the command line, and both files are checked in with working development values. Anything in the
profile file can be overridden per run — `--spring.r2dbc.password=…`, `SPRING_R2DBC_PASSWORD=…`,
`SPRING_APPLICATION_JSON`. Overriding the credentials moves Flyway too, since
`spring.flyway.user`/`password` are declared as `${spring.r2dbc.username}`/`${spring.r2dbc.password}`
rather than repeated — which is the point, but it also means `--spring.profiles.active=` no longer
merely drops the profile: nothing would then define those two keys and the placeholders fail to
resolve at startup. Supply them another way if you switch the profile off. See the root README's
*Running it as a single jar* for what a deployment should override.

`scripts/reset_db.sh`, `scripts/backup_data.sh` and `scripts/renumber_ids.sh` read both files
directly: the URL from the first, the credentials from the second. The connection is therefore
stated once and the scripts stay correct when it changes; all three fail with a named error if
either file, or either key, is missing.

---

## Migrations (Flyway)

`schema.sql` creates the database and `data.sql` fills it. Everything that happens to that database
**afterwards** is Flyway's: `src/main/resources/db/migration/V*.sql`, applied at startup, in order,
once each, recorded in `flyway_schema_history`.

The split is deliberate and is the whole of the configuration:

```properties
spring.flyway.url=jdbc:postgresql://localhost:5432/lnu-timetable
spring.flyway.user=${spring.r2dbc.username}
spring.flyway.password=${spring.r2dbc.password}
spring.flyway.baseline-on-migrate=true
spring.flyway.baseline-version=0
```

- **A URL of its own.** Flyway is a JDBC tool; this service is an R2DBC one and owns no
  `DataSource`. Spring Boot handles exactly this case — give `spring.flyway.url` a JDBC URL and it
  builds a plain single-connection `DataSource` for the migration and nothing else. The JDBC driver
  is a `runtime` dependency for that one purpose. It does mean the address of the database is
  written down **twice**, and the two must move together; there is no way to derive `jdbc:…` from
  `r2dbc:…` in a property placeholder. The credentials are not duplicated — they are read from the
  `loc` profile through `${…}`, so they still live in exactly one place.
- **`baseline-version=0`, not the default 1.** `baselineOnMigrate` lets Flyway adopt a schema that
  already exists rather than refusing to touch it, which every database here is: `schema.sql` made
  it. But Flyway then skips every migration *at or below* the baseline version, so the default of 1
  would silently skip `V1`. Zero says "the starting point is before the first migration", and V1
  applies to a database seeded years ago exactly as it does to one seeded this morning.
- **An empty database is not a supported case.** Point the service at one and `V1` fails, because
  the tables it touches do not exist. That is the right answer rather than a bug: the alternative —
  a guard that skips the migration on an empty schema — records V1 as applied, and then `schema.sql`
  and `data.sql` re-create the very rows it was supposed to remove, with nothing left to remove
  them. Run the two files first, as [Database setup](#database-setup) already says.

`reset_db.sh` drops the schema and re-applies both files, `flyway_schema_history` included, so the
next start re-baselines and re-runs every migration against the freshly seeded data. That is why a
migration here has to stay correct against `data.sql` as shipped, not merely against whatever a
particular database happens to hold — and why every migration in the tree is written to match
nothing on a second run rather than to assume it runs once. Each does it differently, according to
what it changes: V1 by deleting on a predicate that stops matching, V2 with `IF NOT EXISTS` and
`ON CONFLICT DO NOTHING`, V3 and V4 by testing `pg_constraint` / the rows themselves, V5 by testing
`pg_type` and `ADD COLUMN IF NOT EXISTS`, V6 by both — `ADD COLUMN IF NOT EXISTS` for the column and
`pg_constraint` for the `CHECK`, since there is no `ADD CONSTRAINT IF NOT EXISTS` — and V7 by
`IF NOT EXISTS` on every object it creates, a `pg_type` guard around its `CREATE TYPE`, and
`ON CONFLICT (name) DO NOTHING` on the `global_properties` rows it seeds, and V8 by guarding every
rename on the old name still being there.

### `V1__delete_curriculum_items_on_elective_courses.sql`

An `ELECTIVE_GROUP` is the slot a навчальний план reserves; which of its children fills that slot is
decided a level down, on `working_curriculum_items.course_id`. A `curriculum_items` row whose own
course is an `ELECTIVE` is therefore a position the model has no place for — and `data.sql` carries
28 of them, across 6 degree programmes. They put the elective on the plan as a top-level component
beside its own група, and where the група carried the same hours they were counted twice: toward the
programme's volume and toward the 25 % elective share alike.

The delete is **not** cheap, and the migration says so in a `NOTICE` before it runs. None of the 28
is an empty leftover: every one is delivered, so `ON DELETE CASCADE` carries the removal down
`curriculum_items` → `curriculum_item_hours` → `working_curriculum_items` → `lecturer_workloads` →
`timetable_entries` — 41, 43, 43 and 47 rows against `data.sql`. That teaching is real and has to be
re-entered under the група's own position by hand; the migration cannot move it, because 19 of the
28 have no група position in their degree programme at all and one has a position lacking the hour
types the child carries. Only 8 of 28 could have been re-pointed, and a migration that fixed 8 and
left 20 would be harder to reason about than one that removes all 28 and reports what it removed.

`data.sql` has since been re-exported from a database this migration had already cleaned, so it now
carries none of those rows and V1 matches nothing on a fresh install: its `NOTICE` reports 0 and the
cascade never fires. The counts above describe what it did when it ran, which is the state any
database seeded before that export is still in.

The client enforces the same rule going forward, so nothing puts these rows back: `CurriculumEditor`
no longer lists an `ELECTIVE` as a top-level block, and the «Навчальні плани» tab's discipline
picker no longer offers one. See the client README's *Editing a curriculum course-first*.

### `V2__building_travel_times.sql`

A group's day is a sequence of classes and the gap between two bells is fixed; when the two classes
are in different корпуси, that gap has to cover the journey. Nothing in the system knew how long
that journey was, so the solver would put a class in Університетська 1 at 9:50 and the next in
Черемшини 31 at 11:30 as readily as two in one corridor. `building_travel_times` is the missing
fact: `(from_building_id, to_building_id) → minutes`, all 342 ordered pairs of the 19 buildings.

**Directed on purpose.** Lviv is built on hills. Університетська 1 stands at roughly 295 m and
Кирила і Мефодія 8 at 310 m, and a fifteen-metre climb with a bag is not the walk back down; 48 of
the 171 pairs differ by a minute or two for that reason and the rest are symmetric, which is a fact
about the terrain rather than a shortcut in the model. There is no row from a building to itself —
a `CHECK` forbids it, because moving inside one building is not a journey between buildings and a
stored zero is a value someone can edit into something else.

**The numbers are estimates and are meant to be corrected.** They were computed from approximate
coordinates and elevations — straight-line distance × 1.35, 4.8 km/h, Naismith's minute per 25 m
climbed and half of it back on the way down, the lesser of that and a tram ride for anything long,
and a floor of four minutes because leaving one building and entering another is never instant. The
migration's header states the method in full. They run from 4 to 31 minutes, median 13.

**The table is in `schema.sql`**, where every other table is, so that file keeps describing the
whole schema; the migration creates it too, with `IF NOT EXISTS`, because a database made before
today has to get it from somewhere. Both routes end at the same definition — verified by building
one database each way and diffing `\d building_travel_times` — with one cosmetic difference that
survives: `schema.sql` declares `id` first, while the migrated route can only append it, so the
column sits last there. Nothing addresses a column by position. The seed rows are `ON CONFLICT DO
NOTHING` for the same reason: once they are in `data.sql` the migration finds nothing to insert on
a fresh database, and still fills an old one.

**What reads it.** `BuildingTravelTime` is a `@GraphQLEntity` with the usual connection, lookup and
three mutations (`configureBuildingTravelTime` in `OrganizationSchemaConfig`); the client edits the
whole matrix on «Час переходу між корпусами»; and the timetable generator now consults it as two new
hard terms of its objective — Π₄ and Π₅, a group or a lecturer given less time between two classes
than the walk between their корпуси takes. See the client's
[TIMETABLE-GENERATION.md](../timetable-ui/TIMETABLE-GENERATION.md) §1.2.

`V3__building_travel_times_surrogate_id.sql` follows, and exists only because of that entity: V2
gave the table its natural primary key, `(from_building_id, to_building_id)`, and the framework
addresses every row by a single `id`. The pair moved from PRIMARY KEY to UNIQUE, which enforces
exactly as much.

### `V4__merge_duplicate_hrushevskoho_building.sql`

`buildings` held one корпус twice: id 5 «вул. Грушевського, 4» and id 7 «вул. Михайла
Грушевського, 4» — the street's colloquial name and its official one, same number, same postal code,
entered by two different people. Harmless until something was built on `buildings`; then it became
36 travel times to and from a place nobody can be in, and a generator that would answer "four
minutes" for a journey of zero.

id 5 had the 5 rooms and the Біологічний факультет; id 7 had no rooms, no timetable entries and the
Геологічний факультет. So the merge is an UPDATE and a DELETE: the faculty moves to the row with the
rooms, the empty duplicate goes, and its travel rows cascade with it — 342 ordered pairs become 306,
which is 18 × 17. Guarded on the duplicate still being empty: if a room has since been put in it the
two rows are no longer one story, and the migration says so and does nothing rather than guess.

As with V1, `data.sql` was re-exported afterwards: it now seeds 18 buildings and 306 travel rows,
with no id 7 at all. On a fresh install V4 therefore finds the pair it was written for absent and
prints its guard message — expected, not a warning about anything.

### `V5__permission_access_levels.sql`

Adds the `access_level` type and `permissions.level`, turning one indivisible "modify" right into
the three ordered levels described under [The permission model](#the-permission-model), plus
`permissions.updated_at`, since a grant became a row that is updated in place rather than only
inserted.

**Every existing grant is backfilled to `MANAGE`.** That is the faithful value rather than the
safest one: `MANAGE` is exactly what a pre-migration row already permitted — update, delete, create
children, and grant the same scope to somebody else — so nobody loses access on the morning it
ships. Narrowing those grants is a decision for whoever administers them, and the «Доступ» panel
makes it two clicks; silently demoting live grants here would instead present itself as the
application breaking.

### `V6__course_semester.sql`

Adds `courses.semester` — nullable, `CHECK (semester IS NULL OR semester > 0)` — the one semester a
discipline may be planned for.

`curriculum_items` already records the semester a discipline is *studied* in, and for almost every
course that is the right and only place for it: the same дисципліна can be a second-semester
component of one programme and a fourth-semester one of another. An **`ELECTIVE_GROUP`** is not like
that. It exists to reserve one slot, in one semester, that a student fills with one of its children,
and its name usually says so — «Вибіркова дисципліна 5» means nothing anywhere but the fifth
semester, and a position putting it in the sixth is an error nobody notices until the розклад is
built around it. The column is settable on any course; it is the `ELECTIVE_GROUP` that needs it.

Nothing in the database enforces the agreement between this column and `curriculum_items.semester`,
deliberately. The service stores and serves — it validates a `TimetableEntry` against no scheduling
rule either — and a constraint here would reject, at the moment somebody restricts a course, a plan
that was legal when it was written. The client is where the rule lives: both curriculum screens
offer that semester and no other, and flag a position stored before the restriction rather than
silently rewriting it. See the client README's *Editing a curriculum course-first*.

The migration is a no-op on a database created from the current `schema.sql`, which carries the
column: `ADD COLUMN IF NOT EXISTS` skips it, and the `CHECK` is added only when `pg_constraint` says
it is absent. Both routes were built and `\d courses` diffed — they end at the same definition,
constraint name included, with the column last on the migrated route for the same reason V2's `id`
is (a migration can only append).


### `V7__abstract_rooms_and_online_classes.sql`

Adds the two answers to "where is this held?" that are not a room, and the two global properties the
scheduler needs to cost them.

- `abstract_rooms` — a place several classes legitimately share at one hour (see *Where a class may
  be held*), optionally scoped to a faculty and optionally sited in a building, with an optional
  `capacity`.
- `lecturer_workload_abstract_rooms` — the link, **keyed on `lecturer_workload_id` alone**, which is
  what makes "at most one abstract room per class, any number of classes per abstract room" a
  structural guarantee rather than a convention.
- `online_class_platform` enum and `lecturer_workload_online_classes`, keyed the same way.
- `timetable_entries.room_id` becomes nullable — a class held in an abstract room or online still
  has an entry, and that entry has no room.
- Two `global_properties` rows: `abstract_room_travel_time_minutes` (60) and
  `university_commute_time_minutes` (80).

Idempotent throughout, because it has to run against databases created from `schema.sql`, which
already carries all of it: `IF NOT EXISTS` on every object, a `pg_type` guard around `CREATE TYPE`
(Postgres has no `CREATE TYPE IF NOT EXISTS`), `ON CONFLICT (name) DO NOTHING` on the property rows,
and `DROP NOT NULL`, which is naturally idempotent.

### `V8__rename_specialties_to_degree_programs.sql`

Renames `specialties` to `degree_programs`, and with it `academic_groups.specialty_id`,
`curriculum_items.specialty_id` and the whole `course_specialties` join table.

The entity was misnamed, and the misnaming was load-bearing in the one place it is read most. A
**спеціальність** is the broader thing — a code and a name in the national classifier, 122
«Комп'ютерні науки» — and an institution may run several **освітні програми** under one of them.
What this table holds, and what every `curriculum_items` row is written against, is the освітня
програма: `code` still records the specialty the programme sits under, but the row is the
programme. Everything downstream — the групи enrolled in it, its навчальний план, the
навантаження and the розклад derived from that plan — hangs off the programme, so the join every
screen walks was saying the wrong word.

It also rewrites `permissions.resource_type` from `SPECIALTY` to `DEGREE_PROGRAM`. That value is
the entity's simple name in UPPER_SNAKE_CASE, derived from the class at startup by
`EntityMetadataRegistry` (see [The permission model](#the-permission-model)) — so renaming the Java
class changes what the service looks for, and a grant still saying `SPECIALTY` would match nothing.
It would not error; a deanery would simply find its programmes read-only one morning, which is the
kind of failure worth a `UPDATE` in a migration rather than a note in a release.

What it renames beyond the table and the columns is the reason it is longer than it looks:
constraints, their backing indexes and the sequence. Postgres carries none of those along with a
`RENAME`, so without it a database carried forward would keep `specialties_pkey` and
`curriculum_items_specialty_id_fkey` while a database freshly built from `schema.sql` would call
them `degree_programs_pkey` and `curriculum_items_degree_program_id_fkey` — two schemas that are
the same shape and do not compare equal, which is exactly the drift Flyway exists to prevent.
Renaming a `PRIMARY KEY` or `UNIQUE` constraint renames its index with it, so the indexes need no
statement of their own.

Idempotent by guarding every step on the old name still being present — `ALTER TABLE IF EXISTS` and
`ALTER SEQUENCE IF EXISTS` where Postgres offers them, an `information_schema.columns` test around
each `RENAME COLUMN` and a `pg_constraint` test around each `RENAME CONSTRAINT` where it does not.
After `reset_db.sh`, `schema.sql` has already created everything under the new names and this
migration finds nothing to do.

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
thing that handling cannot do: answer a **deep link**. The Angular router owns
`/faculty/3/room-assignment` and `/room-group`, which are paths in the browser and files nowhere, so
a reload or a pasted URL asks this service for something that was never on disk. It answers those with
`index.html` and lets the router take over. Three rules keep it from swallowing anything else:

- every path segment is matched as `[^.]*`, so a request for any name containing a dot — every
  hashed asset, every font — does not match here and falls through to the resource handler, which
  still returns a real 404 when the file genuinely is missing rather than HTML where a script was
  asked for;
- `/graphql` and `/graphiql` belong to Spring for GraphQL's own `RouterFunction`, whose handler
  mapping is ordered `-1` — ahead of the order-`0` mapping that serves annotated controllers — so
  they are matched before these patterns are consulted at all;
- `produces = text/html` keeps it out of the way of anything negotiating for JSON.

Those three are also the whole of the overlap question. `IndexController` is the only other
annotated controller in the service and the two are mutually exclusive by construction, so nothing
else in the application competes with these patterns for a path.

**Why the patterns are enumerated rather than one catch-all.** `PathPattern` accepts `/{*path}`,
which would match every depth at once — but it captures the remainder whole, dots and all, so
`/main-ABC123.js` and `/fonts/LiberationSerif.ttf` would match it too. A handler cannot decline a
request once its mapping has matched, so it would have to serve those files itself, badly, instead of
letting the resource handler do it. The per-segment `[^.]*` constraint is the only thing that
expresses "no dotted name", and a regex constraint is allowed only on a named single-segment
capture — so one pattern per depth is the price of the fall-through, and the depth is bounded by
however many are listed. **Six are**, which is double what the client needs: its deepest route is
three segments, because every tabbed drill-down page carries its open tab as one more segment
(`/faculty/:id/:section`, so that «Кафедри» and «Аудиторії» can be bookmarked and reloaded — see the
client README's [The open tab is part of the
URL](../timetable-ui/README.md#the-open-tab-is-part-of-the-url-section-routets)). A seventh segment
would need one more line in `FrontendController`, and nothing else.

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
| `Building` | `buildings` | → faculties, rooms, travel times |
| `BuildingTravelTime` | `building_travel_times` | whole minutes (`CHECK (minutes >= 0)`); → fromBuilding, toBuilding, both `ON DELETE CASCADE`, so removing a building takes its journeys with it. Directed: (from, to) and (to, from) may differ, and `CHECK` forbids a row from a building to itself. Both ends are `@PermissionParent`s, so a grant over either building covers the journey between them |
| `Faculty` | `faculties` | → building?, departments, degreePrograms, rooms |
| `Department` (кафедра) | `departments` | → faculty, lecturers, courses |
| `DegreeProgram` (освітня програма) | `degree_programs` | code, degree; → faculty, groups, curriculum items |
| `Course` (дисципліна) | `courses` | type (incl. `ELECTIVE_GROUP`/`ELECTIVE`), optional `semester` — when set, the only semester the discipline may be planned for, enforced by the client on both curriculum screens and printed before its tags wherever it is named (see [`V6`](#v6__course_semestersql)); → faculty? *or* department? directly responsible for it, self-referential parent/child (an `ELECTIVE_GROUP` course's `childCourses` are its `ELECTIVE` options), M-N degree programmes this course may be added to a curriculum for (`course_degree_programs`), 1-N tags |
| `CourseTag` | `course_tags` | free-form label shown after the course's name (e.g. "англійською"); → course |
| `CurriculumItem` | `curriculum_items` | semester, control form, ECTS; → **degree programme directly** (no separate `Curriculum`/`curricula` table — removed), course, hours |
| `CurriculumItemHours` | `curriculum_item_hours` | hour type (LECTURE/PRACTICAL/LAB/CONSULTATION/ASSESSMENT/INDEPENDENT_WORK) + count; → curriculum item, working curriculum items |
| `WorkingCurriculumItem` (робочий навчальний план) | `working_curriculum_items` | lecturer count, teaching format; → curriculum item hours, department, optional elective course, M-N academic groups, M-N combined working curriculum items |
| `CombinedWorkingCurriculumItem` | `combined_working_curriculum_items` | pure M-N hub, no scalar fields of its own; bundles several `WorkingCurriculumItem`s that share course/semester/hour-type (e.g. one shared lecture across degree programmes) so one `LecturerWorkload` can cover all of them at once; → M-N working curriculum items, workloads |
| `Lecturer` (викладач) | `lecturers` | position, degree; → department, workloads, workloadConstraints, timetableConstraints |
| `LecturerWorkloadConstraint` | `lecturer_workload_constraints` | one (type, value) workload restriction; no standalone queries/mutations — written through `Lecturer`'s `workloadConstraints` nested list; → lecturer |
| `LecturerTimetableConstraint` | `lecturer_timetable_constraints` | one *scheduling* restriction — when this lecturer may be given classes; no standalone queries/mutations — written through `Lecturer`'s `timetableConstraints` nested list; → lecturer. See [Scheduling constraints](#scheduling-constraints) |
| `LecturerWorkload` (**class requirement**) | `lecturer_workloads` | durationHours (academic hours, 1-4); → classStartTimeSet (which grid of bells its classes run on), M-N rooms + M-N roomGroups (where it may be held — the union, empty meaning unrestricted), M-N lecturers, M-N academicGroups, M-N combinedGroups, 1-N studentAssignments (INDIVIDUALLY only), *exactly one of* workingCurriculumItem / combinedWorkingCurriculumItem, timetable entries |
| `LecturerWorkloadCandidate` | `lecturer_workload_candidates` | a lecturer who *could* deliver a workload, scored 1-100 by desirability — the pool automatic generation picks from, distinct from the lecturers actually assigned; **has its own `create`/`update`/`delete` mutations** (no connection or `findById` query — it is read through `LecturerWorkload.candidates`) because it carries children of its own and nested lists only go one level deep, see [Declare the API](#declare-the-api-no-servicerepositorycontroller); → workload, lecturer, constraints |
| `LecturerWorkloadCandidateConstraint` | `lecturer_workload_candidate_constraints` | `MIN_STUDENTS` (desired) / `MAX_STUDENTS` (ceiling) for one candidate, used only by `INDIVIDUALLY`-taught items; no standalone queries/mutations — written through `LecturerWorkloadCandidate`'s `constraints` nested list; → candidate |
| `LecturerWorkloadStudent` | `lecturer_workload_students` | one lecturer↔student pairing of an `INDIVIDUALLY`-taught workload; no standalone queries/mutations — written through `LecturerWorkload`'s `studentAssignments` nested list; → workload, lecturer, student |
| `Student` | `students` | first/middle/last name (по батькові optional), record book number; → academic group |
| `AcademicGroup` (ПМі-31) | `academic_groups` | year, study form; → degreeProgram, students, M-N combined groups, timetableConstraints |
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
`departments.abbreviation`, `degree_programs(name, degree)`, `academic_groups.name`,
`lecturers.email`, `building_travel_times(from_building_id, to_building_id)` (one figure per
ordered pair; the pair was this table's primary key until V3 gave it a surrogate `id`),
`curriculum_items(course_id, degree_program_id, semester)`,
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
> entity (`Curriculum` / `curricula`, one per degree programme) with `CurriculumItem` pointing at
> it. Since a degree programme only ever has one curriculum, that indirection was removed —
> `CurriculumItem` now references `DegreeProgram` directly via `degree_program_id`.

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
| `online_class_platform` | `ZOOM`, `MICROSOFT_TEAMS`, `GOOGLE_MEET`, `MOODLE`, `SKYPE`, `WEBEX`, `BIGBLUEBUTTON`, `OTHER` — nullable, because "online, platform not yet decided" is a real state |
| `grantee_type` | `USER`, `GROUP` — which column of a `permissions` row is set |
| `access_level` | `EDIT`, `FULL`, `MANAGE` — how much a grant permits. The clearest case of why these are enums: the service asks `level >= 'FULL'` in SQL and `held.allows(required)` in Java, and both mean the same thing only because declaration order is comparison order |
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
`buildings`, `faculties`, `departments`, `degree_programs`, `academic_degrees`, `lecturers`,
`academic_groups`, `combined_groups`, `students`, `courses`, `course_tags` and `rooms`, and
deliberately **not** to e-mail/phone/website/postal codes, record book numbers or the auth tables.

Requires a Postgres built with ICU (standard from v15); `schema.sql` carries a comment with the
`provider = libc, locale = 'uk_UA.utf8'` fallback. ICU collations are deterministic, so `UNIQUE`
indexes on collated columns keep working unchanged. The frontend pins the same alphabet
client-side — see its README's *Ukrainian sorting*.

### `global_properties` — outside the entity framework

`global_properties` (`name` VARCHAR **primary key**, `type` a `property_type` enum, `value`
VARCHAR) is a generic name/type/value store for system-wide settings. It deliberately has **no** annotated
`GlobalProperty` domain class: the framework assumes every entity has a **`Long`** primary key — it
no longer requires the *column* to be called `id` (see `@GraphQLEntity(key = …)` below), but a
`String` key is still outside what it can express. Rather than generalize that assumption across every
existing entity, the `GlobalProperty`/`GlobalPropertyQueries`/`GlobalPropertyMutations` GraphQL
types and their `list` / `globalProperty(name)` / `updateGlobalProperty(name, value)` fields are
hand-built directly in `DynamicGraphQLSchemaBuilder.buildGlobalPropertyTypes()` and wired to
hand-written fetchers in `DynamicDataFetchers` (`globalPropertyList()`, `globalProperty()`,
`updateGlobalProperty()`), following the same escape-hatch pattern already used for
`ConnectionPageInfo` and the Apollo Federation `_service` field. They are not outside authorization,
though they once were: the two reads are wrapped in `DataFetcherProvider#authenticated` and the
write in `#globalSettingMutation`, which requires a `GLOBAL` grant at `EDIT` or above — see [Two
holes this closed on the way](#two-holes-this-closed-on-the-way). `R2dbcQueryEngine.updateWhere(table,
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
keep accepting one. These rows now ship in `data.sql` itself; the separate
`global-properties-limits.sql` that once carried them for an older database is gone, superseded by
the Flyway migrations described under [Schema migrations](#migrations-flyway).

Nothing in the service reads any of these: they are stored and served, and every one of them is
applied in the client. That is the same division as everywhere else — see *How the two halves divide
the work* in the root README.

### Join tables with no entity of their own

Several many-to-many links exist only as join tables, reached through a `@ManyToMany` field rather
than a `@GraphQLEntity` class of their own — they carry no columns beyond the two foreign keys, so
there is nothing to query or mutate directly:

| Join table | Links | Exposed as |
|---|---|---|
| `course_degree_programs` | `Course` ↔ `DegreeProgram` | `Course.degreePrograms`, `degreeProgramIds` input |
| `course_tags` *(has an entity)* | `Course` → `CourseTag` | nested list, see `CourseTag` |
| `combined_group_academic_groups` | `CombinedGroup` ↔ `AcademicGroup` | `CombinedGroup.academicGroups` |
| `working_curriculum_item_groups` | `WorkingCurriculumItem` ↔ `AcademicGroup` | `academicGroupIds` input |
| `combined_working_curriculum_item_members` | `CombinedWorkingCurriculumItem` ↔ `WorkingCurriculumItem` | `workingCurriculumItemIds` input |
| `lecturer_workload_lecturers` | `LecturerWorkload` ↔ `Lecturer` | `lecturerIds` input |
| `lecturer_workload_academic_groups` | `LecturerWorkload` ↔ `AcademicGroup` | `academicGroupIds` input |
| `lecturer_workload_combined_groups` | `LecturerWorkload` ↔ `CombinedGroup` | `combinedGroupIds` input |
| `lecturer_workload_rooms` | `LecturerWorkload` ↔ `Room` | `LecturerWorkload.rooms`, `roomIds` input |
| `lecturer_workload_abstract_rooms` | `LecturerWorkload` ↔ `AbstractRoom` | `LecturerWorkload.abstractRooms`, `AbstractRoom.workloads`, `abstractRoomIds` input — keyed on the workload, so the list holds 0 or 1 |
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

**Where.** Three alternatives, and they are mutually exclusive in practice even though nothing in
the database says so:

1. **In rooms of its own** — the ordinary case, described immediately below.
2. **In an abstract room** (`lecturer_workload_abstract_rooms` → `abstract_rooms`) — «Спортивні
   зали», «Басейн»: one line on the розклад that classes from different groups and different
   specialities legitimately share at the same hour. It is deliberately **not** a `Room`, because
   everything reasoning about rooms is built on one room holding one class at a time, and recording
   this as a room would be a lie the scheduler believes; nothing testing room exclusivity reads that
   table. Its `capacity`, when set, caps the *total* students of all the classes sharing it in one
   slot rather than the size of any one of them. Sited in a building, the journey to it is that
   building's like any room's; sited nowhere, there is no address to measure from and the journey is
   the flat `abstract_room_travel_time_minutes`.
3. **Online** (`lecturer_workload_online_classes`) — the row's *presence* is the fact; its columns
   only say how to attend. Creating one marks the class online, deleting it puts it back in a room.

Both links key on `lecturer_workload_id` **alone**, so a class has at most one abstract room and at
most one online-class row, while an abstract room hosts as many classes as its capacity allows. The
asymmetry is the whole point of the design, and it is the primary key that enforces it.

A class held either way still gets a `timetable_entries` row; that row's `room_id` is `NULL`, which
is why the column is nullable.

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
| `users` | email (unique), first/last name, BCrypt `password_hash`, `must_change_password`, `is_active`, and the optional person link `lecturer_id` / `student_id` — see below |
| `groups` | name (unique), description |
| `user_groups` | `(user_id, group_id)` — a user may belong to any number of groups |
| `permissions` | a single grant: `grantee_type` (`USER`/`GROUP`) + exactly one of `user_id`/`group_id`, `resource_type` + `resource_id` (or `resource_type = 'GLOBAL'` with a `NULL` id for university-wide scope), `level` (`EDIT`/`FULL`/`MANAGE`, with no `DEFAULT` on purpose, so a forgotten column cannot quietly hand out delete rights), `granted_by`, `created_at`, `updated_at`. One row per grantee per exact resource, so re-granting a scope changes `level` in place rather than adding a near-duplicate |

#### Who an account *is*: `users.lecturer_id` / `users.student_id`

An account may also name the person it belongs to — the викладач it is, or the студент. Two nullable
foreign keys, `ON DELETE SET NULL` on both, and one rule:

```sql
CONSTRAINT users_person_link_check CHECK (lecturer_id IS NULL OR student_id IS NULL)
```

A user is a Lecturer **or** a Student **or** neither, and neither is the normal case — deanery staff
and the administrator are nobody in particular, which is why this is a `CHECK` over two nullable
columns rather than a discriminator. Two partial unique indexes
(`users_unique_lecturer` / `users_unique_student`) say the same thing in the other direction: one
account per person, since two accounts both claiming lecturer 123 would make «мій розклад»
ambiguous without either being wrong on its own.

`ON DELETE SET NULL` rather than `CASCADE` is the deliberate part. Striking a lecturer off the staff
list must not delete their account along with its permission grants and its trail in
`permissions.granted_by`; the account survives, unlinked, for an administrator to deal with.

**The link is an identity, not a role.** It grants nothing and restricts nothing: authorization
still comes entirely from `permissions` and the cascade below, and a linked account edits exactly
what its grants allow. All it decides is whose навантаження, навчальний план and розклад the
client's «Мій кабінет» resolves — see the frontend README's
[«Мій кабінет»](../timetable-ui/README.md#мій-кабінет-mydeskpage-me). That separation is what lets a
завідувач кафедри hold both a `DEPARTMENT` grant and a lecturer link without either implying the
other.

Two things follow for the API. `lecturerId`/`studentId` appear on `CurrentUser` (your own account)
and on `User` as returned by the **administrator-only** `users` query — but they are stripped from
the same type where a user is merely *named* rather than administered: `Group.members`,
`PermissionGrant.user` and `PermissionGrant.grantedBy`. `groups` is open to any signed-in caller, so
without that the link would be enumerable university-wide. And only an administrator may set it
(`setUserLink`, `createUser`'s two optional arguments), because an account that can point itself at
a lecturer can read that lecturer's workload.

Because `schema.sql` opens with `DROP SCHEMA public CASCADE`, it cannot be re-applied to a database
that already holds data. Carrying an existing database forward is what
[Schema migrations](#migrations-flyway) is for; the hand-run `db/users-person-link.sql` that
predated Flyway has been removed.

### Permission cascade annotations on domain entities

Most domain classes carry class-level `@PermissionParent`/`@PermissionJoinParent` annotations
(see [Authentication & authorization](#authentication--authorization)) declaring which ancestor
entity a "modify" grant cascades down from. The resulting graph:

| Entity | Cascades down from (any one path is sufficient) |
|---|---|
| `Faculty` | `Building`? |
| `Department`, `DegreeProgram` | `Faculty` |
| `Room` | `Faculty`?, `Building`? |
| `RoomTimetableConstraint` | `Room` |
| `RoomGroup` | `Faculty`?, `Department`? |
| `ClassStartTimeSet` | `Faculty`? |
| `ClassStartTime` | `ClassStartTimeSet` |
| `Course` | `Department`?, `Faculty`?, parent `Course`? (elective group → its options) |
| `CourseTag` | `Course` |
| `Lecturer` | `Department` |
| `LecturerWorkloadConstraint`, `LecturerTimetableConstraint` | `Lecturer` |
| `AcademicGroup` | `DegreeProgram` |
| `AcademicGroupTimetableConstraint` | `AcademicGroup` |
| `CombinedGroup` | any member `AcademicGroup` (via `combined_group_academic_groups`) |
| `Student` | `AcademicGroup` |
| `CurriculumItem` | `DegreeProgram`, `Course` |
| `CurriculumItemHours` | `CurriculumItem` |
| `WorkingCurriculumItem` | `Department`, `CurriculumItemHours`, elective `Course`? |
| `CombinedWorkingCurriculumItem` | any member `WorkingCurriculumItem` (via `combined_working_curriculum_item_members`) |
| `LecturerWorkload` | `WorkingCurriculumItem`?, `CombinedWorkingCurriculumItem`?, any linked `Lecturer`/`AcademicGroup`/`CombinedGroup` (join tables) |
| `LecturerWorkloadCandidate` | `LecturerWorkload` |
| `LecturerWorkloadCandidateConstraint` | `LecturerWorkloadCandidate` |
| `LecturerWorkloadStudent` | `LecturerWorkload` |
| `TimetableEntry` | `LecturerWorkload`, `Room` |
| `BuildingTravelTime` | `Building` at *either* end (`from_building_id`, `to_building_id`) |
| `Building`, `AcademicDegree` | *(none — top-level; only a `GLOBAL` grant reaches these, at `EDIT` to create or change one and `FULL` to delete it)* |

`LecturerWorkload`'s rooms and room groups are deliberately **not** permission parents: being able
to modify a room, or the list of rooms in a group, must not confer the right to modify every
workload that happens to be allowed to use it. Its `ClassStartTimeSet` is left out for the same
reason.

`?` marks a `nullable = true` edge (the FK may be unset, in which case that path just doesn't
apply). Following these edges upward from any row yields the full set of resources whose grant
would cover it — e.g. a grant on a `Faculty` covers its `Department`s, `DegreeProgram`s, `Room`s,
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

**A primary key that is not called `id`.** `@GraphQLEntity(table = "…", key = "lecturer_workload_id")`
says the table's key lives in that column instead. It exists for the tables whose "at most one row
per parent" rule *is* the primary key — `lecturer_workload_online_classes` is the first — where a
surrogate `id` alongside a unique constraint would be two ways of saying the same thing and one of
them enforceable only by convention.

The rest of the framework is untouched by it, because the key column is **projected under the alias
`id`** (`new Col(md.keyColumn(), "id")`). Every consumer — the row mapper, the `Connection`
pagination cursor, `DataLoader` batching, the permission joins — still reads `id`, and the GraphQL
type still exposes `id: ID!`. Only `EntityMetadata.keyColumn` and the SQL that names the column
know the difference. `key` defaults to `"id"`, so nothing else in the codebase changed.

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
            .relation("degreeProgram").relation("course").relation("hours");

        s.query("curriculumItemConnection").entity(CurriculumItem.class).connection()
            .orderBy("semester").filter("degreeProgramId", "degree_program_id");
        s.query("curriculumItem").entity(CurriculumItem.class).findById();

        s.mutation("createCurriculumItem").entity(CurriculumItem.class).create()
            .inputFields("semester", "controlForm", "ectsCredits", "degreeProgramId", "courseId")
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
| `academicGroupConnection` | `facultyId` | `academic_groups.degree_program_id → degree_programs.faculty_id` |
| `combinedGroupConnection` | `facultyId` | `combined_group_academic_groups → academic_groups → degree_programs.faculty_id` |
| `workingCurriculumItemConnection` | `facultyId`, `semesterParity`, `courseId` | `working_curriculum_items.department_id → departments.faculty_id`; `curriculum_item_hours → curriculum_items.semester`; `courseId` ORs the item's own `course_id` (the elective chosen) with `curriculum_item_hours → curriculum_items.course_id` (the discipline delivered) |
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
`degreeProgramId`, so clearing its degree programme sub-filter narrows to "every group of this
faculty" instead of widening to every group in the university.

### Where each entity is declared

The four `*SchemaConfig` classes are the whole API surface — 31 entities, one `configure<Entity>`
method each, split by subject area:

| Config class | Entities declared |
|---|---|
| `OrganizationSchemaConfig` | `Building`, `BuildingTravelTime`, `Faculty`, `Department`, `DegreeProgram`, `Room`, `RoomTimetableConstraint`\*, `RoomGroup`, `AbstractRoom` |
| `CurriculumSchemaConfig` | `Course`, `CourseTag`\*, `CurriculumItem`, `CurriculumItemHours`, `WorkingCurriculumItem`, `CombinedWorkingCurriculumItem` |
| `PeopleSchemaConfig` | `AcademicDegree`, `Lecturer`, `LecturerWorkloadConstraint`\*, `LecturerTimetableConstraint`\*, `Student`, `AcademicGroup`, `AcademicGroupTimetableConstraint`\*, `CombinedGroup` |
| `SchedulingSchemaConfig` | `LecturerWorkload`, `LecturerWorkloadStudent`\*, `LecturerWorkloadCandidate`\*\*, `LecturerWorkloadCandidateConstraint`\*, `ClassStartTimeSet`, `ClassStartTime`, `TimetableEntry`, `LecturerWorkloadOnlineClass`\*\*\* |

Twenty-two of them get the full set — `<entity>Connection` + `<entity>` + `create`/`update`/`delete`.
The exceptions are all children written through a parent:

- \*\*\* **mutations but no queries** (`LecturerWorkloadOnlineClass`): reached only through
  `LecturerWorkload.onlineClass`, so it needs no query of its own, but creating and deleting it is
  how a class is marked online and put back in a room — so the mutations are the API.
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
| `degreeProgramConnection` | `code` | `facultyId` |
| `roomConnection` | `number` | `facultyId`, `buildingId` |
| `buildingTravelTimeConnection` | `from_building_id` | `fromBuildingId`, `toBuildingId` |
| `roomGroupConnection` | `name` | `facultyId`, `departmentId` |
| `academicDegreeConnection` | `level` | — |
| `lecturerConnection` | `lastName` | `departmentId`, `facultyId` (r) |
| `studentConnection` | `lastName` | `academicGroupId` |
| `academicGroupConnection` | `name` | `degreeProgramId`, `facultyId` (r) |
| `combinedGroupConnection` | `name` | `facultyId` (r) |
| `courseConnection` | `name` | `departmentId`, `facultyId`, `parentCourseId`, `degreeProgramId` (r) |
| `curriculumItemConnection` | `semester` | `degreeProgramId`, `courseId` |
| `curriculumItemHoursConnection` | `hourType` | `curriculumItemId` |
| `workingCurriculumItemConnection` | `id` | `departmentId`, `facultyId` (r), `semesterParity` (r) |
| `combinedWorkingCurriculumItemConnection` | `id` | `facultyId` (r), `departmentIds` (r), `semesterParity` (r) |
| `lecturerWorkloadConnection` | `id` | — |
| `abstractRoomConnection` | `name` | `facultyId`, `buildingId` |
| `classStartTimeSetConnection` | `name` | `facultyId` |
| `classStartTimeConnection` | `ordinal` | `classStartTimeSetId` |
| `timetableEntryConnection` | `dayOfWeek` | `workloadId`, `roomId`, `roomIds` (r), `lecturerIds` (r), `academicGroupIds` (r), `semesterParity` (r) |

Nine entities are missing from this table on purpose, and the omission is the design rather than a
gap: `CourseTag`, `LecturerWorkloadConstraint`, `LecturerTimetableConstraint`,
`AcademicGroupTimetableConstraint`, `RoomTimetableConstraint`, `LecturerWorkloadStudent` and
`LecturerWorkloadCandidateConstraint` are read through their parent's relation field and written
through its `.nestedList(...)`; `LecturerWorkloadCandidate` is read through
`LecturerWorkload.candidates` while being written through mutations of its own; and
`LecturerWorkloadOnlineClass` is read through `LecturerWorkload.onlineClass` while being written
through create/update/delete mutations of its own, since its *existence* is the fact being edited. See [Where each
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
   context. A request with *no* header stays anonymous rather than being rejected outright — this
   keeps `login` reachable through the same `/graphql` endpoint, while every other field enforces
   its own requirement. A request that *does* present a token which cannot be honoured also runs
   anonymously, but no longer silently: see [When a token expires](#when-a-token-expires).
2. `AuthorizingDataFetcherProvider` wraps the generic `DynamicDataFetchers` and is the
   `DataFetcherProvider` actually wired into `DynamicGraphQLSchemaBuilder` (via
   `DynamicGraphQlConfiguration`) — the schema builder itself has no authorization awareness.
   It enforces two rules for every reflectively-generated query/mutation:
   - any operation requires a signed-in caller (reads are open to any authenticated user);
   - mutations additionally require an access level on the target (or, for creates, on whichever
     declared parent the new row is being attached to): `create` and `update` need `EDIT`, `delete`
     needs `FULL` — see [The permission model](#the-permission-model) below. The denial message
     names the level that was missing, so somebody holding `EDIT` learns what to ask their deanery
     for rather than guessing whether they are in the wrong place entirely.
3. Hand-rolled operations (`login`, `me`, `changePassword`, `createUser`, `setUserLink`, group/permission
   management) bypass this decorator entirely — they're wired directly in
   `DynamicGraphQLSchemaBuilder.buildAuthTypes()`/`registerAuthFetchers()`, the same escape-hatch
   pattern used for `GlobalProperty` (see above), so a `User`'s password hash is never reachable
   through the generic, selection-set-driven machinery.

### Why the Flyway dependency list has four entries and not one

`flyway-core` on the classpath does **nothing** on its own here. Spring Boot 4 split
`spring-boot-autoconfigure` into one module per technology; what remains in it is twelve core
auto-configurations, and Flyway's is not one of them. Without
`org.springframework.boot:spring-boot-flyway` there is no `FlywayAutoConfiguration`, so no `Flyway`
bean is created, nothing binds the `spring.flyway.*` properties, and **the application starts
normally having migrated nothing** — no warning, because as far as Boot is concerned nobody asked
for Flyway. The failure mode is silence, which is why it is written down here as well as in the
pom.

The other two are less subtle. `flyway-database-postgresql` is Flyway's PostgreSQL support, a
separate artifact since Flyway 10, without which Flyway does not recognise the database it is
pointed at; and `org.postgresql:postgresql` is the JDBC driver, at `runtime` scope, since the
startup migration is the only JDBC connection this service ever opens. No versions are declared for
any of the four — the Boot parent manages all of them.

`spring-boot-flyway` brings `spring-boot-jdbc` with it (that is where `DataSourceBuilder` lives). No
connection pool comes along, so `DataSourceAutoConfiguration` finds neither a pool implementation,
nor an embedded driver, nor a `spring.datasource.url`, and creates no `DataSource` — which is what
we want. The only JDBC `DataSource` in the context is the `SimpleDriverDataSource` Flyway builds for
itself from `spring.flyway.url`, and it is used once, at startup.

### When a token expires

`app.security.jwt-ttl-minutes` is 12 hours by default, and a browser tab outlives that easily. Until
recently the thirteenth hour looked like this: the client kept sending its stored token, the
interceptor could not verify it, the request ran anonymously, `Query.me` answered

```json
{ "data": { "me": null } }
```

with no `errors` array and no status of any kind, and the client — having asked a question that got
a perfectly well-formed answer — had nothing to react to. It stayed on a page it was no longer
entitled to until the user happened to trigger something that failed loudly.

The fix is to stop conflating *nobody presented credentials* with *the credentials presented are no
longer good*. `JwtService.parse` now returns a `TokenResult` — a user id, or one of three
`AuthFailure` values — and `AuthenticationGraphQlInterceptor` reports the failure on the response
**twice**, so a client can act on whichever it reads first:

| Where | What |
|---|---|
| response body | an extra entry in `errors`, with `extensions.code = "UNAUTHENTICATED"`, `extensions.authError` naming the `AuthFailure`, and `classification: "UNAUTHORIZED"` from `ErrorType` |
| response header | `X-Auth-Error: TOKEN_EXPIRED`, named in `CorsFilter`'s `Access-Control-Expose-Headers` so a cross-origin client can actually read it |

The three `AuthFailure` values are `TOKEN_EXPIRED` (correctly signed, past its `exp`),
`INVALID_TOKEN` (malformed, or signed with a key this service does not accept) and
`ACCOUNT_DISABLED` (the token is fine, but the account it names has since been deleted or
deactivated — the one case the client could never work out for itself). jjwt raises
`ExpiredJwtException` only *after* verifying the signature, so `TOKEN_EXPIRED` is never a guess
about an unauthenticated stranger's token: it says "this was one of ours, and its time is up".

Two things this deliberately does **not** do. It does not reject the request — the query still
executes anonymously and returns whatever an anonymous caller may see, with the error entry added
*alongside* the result rather than replacing it. And it does not fire for a request with no
`Authorization` header at all, because that is not a failure. The corollary for any client is to not
send a token it already knows is expired; the Angular client checks the `exp` claim locally before
attaching the header and clears its stored token before posting `login`, so an unauthenticated
operation never picks the error up.

The second half of the same problem was `GraphQlAuthException`. Spring for GraphQL masks any
exception escaping a data fetcher as `INTERNAL_ERROR for <execution-id>` unless a resolver claims
it — so "You must be signed in to do this." was never reaching the browser at all, and could not be
told apart from a genuine server fault. `AuthExceptionResolver` now maps it, and picks the
classification off the request instead of off the throw site: no `Principal` on the context means
nobody is signed in, so the failure is an *authentication* one (`UNAUTHENTICATED` / `UNAUTHORIZED`)
and the client should return to the login page; a `Principal` present means the caller is signed in
and merely not allowed to do this (`FORBIDDEN`), which is a message to read, not a session to end.
Every existing `throw new GraphQlAuthException(…)` is untouched, and cannot drift out of step with
the classification because it never states one.

### The security package

`org.lnu.timetable.security` is fifteen classes, and it is worth knowing which of them decides what:

| Class | Role |
|---|---|
| `AuthenticationGraphQlInterceptor` | reads `Authorization: Bearer <jwt>` on every request, resolves it to a `Principal` and puts it — together with the request's `PermissionEvaluator` — on the GraphQL context. An absent header leaves the request anonymous rather than failing it, which is what keeps `login` reachable through the same endpoint; a token that *was* presented and cannot be honoured also runs anonymously, but adds the `X-Auth-Error` header and an `UNAUTHENTICATED` error entry saying so |
| `AuthFailure` | enum — the three reasons a presented token resolves to nobody (`TOKEN_EXPIRED`, `INVALID_TOKEN`, `ACCOUNT_DISABLED`), each with the Ukrainian text carried on the error entry |
| `AuthExceptionResolver` | maps `GraphQlAuthException` to a real GraphQL error with `extensions.code`, instead of the `INTERNAL_ERROR` mask Spring applies to anything no resolver claims |
| `JwtService` | issues and parses the HS256 tokens, which carry only the user id; `parse` returns a `TokenResult` that distinguishes expiry from every other failure |
| `Principal` | record — id, email, first/last name, `mustChangePassword`, and the person link (`lecturerId`/`studentId`), resolved fresh per request like everything else here |
| `AuthorizingDataFetcherProvider` | wraps `DynamicDataFetchers` and is what the schema builder actually receives; enforces "signed in" on every generated field, `EDIT` on every `create`/`update` and `FULL` on every `delete`, and — through `authenticated()` / `globalSettingMutation()` — the same two rules on the hand-rolled `GlobalProperty` fields |
| `AccessLevel` | the three ordered levels — `EDIT` < `FULL` < `MANAGE` — mirroring the `access_level` PostgreSQL enum |
| `PermissionService` | the factory for a request's `PermissionEvaluator` |
| `PermissionEvaluator` | the decision point, one per request: grants loaded once, ancestry walked set-at-a-time, results memoised. Deliberately not thread-safe — GraphQL resolves fields concurrently, and the memo is only sound because a request's fields share one instance rather than racing several |
| `PermissionGraphRepository` | the set-at-a-time reads the evaluator walks the graph with — `fetchForeignKeys`, `fetchJoinParents`, `fetchLabel`. These no longer swallow database errors: a failed read used to look like "no ancestors", i.e. a silent denial, and now propagates |
| `ResourceRef` | record — one `(resourceType, resourceId)` node of that ancestry, plus the synthetic `GLOBAL` root that university-wide grants name. Making `GLOBAL` a node of the same shape, rather than a magic string spliced into each grant query, is what removes the special case from every lookup |
| `PermissionRepository` | everything else the auth tables need: users, groups, memberships, grants |
| `AuthDataFetchers` | the twenty-odd hand-written fetchers behind `login`, `me`, `changePassword`, `users`, `groups`, `searchUsers`, `accessLevels`, `grantsForResource`, the grant/membership mutations and `setUserLink` (with `linkErrorStatus`, the one place in the service that tells a `CHECK` from a foreign key by reading the `SQLSTATE`) |
| `SecurityBeansConfig` | one bean: the BCrypt `PasswordEncoder` |
| `GraphQlAuthException` | reported as a GraphQL error inside a 200 response, matching how the rest of this API reports problems |

The split between `PermissionGraphRepository` and `PermissionRepository` follows the two questions
being asked: one walks *domain* tables along annotation-declared edges and knows nothing about
users, the other reads the *auth* tables and knows nothing about the domain.

### The permission model

A grant (`permissions` table) has three parts: **who**, **where**, and **how much**.

**Who** is a single user or a single group, never both. A user's effective access is the union of
their own grants and those of every group they belong to.

**Where** is a `resource_type` — an entity's simple class name in `UPPER_SNAKE_CASE`, e.g.
`FACULTY`, derived the same way both sides of the stack independently compute it
(`EntityMetadata#resourceType()` on the backend via Guava's `CaseFormat`, `toResourceType()` in the
frontend) — plus a `resource_id`, or the special `resource_type = 'GLOBAL'` (`resource_id` `NULL`)
for a university-wide scope. The scope **cascades downward**: a grant on a `Faculty` also covers its
`Department`s, `DegreeProgram`s, `AcademicGroup`s, `Room`s, `Course`s, curriculum and
working-curriculum items, lecturer workloads and timetable entries; a grant on a single `Department`
covers that department, its lecturers and their workloads, and nothing belonging to a sibling
department.

**How much** is an `AccessLevel` — three ordered values, and the level does not weaken on the way
down:

| Level | Ukrainian | Covers |
|---|---|---|
| `EDIT` | Редагування | create and update this resource and everything below it. **No deletes.** |
| `FULL` | Повний доступ | everything `EDIT` allows, plus deleting |
| `MANAGE` | Керування доступом | everything `FULL` allows, plus granting and revoking access to this resource and its descendants, at any level up to `MANAGE` |

Three levels rather than a matrix of independent "may update" / "may delete" / "may delegate" flags,
because every combination anyone actually asked for is a prefix of that chain. Nobody wants a person
who can delete a кафедра but not rename it, or hand out access they do not themselves have. The
consequence is that every authorization question in the service reduces to one comparison,
`level >= required`, in SQL as much as in Java — `access_level` is a PostgreSQL enum and declaration
order is comparison order there too.

`EDIT` exists because deletion in this schema cascades: removing a `DegreeProgram` takes its
academic groups, curriculum items and workloads with it. Somebody who maintains навчальні плани
every day should be able to do that job without being one mis-click away from erasing a group.
`MANAGE` exists because delegation is a real act at a university: a deanery should be able to hand a
кафедра to its завідувач without an administrator being the bottleneck.

`isAdmin` is not a column on `users`; it is `GLOBAL` at `MANAGE`. `GLOBAL` at `EDIT` is a coherent
and useful thing to hold — somebody trusted with the whole university's data who cannot delete any
of it, and cannot give the right away.

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
ancestor — coverage through *any one* declared path is enough, and the effective level is the
highest any of them yields. See [Permission cascade annotations on domain
entities](#permission-cascade-annotations-on-domain-entities) above for the full graph as actually
declared across the domain model.

### Where the decisions are made

`PermissionService` is now only a factory. The decisions live in **`PermissionEvaluator`**, one
instance of which exists per GraphQL request (put on the context by
`AuthenticationGraphQlInterceptor`, next to the `Principal`).

That split is the point of the refactor. Authorization here is a graph question, and one request
asks it many times — once per mutation, and once per row when a page asks which of two hundred
courses are editable. The previous implementation answered each from scratch: two round trips for
the caller's groups and grants, then one round trip per node while climbing the hierarchy, with no
memory between questions. Two hundred courses in one faculty meant that faculty was read two hundred
times. The evaluator instead:

1. **Loads the caller's grants once** and answers every subsequent question against that map. The
   `hasAnyGrant` statement — whose `WHERE` clause used to be an OR-list of every ancestor reached,
   so the deeper the row the longer the SQL — is gone entirely.
2. **Walks the ancestor graph breadth-first over a whole set of rows at once**: one statement per
   (table, edge) per level, regardless of how many rows are on screen.
3. **Memoises what it resolved.** A node's level is computed once per request; the second question
   about the same faculty costs nothing.
4. **Tracks visited nodes instead of trusting a depth counter**, so `Course.parent_course_id` — an
   entity that is its own ancestor type — cannot loop, and a legitimately deep chain is not silently
   truncated into a denial. (The depth cap survives as a backstop at 32, and reaching it still ends
   the walk early — a truncated graph is not memoised, and it can under-report a level. Nothing in
   the domain model comes near it: the deepest real chain is
   eleven edges.)

Its surface:

| Method | Answers |
|---|---|
| `levelsFor(entityClass, ids)` | the caller's level on each of many rows, resolved together |
| `levelFor(entityClass, id)` / `allows(entityClass, id, required)` | the same for one row |
| `levelForNew(entityClass, input)` | the level over a row that does not exist yet — the highest held over any parent named in the proposed input. Only `@PermissionParent` foreign keys count: nothing points at the row yet, so a `@PermissionJoinParent` path cannot apply, and a `LecturerWorkload` is created through its working-curriculum item rather than through the lecturer who will teach it. An entity created with none of its optional parent references set has no covering scope at all, so only a `GLOBAL` grant creates it: a `Room` belonging to no building and no faculty is a university-wide object |
| `levelForResource(resourceType, resourceId)` | the same by grant-shaped name, including `GLOBAL` |
| `coveringRefs(resourceType, resourceId)` | every node a grant could sit on and still cover this row — what the admin UI lists *effective* access from |
| `holdsManageAbove(resourceType, resourceId)` | whether the caller's `MANAGE` comes from a **strict** ancestor — the revoke rule below |
| `isAdmin()` / `globalLevel()` / `canDelegateSomewhere()` | the university-wide answers |

Each mutation names the level it needs, in one `switch` in `AuthorizingDataFetcherProvider`:
`create` and `update` need `EDIT`, `delete` needs `FULL`. Reads still need only a signed-in caller.

### Delegation, and who can take access away

Granting requires `MANAGE` over the resource — held on it, on any ancestor of it, or
university-wide — and the granted level may not exceed the caller's own. Since `MANAGE` is the top
of the scale that second rule never bites today; it is written down anyway, so that adding a level
above `MANAGE` later cannot silently let a delegate mint it.

Granting the same scope to the same grantee twice is an **update of the level**, not a failure:
"give Ivanenko `FULL` here, he only had `EDIT`" is the same administrative act as granting it, and
making the caller revoke-then-grant would leave a window where they had neither. The mutation
reports `errorStatus: UPDATED` alongside `isSuccess: true` so the UI can say which happened.

A note on how this behaved before, because it explains a symptom rather than only a design: the old
`insertPermission` bound `user_id`, `group_id` and `resource_id` with a plain `bind(name, value)`,
and every grant has at least one of those null — a grant is a user's *or* a group's. R2DBC rejects a
plain bind of null (it has no type to send the parameter as), so the statement always failed; the
repository swallowed the error with `onErrorResume(e -> Mono.empty())`, and the fetcher read the
empty result as "the row is already there" and answered `ALREADY_GRANTED`. `grantPermission`
therefore never once succeeded, for anybody, and said so in the least alarming way available. That
is why the seeded «Деканат ФПМіІ» grant is inserted by `data.sql` rather than made through the UI.
The nulls now go through `Parameters.in(R2dbcType.BIGINT, …)`, which carries the type alongside the
absent value, and only a genuine integrity violation is translated into a status
(`INVALID_GRANTEE`) — everything else propagates, so the next failure of this kind will be visible
instead of comfortable.

Revoking requires one thing more: the caller's `MANAGE` must come from **above** the grant's
resource, or the grant must be one they made themselves (`granted_by`). This closes a hole the old
rule left open. When delegation and modification were the same check, everyone holding a grant on a
кафедра could revoke everyone else's grant on that same кафедра — including the one the deanery had
just made, and including their own. Two heads of the same department could unseat each other, and a
delegate could lock out the person who appointed them. Requiring authority from a strict ancestor
means access is withdrawn by whoever is actually above it, while `granted_by` still lets anyone undo
their own mistake immediately.

### Two holes this closed on the way

- `updateGlobalProperty` had **no authorization check at all**. Any signed-in account — every
  student with a login — could change the semester dates and the timetable-generation weights the
  solver runs on. University-wide settings belong to no entity, so there is no scope for a grant to
  cascade from: changing them now requires `GLOBAL` at `EDIT` or above
  (`DataFetcherProvider#globalSettingMutation`). Reading them stays open to any signed-in user, as
  every page depends on it.
- The `GlobalProperty` read fields bypassed even the signed-in check, because they were registered
  straight from `DynamicDataFetchers` rather than through the authorizing decorator. They now go
  through `DataFetcherProvider#authenticated`.

### GraphQL API

| Field | Kind | Notes |
|---|---|---|
| `login(email, password)` | mutation | returns a JWT + whether the account must change its password |
| `me` | query | the signed-in `CurrentUser` (profile, `isAdmin` — which is exactly `GLOBAL` at `MANAGE` — `lecturerId`/`studentId`, groups, and every effective grant with its `level`), or `null` |
| `changePassword(currentPassword, newPassword)` | mutation | minimum 8 characters; clears `mustChangePassword` |
| `createUser(email, firstName, lastName, temporaryPassword, lecturerId?, studentId?)` | mutation | **admin-only**; the created account must change its password on first login. The two optional ids link it to a person straight away — at most one of them, or `BOTH_LINKS_SET` |
| `setUserLink(userId, lecturerId?, studentId?)` | mutation | **admin-only**; says which lecturer or student an account belongs to. Both omitted clears the link; both given fails `BOTH_LINKS_SET`; a person another account already claims fails `ALREADY_LINKED`; an id naming nobody fails `INVALID_LINK` |
| `setUserActive(userId, active)` | mutation | **admin-only**; deactivates/reactivates an account |
| `users` | query | **admin-only**; all accounts |
| `createGroup(name, description)`, `addUserToGroup`/`removeUserFromGroup` | mutation | **admin-only** group management |
| `groups` | query | any authenticated user |
| `grantPermission(granteeType, userId\|groupId, resourceType, resourceId, level)` | mutation | needs `MANAGE` on the resource; `resourceId` is omitted only for `GLOBAL`. Re-granting an existing scope moves its level and answers `isSuccess: true` with `errorStatus: UPDATED`. Refusals: `FORBIDDEN` (no `MANAGE` there, or no access at all), `LEVEL_ABOVE_OWN`, `INVALID_GRANTEE` (neither or both of user/group, or an id naming nobody), `UNKNOWN_RESOURCE_TYPE`, `UNKNOWN_ACCESS_LEVEL` |
| `revokePermission(permissionId)` | mutation | needs `MANAGE` from a **strict ancestor** of the grant's resource, or that the caller made it (`granted_by`) — that second branch is checked first and needs no level at all. Refusals: `FORBIDDEN`, `PERMISSION_NOT_FOUND` |
| `accessLevels(resourceType, resourceIds)` | query | `[ResourceAccess!]!` — `{ id, level }` per reachable id, which is what the frontend uses to decide which buttons to show. Ids the caller cannot reach are omitted rather than returned with a null level. Replaces `canModifyResources`, whose yes/no answer could not say whether the Delete button next to Edit belonged there |
| `grantsForResource(resourceType, resourceId, includeInherited)` | query | who can reach a resource and at what level; needs `MANAGE` on it. `includeInherited` defaults to true, adding grants held on ancestors and university-wide grants, each marked `inherited: true` — "who can edit this кафедра" is answered wrongly by a list that omits the deanery above it. Ordered direct-first, then strongest level first within each group |
| `searchUsers(query, limit)` | query | finds active accounts by e-mail or name (either order), case-insensitive substring, for the grantee picker. Needs `MANAGE` somewhere — university-wide or on any one resource — and returns identity only, never the person link. A query under two characters returns `[]` rather than an error; `limit` defaults to 20 and is clamped to 1..50. The full `users` listing stays admin-only: a deanery needs to find the person they are handing a кафедра to, not to enumerate the university's staff |

Two GraphQL types carry the model: the enum `AccessLevel { EDIT, FULL, MANAGE }` — an enum rather
than a string so a client cannot invent a fourth value and so introspection carries what each one
means — and `ResourceAccess { id, level }`. `PermissionGrant` gained `level: AccessLevel!` and
`inherited: Boolean`, the latter set only by `grantsForResource` and only as a display hint: an
inherited grant is shown as context and cannot be revoked from there.

One consequence of the upsert worth knowing before it surprises somebody: `DO UPDATE` also sets
`granted_by` to whoever re-granted. Since revocation keys on `granted_by`, re-levelling somebody
else's grant transfers the right to revoke it from the original granter to you.

All admin-only fields fail with a `GraphQlAuthException` for non-admins; unauthenticated calls to
anything except `login` fail the same way with "You must be signed in to do this." Both arrive as a
GraphQL error carrying `extensions.code` — `FORBIDDEN` when someone is signed in, `UNAUTHENTICATED`
when nobody is (see [When a token expires](#when-a-token-expires)), which is the difference between
a message to show and a session to end.

`me` is the one field that answers `null` rather than failing when nobody is signed in, and that is
what made an expired session invisible for as long as it was: a `null` here now travels with the
`X-Auth-Error` header and an `UNAUTHENTICATED` entry whenever a token was presented and refused.

### Configuration & seed data

`app.security.jwt-secret` (≥32 bytes for HS256) lives in `application-loc.properties` and
`app.security.jwt-ttl-minutes` (default 720 = 12 hours) in `application.properties` — see
[Configuration](#configuration). The checked-in secret is a generated dev-only value, and the `loc`
profile is active inside the packaged jar as well, so **override it before deploying anywhere
real** — `--app.security.jwt-secret=…`, `APP_SECURITY_JWTSECRET`, or `SPRING_APPLICATION_JSON`.

`data.sql` seeds two groups ("Деканат ФПМіІ", "Завідувачі кафедр") and exactly one account:

| Email | Password | Role |
|---|---|---|
| `admin@lnu.edu.ua` | `Admin#2026` | `GLOBAL` at `MANAGE` — the administrator grant — and no forced password change |

Everything else about the auth tables is left for that administrator to create, which matches the
no-self-registration rule: there is no seeded example of a forced password change, of a scoped
`FACULTY`/`DEPARTMENT` grant, or of an account linked to a lecturer or a student. Both groups are
seeded empty — "Деканат ФПМіІ" keeps its `FACULTY` grant at `MANAGE`, so adding a user to it is enough to hand
out faculty-wide access, and `permissions` carries just that grant plus the administrator's `GLOBAL`
one.

Exercising the person link therefore takes two steps on «Користувачі та права»: create the account,
then point it at a lecturer or a student (`setUserLink`). Nothing in `data.sql` does it for you.

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
│   ├── security/     JWT + AccessLevel/PermissionEvaluator (see Authentication & authorization)
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
│       ├── data.sql       pg_dump-style seed: the real LNU structure plus the
│       │                  transcribed ФПМІ 2025/2026 timetable (see Database setup)
│       └── migration/     Flyway migrations — every change a populated database
│                          takes after schema.sql created it, applied at startup
│                          and recorded in flyway_schema_history
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

- **`schema.sql`/`data.sql` are applied manually, not on startup.** Flyway now runs at startup, but
  it *carries a database forward* rather than creating one: nothing re-runs those two files when the
  app boots — see [Database setup](#database-setup) and [Migrations (Flyway)](#migrations-flyway).
  After
  pulling a change that touches either file, you must re-run both against your local database
  yourself, or requests against the new/changed columns fail with a Postgres "column ... does
  not exist" error (surfaced as a generic `BadSqlGrammarException` / "bad SQL grammar" message,
  which doesn't make the real cause obvious). `scripts/reset_db.sh` does both steps in one
  command. Note that this makes every schema change destructive by default: a change that only
  *adds* a column or an enum value belongs in a Flyway migration instead, which is exactly what
  `db/migration/` is now for — that half of the problem is solved, and it is the half that used to
  have nothing tracking which incremental scripts a given database had already run.
- **`spring.profiles.active=loc` is compiled into the jar.** A packaged deployment therefore still
  loads `application-loc.properties` — its dev credentials, its DEBUG SQL logging (every statement
  and every bound parameter, including the ones behind `login`), and `app.apollo-sandbox.enabled=true`,
  which leaves `/` redirecting to Apollo Sandbox rather than serving the client. Each has to be
  overridden per run, or the profile switched off with `--spring.profiles.active=`. Convenient for
  `mvn spring-boot:run`, a trap for anything else; a `prod` profile file would be the tidier answer.
- **`FrontendController` matches at most six path segments.** Every client route fits today (the
  deepest is three — `/faculty/:id/:section`), but a deeper one added later would 404 on reload
  until another pattern is added there. It is a fixed list of patterns rather than a catch-all precisely so that
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
- **A `CHECK`-constraint failure is reported as if a related row were missing.** *(Except for the
  person link, which is the one place that does it properly — `AuthDataFetchers#linkErrorStatus`
  reads the Postgres `SQLSTATE` and returns `ALREADY_LINKED` for `23505`, `BOTH_LINKS_SET` for
  `23514` and `INVALID_LINK` otherwise, and its callers narrow `onErrorResume` to
  `DataIntegrityViolationException` so a dropped connection is still an error rather than "that
  lecturer does not exist". Generalising that to the reflective handler is the fix described below.)*
  `DynamicDataFetchers`' generic error handler maps any `DataIntegrityViolationException` — which is
  also what a foreign-key violation throws — to whichever declared error status *contains* the
  substring `"NOT_FOUND"`, so it cannot distinguish the two. `lecturer_workloads.duration_hours`
  (`CHECK … BETWEEN 1 AND 4`) surfaces as `LECTURERWORKLOAD_NOT_FOUND`; a malformed
  `constraint_value` on any of the three timetable-constraint tables surfaces as its parent's
  `RELATED_NOT_FOUND`; `room_groups_scope_check`, `class_start_time_sets_default_scope_check` and
  `courses_semester_check` (a `semester` of `0` or less on a discipline) behave the same way. In
  practice each is only reachable by bypassing the UI, which validates the
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
- There is **no read restriction**: any authenticated user can query any entity. Grants govern
  which mutations succeed and, from that, which buttons the client shows — see [The permission
  model](#the-permission-model) for the three levels and what each opens.
- `grantsForResource` requires already knowing the exact `resourceType`/`resourceId` to audit — 
  there's no single query that lists every grant in the system across all resource types.
- `PermissionEvaluator` walks the permission graph breadth-first — one SQL statement per (table,
  edge) per level, over the whole set of rows being asked about, memoised for the rest of the
  request — rather than as a single recursive CTE. That is a large improvement on the per-row,
  per-edge walk it replaced, and comfortably enough at this project's scale, but the ancestor
  closure is still recomputed on every request. A much larger entity graph, or a page listing rows
  from many different faculties at once, would want a materialised `resource_ancestors` closure
  table maintained by triggers, which would additionally let the permission predicate be pushed
  into the list queries themselves instead of being asked separately afterwards.
- Reads are still gated only on being signed in. Scoping *visibility* the way modification is
  scoped is a larger change than adding levels was — every list query would need the permission
  predicate pushed into its `WHERE` clause — and it is not what the university asked for: a розклад
  is public information within the institution.
