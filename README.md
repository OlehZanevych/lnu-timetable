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

1. **Structure** — buildings, faculties, departments, degree programmes, rooms, academic and
   combined groups, lecturers, students.
2. **Curricula** — a `CurriculumItem` per (course, degree programme, semester), its hours split by
   kind (lecture / practical / lab / consultation / …), and the *working* curriculum items that say
   which department delivers each block of hours, to which groups, in what teaching format.
3. **Lecturer workloads** — who actually teaches each working curriculum item, how long a class runs,
   on which grid of bells, and in which rooms it may be held. This can be
   [**generated automatically**](./timetable-ui/WORKLOAD-GENERATION.md) from a pool of scored
   candidates, subject to per-lecturer ceilings on annual hours and distinct courses.
4. **The timetable** — a day, a start time, a room and (for biweekly classes) a week parity for every
   class session those workloads require. This too can be
   [**generated automatically**](./timetable-ui/TIMETABLE-GENERATION.md), respecting the scheduling
   constraints of lecturers, groups and rooms, and scheduling *around* the classes other faculties
   have already placed in the same rooms and with the same people.

Two of those stages are entered from more than one direction, because the shape of the data and the
shape of the work do not always agree.

**Where a class may be held** is stored on the workload (stage 3), but it is decided at faculty
level: rooms belong to a faculty, and the timetable that has to fit in them is built for a whole
faculty at once. So it has a screen of its own — «Призначення аудиторій» — a board of one card per
class, tinted red when nothing has been assigned. Naming no room is legal and schedules perfectly
well; it is almost never what anyone *decided*, and until that board existed nobody found out until a
lecture for 120 students had been placed in a 12-seat lab.

**A discipline can be corrected from its own page.** `/course/:id` walks the whole chain — curriculum
items, working curriculum items, workloads, room assignment, timetable entries — and edits every
level in place, so fixing one discipline no longer means visiting a degree programme page, then a
department page, then a faculty page in turn. An `ELECTIVE_GROUP` also manages its electives there.

**Not every semester is the same length.** A degree programme now says how many semesters it runs
for, and «Тривалість семестрів» on its page says how many teaching weeks any one of them lasts where
that differs from the one number the whole university otherwise uses — the last semester of a
master's programme, mostly, where the final attestation and a work placement take up the rest. Those
figures are recorded but not yet read by the arithmetic that decides how many classes a week a plan
position needs: see [«Тривалість
семестрів»](./timetable-ui/README.md#semester-lengths-degreeprogramsemesterlist-тривалість-семестрів).

Alongside it: JWT sign-in with entity-scoped, cascading permissions, at three ordered levels — edit,
full (which adds deletion) and manage (which adds the right to hand the same access to somebody
else, so a deanery delegates a кафедра itself rather than queuing behind an administrator), with the
client hiding what a given account cannot use — down to whole pages and tabs — from the same cascade
the service enforces, published rather than copied;
**invitation links into a group** — membership is how access travels here, so putting an account
into a group is the act that hands it whatever that group can reach; a link does that act once for
however many people follow it, lives between five minutes and thirty days, and is revoked by
deleting it, while who may mint one is the delegation rule read again («MANAGE over everything the
group can reach»), which is also what took group membership off the administrator's desk;
**self-service accounts** for the people already in the system — a викладач or a студент whose row
carries an e-mail address creates their own account by following a link sent to it, valid thirty
minutes, and anybody who has forgotten a password replaces it the same way, while an address
belonging to nobody the institution has entered is told plainly that self-registration is not open
to it;
**«Мій кабінет»**, where an account linked to a викладач or a студент reads its own навантаження or
навчальний план and its own розклад, defaulting to the half-year that is running; and four printable
forms —
the [**«Навчальний план»**](./timetable-ui/CURRICULUM-PDF.md) of a degree programme, the
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
pick up a schema change on a database you do not mind losing — see the service README's *Known
limitations* for why that step is manual.

A database you *do* mind losing is carried forward by **Flyway** instead: the migrations in
`timetable/src/main/resources/db/migration` run at startup, in order, once each. There is no
separate command — starting the service is what applies them, and it refuses to start if one fails.
See the service README's [Migrations](./timetable/README.md#migrations-flyway) for what each one
does and for the one dependency whose absence makes the whole mechanism silently do nothing.

Everything *after* that first load is **Flyway's**. `db/migration/V*.sql` runs at startup, against a
database the two files above have already created, so a deployment holding real data is carried
forward instead of being rebuilt: see the service README's [Migrations
(Flyway)](./timetable/README.md#migrations-flyway).

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

That is the **only** seeded account, so the first thing a fresh database needs is for that
administrator to create the accounts the institution actually wants, scope them with permission
grants at the level each job actually needs, and (for a lecturer or a student) point them at the
person they belong to. The three seeded groups survive with no members, «Деканат ФПМіІ» still holding
its `FACULTY` grant, ready to be populated.

The third of them is «Волонтери — наповнення даних», which reaches `data.sql` by way of
[`V12`](./timetable/README.md#v12__data_entry_volunteers_groupsql): one `FACULTY` grant at `EDIT` per
факультет, which is the scope the people who type the university in work in — every кафедра, освітня
програма, discipline, навчальний план, викладач, аудиторія, навантаження and розклад, and none of the
global properties, the university-wide bell schedules or the accounts. Filling it is what the
invitation links are for: open the group, make a link, share it once.

A викладач or a студент need not wait for any of that: if their own row carries an e-mail address
they register themselves at `/register`, and the account that results is linked to them by
construction. That needs a mailbox to send from — set `MAIL_USERNAME` and `MAIL_PASSWORD` in the
environment before starting the service:

```bash
MAIL_USERNAME=timetable@lnu.edu.ua MAIL_PASSWORD='…' mvn spring-boot:run
```

Without them the service starts normally and reports «не вдалося надіслати листа» on the first
attempt, rather than telling somebody to check an inbox nothing was sent to. What the links inside
those messages point at is `app.base-url` — `http://localhost:4200` under the `loc` profile, where
the client runs on its own port. See the service README's [Self-service registration and password
recovery](./timetable/README.md#self-service-registration-and-password-recovery).

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
    --app.security.jwt-secret=<a fresh secret of at least 32 bytes> \
    --app.base-url=https://timetable.lnu.edu.ua
```

That one property is the whole switch between the two things `/` can be — the Apollo Sandbox
redirect a developer wants, or the Angular client a deployment wants. `IndexController` and
`FrontendController` are each conditional on it and are never both registered; see the service
README's [Serving the frontend from this
service](./timetable/README.md#serving-the-frontend-from-this-service).

`app.base-url` is the one property whose *default* is wrong for a deployment rather than merely
dev-flavoured: it is what the registration and password-recovery links in outgoing e-mail are built
from, so leaving it at `localhost` puts a link to the reader's own machine in the reader's inbox.
The mailbox those messages are sent from is not a property at all — `MAIL_USERNAME` and
`MAIL_PASSWORD` are read from the environment, and are the two credentials this service needs
besides the database and the JWT secret.

Two more things worth knowing before deploying this anywhere real. Adding
`--spring.profiles.active=` drops `application-loc.properties` altogether, so nothing at all is
inherited from the local profile — otherwise its DEBUG SQL logging (which logs every statement and
every bound parameter, including the ones behind `login`) stays on. And a command line is readable
through `ps`, so prefer the environment-variable forms — `SPRING_R2DBC_PASSWORD`,
`APP_SECURITY_JWTSECRET` — for anything you would not commit.

The schema is still not created on startup: run `schema.sql` and `data.sql` against the target
database once first.

### Keeping it running

Doing the above by hand on every deployment — pull, build, kill the old process, start a new one
with its credentials on the command line — is what [`scripts/deploy/`](./scripts/deploy/README.md)
automates, in one command:

```bash
sudo scripts/deploy/install-service.sh
```

That installs a systemd unit which keeps the jar running and starts it again after a reboot, and a
cron job which checks the tracked branch every ten minutes and rebuilds, redeploys and restarts when
it moves — putting the previous jar back if the new one will not come up. It also supplies
`--spring.profiles.active=` and passes the credentials as environment variables rather than
arguments, which are the two things in this section that are easiest to forget. The mailbox and the
public address go in the same way, as `--mail-username`, `--mail-password` and `--base-url`, so that
self-service registration works from the first start rather than after an edit to a file in `/etc`.

---

## Documentation

| Document | What it covers |
|---|---|
| [`timetable/README.md`](./timetable/README.md) | the domain model and every table, the config-driven entity framework (no controllers, services, repositories or `.gqls` files) and the `HandWrittenApi` plug-in point for the parts of it that cannot be generated, the generated GraphQL surface and its query catalogue, N+1-safe relation batching, the Flyway migrations that carry a database forward, authentication, self-service registration and password recovery, group invitation links and the one rule that governs a group's membership, the levelled permission model — how it is evaluated, how it is published to the client, and why an entity that declares no owner does not start — and the person link that says who an account is |
| [`timetable-ui/README.md`](./timetable-ui/README.md) | the two UI architectures that coexist, every page and child-list widget, the tab of a drill-down page in the URL, editing and deleting from a drill-down page and the links that lead between them, «Мій кабінет», the registration and password-recovery screens, the group pages and the screen an invitation link opens, the travel-time matrix, how every value reaches the service as a GraphQL variable, the reusable form controls, the pure modules that hold the logic, Ukrainian sorting and collation, and the permission-aware UI — which button each level opens, which screens and tabs hide themselves entirely, and the «Немає доступу» card that answers a link to one of them |
| [`timetable-ui/WORKLOAD-GENERATION.md`](./timetable-ui/WORKLOAD-GENERATION.md) | assigning lecturers to working curriculum items: constraint semantics, the three passes, complexity, a worked example, and what is and isn't guaranteed |
| [`timetable-ui/scripts/workload-bench/README.md`](./timetable-ui/scripts/workload-bench/README.md) | the benchmark behind that algorithm — 48 synthetic department instances, how they are sized from the statutory 600-hour ceiling, every metric defined, and the before-and-after of the optimisation |
| [`timetable-ui/TIMETABLE-GENERATION.md`](./timetable-ui/TIMETABLE-GENERATION.md) | the UCTP solver: objective function, data structures, per-phase pseudocode, every parameter, the worker portfolio, a traced example, complexity, and the code map |
| [`timetable-ui/SOLVER-OPTIMISATION.md`](./timetable-ui/SOLVER-OPTIMISATION.md) | the study that produced the current solver — what was wrong with the old search, what replaced it, how it scales, and the seven mechanisms that were built and rejected on measurement |
| [`timetable-ui/scripts/timetable-bench/README.md`](./timetable-ui/scripts/timetable-bench/README.md) | the benchmark behind the solver — why the instances are built backwards around a hidden feasible schedule, the independent scorer, and how to re-run the whole study |
| [`timetable-ui/CURRICULUM-PDF.md`](./timetable-ui/CURRICULUM-PDF.md) | the printable curriculum — which of its parts are required by the Закон України «Про вищу освіту» and which are settled practice, the compliance checks it carries, and what the data model cannot yet fill in |
| [`timetable-ui/WORKING-CURRICULUM-PDF.md`](./timetable-ui/WORKING-CURRICULUM-PDF.md) | the printable working curriculum — why it has no legal footing at all since 1993, what institutional practice actually puts in one, and how department teaching hours are projected from it |
| [`timetable-ui/WORKLOAD-PDF.md`](./timetable-ui/WORKLOAD-PDF.md) | the printable workload sheet — what each part of the document answers to in Ukrainian practice, and the ДСТУ 4163:2020 layout rules |
| [`timetable-ui/TIMETABLE-PDF.md`](./timetable-ui/TIMETABLE-PDF.md) | the printable class timetable in its five cuts — why no law mentions it at all, why no sanitary regulation applies to higher education, why only the faculty sheet is approved, and the grid-versus-list layout rule |
| [`timetable/scripts/lnu_import/README.md`](./timetable/scripts/lnu_import/README.md) | the two-stage pipeline that scraped the real LNU structure into `data.sql`, and how to re-run it |
| [`scripts/deploy/README.md`](./scripts/deploy/README.md) | running the jar as a service on a Linux host — the systemd unit and why it replaced a pidfile and a polling health check, the job that tracks a branch and rebuilds when it moves, why the deployed jar is a copy and what that buys when a build fails, and what a deployment deliberately does not inherit from the development profile |

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
runs in Web Workers — several at once on different seeds, best answer wins — because it is a search
with a time budget rather than a computation.

That the algorithms are free of the framework is not a stylistic preference — it is what lets them be
*measured*. `timetable-ui/scripts/workload-bench` runs the shipped workload generator, unmodified,
under Node across 48 generated department instances and re-checks every plan it produces against the
database's own constraint semantics. The one time that harness was pointed at the code it found a
quadratic in the search and a class of constraint breach nobody had noticed.
`timetable-ui/scripts/timetable-bench` now does the same for the timetable solver, on instances built
around a hidden feasible schedule so that a perfect answer is known to exist; pointing it at the code
found that the search was reaching a local optimum in its first iteration and never moving again.

**The contract between them is the generated schema**, and the service README's *The query
catalogue* is worth reading before adding a query — several connections carry `EXISTS`-subquery
filters (`facultyId`, `semesterParity`, `roomIds`, …) precisely so the client never has to fetch the
whole university and narrow it down in the browser.

---

## Repository layout

```
lnu-timetable/
├── run/                  exists only on a deployment host: the deployed jar, the one kept
│                         to roll back to, and the update log (git-ignored)
├── scripts/              build-ui.sh (Angular → the service's static resources) and
│   │                     build-app.sh (that, then the deployable jar)
│   └── deploy/           running that jar as a service: the systemd unit, the branch-
│                         tracking update job, and the installer that sets both up
├── timetable/            the GraphQL service
│   ├── src/main/java/org/lnu/timetable/
│   │   ├── config/       the four schema-config classes — the whole API definition
│   │   ├── controller/   IndexController / FrontendController — the two owners of "/"
│   │   ├── domain/       annotated POJOs, one per table
│   │   ├── framework/    the config-driven engine (metadata → schema → SQL)
│   │   ├── mail/         MailService — the two e-mailed one-time links, over SMTP
│   │   └── security/     JWT, the entity-scoped levelled permission model, and
│   │                     self-service registration / password recovery
│   ├── src/main/resources/
│   │   ├── application.properties      what is the same in every environment
│   │   ├── application-loc.properties  what is not: credentials, JWT secret, SQL
│   │   │                               logging, and the "/" toggle
│   │   ├── static/       the built client, put here by scripts/build-ui.sh (git-ignored)
│   │   └── db/
│   │       ├── schema.sql   DDL — starts with DROP SCHEMA public CASCADE
│   │       ├── data.sql     the real LNU structure plus the ФПМІ 2025/2026 timetable
│   │       └── migration/   Flyway migrations, applied at startup to a database
│   │                        schema.sql has already created
│   └── scripts/          reset/backup helpers, and the lnu.edu.ua import pipeline
└── timetable-ui/         the Angular client
    ├── src/app/          pages, child-list widgets, form controls, and the pure modules
    ├── src/styles.css    every style in the app is global and lives here
    ├── public/fonts/     Liberation Serif subsets, fetched on demand by the PDF export
    └── scripts/
        ├── check-graphql-variables.mjs  npm run lint:graphql — the one check that needs
        │                                neither a service nor a browser
        ├── workload-bench/  the benchmark for the workload generator: two Node scripts,
        │                    48 generated department instances, and the measured
        │                    before-and-after — see its own README
        └── timetable-bench/ the benchmark for the timetable solver: instances built
                             backwards around a hidden feasible schedule, an independent
                             scorer, and the study behind SOLVER-OPTIMISATION.md
```

---

## Status

Local-development quality, and deliberately so in a few places the sub-READMEs each spell out under
*Known limitations*: `schema.sql`/`data.sql` are still applied by hand (Flyway carries a database
forward from there but does not create it), the
JWT secret and database password checked into `application-loc.properties` are dev-only values and
that profile is active inside the packaged jar too, the CORS filter allows any origin, and the
client has no automated tests. Read those sections — and *Running it as a single jar* above, for
what to override — before deploying any of this anywhere real.
On a host configured by `scripts/deploy/install-service.sh` one of them is answered: the service
runs with that profile dropped and its own credentials, and the installer refuses a JWT secret that
is the checked-in one. The rest still stand — it does not create the database and it does not touch
the CORS filter.

---

## License

[**PolyForm Noncommercial License 1.0.0**](./LICENSE.md) — copyright © 2026 Oleh Zanevych.

Any noncommercial purpose is a permitted purpose, which is most of what this repository
exists for: personal study, research, experiment and testing, and use by an educational
institution, a public research organization or a government institution, whatever the
source of its funding. So a university may run it, a student may read it and build on it,
and a dissertation may cite it. Pass the licence on with any part of it you pass on.

Anything commercial — selling it, running it as a paid service, or using it in the course
of a business — is **not** granted here and needs a separate licence from me first:
<oleh.zanevych@gmail.com>.

Third-party components keep their own terms: the Liberation Serif subsets under
`timetable-ui/public/fonts/` are under the SIL Open Font License 1.1, and every npm and
Maven dependency is licensed by its own author.
