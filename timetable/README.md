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

`data.sql` has since been re-dumped from a database every migration in the tree has run against, so
the two commands succeed as they stand. That re-dump is load-bearing rather than cosmetic, and twice
over: the dump's `degree_programs` inserts now name `duration_semesters`, which
[`V10`](#v10__degree_program_semesterssql) made `NOT NULL` with no default and which no earlier dump
could satisfy; and its `flyway_schema_history` block now records V1…V12 as applied, which is what
[Migrations](#migrations-flyway) below reasons about. Re-dump it the same way after adding a
migration that changes what a table's columns are.

`data.sql` is no longer a pristine `pg_dump` of a hand-entered database: on top of the real LNU
structure it carries the **ФПМІ 2025/2026 timetable**, transcribed from the faculty's published
PDF sheets — 1381 `timetable_entries` over both halves of the year, with the rooms, room groups,
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
| `application.properties` | what is the same everywhere — the connection URL and pool sizing, the `spring.flyway.*` block (see [Migrations](#migrations-flyway)), GraphiQL, `app.security.jwt-ttl-minutes`, the `account-token` TTL and cooldown, the `spring.mail.*` SMTP block, `app.base-url`, and `spring.profiles.active=loc` |
| `application-loc.properties` | what is not — `spring.r2dbc.username`/`password`, `app.security.jwt-secret`, the R2DBC SQL/param debug logging (which is how the N+1 query problem described below was originally spotted), `app.base-url` (the client's own port in development), and `app.apollo-sandbox.enabled` |

Two values are in **neither** file, because they are credentials rather than configuration: the
mailbox the registration and password-recovery links are sent from is read from `MAIL_USERNAME` and
`MAIL_PASSWORD` in the environment, with empty defaults so that a service started without them
starts normally and reports `MAIL_FAILED` on the first attempt to send. See [Self-service
registration and password recovery](#self-service-registration-and-password-recovery).

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

`reset_db.sh` drops the schema and re-applies both files, `flyway_schema_history` included — and
that last inclusion is what decides what happens next. Flyway baselines a schema only when the
history table is *missing*, and after a reset it is present and populated: the dump carries the
baseline row plus V1…V12, so **nothing re-baselines and no migration in the tree runs again**. That
is the right outcome — the dump was taken after they ran, so their effects are already in the data —
and it means only a migration added *since* the last dump runs on a reset. There is none today.
(`schema.sql` says the same thing in its comment above `flyway_schema_history`; the two are meant to
agree.)

Every migration here is nevertheless written to match nothing on a second run rather than to assume
it runs once, because a reset is not the only way one meets a database that has already had it: a
deployment carrying real data replays whatever it has not recorded, and a database seeded from an
older dump replays everything after it. Each does it differently, according to
what it changes: V1 by deleting on a predicate that stops matching, V2 with `IF NOT EXISTS` and
`ON CONFLICT DO NOTHING`, V3 and V4 by testing `pg_constraint` / the rows themselves, V5 by testing
`pg_type` and `ADD COLUMN IF NOT EXISTS`, V6 by both — `ADD COLUMN IF NOT EXISTS` for the column and
`pg_constraint` for the `CHECK`, since there is no `ADD CONSTRAINT IF NOT EXISTS` — and V7 by
`IF NOT EXISTS` on every object it creates, a `pg_type` guard around its `CREATE TYPE`, and
`ON CONFLICT (name) DO NOTHING` on the `global_properties` rows it seeds, V8 by guarding every
rename on the old name still being there, V9 by `IF NOT EXISTS` on the table and the index it
creates plus a `pg_type` guard around its `CREATE TYPE`, and V10 by `ADD COLUMN IF NOT EXISTS`, a
backfill restricted to the rows that have no value yet, a `SET NOT NULL` that is a no-op on a column
that already has it, `CREATE TABLE IF NOT EXISTS`, and a `pg_constraint` test around the one `CHECK`
it adds to an existing table, V11 by `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`,
and V12 — which inserts rows rather than creating objects — by a `WHERE NOT EXISTS` on each of the
two, so a replay adds neither a second group of the same name nor a second grant of the same scope.

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

### `V9__account_tokens.sql`

Adds `account_tokens` and the `account_token_purpose` enum behind it — the one-time links that let a
викладач or a студент create their own account, and let anybody replace a forgotten password. See
[Self-service registration and password recovery](#self-service-registration-and-password-recovery)
for what the table is and why it is one table rather than two.

It adds one existing-table object besides that, and only one: `users_unique_lower_email`, the unique
index on `lower(email)` described under [Who an account *is*](#who-an-account-is-userslecturer_id--usersstudent_id).
No column is added to `users`, no grant is rewritten, and an account created through a link is
indistinguishable from one an administrator created except that it has never needed
`must_change_password`. A database that migrates and then never has `MAIL_USERNAME` set simply never
issues a link, and everything else works exactly as before.

**That index is the one statement here that can fail on a real database**, and failing is the right
answer: it fails only when two accounts already differ in nothing but the capitalisation of their
e-mail, which means at least one of them cannot sign in today. Flyway then refuses to start the
service, which is how you find out. Decide which of the pair is the real account, move or delete the
other, and start again — the migration's own comment says so at the statement.

Idempotent by `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` (both of them) and a
`pg_type` guard around the `CREATE TYPE` — the same three tools V7 uses, for the same reason: after
`reset_db.sh`, `schema.sql` has already created all of it.

### `V10__degree_program_semesters.sql`

How long a programme runs, and how long each of its semesters runs.

The розклад decides how many classes a week a plan position needs by dividing its hours by
(weeks × class length), and the weeks in that division came from `semester_duration_weeks` — one
number for the whole university. That holds for most of a degree and stops holding at the end of one:
the last semester of a master's programme is largely taken up by the final attestation and a work
placement, so its teaching runs for fewer weeks than sixteen, and planning it as sixteen puts *fewer*
classes a week on the timetable than the plan's hours actually require.

Two things are added. `degree_programs.duration_semesters` says how long the programme is, and
`degree_program_semesters` overrides the weeks for one semester of one programme — one row per
semester that *differs*, since a missing row means «the usual length», which is exactly what the
global property is for. Filling the table in exhaustively would turn one number that can be corrected
in one place into several hundred copies of it that cannot.

**Three steps for one column, because it is `NOT NULL`.** A `NOT NULL` column cannot be added in one
statement to a table that already holds rows, so it arrives nullable, every row is given a value, and
only then is the constraint added:

| Degree | Semesters |
|---|---|
| `BACHELOR`, `PHD`, `DOCTOR_OF_SCIENCE` | 8 |
| `MASTER`, `JUNIOR_BACHELOR` | 4 |

All five are named explicitly rather than left to an `ELSE`, because a row still `NULL` at step three
stops the migration with a constraint violation and nothing says why. Only `BACHELOR` and `MASTER`
appear in the current data — 40 programmes and 32 — and the other three carry the ordinary length for
their degree; a database holding one of them should have it corrected on the programme's own page.
Nothing infers the length from the curriculum, deliberately — a programme whose plan has
only been entered up to the fifth semester is still a four-year programme, and reading the plan would
produce a confidently wrong number for exactly the programmes that are half-entered.

The backfill is `WHERE duration_semesters IS NULL`, so a value somebody has since corrected survives
a replay; `SET NOT NULL` is a no-op on a column that already has it, and the table and its constraint
are guarded the usual way. After `reset_db.sh`, `schema.sql` has already created all of this with the
column non-null from the start, and every step here finds nothing to do.

One consequence outside the migration, since resolved: `data.sql` predated the column, and its
`INSERT INTO degree_programs (id, code, name, degree, faculty_id)` could not satisfy a `NOT NULL`
column with no default. It has been re-dumped from a database this migration had run against, so its
`degree_programs` inserts now name `duration_semesters`.

### `V11__group_invitations.sql`

Adds `group_invitations` — the links that let somebody put themselves into a group instead of being
added to it one account at a time. The table, its unique `token`, the `(group_id, created_at DESC)`
index the listing reads, and the `CHECK` that bounds a link's life to between five minutes and thirty
days. Nothing existing changes: no column is added to `users` or `groups`, and no grant is touched.

After `reset_db.sh`, `schema.sql` has already created the table, its `CHECK` and its index, and
`data.sql` records this migration as applied — so it does not run there at all, and would find
nothing to do if it did.

See [Group invitation links](#group-invitation-links) for why the token is stored as it is and who
may mint one.

### `V12__data_entry_volunteers_group.sql`

Seeds «Волонтери — наповнення даних» and one `FACULTY` grant at `EDIT` per факультет, enumerated
from `faculties` rather than written out — nineteen grants against the university as `data.sql`
records it.

On a database built from the shipped files it inserts **nothing**, and that is not a failure of the
migration: `data.sql` was re-dumped after this ran, so it already carries the group, the nineteen
grants and the `flyway_schema_history` row saying V12 is applied. The migration is for the databases
the dump does not reach — a deployment holding real data, or one seeded from an older dump.

It is a *data* migration, and the only one here that exists to make the product usable on the day it
is installed rather than to carry a schema forward. The system is empty until somebody types the
university into it, that work is done by volunteers over a few weeks, and scoping twenty accounts by
hand is the thing that does not happen. The group is the scope, handed out once — an invitation link,
now — and withdrawn in one act: delete the group and every grant below it goes too
(`permissions.group_id` is `ON DELETE CASCADE`), leaving the accounts themselves intact.

Nineteen faculty grants rather than one `GLOBAL` grant, and the difference is exactly the three
exclusions the job came with — global properties (which need `GLOBAL`, so no number of faculty grants
reaches them), account management (`GLOBAL` at `MANAGE`), and deletion (`FULL`, one level above what
this group holds). What that scoping costs is stated in the migration's own header and worth
repeating here: `Building` and `AcademicDegree` are `@PermissionRoot` and stay out of reach, a
факультет created *after* the migration runs gets no grant, **an аудиторія that names a корпус and no
факультет is not covered either** — 31 of the 75 rooms in `data.sql`, and 12 of the 14 room groups,
which belong to no факультет and no кафедра — and a `ClassStartTimeSet` that names a факультет — «Вечірні заняття (ФПМІ)», the one such row in `data.sql` — is covered like anything else
hanging off that faculty. The two university-wide bell sets are not. If the bells must be untouchable
outright, the way to say so is to leave every set university-wide rather than to weaken these grants.

The rooms are the gap most likely to be noticed first, and it has two answers, both an
administrator's rather than this migration's: give those 31 аудиторії the факультет they in fact
belong to, or add one `BUILDING` grant at `EDIT` per корпус — `Room` hangs off a корпус as well as a
факультет, so that covers every аудиторія in it. The second also brings корпуси and the travel-time
matrix into scope, which is data entry too, and still reaches neither the global properties nor the
accounts.

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
| `DegreeProgram` (освітня програма) | `degree_programs` | code, degree, `duration_semesters` (NOT NULL — how long the programme runs, counted in semesters rather than as the number its last semester carries, since a master's plan may run 9–11); → faculty, groups, curriculum items, semesters |
| `DegreeProgramSemester` | `degree_program_semesters` | how many teaching weeks one semester of one programme runs for, overriding the `semester_duration_weeks` global property. One row per semester that *differs* — a missing row means the usual length, which is what the property is for. `semester` is the number the plan itself uses; unique per (programme, semester); → degree programme |
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
`departments.abbreviation`, `degree_programs(name, degree)`,
`degree_program_semesters(degree_program_id, semester)` (a programme states each of its semesters'
length at most once, so re-stating it is an update rather than a second row), `academic_groups.name`,
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
| `account_token_purpose` | `REGISTRATION`, `PASSWORD_RESET` — what an e-mailed one-time link is for, and which column of an `account_tokens` row therefore names its subject |
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

**What the table holds.** `data.sql` seeds twenty-one rows, in three groups.

| Property | Seeded | What it governs |
|---|---|---|
| `academic_hour_duration_minutes` | 40 | length of one academic hour; every class end time in the client is computed from it |
| `semester_duration_weeks` | 16 | weeks in a semester; the schedule builder divides a workload's hours by it — unless the programme states otherwise for that semester in `degree_program_semesters`, which overrides this number for it (see [`V10`](#v10__degree_program_semesterssql)) |
| `current_semester_parity` | `ODD` | which half-year is running; the default of every semester filter |
| `default_class_duration_hours` | 2 | what a new workload starts at |
| `default_max_hours_per_year` | 600 | annual teaching ceiling for a lecturer who sets none of their own |
| `hours_per_ects_credit` | 30 | hours in one ECTS credit — every curriculum total is built on it |
| `credits_per_academic_year` · `credits_per_year_tolerance` | 60 · 3 | the year's credit target and how far a plan may sit from it |
| `min_credits_*` / `max_credits_*` (`junior_bachelor`, `bachelor`, `master`, `phd`) | 120/120, 180/240, 90/120, 30/60 | the volume a programme of each degree must fall within |
| `min_elective_share_percent` | 25 | least share of a programme that must be elective |
| `max_courses_per_semester` · `max_exams_per_semester` | 8 · 5 | per-semester ceilings a plan is advised against |
| `abstract_room_travel_time_minutes` · `university_commute_time_minutes` | 60 · 80 | the journey to an abstract room that is sited in no building, and the journey between home and the university that a day mixing an online class with an in-room one has to leave room for (see [`V7`](#v7__abstract_rooms_and_online_classessql)) |

The second group — `hours_per_ects_credit` through `max_exams_per_semester` — arrived when the client's
curriculum checks stopped being constants. The reason is worth recording on this side too, because
it constrains what the service may assume: **these figures are not invariants.** Some are statutory
and change when the law does (the elective quota was rewritten by Закон № 3642-IX in 2024); the rest
differ between institutions by design, since the Закон «Про вищу освіту» leaves the form of the
educational process to each institution. A **blank value is meaningful** — it means «не встановлено»,
and the
client drops the check that rests on it — so `updateGlobalProperty` accepts an empty string and must
keep accepting one. These rows now ship in `data.sql` itself; the separate
`global-properties-limits.sql` that once carried them for an older database is gone, superseded by
the Flyway migrations described under [Schema migrations](#migrations-flyway). The third group is the
last two rows, seeded by [`V7`](#v7__abstract_rooms_and_online_classessql) when a class stopped
having to be held in a room: they are the two journeys `building_travel_times` cannot price, because
neither of them has a building at both ends.

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

Like `global_properties`, the six auth tables have no `@GraphQLEntity` domain class — a `User`'s
`password_hash` must never be reachable through the fully-generic, selection-set-driven query
machinery, so `User`/`Group`/`PermissionGrant` are hand-built GraphQL types with hand-written
fetchers instead (see [Authentication & authorization](#authentication--authorization) below).

| Table | Notes |
|---|---|
| `users` | email (unique), first/last name, BCrypt `password_hash`, `must_change_password`, `is_active`, and the optional person link `lecturer_id` / `student_id` — see below |
| `groups` | name (unique), description |
| `user_groups` | `(user_id, group_id)` — a user may belong to any number of groups |
| `permissions` | a single grant: `grantee_type` (`USER`/`GROUP`) + exactly one of `user_id`/`group_id`, `resource_type` + `resource_id` (or `resource_type = 'GLOBAL'` with a `NULL` id for university-wide scope), `level` (`EDIT`/`FULL`/`MANAGE`, with no `DEFAULT` on purpose, so a forgotten column cannot quietly hand out delete rights), `granted_by`, `created_at`, `updated_at`. One row per grantee per exact resource, so re-granting a scope changes `level` in place rather than adding a near-duplicate |
| `group_invitations` | one shareable link into a group: `group_id`, the `token` itself (not a hash — see [Group invitation links](#group-invitation-links)), `expires_at` bounded to 5 minutes … 30 days by a `CHECK`, `join_count`, `created_by`. Deleting the row is how a link is revoked |
| `account_tokens` | one e-mailed link: `purpose` (`REGISTRATION`/`PASSWORD_RESET`), the SHA-256 of the token, the address it went to, exactly one of `lecturer_id`/`student_id`/`user_id` according to the purpose, `expires_at`, `used_at`. See [Self-service registration and password recovery](#self-service-registration-and-password-recovery) |

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

A third unique index, `users_unique_lower_email`, says that an address is one account however it is
capitalised. `email` is already `UNIQUE`, but case-sensitively, while every lookup in the service is
`lower(email) = lower(:email)` — so without it `A.Petrenko@lnu.edu.ua` and `a.petrenko@lnu.edu.ua`
are two rows the column constraint permits and no code path can tell apart: the duplicate check
before a new account sees neither of them, and `login` finds two rows where it expects one. It was
added by [`V9`](#v9__account_tokenssql) because self-service registration is the first
unauthenticated path that could create the second row.

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
| `Room`, `AbstractRoom` | `Faculty`?, `Building`? |
| `RoomTimetableConstraint` | `Room` |
| `RoomGroup` | `Faculty`?, `Department`? |
| `ClassStartTimeSet` | `Faculty`? |
| `ClassStartTime` | `ClassStartTimeSet` |
| `Course` | `Department`?, `Faculty`?, parent `Course`? (elective group → its options) |
| `CourseTag` | `Course` |
| `Lecturer` | `Department` |
| `LecturerWorkloadConstraint`, `LecturerTimetableConstraint` | `Lecturer` |
| `AcademicGroup`, `DegreeProgramSemester` | `DegreeProgram` |
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
| `LecturerWorkloadStudent`, `LecturerWorkloadOnlineClass` | `LecturerWorkload` |
| `TimetableEntry` | `LecturerWorkload`, `Room` |
| `BuildingTravelTime` | `Building` at *either* end (`from_building_id`, `to_building_id`) |
| `Building`, `AcademicDegree` | *(nothing — both declare `@PermissionRoot`; only a `GLOBAL` grant reaches them, at `EDIT` to create or change one and `FULL` to delete it)* |

`LecturerWorkload`'s rooms and room groups are deliberately **not** permission parents: being able
to modify a room, or the list of rooms in a group, must not confer the right to modify every
workload that happens to be allowed to use it. Its `ClassStartTimeSet` is left out for the same
reason.

**An entity that declares nothing at all does not start.** "Nothing is above this" and "the edge was
forgotten" used to be the same state — the absence of an annotation — and they have opposite
consequences: the first is a university-wide object, the second silently drops the entity out of
every faculty's cascade until a deanery reports that they can no longer edit their own rows. Nothing
fails, no test notices, and the symptom arrives as a denial weeks later. `@PermissionRoot` is the
first of the two said out loud, and `EntityMetadataRegistry` now refuses to build metadata for a
`@GraphQLEntity` that declares neither it nor a parent — so the question is answered at startup, by
whoever adds the entity, and `SchemaBuildTest` reaches it without a database. Declaring *both* is
refused just as loudly: a root has no owner and an entity with an owner inherits from it, so the two
together describe nothing the cascade could act on.

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
│                  @PermissionParent(s), @PermissionJoinParent(s),
│                  @PermissionRoot — see below
├── metadata/      EntityMetadataRegistry — scans @GraphQLEntity at startup,
│                  builds EntityMetadata (fields, columns, types, relations,
│                  resourceType, permissionParents, permissionJoinParents,
│                  permissionRoot) and refuses an entity that declares no
│                  permission edge and no root;
│                  PermissionTypeGraph — the same cascade at the level of
│                  resource types, for the questions that name no row
├── config/        GraphQLSchemaConfig + DSL: SchemaDefinition, TypeDefinition,
│                  QueryDefinition, MutationDefinition (create/update/delete,
│                  plus .nestedList(...) and .manyToMany(...) — see below)
├── schema/        DynamicGraphQLSchemaBuilder — builds GraphQLSchema from
│                  metadata + config; DataFetcherProvider; HandWrittenApi +
│                  SchemaTypeRegistry — the plug-in point for the parts of the
│                  API that cannot be generated (see below)
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
org.lnu.timetable.mail       — MailService: the two e-mailed links, over SMTP
```

### The parts that cannot be generated (`HandWrittenApi`)

Almost everything in this schema is reflective: an annotated POJO plus a few declarative lines
produce a type, a connection, three mutations and the SQL behind them. Four areas are not, and
never could be.

- **`GlobalProperty`** is a name/value store, not an entity keyed by an id.
- **Authentication and access** — `login`, `me`, `changePassword`, the user, group and grant
  management — because a password hash must never be reachable through fully-generic,
  selection-set-driven machinery, and because `login` does not fit the id-keyed CRUD shape anyway.
- **Self-service registration and password recovery**, for both of those reasons at once.
- **`accessModel`**, the permission cascade published by resource type, because it is metadata about
  the schema rather than a row in it — there is no table to select from and no id to key it by.

The first two are wired into `DynamicGraphQLSchemaBuilder` by hand, each with a parameter on
`buildSchema` and a `buildXxxTypes()` / `addXxxQueryFields()` / `addXxxMutationFields()` /
`registerXxxFetchers()` quartet named after the area. That is a workable shape for one exception and
a poor one for the third: the builder grows a parameter it can type-check nothing about, and an area
can only be added by editing the framework.

`HandWrittenApi` is that wiring, stated once:

```java
public interface HandWrittenApi {
    default void buildTypes(SchemaTypeRegistry types) {}
    default void addQueryFields(GraphQLObjectType.Builder queryBuilder) {}
    default void addMutationFields(GraphQLObjectType.Builder mutationBuilder) {}
    default void registerFetchers(GraphQLCodeRegistry.Builder codeRegistry) {}
}
```

An implementation is an ordinary `@Component`. `DynamicGraphQlConfiguration` injects every one of
them as `List<HandWrittenApi>` — the same way it already collects `List<GraphQLSchemaConfig>` — and
the builder applies each at the point its own hardcoded areas are applied. A new hand-written area
is a new bean and nothing else. Every method is defaulted, so an area that only adds queries does
not have to say so four times.

Two things it deliberately withholds. `SchemaTypeRegistry` is **write-only** — `object`,
`enumeration`, `input`, and no way to read what anything else declared — so two areas cannot come to
depend on the order they happen to be visited in. And nothing here routes through
`AuthorizingDataFetcherProvider`: a hand-written area states its own rule, which for `login` and for
`requestRegistration` is *none*, and inheriting the generic "must be signed in" would make both
unreachable.

`SelfServiceSchema` and `AccessModelSchema` are the two implementations today, and the second is what
the interface was for: `accessModel` arrived as a `@Component` and a constructor argument, with no
parameter added to `buildSchema` and no edit to the framework at all. `GlobalProperty` and the auth
surface were left where they are: moving working code to prove a point is how a refactor becomes a
regression, and the interface's value is in what is added next, not in what is already correct.

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

The four `*SchemaConfig` classes are the whole API surface — 32 entities, one `configure<Entity>`
method each, split by subject area:

| Config class | Entities declared |
|---|---|
| `OrganizationSchemaConfig` | `Building`, `BuildingTravelTime`, `Faculty`, `Department`, `DegreeProgram`, `DegreeProgramSemester`\*, `Room`, `RoomTimetableConstraint`\*, `RoomGroup`, `AbstractRoom` |
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
  `CourseTag` through `Course.tags`, `DegreeProgramSemester` through `DegreeProgram.semesters`,
  `LecturerWorkloadConstraint` through
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
| `workingCurriculumItemConnection` | `id` | `departmentId`, `facultyId` (r), `semesterParity` (r), `courseId` (r) |
| `combinedWorkingCurriculumItemConnection` | `id` | `facultyId` (r), `departmentIds` (r), `semesterParity` (r) |
| `lecturerWorkloadConnection` | `id` | — |
| `abstractRoomConnection` | `name` | `facultyId`, `buildingId` |
| `classStartTimeSetConnection` | `name` | `facultyId` |
| `classStartTimeConnection` | `ordinal` | `classStartTimeSetId` |
| `timetableEntryConnection` | `dayOfWeek` | `workloadId`, `roomId`, `roomIds` (r), `lecturerIds` (r), `academicGroupIds` (r), `semesterParity` (r) |

Ten entities are missing from this table on purpose, and the omission is the design rather than a
gap: `CourseTag`, `DegreeProgramSemester`, `LecturerWorkloadConstraint`,
`LecturerTimetableConstraint`, `AcademicGroupTimetableConstraint`, `RoomTimetableConstraint`,
`LecturerWorkloadStudent` and
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

There are two ways an account comes into being, and both start from somebody the institution has
already entered. An administrator creates one (`createUser`) with a temporary password, and the
account is forced to change it (`must_change_password = TRUE`) before it can do anything else. Or a
викладач or a студент whose own row carries an e-mail address creates their own, by following a link
sent to that address — see [Self-service registration and password
recovery](#self-service-registration-and-password-recovery). What there is no way to do is register
as somebody the university has never heard of: the second road checks `lecturers` and then
`students` for the address before it will send anything at all. Authentication is a stateless JWT (`io.jsonwebtoken`/jjwt) carrying only the user
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
   through the generic, selection-set-driven machinery. The six self-service fields
   (`requestRegistration`, `completeRegistration`, `requestPasswordReset`, `resetPassword` and the
   two link-inspection queries) bypass it for the same reason and by a later route: they arrive
   through the framework's [`HandWrittenApi`](#the-parts-that-cannot-be-generated-handwrittenapi)
   plug-in point rather than from inside this class. Every one of them is reachable by an
   unauthenticated caller by design — somebody with no account, or one they cannot open, is exactly
   who they are for.

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

`org.lnu.timetable.security` is twenty-four classes, and it is worth knowing which of them decides what:

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
| `PermissionRepository` | everything else the auth tables need: users, groups, memberships, grants — including `grantsOfGroup`, the one read `GroupAdminPolicy` decides on |
| `GroupAdminPolicy` | the one rule for who may administer a group — an administrator, or `MANAGE` over **every** resource that group holds a grant on. Shared by the membership mutations and the invitation links, because putting an account into a group and minting a link into it are the same act through different doors. See [Group invitation links](#group-invitation-links) |
| `AuthDataFetchers` | the twenty-odd hand-written fetchers behind `login`, `me`, `changePassword`, `users`, `groups`, `searchUsers`, `accessLevels`, `grantsForResource`, the grant mutations, the membership mutations (gated by `GroupAdminPolicy` rather than by «is this an admin» since invitation links arrived) and `setUserLink` (with `linkErrorStatus`, the one place in the service that tells a `CHECK` from a foreign key by reading the `SQLSTATE`) |
| `AccountTokenPurpose` | enum — the two things an e-mailed one-time link can be (`REGISTRATION`, `PASSWORD_RESET`), mirroring the `account_token_purpose` PostgreSQL enum the way `AccessLevel` mirrors `access_level` |
| `AccountTokenRepository` | the SQL behind those links — issuing, the per-address cooldown, invalidating what was outstanding, redeeming — plus the two person lookups (`findLecturerByEmail`, `findStudentByEmail`) that decide whether a link may be sent at all. The one place in this package that reads a *domain* table by anything other than a declared permission edge |
| `SelfServiceDataFetchers` | the six fetchers behind registration and recovery, and the four-question rule in [Self-service registration and password recovery](#self-service-registration-and-password-recovery) |
| `SelfServiceSchema` | their GraphQL surface, added through the framework's `HandWrittenApi` plug-in point rather than hardcoded into the schema builder |
| `GroupInvitationRepository` | the SQL behind `group_invitations`. Writes `expires_at` as `now() + make_interval(mins => :ttl)` so that both sides of the table's lifetime `CHECK` come from one clock |
| `GroupInvitationDataFetchers` | the six fetchers behind the invitation links, and the one place that decides what redeeming one is worth: a single `user_groups` row, never an account and never a grant |
| `GroupInvitationSchema` | their GraphQL surface, a `HandWrittenApi` like `SelfServiceSchema` |
| `AccessModelSchema` | one query, `accessModel`: the permission cascade by resource type, so the client can decide what to draw from the graph this service enforces rather than from a copy of it. A `HandWrittenApi` for the same reason `SelfServiceSchema` is one — it is not a row keyed by an id — and it answers from `PermissionTypeGraph`, which is built once at startup |
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
| `creatableResourceTypes()` | which *kinds* of thing the caller could create somewhere — a question with no row in it, answered from the grants already loaded and `PermissionTypeGraph`, so it costs neither a query nor a walk |

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

### Self-service registration and password recovery

An account is created by an administrator, or by the person it belongs to. The second road is what
this section is about, and the rule that makes it safe is narrow enough to state in one sentence:
**a person the institution has already entered may claim the account that belongs to them, and
nobody else may create one at all.**

`requestRegistration` asks four questions of one address, in this order, and each of the four
answers is a different thing to tell the person who typed it:

| The address belongs to | Answer | What the client does with it |
|---|---|---|
| an existing account | `ALREADY_REGISTERED` | says so, and offers to send a password-recovery link to the same address instead — one button, already knowing the address |
| a `Lecturer` | `LINK_SENT` (`role: LECTURER`) | «перевірте пошту» |
| failing that, a `Student` | `LINK_SENT` (`role: STUDENT`) | the same |
| nobody | `NOT_ELIGIBLE` | says self-registration is not open for this address, and who to ask |

Викладачі are consulted before студенти because that is how an ambiguous address should resolve: a
person who is both a doctoral студент and an assistant викладач exists, and the account they need is
the one that opens their навантаження. A fifth answer, `PERSON_ALREADY_LINKED`, covers the case the
address alone cannot see — a викладач who was given an account under a personal address and has
since had a university one added to their row. `users_unique_lecturer` would refuse the second
account anyway; checking here means the answer is a sentence rather than an integrity violation
thirty minutes later.

`requestPasswordReset` is the same shape with one question: does an account have this address.

**The links.** 32 bytes from `SecureRandom`, base64url, in a path segment
(`/register/<token>`, `/reset-password/<token>` — base64url contains no dot, which is what keeps
`FrontendController`'s `[^.]*` patterns serving them). Only the SHA-256 is stored, in
`account_tokens`, for the same reason `users.password_hash` is a hash: a link is a bearer credential
for thirty minutes, and a dump of that table must not be a set of working ones. SHA-256 rather than
BCrypt, deliberately — a lookup key has to be computed from the input rather than compared against
every row, and what makes this one unguessable is that it is 256 bits of `SecureRandom`, not that
the hash is expensive.

Four rules keep a link from being worth more than one use:

- **A delivered link supersedes what was outstanding.** Ask twice and the first e-mail's link stops
  working, so the newest message is always the live one and nobody has to work out which of two is
  current. It *expires* the older ones rather than marking them used, and the difference is what the
  reader is told: `used_at` means «ви вже це зробили» — go and sign in — which is a lie to somebody
  who never redeemed anything and has no password to sign in with. And it happens **after** the new
  message has actually been sent, because retiring the old link first would mean an SMTP failure
  left the person with no working link at all. A send that fails deletes the row it just wrote, so
  nothing changed: the old link still works and the cooldown has not started.
- **Redeeming is a conditional `UPDATE`** — `SET used_at = now() WHERE id = :id AND used_at IS NULL`,
  read back through `rowsUpdated()`. Two tabs submitting the same link both reach it; exactly one
  gets 1 back, and the loser is told «посилання вже використано» rather than colliding on a unique
  index. It is done *before* the account is created for exactly that reason — and *after* the
  password has been hashed, so that BCrypt refusing an over-long input costs a message rather than
  the link.
- **A cooldown of `app.security.account-token-cooldown-seconds`** (60) per address and purpose,
  which bounds what one inbox can be sent.
- **A cap of `app.security.account-token-max-per-minute`** (20) over every address at once, which
  bounds what the mailbox as a whole can be made to send. The two limits have different victims: a
  script walking a list of five thousand published university addresses trips the first not once,
  and the damage is to the sending mailbox's reputation rather than to any one recipient. Both
  refusals answer `TOO_MANY_REQUESTS`, since from outside they are the same "not now" and saying
  which would only tell an attacker what they hit.

**What the account gets.** Its name, from the викладач or студент row — read at redemption rather
than copied onto the token when it was issued, since the thirty minutes in between are long enough
for a кафедра to correct a misspelt surname. Its person link, set by construction rather than by an
administrator's later `setUserLink`. `must_change_password = FALSE`, because the password was
chosen by the person who will use it, over TLS, thirty seconds ago — forcing them to replace a
secret only they have ever seen would be theatre. And a JWT in the mutation's response, so they are
signed in on the screen where they chose it.

**What it does not get: any permission at all.** Reads are open to every authenticated caller, so a
newly registered викладач immediately sees «Мій кабінет», their навантаження and their розклад —
which is the whole of what a self-registered account is for. Every write still needs a grant
somebody holding `MANAGE` chose to make.

**The mail.** `org.lnu.timetable.mail.MailService`, over SMTP, configured for
`smtp.office365.com:587` with STARTTLS. The mailbox is a credential and is therefore in neither
properties file: `MAIL_USERNAME` and `MAIL_PASSWORD` are read from the environment with empty
defaults, so a service started without them starts normally and answers `MAIL_FAILED` on the first
attempt to send rather than refusing to boot. On a host configured by
[`scripts/deploy/install-service.sh`](../scripts/deploy/README.md#outgoing-mail) they are
`--mail-username` / `--mail-password`, alongside `--base-url` for the address the links point at. `JavaMailSender` is blocking and everything else here
is not, so each send runs on `Schedulers.boundedElastic()`. Two things Microsoft's side decides and
neither is visible from this repository: **SMTP AUTH is disabled per mailbox by default** and has to
be enabled for `timetable@lnu.edu.ua` explicitly, and a mailbox with multi-factor authentication
cannot use its own password here at all — it needs an app password. The links themselves are built
from `app.base-url`, which is `http://localhost:4200` in the `loc` profile (where the client runs on
its own port) and `http://localhost:8080` otherwise: **set it to the public address before deploying
anywhere real, or every link in every inbox points at the reader's own machine.**

**Not hidden.** A public sign-up form normally answers every address with the same "check your
inbox", so that the form cannot be used to test whether an address is registered. That is the wrong
trade here, and the reasoning is in *Known limitations* along with what it costs.

### Group invitation links

Membership is how access travels here: a grant may name a group, and «Деканат ФПМіІ» holds `MANAGE`
on its факультет, so putting an account into a group is the act that lets that account do anything at
all. That act was an administrator's, one account at a time, through two text boxes on «Користувачі та
права» into which the numeric id of a user and the numeric id of a group were typed. It is the right
shape for handing somebody a кафедра and the wrong one for the weeks the university's data is
entered, when the most accounts exist and the fewest of them belong to anyone an administrator knows
by id.

Two changes, and the second is only the first said in public.

**Membership is no longer administrator-only.** `addUserToGroup` and `removeUserFromGroup` are
governed by `GroupAdminPolicy`: an administrator, **or** somebody holding `MANAGE` over *every*
resource the group holds a grant on. That is delegation's own rule — you may hand out only what you
hold — applied to the act that actually hands access out. Both halves are load-bearing: *every*
rather than *any*, because a group granted both `FACULTY` #1 and `DEPARTMENT` #7 is worth both and
the head of that one кафедра must not be able to mint faculty-wide access through the side door of
membership; and a group with **no grants at all** is an administrator's alone, because "every" over
an empty set is vacuously true and an empty group is one grant away from being a powerful one.
`createGroup` stays administrator-only — a group that does not exist yet holds no grants to measure
anybody against.

**An invitation is that same act, delegated to the person joining.** A link into one group, good for
between five minutes and thirty days, shared however its holder likes, listed and deletable on the
group's own page. Redeeming one inserts a single `user_groups` row for the account already signed in
and does nothing else: it creates no account, makes no grant, and confers no right to invite anybody
further. A visitor who has no account is sent to `/login` — self-service registration stays what it
was, open only to a викладач or a студент the institution has already entered.

**The token is stored as it is, and `account_tokens` stores only a SHA-256.** The difference is what
the two are for. A registration link goes to one address and is spent once, so nobody ever needs to
read it back, and hashing costs nothing. An invitation is shared with a room full of people over
days, and whoever made it has to be able to open «Посилання-запрошення» a week later and paste the
same link into a second chat — which a hash cannot answer. Hashing here would mean either «shown
once, then never again» or a new link per re-share, and both make the list a worse answer to the
question the list exists for.

So `group_invitations` holds live bearer credentials, and that is bounded rather than denied. Every
row expires, and no row may outlive thirty days (a `CHECK`, not only a validated argument — a client
that forgets to check its own form must not be able to write a link that outlives the term). Every
row can be deleted the moment it has done its work, which is the whole of revocation: there is no
disabled state, because a link that should stop working should stop existing. The token is reachable
through exactly one query, which refuses anybody who may not administer the group. And what redeeming
one is worth is membership of one group — never an account, never a grant.

One thing the lifetime bound taught: `expires_at` is written as `now() + make_interval(mins => :ttl)`
rather than from the JVM's clock. The `CHECK` compares it against `created_at`, which defaults to the
database's `now()`, so computing one side in Java means comparing two clocks — and a request for the
maximum thirty days fails with an integrity violation nobody can reproduce whenever the two machines
disagree by a millisecond.

### GraphQL API

| Field | Kind | Notes |
|---|---|---|
| `login(email, password)` | mutation | returns a JWT + whether the account must change its password |
| `me` | query | the signed-in `CurrentUser` (profile, `isAdmin` — which is exactly `GLOBAL` at `MANAGE` — `lecturerId`/`studentId`, groups, and every effective grant with its `level`), or `null`. Also `globalLevel` and `creatableResourceTypes` — see below |
| `changePassword(currentPassword, newPassword)` | mutation | minimum 8 characters; clears `mustChangePassword` |
| `createUser(email, firstName, lastName, temporaryPassword, lecturerId?, studentId?)` | mutation | **admin-only**; the created account must change its password on first login. The two optional ids link it to a person straight away — at most one of them, or `BOTH_LINKS_SET` |
| `setUserLink(userId, lecturerId?, studentId?)` | mutation | **admin-only**; says which lecturer or student an account belongs to. Both omitted clears the link; both given fails `BOTH_LINKS_SET`; a person another account already claims fails `ALREADY_LINKED`; an id naming nobody fails `INVALID_LINK` |
| `setUserActive(userId, active)` | mutation | **admin-only**; deactivates/reactivates an account |
| `users` | query | **admin-only**; all accounts |
| `createGroup(name, description)` | mutation | **admin-only**. A new group holds no grants, so there is nobody but an administrator for `GroupAdminPolicy` to measure |
| `addUserToGroup`/`removeUserFromGroup` | mutation | needs `MANAGE` over **every** resource the group holds a grant on, or administrator access — see [Group invitation links](#group-invitation-links). No longer admin-only |
| `manageableGroups` | query | the groups this caller may administer — every group for an administrator, and for anybody else the ones the rule above admits. `groups` stays open to every signed-in caller, because naming a group is not administering it |
| `groupInvitations(groupId)` | query | every invitation of one group, newest first, **tokens included**. Refused with `FORBIDDEN` unless the caller may administer that group |
| `groupInvitation(token)` | query | inspects a link without redeeming it: `GroupInvitationCheck { isValid, status, groupId, groupName, isMember }`, `status` being `VALID`, `NOT_FOUND` or `EXPIRED`. Signed-in callers only — an invitation joins an *account* to a group |
| `createGroupInvitation(groupId, ttlMinutes)` | mutation | mints a link. `ttlMinutes` is 5 … 43 200 (thirty days), checked here and again by the table. Refusals: `INVALID_TTL`, `GROUP_NOT_FOUND`, and `FORBIDDEN` as a GraphQL error |
| `deleteGroupInvitation(invitationId)` | mutation | revokes a link by deleting it. Membership already gained through it is untouched — revoking an invitation is not revoking access, which is what `revokePermission` is for. Refusals: `NOT_FOUND`, and `FORBIDDEN` as a GraphQL error |
| `joinGroupByInvitation(token)` | mutation | redeems a link: one `user_groups` row for the signed-in account, and `join_count + 1`. `ALREADY_MEMBER` is read off the insert (`ON CONFLICT DO NOTHING` updating no rows) rather than asked first, so two tabs cannot count one member twice. Refusals: `INVALID_TOKEN`, `EXPIRED_TOKEN`, `ALREADY_MEMBER` |
| `groups` | query | any authenticated user |
| `grantPermission(granteeType, userId\|groupId, resourceType, resourceId, level)` | mutation | needs `MANAGE` on the resource; `resourceId` is omitted only for `GLOBAL`. Re-granting an existing scope moves its level and answers `isSuccess: true` with `errorStatus: UPDATED`. Refusals: `FORBIDDEN` (no `MANAGE` there, or no access at all), `LEVEL_ABOVE_OWN`, `INVALID_GRANTEE` (neither or both of user/group, or an id naming nobody), `UNKNOWN_RESOURCE_TYPE`, `UNKNOWN_ACCESS_LEVEL` |
| `revokePermission(permissionId)` | mutation | needs `MANAGE` from a **strict ancestor** of the grant's resource, or that the caller made it (`granted_by`) — that second branch is checked first and needs no level at all. Refusals: `FORBIDDEN`, `PERMISSION_NOT_FOUND` |
| `accessLevels(resourceType, resourceIds)` | query | `[ResourceAccess!]!` — `{ id, level }` per reachable id, which is what the frontend uses to decide which buttons to show. Ids the caller cannot reach are omitted rather than returned with a null level. Replaces `canModifyResources`, whose yes/no answer could not say whether the Delete button next to Edit belonged there |
| `accessModel` | query | `[ResourceTypeAccess!]!` — the permission cascade by entity type: each type's foreign-key parents (with the input field naming each), its join-table parents, and whether it is a `@PermissionRoot`. Derived from the annotations at startup, so it is constant for the lifetime of the service and a client fetches it once. What lets the frontend answer "could this account create one of these" and "which of the values I am about to send names a scope" without keeping its own copy of the hierarchy |
| `grantsForResource(resourceType, resourceId, includeInherited)` | query | who can reach a resource and at what level; needs `MANAGE` on it. `includeInherited` defaults to true, adding grants held on ancestors and university-wide grants, each marked `inherited: true` — "who can edit this кафедра" is answered wrongly by a list that omits the deanery above it. Ordered direct-first, then strongest level first within each group |
| `requestRegistration(email)` | mutation | **unauthenticated**. Asks for a registration link. `LINK_SENT` (with `role`), `ALREADY_REGISTERED`, `PERSON_ALREADY_LINKED`, `NOT_ELIGIBLE`, `TOO_MANY_REQUESTS`, `MAIL_FAILED` — see above |
| `requestPasswordReset(email)` | mutation | **unauthenticated**. `LINK_SENT`, `UNKNOWN_EMAIL`, `ACCOUNT_DISABLED`, `TOO_MANY_REQUESTS`, `MAIL_FAILED` |
| `registrationLink(token)` / `passwordResetLink(token)` | query | **unauthenticated**. Inspects a link without spending it: `AccountLinkCheck { isValid, status, email, firstName, lastName, role }`, `status` being `VALID`, `NOT_FOUND`, `EXPIRED` (past its thirty minutes, or replaced by a newer link), `USED` or `UNAVAILABLE` (the link is good, but the account has since been deactivated or came into being some other way). What lets the page say «термін дії посилання минув» on arrival rather than after a password has been typed, and what keeps a form that cannot succeed off the screen |
| `completeRegistration(token, password)` | mutation | **unauthenticated**. Creates the account, links it to the person the link named, and returns a JWT. Refusals: `INVALID_TOKEN`, `EXPIRED_TOKEN`, `USED_TOKEN`, `WEAK_PASSWORD` (under 8 characters, or over the 72 bytes BCrypt hashes), `ALREADY_REGISTERED`, `PERSON_ALREADY_LINKED` |
| `resetPassword(token, password)` | mutation | **unauthenticated**. Sets the new password, clears `must_change_password`, returns a JWT. Refusals: the same minus the last two, plus `ACCOUNT_DISABLED` |
| `searchUsers(query, limit)` | query | finds active accounts by e-mail or name (either order), case-insensitive substring, for the grantee picker. Needs `MANAGE` somewhere — university-wide or on any one resource — and returns identity only, never the person link. A query under two characters returns `[]` rather than an error; `limit` defaults to 20 and is clamped to 1..50. The full `users` listing stays admin-only: a deanery needs to find the person they are handing a кафедра to, not to enumerate the university's staff |

Two GraphQL types carry the model: the enum `AccessLevel { EDIT, FULL, MANAGE }` — an enum rather
than a string so a client cannot invent a fourth value and so introspection carries what each one
means — and `ResourceAccess { id, level }`. `PermissionGrant` gained `level: AccessLevel!` and
`inherited: Boolean`, the latter set only by `grantsForResource` and only as a display hint: an
inherited grant is shown as context and cannot be revoked from there.

#### Publishing what a caller could do, and where

`accessLevels` answers "may I edit *this* row", which is the right question next to a row and the
wrong one before a screen exists. A client also has to decide whether to draw «+ Додати» at all, and
whether a page of nothing but editors is worth offering — and neither has a row to ask about. That
gap is why the frontend used to guess: it showed «+ Додати» to anyone holding a grant *anywhere*, so
a викладач whose grant was one кафедра was offered «+ Додати корпус» and refused by this service the
moment they pressed it.

Two fields on `CurrentUser` and one query close it, and all three are derived from the annotations
already declared on the domain classes rather than from anything new:

| Field | Answers |
|---|---|
| `CurrentUser.globalLevel` | this account's university-wide level, or null. The client used to scan `permissions` for `resource_type = 'GLOBAL'` itself |
| `CurrentUser.creatableResourceTypes` | the entity types it could create something of **somewhere** — `PermissionEvaluator#creatableResourceTypes`, over grants already loaded for the request, so `me` costs what it did |
| `Query.accessModel` | the cascade by type, from `PermissionTypeGraph` |

`creatableResourceTypes` is a type-level answer on purpose: "possible somewhere", not "possible
here". It is what decides whether a control or a whole screen is worth drawing, and it is never what
decides whether a write is accepted — that is still `AuthorizingDataFetcherProvider`, against the
row. Reading it as permission would be a mistake in the safe direction (a shown button, a refused
mutation) rather than in the dangerous one, but it is worth stating which of the two questions it is
answering.

One consequence of the upsert worth knowing before it surprises somebody: `DO UPDATE` also sets
`granted_by` to whoever re-granted. Since revocation keys on `granted_by`, re-levelling somebody
else's grant transfers the right to revoke it from the original granter to you.

All admin-only fields fail with a `GraphQlAuthException` for non-admins; unauthenticated calls to
anything except `login` and the six self-service fields above fail the same way with "You must be signed in to do this." Both arrive as a
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

Self-service registration adds four more, all in `application.properties`:
`app.security.account-token-ttl-minutes` (30), `app.security.account-token-cooldown-seconds` (60),
the `spring.mail.*` SMTP block, and `app.base-url`. The mailbox itself is not there — `MAIL_USERNAME`
and `MAIL_PASSWORD` come from the environment — and `app.base-url` is the one of the four that is
wrong by default for a deployment: override it, or the links point at the reader's own machine.

`data.sql` seeds three groups («Деканат ФПМіІ», «Завідувачі кафедр», «Волонтери — наповнення даних»)
and exactly one account:

| Email | Password | Role |
|---|---|---|
| `admin@lnu.edu.ua` | `Admin#2026` | `GLOBAL` at `MANAGE` — the administrator grant — and no forced password change |

Everything else about the auth tables is left for that administrator to create: there is no seeded
example of a forced password change, and none of an account linked to a lecturer or a student.
`account_tokens` and `group_invitations` are seeded empty too, and stay empty until somebody asks for
a link.

All three groups are seeded **empty**, which is what keeps the twenty-one grants in `permissions`
from being anybody's access yet: the administrator's `GLOBAL` at `MANAGE`, «Деканат ФПМіІ»'s
`FACULTY` grant at `MANAGE`, and the nineteen `FACULTY` grants at `EDIT` that «Волонтери — наповнення
даних» holds. Adding one user to the first is enough to hand out faculty-wide access; adding one to
the third is enough to put somebody to work entering data. Both are one act now — a link from the
group's own page, or a search on it — rather than an administrator typing two ids.

The third group is «Волонтери — наповнення даних» — the scope the people entering the university's
data work in, and nothing above it. It reaches the dump by way of
[`V12`](#v12__data_entry_volunteers_groupsql), which is also where what that scoping deliberately
does and does not reach is written down.

Exercising the person link therefore takes two steps on «Користувачі та права»: create the account,
then point it at a lecturer or a student (`setUserLink`). Nothing in `data.sql` does it for you —
though self-service registration now does, for the accounts that arrive that way, since a link is
issued to a person and the account it creates is linked to them by construction.

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

1. Create the annotated POJO in `org.lnu.timetable.domain`, and say who owns it: a
   `@PermissionParent`/`@PermissionJoinParent` for each way a grant should cascade into it, or
   `@PermissionRoot` if it genuinely belongs to the university rather than to anything. This is not
   optional — an entity declaring neither fails startup, because the two used to be indistinguishable
   and one of them is a bug nothing reports (see [Permission cascade
   annotations](#permission-cascade-annotations-on-domain-entities)).
2. Add its table to `src/main/resources/db/schema.sql` (and seed rows to `data.sql`).
3. Add a `type` + queries + mutations block in the relevant `*SchemaConfig` (or a new one,
   registered as a `@Component` implementing `GraphQLSchemaConfig` — all of them are picked
   up automatically via `List<GraphQLSchemaConfig>` injection).
4. Restart — the schema, SQL handlers, relation batch loaders, the authorization cascade and the
   `accessModel` the frontend reads it from are all regenerated automatically. Nothing in the client
   needs editing for its permission handling to be correct about the new entity.

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
│   ├── framework/    the config-driven engine, plus HandWrittenApi — the plug-in point
│   │                 for the parts of the API it cannot generate (see The framework above)
│   ├── security/     JWT + AccessLevel/PermissionEvaluator, and the one-time links behind
│   │                 self-service registration (see Authentication & authorization)
│   ├── mail/         MailService — those links, over SMTP; the only place this service
│   │                 sends mail from
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
- **Self-service registration says which of four things is true of an address, and that is a
  deliberate disclosure.** `requestRegistration` answers `ALREADY_REGISTERED`, `LINK_SENT` or
  `NOT_ELIGIBLE`, so anybody may test whether a given address has an account or belongs to a
  викладач or студент here. A public sign-up form would answer all three with the same "check your
  inbox". Two things make that the wrong trade for this system: the population is closed and already
  published — a person's university address is on their кафедра's own web page — so there is nothing
  to learn that is not already on the web, and the three answers are not interchangeable, since an
  address that will never work has to say so or its owner waits for an e-mail that is not coming and
  concludes the system is broken. The cost is real: it is an enumeration oracle, and a *free* one —
  the two rate limits count links actually issued, so the three answers that send no e-mail are
  unlimited, and a script can read back which of a list of addresses has an account and which
  belongs to a викладач rather than a студент as fast as it can ask. A closed institutional
  deployment behind a university network is the setting this was judged in; a public one should
  reconsider it, and would want a per-caller limit on the question as well as on the sending.
- **Redeeming a link is two statements, not one transaction.** `markUsed` and the `INSERT` into
  `users` (or the `UPDATE` of a password) are separate round trips, and only a
  `DataIntegrityViolationException` is recovered — so a connection dropped between them leaves the
  link spent, no account created, and a generic «не вдалося завершити дію» on screen, with the
  60-second cooldown blocking an immediate retry. The two reachable causes of a failure *between*
  them have been moved out of the way (the password is hashed and length-checked before the link is
  spent, and the length bound is BCrypt's own 72 bytes), so what is left is the database itself
  failing mid-request. Wrapping the pair in a `TransactionalOperator` is the fix, and is worth doing
  the next time this code is opened.
- **Spent and expired `account_tokens` rows are never deleted.** A used link is kept so that a second
  click can say «посилання вже використано» instead of «посилання недійсне», which is the difference
  between "you have already done this" and "somebody sent you something broken" — but nothing ever
  prunes them, so the table grows by one row per link ever issued. At institutional volumes that is
  tens of rows a term and will not matter for years; a `DELETE FROM account_tokens WHERE created_at
  < now() - INTERVAL '30 days'` on a schedule is the whole of the fix when it does.
- **The mailbox has to be one Microsoft still lets authenticate with a password.** SMTP AUTH is
  disabled per mailbox by default on Office 365 and has to be enabled for `timetable@lnu.edu.ua`
  explicitly, and a mailbox with multi-factor authentication cannot use its own password at all —
  it needs an app password. Neither is visible from this repository, and the symptom of getting it
  wrong is a `MAIL_FAILED` with an authentication failure in the log. Moving to the Microsoft Graph
  API with client credentials would remove the dependency entirely, at the cost of an Azure app
  registration; `spring.mail.host`/`port` being ordinary properties is the cheap escape in the
  meantime — a departmental relay works with no code change.
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
  `RELATED_NOT_FOUND`; `room_groups_scope_check`, `class_start_time_sets_default_scope_check`,
  `courses_semester_check` (a `semester` of `0` or less on a discipline) and the two length rules
  V10 added — `degree_programs_duration_semesters_check`, and the `semester` / `duration_weeks`
  checks a `degree_program_semesters` row passes through as part of its programme's `semesters`
  list — behave the same way. In
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
