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

Alongside it: JWT sign-in with entity-scoped, cascading permissions; and a printable
[**«Розрахунок навчального навантаження»**](./timetable-ui/WORKLOAD-PDF.md) sheet, rendered to PDF
entirely in the browser.

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

Sign in with one of the seeded accounts:

| Email | Password | Role |
|---|---|---|
| `admin@lnu.edu.ua` | `Admin#2026` | full administrator |
| `dean.fpmi@lnu.edu.ua` | `Temp#12345` | faculty-scoped; must change password on first login |
| `o.melnyk@lnu.edu.ua` | `Temp#12345` | department-scoped; must change password on first login |

There is no sign-up screen anywhere: accounts are created by an administrator, by design.

---

## Documentation

| Document | What it covers |
|---|---|
| [`timetable/README.md`](./timetable/README.md) | the domain model and every table, the config-driven entity framework (no controllers, services, repositories or `.gqls` files), the generated GraphQL surface and its query catalogue, N+1-safe relation batching, authentication and the permission cascade |
| [`timetable-ui/README.md`](./timetable-ui/README.md) | the two UI architectures that coexist, every page and child-list widget, the reusable form controls, the pure modules that hold the logic, Ukrainian sorting and collation, and the permission-aware UI |
| [`timetable-ui/WORKLOAD-GENERATION.md`](./timetable-ui/WORKLOAD-GENERATION.md) | assigning lecturers to working curriculum items: constraint semantics, the three passes, complexity, a worked example, and what is and isn't guaranteed |
| [`timetable-ui/TIMETABLE-GENERATION.md`](./timetable-ui/TIMETABLE-GENERATION.md) | the UCTP solver: objective function, data structures, per-phase pseudocode, every parameter, a traced example, complexity, and the code map |
| [`timetable-ui/WORKLOAD-PDF.md`](./timetable-ui/WORKLOAD-PDF.md) | the printable workload sheet — what each part of the document answers to in Ukrainian practice, and the ДСТУ 4163:2020 layout rules |
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

**The client holds the algorithms.** Both generators, all the workload arithmetic, the PDF engine
and the Ukrainian collator are hand-written modules in `timetable-ui/src/app`, free of Angular,
GraphQL and I/O, so each can be run and tested on plain objects. The timetable solver additionally
runs in a Web Worker, because it is a search with a time budget rather than a computation.

**The contract between them is the generated schema**, and the service README's *The query
catalogue* is worth reading before adding a query — several connections carry `EXISTS`-subquery
filters (`facultyId`, `semesterParity`, `roomIds`, …) precisely so the client never has to fetch the
whole university and narrow it down in the browser.

---

## Repository layout

```
lnu-timetable/
├── timetable/            the GraphQL service
│   ├── src/main/java/org/lnu/timetable/
│   │   ├── config/       the four schema-config classes — the whole API definition
│   │   ├── domain/       annotated POJOs, one per table
│   │   ├── framework/    the config-driven engine (metadata → schema → SQL)
│   │   └── security/     JWT + the entity-scoped permission model
│   ├── src/main/resources/db/
│   │   ├── schema.sql    DDL — starts with DROP SCHEMA public CASCADE
│   │   └── data.sql      the real LNU structure plus the ФПМІ 2025/2026 timetable
│   └── scripts/          reset/backup helpers, and the lnu.edu.ua import pipeline
└── timetable-ui/         the Angular client
    ├── src/app/          pages, child-list widgets, form controls, and the pure modules
    ├── src/styles.css    every style in the app is global and lives here
    └── public/fonts/     Liberation Serif subsets, fetched on demand by the PDF export
```

---

## Status

Local-development quality, and deliberately so in a few places the sub-READMEs each spell out under
*Known limitations*: `schema.sql`/`data.sql` are applied by hand rather than by a migration tool, the
checked-in JWT secret and database password are dev-only values, the CORS filter allows any origin,
and the client has no automated tests. Read those sections before deploying any of this anywhere
real.
