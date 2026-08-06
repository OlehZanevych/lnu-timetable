# LNU Timetable

A system for building the course timetable of a faculty of **Ivan Franko National University of
Lviv** — from the curriculum, through each department's lecturer workloads, to the weekly schedule
itself.

It is two projects in one repository, talking to each other over GraphQL:

| | | |
|---|---|---|
| [**`timetable/`**](./timetable/README.md) | the service | Spring Boot 4 · Java 25 · WebFlux · Spring for GraphQL · R2DBC / PostgreSQL |
| [**`timetable-ui/`**](./timetable-ui/README.md) | the web client | Angular 21 · standalone components · signals · zoneless |

Each has a README of its own, and each is worth reading before touching that half — they are the
design documents, not just setup notes. **Start with [`timetable/README.md`](./timetable/README.md)**
if you are here for the data model or the API, and with
[`timetable-ui/README.md`](./timetable-ui/README.md) if you are here for the screens or the
algorithms.

---

## What the system does

The work it supports runs in one direction, and each stage is the input to the next:

1. **Structure** — buildings, faculties, departments, specialties, rooms, academic and combined
   groups, lecturers, students.
2. **Curricula** — a `CurriculumItem` per (course, specialty, semester), its hours split by kind
   (lecture / practical / lab / consultation / …), and the *working* curriculum items that say which
   department delivers each block of hours, to which groups, in what teaching format.
3. **Lecturer workloads** — who actually teaches each working curriculum item, how long a class runs,
   on which grid of bells, and in which rooms it may be held. This can be
   [**generated automatically**](./timetable-ui/WORKLOAD-GENERATION.md) from a pool of scored
   candidates, subject to per-lecturer ceilings on annual hours and distinct courses.
4. **The timetable** — a day, a start time, a room and (for biweekly classes) a week parity for every
   class session those workloads require. This too can be
   [**generated automatically**](./timetable-ui/TIMETABLE-GENERATION.md), respecting the scheduling
   constraints of lecturers, groups and rooms, and scheduling *around* the classes other faculties
   have already placed in the same rooms and with the same people.

Alongside it: JWT sign-in with entity-scoped, cascading permissions; **«Мій кабінет»**, where an
account linked to a викладач or a студент reads its own навантаження or навчальний план and its own
розклад, defaulting to the half-year that is running; and four printable forms —
the [**«Навчальний план»**](./timetable-ui/CURRICULUM-PDF.md) of a specialty, the
[**«Робочий навчальний план»**](./timetable-ui/WORKING-CURRICULUM-PDF.md) of one of its academic
years, the [**«Розрахунок навчального навантаження»**](./timetable-ui/WORKLOAD-PDF.md) of a
lecturer, and the [**«Розклад занять»**](./timetable-ui/TIMETABLE-PDF.md) of a faculty, a
department, a lecturer, a room or an academic group — all rendered to PDF entirely in the browser, the first two also
checking the plan against the volume, credit and elective-share limits — every one of them a
`global_properties` row an administrator edits, not a constant, because the statutory figures change
with the law and the rest differ between institutions by design.

Only one of those four is an approved document. The faculty timetable carries the «ЗАТВЕРДЖУЮ»
approval block and a block of signatures; the department, lecturer, room and academic-group sheets
are the same data cut a different way, print «Довідковий документ. Затвердженню не підлягає», and point back at the
faculty sheet — because an approval block on a sheet nobody approves is a claim, not a decoration.

---

## Quick start

You need **PostgreSQL** (v15+, built with ICU), **JDK 25**, **Maven**, and **Node 20+**.

```bash
# 1. database
createdb -h localhost -U postgres lnu-timetable
psql -h localhost -U postgres -d lnu-timetable -f timetable/src/main/resources/db/schema.sql
psql -h localhost -U postgres -d lnu-timetable -f timetable/src/main/resources/db/data.sql

# 2. service  → http://localhost:8080/graphiql
cd timetable
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home mvn spring-boot:run

# 3. client   → http://localhost:4200
cd ../timetable-ui
npm install
npm start
```

`npm start` proxies `/graphql` to `http://localhost:8080`, so the service has to be up first.
`timetable/scripts/reset_db.sh` re-applies both SQL files in one command, which is the usual way to
pick up a schema change — see the service README's *Known limitations* for why that step is manual.
Two files beside them apply one change each *without* dropping the database, for a deployment that
already holds data: `global-properties-limits.sql` (the curriculum limits) and
`users-person-link.sql` (the `users.lecturer_id` / `users.student_id` columns).

Everything environment-specific lives in one file,
[`timetable/src/main/resources/application-loc.properties`](./timetable/src/main/resources/application-loc.properties):
the database credentials, the JWT signing key, the R2DBC SQL logging, and the toggle that decides
what `/` serves. It is checked in with working local values and activated by
`spring.profiles.active=loc` in `application.properties`, so a fresh clone runs as-is — change the
two `spring.r2dbc.*` lines if your PostgreSQL disagrees. The three helper scripts under
`timetable/scripts/` read the same file, so the credentials are stated once and cannot drift.

Sign in with one of the seeded accounts:

| Email | Password | Role |
|---|---|---|
| `admin@lnu.edu.ua` | `Admin#2026` | full administrator |

That is the **only** seeded account. There is no sign-up screen anywhere — every other account is
created from «Користувачі та права», by design — so the first thing a fresh database needs is for
that administrator to create the accounts the institution actually wants, scope them with permission
grants, and (for a lecturer or a student) point them at the person they belong to. The two seeded
groups survive with no members, «Деканат ФПМіІ» still holding its `FACULTY` grant, ready to be
populated.

---

## Running it as a single jar

The two halves also ship as one artifact. `scripts/build-app.sh` builds the Angular client, copies
the bundle into the service's `src/main/resources/static/`, and packages the Spring Boot jar around
it — the result serves the GraphQL API on `/graphql` and the client on everything else, from one
process needing nothing but a JRE 25 and a reachable PostgreSQL.

```bash
scripts/build-ui.sh     # build timetable-ui → timetable/src/main/resources/static/
scripts/build-app.sh    # the above, then mvn clean package
```

`build-app.sh` calls `build-ui.sh` itself, so it is normally the only one you run; `--skip-ui`
packages whatever is already in `static/`, `--skip-tests` skips `SchemaBuildTest`. It refuses to
report success unless `BOOT-INF/classes/static/index.html` really is inside the jar, so a frontend
that silently failed to build cannot be mistaken for one that shipped.

Run the result:

```bash
java -jar timetable/target/timetable-0.0.1-SNAPSHOT.jar \
    --spring.r2dbc.username=postgres \
    --spring.r2dbc.password=postgres47 \
    --app.security.jwt-secret=vFhvq86LU85HrhoVaf7i4P5GErwPZnAIe3rFF5c8-Ch0jmzce3DRwHMIn_pi3pjL
```

That starts the API with its credentials given explicitly rather than inherited. Note what it does
*not* do: **`/` still redirects to Apollo Studio Sandbox**, because `application-loc.properties`
travels inside the jar and sets `app.apollo-sandbox.enabled=true`. One more flag serves the client
there instead:

```bash
java -jar timetable/target/timetable-0.0.1-SNAPSHOT.jar \
    --app.apollo-sandbox.enabled=false \
    --spring.r2dbc.url=r2dbc:postgresql://HOST:5432/lnu-timetable \
    --spring.r2dbc.username=USER \
    --spring.r2dbc.password=PASSWORD \
    --app.security.jwt-secret=<a fresh secret of at least 32 bytes>
```

That one property is the whole switch between the two things `/` can be — the Apollo Sandbox
redirect a developer wants, or the Angular client a deployment wants. `IndexController` and
`FrontendController` are each conditional on it and are never both registered; see the service
README's [Serving the frontend from this
service](./timetable/README.md#serving-the-frontend-from-this-service).

Two more things worth knowing before deploying this anywhere real. Adding
`--spring.profiles.active=` drops `application-loc.properties` altogether, so nothing at all is
inherited from the local profile — otherwise its DEBUG SQL logging (which logs every statement and
every bound parameter, including the ones behind `login`) stays on. And a command line is readable
through `ps`, so prefer the environment-variable forms — `SPRING_R2DBC_PASSWORD`,
`APP_SECURITY_JWTSECRET` — for anything you would not commit.

The schema is still not created on startup: run `schema.sql` and `data.sql` against the target
database once first.

---

## Documentation

| Document | What it covers |
|---|---|
| [`timetable/README.md`](./timetable/README.md) | the domain model and every table, the config-driven entity framework (no controllers, services, repositories or `.gqls` files), the generated GraphQL surface and its query catalogue, N+1-safe relation batching, authentication, the permission cascade, and the person link that says who an account is |
| [`timetable-ui/README.md`](./timetable-ui/README.md) | the two UI architectures that coexist, every page and child-list widget, editing and deleting from a drill-down page and the links that lead between them, «Мій кабінет», the reusable form controls, the pure modules that hold the logic, Ukrainian sorting and collation, and the permission-aware UI |
| [`timetable-ui/WORKLOAD-GENERATION.md`](./timetable-ui/WORKLOAD-GENERATION.md) | assigning lecturers to working curriculum items: constraint semantics, the three passes, complexity, a worked example, and what is and isn't guaranteed |
| [`timetable-ui/scripts/workload-bench/README.md`](./timetable-ui/scripts/workload-bench/README.md) | the benchmark behind that algorithm — 48 synthetic department instances, how they are sized from the statutory 600-hour ceiling, every metric defined, and the before-and-after of the optimisation |
| [`timetable-ui/TIMETABLE-GENERATION.md`](./timetable-ui/TIMETABLE-GENERATION.md) | the UCTP solver: objective function, data structures, per-phase pseudocode, every parameter, a traced example, complexity, and the code map |
| [`timetable-ui/CURRICULUM-PDF.md`](./timetable-ui/CURRICULUM-PDF.md) | the printable curriculum — which of its parts are required by the Закон України «Про вищу освіту» and which are settled practice, the compliance checks it carries, and what the data model cannot yet fill in |
| [`timetable-ui/WORKING-CURRICULUM-PDF.md`](./timetable-ui/WORKING-CURRICULUM-PDF.md) | the printable working curriculum — why it has no legal footing at all since 1993, what institutional practice actually puts in one, and how department teaching hours are projected from it |
| [`timetable-ui/WORKLOAD-PDF.md`](./timetable-ui/WORKLOAD-PDF.md) | the printable workload sheet — what each part of the document answers to in Ukrainian practice, and the ДСТУ 4163:2020 layout rules |
| [`timetable-ui/TIMETABLE-PDF.md`](./timetable-ui/TIMETABLE-PDF.md) | the printable class timetable in its five cuts — why no law mentions it at all, why no sanitary regulation applies to higher education, why only the faculty sheet is approved, and the grid-versus-list layout rule |
| [`timetable/scripts/lnu_import/README.md`](./timetable/scripts/lnu_import/README.md) | the two-stage pipeline that scraped the real LNU structure into `data.sql`, and how to re-run it |

---

## How the two halves divide the work

Worth knowing before looking for something in the wrong project.

**The service stores and serves; it decides very little.** It generates its whole GraphQL schema at
startup from annotated entities plus a few declarative lines per entity, and translates each
selection set into SQL that reads only the requested columns. What it does *not* contain is any
scheduling or workload logic: it has no scheduler, and it does not validate a `TimetableEntry`
against the rules that govern it. Its guarantees are structural — foreign keys, value ranges,
uniqueness, cascades — plus authorization.

**The client holds the algorithms.** Both generators, all the workload arithmetic, the curriculum
arithmetic and its statutory checks, the PDF engine and the Ukrainian collator are hand-written
modules in `timetable-ui/src/app`, free of Angular, GraphQL and I/O, so each can be run and tested
on plain objects. The timetable solver additionally
runs in a Web Worker, because it is a search with a time budget rather than a computation.

That the algorithms are free of the framework is not a stylistic preference — it is what lets them be
*measured*. `timetable-ui/scripts/workload-bench` runs the shipped workload generator, unmodified,
under Node across 48 generated department instances and re-checks every plan it produces against the
database's own constraint semantics. The one time that harness was pointed at the code it found a
quadratic in the search and a class of constraint breach nobody had noticed; the same approach is
open to the timetable solver, which has no equivalent yet.

**The contract between them is the generated schema**, and the service README's *The query
catalogue* is worth reading before adding a query — several connections carry `EXISTS`-subquery
filters (`facultyId`, `semesterParity`, `roomIds`, …) precisely so the client never has to fetch the
whole university and narrow it down in the browser.

---

## Repository layout

```
lnu-timetable/
├── scripts/              build-ui.sh (Angular → the service's static resources) and
│                         build-app.sh (that, then the deployable jar)
├── timetable/            the GraphQL service
│   ├── src/main/java/org/lnu/timetable/
│   │   ├── config/       the four schema-config classes — the whole API definition
│   │   ├── controller/   IndexController / FrontendController — the two owners of "/"
│   │   ├── domain/       annotated POJOs, one per table
│   │   ├── framework/    the config-driven engine (metadata → schema → SQL)
│   │   └── security/     JWT + the entity-scoped permission model
│   ├── src/main/resources/
│   │   ├── application.properties      what is the same in every environment
│   │   ├── application-loc.properties  what is not: credentials, JWT secret, SQL
│   │   │                               logging, and the "/" toggle
│   │   ├── static/       the built client, put here by scripts/build-ui.sh (git-ignored)
│   │   └── db/
│   │       ├── schema.sql   DDL — starts with DROP SCHEMA public CASCADE
│   │       ├── data.sql     the real LNU structure plus the ФПМІ 2025/2026 timetable
│   │       ├── global-properties-limits.sql
│   │       │                the curriculum limits alone, ON CONFLICT DO NOTHING —
│   │       │                for a database seeded before they existed
│   │       └── users-person-link.sql
│   │                        the users.lecturer_id / users.student_id columns alone,
│   │                        as ALTER TABLE — same purpose, same re-runnability
│   └── scripts/          reset/backup helpers, and the lnu.edu.ua import pipeline
└── timetable-ui/         the Angular client
    ├── src/app/          pages, child-list widgets, form controls, and the pure modules
    ├── src/styles.css    every style in the app is global and lives here
    ├── public/fonts/     Liberation Serif subsets, fetched on demand by the PDF export
    └── scripts/
        └── workload-bench/  the benchmark for the workload generator: two Node scripts,
                             48 generated department instances, and the measured
                             before-and-after — see its own README
```

---

## Status

Local-development quality, and deliberately so in a few places the sub-READMEs each spell out under
*Known limitations*: `schema.sql`/`data.sql` are applied by hand rather than by a migration tool, the
JWT secret and database password checked into `application-loc.properties` are dev-only values and
that profile is active inside the packaged jar too, the CORS filter allows any origin, and the
client has no automated tests. Read those sections — and *Running it as a single jar* above, for
what to override — before deploying any of this anywhere real.
