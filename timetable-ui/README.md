# Timetable UI

An **Angular 21** front-end for the [Timetable GraphQL Service](../timetable). It lets deanery
staff enter all the data needed to generate a university course timetable, and displays the
resulting schedule as a weekly grid. Styled after
[lnu.edu.ua](https://lnu.edu.ua/structure/faculties/) (navy + gold, serif headings).

- Angular 21 (standalone components, **signals**, **zoneless** change detection, new `@if`/`@for`/`@switch` control flow)
- Automatic lecturer-workload generation runs **in the browser** — see
  [WORKLOAD-GENERATION.md](./WORKLOAD-GENERATION.md) for the algorithm in full
- Automatic **timetable** generation runs in the browser too, in a portfolio of Web Workers — a UCTP
  solver built on the objective function of *"Adaptive Memetic Algorithm for University Course
  Timetabling"*; see [TIMETABLE-GENERATION.md](./TIMETABLE-GENERATION.md)
- Talks to the service over plain GraphQL-over-HTTP (`GraphqlService`, no Apollo Client dependency)
- JWT sign-in with forced password change on first login, and permission-aware UI that hides
  edit/delete/create controls a user isn't allowed to use — see [Authentication](#authentication)

---

## Requirements

- Node.js 20+ (developed on Node 24, npm 11.6.1)
- The GraphQL service running on `http://localhost:8080` (see `../timetable`)

---

## Run

```bash
npm install        # first time only
npm start          # ng serve on http://localhost:4200
```

`npm start` proxies `/graphql` → `http://localhost:8080` (`src/proxy.conf.json`), so the
backend must be running. Then open **http://localhost:4200**.

```bash
npm run build          # production build into dist/
npm run lint:graphql   # every GraphQL argument is a variable — see below
```

`lint:graphql` is the one check this project can run without a service, a browser or a test runner.
It reads the TypeScript AST of every file in `src/app`, finds the string and template literals that
are GraphQL documents, and fails on a value written into one — an interpolated id, a hard-coded
`limit`, or a `GqlVars` header read before the arguments it is supposed to describe. See [Every
value travels as a variable](#every-value-travels-as-a-variable-graphqlservicets) for the rule it
enforces and why.

It also checks something the rule above does not cover: that every argument *name* is one the
service actually declares, listed in the script's `ARG_TYPES`. That check exists because a document
can satisfy every other rule and still be rejected on arrival. `GqlVars.ref` renames a variable
whose name is taken but whose value differs — a second `limit` on one document becomes `$limit2` —
and reaching for `v.arg('timeLimit', …)` to get that separation renames the *argument* instead,
emitting `timeLimit: $timeLimit`. It is a variable, it is declared, nothing is interpolated; only
the server disagrees, with `Unknown field argument 'timeLimit'`. Both spellings are checked — the
literal one written into a document, and the `v.arg(…)` call that produces it at runtime, which is
the one that has to be read from the call site because the offending text never appears in the
source. To rename only the variable, use `v.ref('<the real argument name>', …)` and write the
argument name yourself.

And one rule more, for the other half of the same mistake: **every variable a document reads must be
declared by its operation**. A document can name the right argument, bind it to a variable, and pass
that variable's value in the map, and still be rejected — because the operation header never heard
of it. That is checked only where the header is fully literal; one assembled from `v.declaration()`
is by construction the list of whatever was asked for.

Two exemptions keep it honest. An entity's create/update payload argument is named after the entity
(`faculty:`, `buildingTravelTime:`, `timetableEntry:`) and so cannot be listed in advance — those
are recognised instead by the variable they bind to, whose declared type ends in `InputPayload`,
collected per file because a document assembled from parts keeps its declarations in a different
template literal from the field that uses them. And the scan is `src/app` itself, non-recursively,
`.ts` only: a subdirectory added later would go unchecked.

The workload generator has a benchmark of its own, which needs neither the service nor a browser —
it runs the shipped TypeScript under Node:

```bash
npm run bench:generate     # rebuild the 48 test instances (deterministic)
npm run bench              # measure, write scripts/workload-bench/results/
npm run bench:check-data   # verify the committed instances match a fresh build
```

See [Measuring the workload generator](#measuring-the-workload-generator-scriptsworkload-bench).

### Served from the service

`npm run build` is also the first half of the deployment path. `scripts/build-ui.sh` in the
repository root runs it and copies `dist/timetable-ui/browser/` into the service's
`src/main/resources/static/`, and `scripts/build-app.sh` then packages both halves into one Spring
Boot jar — so the whole system deploys as a single artifact.

Nothing in this project changes between the two modes. `GraphqlService` posts to the relative path
`/graphql`, so being served from the same origin as the API needs no configuration at all;
`src/proxy.conf.json` exists only because `ng serve` runs on a port of its own. Deep links keep
working because the service answers any dotless path with `index.html` — that rule, and the one
limit it carries, is written up in the [service
README](../timetable/README.md#serving-the-frontend-from-this-service).

---

## Two architectures, side by side

The app has grown two different UI patterns over time, and both are still in active use for
different purposes:

1. **Generic, config-driven CRUD tables** — one metadata file (`entities.ts`) describes every
   entity; a shared `BaseEntity` directive + `entity-page.html` template render a table +
   modal create/edit form for it. Adding an entity here is a metadata edit, not new markup.
2. **Dedicated hierarchical drill-down pages** — hand-written components with their own
   GraphQL queries/mutations for the main "browse the university" flow: faculties → buildings
   → departments → degree programmes → academic groups, each with an information page and
   purpose-built child-list widgets (e.g. curriculum items with nested hour blocks, working
   curriculum items with faculty/department/group pickers).

Both talk to the same backend through the same `GraphqlService`; which one a given screen uses
just depends on whether it needed a bespoke layout.

> **The app is zoneless** (Angular 21's default — there is no `zone.js` dependency and no
> `provideZonelessChangeDetection()` call needed). Change detection is driven by signal reads and
> by template event bindings, *not* by monkey-patched async APIs. In practice that means a
> component holding editable state in a plain mutable object may not re-render when that object is
> mutated. Widgets whose state is a flat form bound with `[(ngModel)]` are fine, because the
> control-value-accessor's own event binding marks the view dirty; anything holding a *tree* of
> editable rows should make each editable value its own `WritableSignal` and replace arrays
> immutably. `CurriculumEditor` is the worked example of that pattern.
>
> The same rule bites in `computed()`, and more quietly: a computed only re-runs when a **signal**
> it read changes, so reading a plain field inside one memoises that field's first value forever,
> with no error and no warning. "Оцінка навантаження" showed one lecturer's figures no matter who
> was picked for exactly this reason — the selection was a plain `string`. If a value is read
> inside `computed()`, it has to be a signal.

```
src/app/
├── entities.ts               # metadata for the generic CRUD tables: fields, FK refs, options
├── graphql.service.ts        # tiny GraphQL-over-HTTP client (POST /graphql, query + variables),
│                             #   and GqlVars for the documents assembled at runtime
├── base-entity.ts            # BaseEntity: shared list/create/update/delete + option loading,
│                             #   now also gated by accessById/canEdit/canDelete (see Authentication)
├── entity-page.html          # shared table + modal-form template for the generic pages
├── entity-pages.ts           # thin components extending BaseEntity, one per entity, → /:single
├── search-select.ts          # SearchSelect: select2-like searchable single-value dropdown
├── multi-select.ts           # MultiSelect: checkbox-list dropdown for many-to-many fields
├── time-select.ts            # TimeSelect: hour + minute dropdown pair bound to one "HH:mm" string
├── dept-faculty-select.ts    # DeptFacultySelect: faculty-filtered department picker
├── sort.ts                   # compareUk(): the one Ukrainian-alphabet string comparator
├── course-label.ts           # courseLabel(): a discipline's name with its courses.semester and
│                             #   course_tags in parentheses — one rule, every screen, no sheet
├── auth.service.ts           # AuthService: session state (JWT, CurrentUser), login/logout,
│                             #   changePassword, the four self-service link operations, and
│                             #   accessLevels() permission lookups — see Authentication
├── auth.interceptor.ts       # authInterceptor: attaches "Authorization: Bearer <jwt>" to requests,
│                             #   and ends the session when a response says that token is dead
├── auth.guard.ts             # authGuard (must be signed in + password changed), adminGuard
├── resource-type.ts          # toResourceType(): entity name → backend permission resource type
├── access-level.ts           # AccessLevel: EDIT < FULL < MANAGE, the ordering, labels and hints
├── access-need.ts            # AccessNeed: a screen's requirement stated as a value — one row,
│                             #   university-wide, or «anywhere of a kind» (see Authentication)
├── access-gate.ts            # AccessGate + NoAccessCard: renders content when the need is met and
│                             #   «Немає доступу» when it is not
├── resource-access.ts/.html  # ResourceAccessPanel: who can reach one resource, and the form for
│                             #   delegating it — the «Доступ» tab of a faculty and a department
├── login-page.ts/.html       # "/login"
├── change-password-page.ts/.html  # "/change-password" — forced after signing in with a temporary password
├── account-request-page.ts/.html  # "/register" and "/forgot-password" — asks for an e-mail address
│                             #   and reports what the service found; one component, data.mode apart
├── account-link-page.ts/.html     # "/register/:token" and "/reset-password/:token" — what a link in
│                             #   an e-mail opens; checks the link, then sets the password
├── admin-page.ts/.html       # "/admin" — user/group/access management console (admin-only)
├── app.ts / app.html         # shell: LNU header + sidebar navigation
├── app.css                    # empty — every style in this app is global, in src/styles.css
├── app.config.ts             # bootstrap providers: router + HttpClient with authInterceptor
├── section-route.ts          # kebabCase() — the one identifier→URL-slug rule — and sectionNav(),
│                             #   which binds a tabbed page's open section to its :section parameter
├── app.routes.ts             # route table (see below)
│
├── faculty-home.ts/.html         # "/" — faculty tiles (drill-down entry point)
├── faculty-page.ts/.html         # "/faculty/:id/:section" — faculty detail with tabbed sections
├── building-home.ts/.html        # "/building" — building tiles
├── building-page.ts/.html        # "/building/:id/:section" — building detail (rooms)
├── department-page.ts/.html      # "/department/:id/:section" — department detail (lecturers, combined
│                                 #   working curriculum items, lecturer workloads)
├── degree-program-page.ts/.html  # "/degree-program/:id/:section" — degree programme detail
│                                 #   (curricula, groups)
├── academic-group-page.ts/.html  # "/academic-group/:id/:section" — group detail (students)
├── department-list.ts/.html          # child-list widget: departments within a faculty
├── degree-program-list.ts/.html      # child-list widget: degree programmes within a faculty
├── degree-program-semester-list.ts/.html  # programme tab: how many teaching weeks each semester
│                                     #   runs for — "Тривалість семестрів" (see below)
├── academic-group-list.ts/.html      # child-list widget: academic groups within a programme
├── curriculum-editor.ts/.html        # programme tab: course-first inline curriculum editor —
│                                     #   "Редагування планів" (see below)
├── curriculum-item-list.ts/.html     # programme tab: curriculum items (semester/course/ECTS/hours)
│                                     #   and the printable «Навчальний план» — "Навчальні плани"
├── curriculum-summary.ts/.html       # the programme's headline figures, shown on both curriculum
│                                     #   tabs — presentational, renders a CurriculumPlan
├── curriculum-plan.ts                # what a curriculum adds up to, and where it departs from
│                                     #   the limits set for it — pure
├── plan-limits.ts                    # those limits, read from global_properties — pure
├── global-properties.service.ts      # GlobalPropertiesService: the settings table, loaded once
├── curriculum-report.ts              # the printable «НАВЧАЛЬНИЙ ПЛАН» sheet — pure, returns bytes
├── working-curriculum-list.ts/.html  # programme tab: assign a department to each hours block —
│                                     #   "Редагування робочих планів"
├── working-curriculum-view.ts/.html  # programme tab: the same plan read as a document, by course year,
│                                     #   with the printable working curriculum — "Робочі навчальні плани"
├── working-curriculum-summary.ts/.html # the working curriculum's headline figures, shown on both
│                                     #   curriculum tabs — presentational
├── working-curriculum-plan.ts        # which department delivers what, and what it adds up to
│                                     #   per department — pure
├── working-curriculum-report.ts      # the printable «РОБОЧИЙ НАВЧАЛЬНИЙ ПЛАН» — pure, returns bytes
├── course-page.ts/.html              # "/course/:id/:section" — one discipline across curricula, working
│                                     #   curricula and workloads; edits/deletes it (lazy route)
├── lecturer-page.ts/.html            # "/lecturer/:id/:section" — one lecturer: classes and timetable;
│                                     #   edits/deletes them (lazy)
├── room-page.ts/.html                # "/room/:id/:section" — one room: details and occupancy;
│                                     #   edits/deletes it (lazy)
├── timetable-grid.ts                 # timetable entries → the grid every view and the PDF read
│                                     #   — pure
├── timetable-view.ts/.html           # the one read-only timetable, mounted five ways
├── timetable-report.ts               # the printable «РОЗКЛАД ЗАНЯТЬ» — pure, returns bytes
├── combined-working-curriculum-item-list.ts/.html  # department tab: propose/manage merges of
│                                                    #   working curriculum items into a shared
│                                                    #   CombinedWorkingCurriculumItem
├── lecturer-constraint-list.ts/.html # department tab: per-lecturer workload constraints with
│                                     #   cross-field validation — "Обмеження навантаження"
├── timetable-constraint-list.ts/.html # one component, three tabs: scheduling constraints for
│                                     #   lecturers (department), academic groups and rooms
│                                     #   (faculty) — "Обмеження розкладу" (see below)
├── workload-stats.ts                 # per-lecturer hour totals + constraint deviation — pure
├── workload-tree.ts                  # loads a department's delivered workload, flattened
├── department-workload-summary.ts/.html # the department's workload on one sheet, one row per
│                                     #   lecturer — "Зведене навантаження"; also embedded at the
│                                     #   top of "Обмеження навантаження"
├── lecturer-workload-detail.ts/.html # department tab: assess one lecturer — "Оцінка навантаження"
├── workload-report.ts                 # the printable «РОЗРАХУНОК НАВЧАЛЬНОГО
│                                   #   НАВАНТАЖЕННЯ» sheet — pure, returns bytes
├── pdf-writer.ts                      # dependency-free PDF engine: TrueType subsetting,
│                                   #   Identity-H, tables that break across pages
├── pdf-fonts.ts                       # browser glue: lazy font fetch, cache, download
├── workload-generator.ts             # the automatic assignment algorithm — pure, no Angular
├── lecturer-workload-list.ts/.html   # department tab: assign lecturers/groups/duration to each
│                                     #   working (or combined) curriculum item — "Навантаження викладачів"
├── room-assignment-list.ts/.html     # faculty tab: where each class may be held —
│                                     #   "Призначення аудиторій" (see below)
├── faculty-timetable-list.ts/.html   # faculty tab: auto-generates schedulable blocks from
│                                     #   workload hours and assigns day/start-time/room —
│                                     #   "Формування розкладу" (see below)
├── timetable-solver.ts               # the UCTP solver itself — pure, no Angular/GraphQL/I-O
├── timetable-solver.worker.ts        # runs it off the main thread and reports progress; several
│                                     #   instances run at once, best answer wins (§8a there)
├── global-properties-page.ts/.html   # "/global-properties" — edit the global_properties settings (lazy)
├── building-travel-times.ts/.html    # "/building-travel-times" — the directed travel-time matrix
│                                     #   between buildings (lazy)
│
└── me-page.ts/.html          # "/me/:section" — «Мій кабінет»: the signed-in user's own навантаження or
                              #   навчальний план, and their own розклад (lazy route)
```

Outside `src/app`, `scripts/` holds the three things that run without the application: the
`workload-bench/` and `timetable-bench/` harnesses, each described below, and
`check-graphql-variables.mjs` behind `npm run lint:graphql`.

The `/timetable` page that used to sit at the end of this list is **gone**. It was a read-only
weekly grid over `timetableEntryConnection(limit: 1000)` with no faculty scope and no
`semesterParity`, against a `data.sql` carrying 1428 entries spanning both halves of the year — so it
silently dropped 428 rows to its limit and overlaid autumn on spring in the cells it did show. Every
other consumer of that table has filtered by semester since the filter existed. `TimetableView`
already does everything that page did and does it correctly, five times over; `me-page.ts` is what
took its place in the sidebar.

### Every value travels as a variable (`graphql.service.ts`)

`GraphqlService` is thirty lines: it POSTs `{ query, variables }` to `/graphql`, throws on
`errors[]`, and returns `data`. What is worth stating is the rule the whole client follows about
what goes in which half.

**No value is ever written into a query document.** Not an id, not a filter, not a page size, not
the name of a `global_properties` row. Every argument names a variable, and the value travels beside
the document:

```ts
const q = `query($facultyId: ID, $limit: Int!) { degreePrograms {
  degreeProgramConnection(limit: $limit, facultyId: $facultyId) {
    nodes { id code name degree durationSemesters } }
} }`;
this.gql.request(q, { facultyId: this.facultyId, limit: 200 });
```

The client used to interpolate them —
``` `degreeProgramConnection(limit: 200, facultyId: "${this.facultyId}")` ``` — which worked because
every value it ever interpolated happened to be a database id. That is not a property of the code,
it is a property of the data it has been given so far: the same template with a name in it produces
a broken document the moment the name contains a quote, and a query built by concatenation cannot be
told apart from a query built by an attacker who supplied one of the pieces. Variables remove the
question rather than answer it — the value is transported as JSON and typed by the server, and a
quote in it is a quote in a string.

Two things follow that are worth having anyway. The document is now a **constant**: the same screen
sends byte-identical text every time, which is what a server-side parse cache is for. And the
argument's type is now *written down* at the call site — `$facultyId: ID`, `$limit: Int!`,
`$roomIds: [ID!]` — where before it was implied by whether the interpolation had quotes around it.
Those types are the ones `QueryDefinition` declares: `filter(…)`/`relationFilter(…)` → `ID`,
`relationFilterList(…)` → `[ID!]`, `relationFilterString(…)` → `String`, a connection's paging →
`Int!`, an entity lookup's `id` and a `globalProperty`'s `name` → `ID!`.

#### Documents assembled at runtime (`GqlVars`)

Most queries are fixed text with a fixed set of variables and say so inline. A handful are not:
*which* filters apply, or *how many* aliased sub-queries there are, is decided in the browser.
«Академічні групи» filters by освітня програма, by факультет, by both or by neither; the student
loader asks for one aliased `studentConnection` per group; `BaseEntity` names its filter arguments
from entity metadata, so even the argument *names* are assembled. Those documents are built by
concatenation — and concatenating a value in with them is exactly what the rule above forbids.

`GqlVars` is the answer, and it is small enough to read in one sitting. `arg(name, type, value)`
records the value, returns `name: $name` for the document, and keeps the value on the side;
`optionalArg` returns `''` instead when there is nothing to filter by, so an unused filter is
*absent* from the document rather than present and null — the shape the server has always been sent.
`declaration()` returns the operation header naming everything recorded, and `values` is what goes
to `request`:

```ts
const v = new GqlVars();
const args = [
  v.arg('limit', 'Int!', 500),
  v.optionalArg('degreeProgramId', 'ID', this.degreeProgramId),
  v.optionalArg('facultyId', 'ID', this.facultyId)
].filter(Boolean).join(', ');
const q = `${v.declaration()}{ academicGroups { academicGroupConnection(${args}) { … } } }`;
this.gql.request(q, v.values);
```

Two things to know before using it. **Build the arguments before the template**, not inside it: a
template literal evaluates left to right, so `${v.declaration()}` read ahead of the `v.arg(…)` calls
it is supposed to describe emits a header missing half its variables — a document the server
rejects, and one the compiler is perfectly happy with. And when the argument name is not the
variable name — an aliased sub-query repeats one argument across N fields — use `ref` and write the
argument yourself: `` `g${i}: studentConnection(academicGroupId: ${v.ref(`group${i}`, 'ID', id)})` ``.
`ref` also reuses a name already bound to the same value and numbers it when bound to a different
one, because two declarations of one name is a document GraphQL rejects outright and the parts that
assemble one cannot see what the other parts declared.

### The pure modules

Fourteen files carry the logic that is not UI. All of them are free of Angular, GraphQL and I/O: they
take plain objects and return plain objects, so each can be unit-tested (or run under Node) on its
own, and the components' only job is to map data in and apply results out. This is the single most
load-bearing convention in the app — every algorithm here is hand-written, and none of them is
allowed to reach for a service.

| Module | What it computes | Documented in |
|---|---|---|
| `workload-generator.ts` | which lecturer delivers which working curriculum item | [WORKLOAD-GENERATION.md](./WORKLOAD-GENERATION.md) |
| `timetable-solver.ts` | day / start time / room / week parity for every class session | [TIMETABLE-GENERATION.md](./TIMETABLE-GENERATION.md) |
| `workload-stats.ts` | per-lecturer hour totals and deviation from the constraints | *Workload statistics*, below |
| `plan-limits.ts` | the limits a plan is measured against, read from `global_properties` | *Curriculum limits are settings*, below |
| `curriculum-plan.ts` | what a programme's curriculum adds up to, and its compliance with those limits | [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) |
| `curriculum-report.ts` | the printable «Навчальний план» sheet | [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) |
| `working-curriculum-plan.ts` | which department delivers what, and the hours that projects onto each | [WORKING-CURRICULUM-PDF.md](./WORKING-CURRICULUM-PDF.md) |
| `working-curriculum-report.ts` | the printable «Робочий навчальний план» sheet | [WORKING-CURRICULUM-PDF.md](./WORKING-CURRICULUM-PDF.md) |
| `timetable-grid.ts` | timetable entries → day × class slot × subject, for every view and the sheet | *The five timetables*, below |
| `timetable-report.ts` | the printable «Розклад занять» sheet | [TIMETABLE-PDF.md](./TIMETABLE-PDF.md) |
| `workload-report.ts` | the printable «Розрахунок навчального навантаження» sheet | [WORKLOAD-PDF.md](./WORKLOAD-PDF.md) |
| `pdf-writer.ts` | a PDF, from scratch, including the TrueType subsetting | *Printable workload calculation*, below |
| `sort.ts` | `compareUk` — the one Ukrainian-alphabet comparator | *Ukrainian sorting*, below |
| `course-label.ts` | `courseLabel` — a discipline's name with its `courses.semester` and `course_tags` in parentheses | *Naming a discipline*, below |

Only one of them needs a host that is not a component: `timetable-solver.worker.ts` runs the solver
on its own thread — and, since the search is stochastic and different seeds land in different local
optima, several of those workers run at once on the same problem and the best answer wins
([TIMETABLE-GENERATION.md](./TIMETABLE-GENERATION.md) §8a). `workload-generator.ts` needs no host at
all, because it is three greedy passes over a department rather than a search with a time budget —
it returns before a frame is missed.

### Option lists are declared once

Several screens offer the same choice, and a list restated per component drifts. Anything of that
kind lives in `entities.ts`: `HOUR_TYPE_OPTIONS`, `DAY_OF_WEEK_OPTIONS`, `WEEK_PARITY_OPTIONS`,
`CONTROL_FORM_OPTIONS`, `TEACHING_FORMAT_OPTIONS`, `COURSE_TYPE_OPTIONS`, `STUDY_FORM_OPTIONS` — and
**`SEMESTER_PARITY_OPTIONS`**, the two halves of the academic year, which had accumulated four
near-identical copies (the timetable view, «Мій кабінет», the schedule builder and the
`current_semester_parity` settings editor). Two of the four spelled the labels «Перший (непарний)
семестр» and two «Перший (непарний)»; since the three pickers that narrow a view already carry their
own «Семестр» caption — and the fourth sits in a settings table under «Поточний семестр» — the short
form won. Two more screens have been built on the constant since and never had a copy of their own:
«Призначення аудиторій» and the faculty's «Розклад факультету» tab.

One screen takes the list as it is and relaxes something else instead: on its two *table* tabs
«Мій кабінет» lets the picker be **cleared**, and an empty picker is the whole year. Nothing here had
to change for it — an empty value is the absence of a choice rather than a third half-year — and
every other picker built from this list still passes `[clearable]="false"`. See
[«Мій кабінет»](#мій-кабінет-mydeskpage-me).

Ordering is part of the declaration, not a separate constant: `HOUR_TYPE_OPTIONS` is in the same
order as the `hour_type` enum in `schema.sql`, and screens that need to sort by hour type derive the
rank from that list rather than restating it.

### Naming a discipline (`course-label.ts`)

A course's name does not identify it. «Іноземна мова» taught in English and «Іноземна мова» taught
in German are two `courses` rows, two lines of the plan and two lecturers' workloads, and a list
showing only the name shows them as the same thing twice. `course_tags` is what tells them apart, so
**everywhere the UI names a course it renders `courseLabel(name, tags)`** — `Іноземна мова
(англійською)`, or the bare name when the course has no tags, parentheses omitted rather than left
empty.

A course may also be restricted to **one semester** (`courses.semester`, [`V6`](../timetable/README.md#v6__course_semestersql)),
and that value is written **first inside the same parentheses**:
`Вибіркова дисципліна 5 (семестр 5, англійською)`. It goes there rather than beside them because it
answers the same question the tags answer — which «Вибіркова дисципліна 5» is this, out of the
several a degree programme may carry — and
because a second bracketed group after the first reads as a footnote rather than as part of the
name. `courseLabel(name, tags, semester)`; the third argument is optional, so a caller that has not
selected the column renders exactly what it rendered before rather than a wrong label, and the flip
side is that putting a course on a new screen means selecting `semester` as well as `tags`
(`COURSE_LABEL_SELECTION` is that selection written down once).

That is one rule applied in about twenty places, which is why it is a pure module rather than a
method: three components had already grown their own private copy of it before this file existed.

**The four PDF sheets deliberately keep printing the bare name.** Their columns are sized by their
own layout rules and the faculty timetable is read as approved paper; a tag appearing there is a
document change, not a UI change. Four modules feed both a screen and a sheet, and each of them
therefore carries the label in a field *beside* the raw name rather than in place of it:

| Module | Printed by the sheet | Rendered on screen |
|---|---|---|
| `working-curriculum-plan.ts` | `WorkingPlanRow.name` | `WorkingPlanRow.label` |
| `workload-stats.ts` | `StatItem.courseName` | `StatItem.courseLabel` |
| `timetable-grid.ts` | `GridEntry.courseName` | `GridEntry.courseLabel` |
| `faculty-timetable-list.ts` | — | `Block.courseLabel` beside `Block.courseName` |

`curriculum-plan.ts` is the exception that proves the rule: it has no tagged counterpart, because
nothing renders a `PlanRow`'s discipline name — «Навчальні плани» builds its table from the raw
curriculum items and labels them itself, and the summary above it shows only totals. Adding a field
for symmetry that no template reads would be dead code.

`faculty-timetable-list.ts` prints nothing at all, yet still splits the two. Its `sortBlocks`
collates on the name, and folding tags in would let the tag text drive the ordering and split two
same-named disciplines apart — which is the general reason the split is not only about PDFs.

Two other things read the raw field and must keep doing so: the sorts (`compareUk` on a name, so
ordering does not shuffle when a tag is added) and the distinct-discipline tallies — «Дисциплін» on
a lecturer's page counts `courseName` values, `DepartmentLoad.courses` counts them per кафедра, and
`LecturerStats.distinctCourses` counts `courseId`. Folding tags into those strings would quietly
change reported figures.

One deliberate hole: a `ComplianceCheck`'s `verdict` names the disciplines that fail a check, and
that one string is both shown on the page and printed in the sheet's примітки — so it stays bare,
and the warning card on «Робочі навчальні плани» names a discipline slightly more tersely than the
table above it. Splitting the check in two to fix a parenthesis was not worth it.

**Two screens are left out, because they already answer the question this rule exists to answer.**
The generic «Дисципліни» table (`/course`) has «Теги» and «Семестр» columns of its own, and the
course page (`/course/:id`) prints the tags on the line under the heading and the semester as a row
of the info table — on the page *about* that course both have room to be a fact rather than a
parenthesis. Both are read the other way round from every other
screen: you arrive knowing which discipline you want. Every *other* course either of them names —
the parent «Група вибіркових», the child electives, the course picker — is labelled the usual way.

Leaving the generic table out is also what keeps `entities.ts` / `base-entity.ts` free of this
entirely: the option loader there selects `id` plus one scalar, and teaching it to carry a nested tag
list means a new metadata opt-in threaded through the selection, the dropdown label and the table
cell — for the single Course foreign key that exists (`parentCourseId`). The bespoke duplicate of
that same picker on the course page does the labelling instead.

### Generic CRUD tables (`entities.ts` / `BaseEntity`)

Each entity in `entities.ts` declares its GraphQL field/namespace names and form fields;
foreign keys are `ref(...)` fields pointing at another entity for the dropdown:

```ts
{
  name: 'Department', label: 'Departments',
  single: 'department', namespace: 'departments', list: 'departmentConnection',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    ref('facultyId', 'Faculty', 'faculty', 'faculty', 'name', true) // FK → Faculty
  ]
}
```

Two more field-builder helpers cover relations `ref(...)` can't express, both used by the
`Course` entity: `multiref(name, label, ref, relation, refLabel)` renders an
`app-multi-select` bound to a many-to-many id-list input field (`Course.degreeProgramIds`, which
degree programmes the course may be added to a curriculum for — see the backend's
`.manyToMany(...)`), replacing the join-table membership wholesale on save; `tags(name, label,
relation, tagField)` renders a plain comma-separated text input that's split/joined against a
nested-list mutation field (`Course.tags` — see the backend's `.nestedList(...)`) — an empty
comma-separated entry is filtered out, so "тег1, , тег2" becomes two tags, not three.

A `time(name, label, required, minHour, maxHour, minuteStep)` helper declares an `"HH:mm"` string
edited through `TimeSelect`'s hour + minute dropdowns instead of a free-text box — used by
`ClassStartTime.startTime`, where only valid slot times should be enterable. Because the form is
metadata-driven, any future time field gets the same widget for free.

A `'number'` field may declare **`min` / `max`**, and `BaseEntity#validate` refuses a value outside
them before the mutation is sent (`Course.semester` carries `min: 1`, mirroring
`courses_semester_check`). The check is in the component rather than on the input because the
attribute alone would do nothing — Angular puts `novalidate` on every form it manages, so the
browser never enforces it — and because of what the server makes of a value that gets through: a
`CHECK` violation and a missing foreign key both arrive as the same exception, and the generic
handler reports either as the entity's `…_NOT_FOUND` status, so «Семестр: 0» would come back as «a
referenced entity does not exist». See the service README's
[Known limitations](../timetable/README.md#known-limitations); refusing the value here is what keeps
that limitation confined to callers who bypass the UI. The attributes are rendered too, so the
number spinner also stops at the bound.

A `'boolean'` field type renders a checkbox (`ClassStartTimeSet.isDefault` is the only one so far)
and needs three small departures from how every other type is handled, all in `base-entity.ts`:
the table cell shows «Так» or a **blank**, not "Ні" repeated down the column — the point of the
column is to show which row *is* the default one; `edit(row)` seeds the form with a real boolean
rather than `?? ''`, because `''` would also be read as "empty"; and `buildInput` always sends the
value, since an unticked box is a value rather than an absence. Without the last two, a set could
be made the default but never un-made.

An entity may also declare `detailRoute` — the path of its own drill-down page. Set it, and every
generic table of that entity grows an **«Відкрити →»** link in its actions column: not only the
standalone table page but every embedding of it, so the faculty page's «Дисципліни» and «Аудиторії»
tabs and the department page's «Викладачі» tab all lead somewhere without a line of their own.
`Course`, `Lecturer`, `Room`, `DegreeProgram`, `AcademicGroup`, `Faculty`, `Department` and
`Building` carry one. That the link is metadata rather than markup is the point: the alternative was
the same anchor pasted into four call sites and forgotten in the fifth.

`detailRoute` does a second job: **a `ref` column renders as a link to the row it points at.** The
cell used to print the referenced row's database id beside its name — «Дискретна математика (#42)»,
and the same in every foreign-key dropdown — and the tables carried a leading `#` column of their
own id besides. Both are gone. An id is not something a reader can act on: it was there because it
was the only thing telling two same-named rows apart and the only way to get from one to the other,
and a link does both, properly. Where a referenced entity has no page — `AcademicDegree`,
`RoomGroup`, `ClassStartTimeSet`, `TimetableEntry`, `Student` — the cell is its name as plain text,
and an empty reference is still an em dash.

One thing was lost with the ids and is worth naming: two rows with the same name now read
identically in a **dropdown**, which cannot hold a link. Where that matters the picker already says
more than the name — `AdminPage`'s two person pickers append the кафедра or the академічна група —
and the general fix, if a list ever needs it, is to append the distinguishing parent rather than to
put the id back.

A `ref` field may also carry `parentFilter: { namespace, list, label }`. That swaps its plain
dropdown for `DeptFacultySelect` — a second select above it, loaded from that connection, which
narrows the first one's options (used by `Lecturer.departmentId`: pick a faculty, then one of its
departments). Nothing else in the form changes; the field still saves the same FK.

Field order in `fields[]` drives **both** the table columns and the modal form, so reordering one
reorders the other — `Student` is listed Прізвище → Ім'я → По батькові for that reason.

The enum option lists (`DEGREE_OPTIONS`, `POSITION_OPTIONS`, `COURSE_TYPE_OPTIONS`,
`CONTROL_FORM_OPTIONS`, `HOUR_TYPE_OPTIONS`, `TEACHING_FORMAT_OPTIONS`, …) are exported, and the
hand-written pages read them too rather than keeping their own copies — `courseTypeLabel(value)` and
`positionLabel(value)` are the shared value → Ukrainian label lookups for `courses.course_type` and
`lecturers.position`. `POSITION_OPTIONS` was inline in the `Lecturer` metadata until the PDF report
needed the same labels; anything that renders a stored enum should reach for the exported list
rather than repeat it. A page that hand-rolls its own map is a bug waiting to happen: the one that
existed showed raw `INTERNSHIP` / `COURSE_WORK` in a column because its private map only covered
three of the eight values. One exception is still in the tree: `degree-program-page.ts` declares its
own `DEGREE_OPTIONS` literal rather than importing the shared one (its sibling
`degree-program-list.ts` imports it). The two agree today, which is exactly what makes the
duplication easy to miss.

`BaseEntity` (an abstract `@Directive`) builds the queries/mutations from this metadata —
list (`{ <namespace> { <list>(limit, offset) { nodes {...} } } }`), create/update (typed
`$input: <Name>InputPayload!`) and delete (`$id: ID!`) — and every entity page is a one-line
subclass rendered through the shared `entity-page.html` (table + modal form):

```ts
@Component({ selector: 'app-course', templateUrl: './entity-page.html', imports: [FormsModule, SearchSelect] })
export class CoursePage extends BaseEntity { meta = meta('Course'); }
```

A host page narrows a table it does not own through four inputs. `filterValue` supplies
`meta.filterParam` (the optional, user-facing sub-filter); `extraFilterParam`/`extraFilterValue` add
a second, always-on argument for a scope the host always wants (courses scoped to the current
faculty, whatever the department sub-filter says); and `presets` pre-fills the create form and hides
those columns, which is what keeps a created row valid against constraints the form no longer shows.

**`search` is the fifth, and it is the only one that does not reach the backend.** It narrows the
rows already loaded, case-folded with the Ukrainian locale. That is not a shortcut: the connection is
fetched once with `limit: 1000` and no paging, so within a scope every candidate row is already in
the browser and a round trip per keystroke would be slower than the filter it replaces — and a
`.filter` argument is an equality on a column, which is not what "find the discipline whose name
contains this" means. What it matches is exactly what the table shows: every visible cell, rendered
through the same `display()` the rows use, so a search finds the ref labels and tag text a reader can
see and cannot match a column hidden by `presets`. The header reads «N запис(ів) · з M» while a
search is active, and the empty row distinguishes "nothing matched «X»" from "no data yet" — a typo
otherwise looks like an empty database. The faculty page's «Дисципліни» tab uses it beside the
server-side кафедра filter.

`entity-pages.ts` currently registers 14 such pages (`academicDegree`, `faculty`,
`department`, `degreeProgram`, `course`, `lecturer`, `student`, `academicGroup`,
`room`, `roomGroup`, `abstractRoom`, `classStartTimeSet`, `classStartTime`, `timetableEntry`), each routed at the
**kebab-case of its `single`** — `roomGroup` becomes `/room-group`, `classStartTimeSet` becomes
`/class-start-time-set` — by the same `kebabCase` that turns a section key into a section slug. These
are the fallback / power-user screens — useful for bulk edits or entities
without a dedicated drill-down page (`Room`, `RoomGroup`, `AbstractRoom`, `ClassStartTimeSet`,
`ClassStartTime`, `AcademicDegree`, `TimetableEntry`). Two of them lean on the metadata in ways worth noting:
`RoomGroup` uses `multiref` for its rooms and offers both a faculty and a department picker even
though the two are mutually exclusive — the database rejects a row that sets both
(`room_groups_scope_check`), so a form that does fails on save rather than being prevented here;
`ClassStartTime` carries a `filterParam: 'classStartTimeSetId'` — eleven of the sixteen entities carry
a `filterParam`, but this is the one where it is not merely convenient: `ordinal` only numbers
periods *within* a set, so an unfiltered list interleaves every set's and two rows both read "2.". `CombinedGroupPage`
(the same `BaseEntity` table) is also registered as a component but not routed standalone — it's
embedded directly as the Faculty page's "Об'єднані групи" tab instead. `CurriculumItem`,
`CurriculumItemHours`, `WorkingCurriculumItem` and `LecturerWorkload` have no generic page at all;
they're managed exclusively through the hand-written drill-down pages below
(`DegreeProgramDetailPage`'s working-curriculum-items tab and the department's "Навантаження
викладачів" tab, via `LecturerWorkloadList`).

### Hierarchical drill-down pages

The main browsing flow is a set of hand-written pages, each fetching its own GraphQL query and
composing purpose-built child-list components rather than going through `BaseEntity`. Every one of
them is tabbed, and **each tab is an address of its own** — `/faculty/:id/room-assignment`,
`/degree-program/:id/working-curricula`, `/me/timetable` — so any of them can be bookmarked, sent to
a colleague and reloaded; see [The open tab is part of the
URL](#the-open-tab-is-part-of-the-url-section-routets). The paths below name the pages; their
default tab is `info`, which the bare path redirects to.

- **`FacultyHome`** (`/`) → tiles for all faculties → **`FacultyPage`** (`/faculty/:id`), tabbed
  into "Факультет / Структура / Люди та групи / Навчальні плани / Розклад" sections: info,
  departments (`DepartmentList`), degree programmes (`DegreeProgramList`), rooms, academic groups,
  combined groups (`CombinedGroupPage`), courses, room assignment (`RoomAssignmentList`, see below),
  "Обмеження груп" and "Обмеження аудиторій" (two instances of `TimetableConstraintList`, see
  below), and schedule building (`FacultyTimetableList`, see below). The "Розклад" group is ordered
  by the order the work happens in: state where each class may be held and when its groups and rooms
  are unavailable, then generate a timetable that obeys all three, then read it. Every list on this
  page is scoped to the faculty, including the two that have no `faculty_id` of their own:
  "Академічні групи" passes `[facultyId]` alongside its optional degree programme sub-filter (so
  clearing that sub-filter means "all degree programmes *of this faculty*", not "every group in the
  university"), and "Об'єднані групи" passes the same scope to the generic table through
  `extraFilterParam`/`extraFilterValue` — both backed by the `facultyId` relation filters described
  in the backend README.
- **`BuildingHome`** (`/building`) → **`BuildingPage`** (`/building/:id`): info + rooms
  (each room shows/edits its own faculty; there's no separate "faculties in this building" tab).
- **`DepartmentDetailPage`** (`/department/:id`): info, lecturers, combined working curriculum
  items (`CombinedWorkingCurriculumItemList` — merge proposals, see below), workload constraints
  and department statistics (`LecturerConstraintList` — "Обмеження навантаження", see below),
  per-lecturer scheduling constraints (`TimetableConstraintList` — "Обмеження розкладу", see
  below), lecturer workloads (`LecturerWorkloadList` — "Навантаження викладачів", see below), the
  department-wide summary (`DepartmentWorkloadSummary` — "Зведене навантаження") and the
  per-lecturer assessment (`LecturerWorkloadDetail` — "Оцінка навантаження", see below).
- **`DegreeProgramDetailPage`** (`/degree-program/:id`): info, **«Тривалість семестрів»**
  (`DegreeProgramSemesterList` — see below), then **each plan twice — once to
  edit, once to read** — plus academic groups (`AcademicGroupList`). The curriculum is entered
  course-first (`CurriculumEditor`, "Редагування планів") and read as a table with its printable
  «Навчальний план» (`CurriculumItemList`, "Навчальні плани"); the working curriculum is entered by
  hanging a department off each hours block (`WorkingCurriculumList`, "Редагування робочих планів")
  and read as a document with its own printable sheet (`WorkingCurriculumView`, "Робочі навчальні
  плани"). All four see below. The editors are shaped for *entering* data and the readers for
  *checking* it, which is why neither shape serves both.
- **`AcademicGroupDetailPage`** (`/academic-group/:id`): info, students. (No workload tab here —
  workloads are managed per-department, not per-group.)
- **`CourseDetailPage`** (`/course/:id`), **`LecturerDetailPage`** (`/lecturer/:id`) and
  **`RoomDetailPage`** (`/room/:id`): the three entities that were only ever rows in a table now have
  pages of their own — all three see below. They are **lazy routes** (`loadComponent`), because each
  is a whole screen with its own aggregate query, none is on the path to a timetable, and the main
  bundle sits close to its budget.

The faculty page gained two tabs in the same round: «Групи аудиторій» under *Структура* (the generic
`RoomGroup` table, scoped and preset to the faculty — `room_groups_scope_check` forbids a group
carrying both a faculty and a department, so presetting `facultyId` is what keeps a created row
valid) and «Розклад факультету» under *Розклад*. The department page gained «Розклад кафедри».

Both pages later gained one more, **«Доступ»**, the first tab to be *conditional*: it is filtered
out of the navigation unless the account holds `MANAGE` on that faculty or department, and the panel
it shows re-checks the same thing rather than trusting its host. See [Delegating
access](#delegating-access-resourceaccesspanel). The department page's
«✎ Редагувати» became conditional in the same round — it used to render for everybody and rely on
the server to refuse, which it did, after the form had been filled in.

It is no longer alone. Every tab whose whole purpose is entering data now comes and goes the same
way — the four scheduling tabs of a факультет, the three writing tabs of a кафедра, and the two
«Редагування…» tabs and «Тривалість семестрів» of an освітня програма — each on the kind of thing it
maintains rather than on `MANAGE` over the page it sits in, and each with the same answer given
again behind the tab, so that a pasted address is refused on the screen instead of quietly opening
«Інформація». The tab lists above are therefore what somebody holding the rights for all of them
sees; see [Which screens hide themselves](#which-screens-hide-themselves) for how the set is
narrowed to one account.

#### Editing a curriculum course-first (`CurriculumEditor`, degree programme "Редагування планів" tab)

The same `curriculum_items` rows as the tab below it, inverted: one block per **course** the degree
programme is allowed to teach (`courseConnection(degreeProgramId:)`, backed by
`course_degree_programs`), each holding its semester blocks, each of those holding a row per hour
type. Courses with no curriculum items yet are listed too — sorted to the top alphabetically — so
gaps in the plan are visible rather than merely absent, which a table of existing rows cannot show.
Everything is edited inline, one save per semester block, rather than through a modal.

**An `ELECTIVE` is not one of those courses.** It is a choice inside an `ELECTIVE_GROUP`, and the
group is what the plan reserves a slot for; which child fills it is decided a level down, on
`WorkingCurriculumItem.course`. Listing the children here put «Основи web програмування (пм)» and
its forty siblings on the page as top-level blocks marked «без позицій плану», burying the
components that *are* the plan under courses that structurally never can be. `isPlannable` filters
them out at load, so an elective reaches this page only through its група — and the «Навчальні
плани» tab's discipline picker is filtered the same way, with one exception: a position that
already names an elective keeps naming it in the edit form, because an edit form must never
silently drop a value the database holds. The rule is the course's own `courseType` rather than
"has a parent course", so that it is the same rule the database is cleaned by — see the service
README's [`V1__delete_curriculum_items_on_elective_courses.sql`](../timetable/README.md#v1__delete_curriculum_items_on_elective_coursessql),
which removes the 28 positions that should never have been attached to one. In the seeded data the
two readings coincide exactly: all 664 electives have a parent, and nothing else does.

- **Ordering** — courses sort by their lowest semester, ties broken by course name; semester blocks
  sort by semester. Unplanned courses come first.
- **No duplicate semesters** — the semester dropdown only offers values no sibling block already
  uses, and `save()` re-checks (two new blocks can both be unsaved at once), with
  `UNIQUE (course_id, degree_program_id, semester)` as the backstop.
- **A course restricted to one semester offers that semester and nothing else.** `courses.semester`
  (see the service README's [`V6`](../timetable/README.md#v6__course_semestersql)) says a discipline
  is a component of one semester and of no other — normally an `ELECTIVE_GROUP`, whose whole purpose
  is a slot the plan reserves in one place. Its block shows «лише семестр N», its dropdown carries
  the one value, «+ Семестр» closes after the single position it can have, and `validate()` refuses
  anything else. The database is not asked to enforce this, on purpose: restricting a course must
  not invalidate plans that were legal when they were written.
- **Hours** — a fixed row per hour type, always shown. A blank or `0` field means "not set": it is
  omitted from the nested `hours` list, which is what makes the backend *delete* an existing row
  (see the backend's `.nestedList(...)` reconciliation). A field that would drop a stored row is
  flagged "буде вилучено" before you save, since clearing a box is otherwise a silent deletion.
- **Concurrent edits** — saving one course reloads only that block, preserving unsaved edits
  elsewhere on the page.
- A course-name filter and a "лише заплановані" toggle keep the page usable: a degree programme can
  have 200+ courses.

Editable state is a signal per field (see the zoneless note above), which is also what makes
sibling blocks re-render when a neighbour changes — a block reading `sibling.semester()` while
computing its own dropdown options registers as a consumer of that signal.

#### Semester lengths (`DegreeProgramSemesterList`, «Тривалість семестрів»)

How many teaching weeks each semester of one освітня програма runs for.

The розклад decides how many classes a week a plan position needs by dividing its hours by
(weeks × class length), and the weeks in that division came from `semester_duration_weeks` — one
number for the whole university. That is right for most of a degree and wrong at the end of one: the
last semester of a master's programme is largely taken up by the final attestation and a work
placement, so its teaching runs for fewer weeks, and planning it as sixteen puts *fewer* classes a
week on the timetable than the plan's hours require.
This tab is where that is said, per programme and per semester.

**An empty cell is a value, not a gap.** It means «the usual length», and the placeholder shows what
that number currently is, so nobody has to remember it. Clearing a cell deletes the stored row rather
than storing a duplicate of the default, and the screen does not offer to fill every semester in:
several hundred copies of one number cannot be corrected in one place, which is the whole point of
the property they would be copies of.

**The semesters listed are the ones the programme's own curriculum uses, not 1…n.** A master's
programme in this database may number its semesters 9, 10, 11 — carrying on from the bachelor's
degree it follows — while another restarts at 1, and a table offering 1, 2, 3 to the first would
collect numbers that join to nothing. The list is the union of the plan's semesters and any already
overridden, falling back to 1…`durationSemesters` only when both of those are empty. A stored
override for a semester the plan no longer has is kept rather than dropped, so the next save cannot
delete it silently.

One «Зберегти» settles the whole table: it is one `updateDegreeProgram` carrying the semesters as a
nested list, so a row with an id is updated, one without is inserted, and a row the list no longer
mentions is deleted — which is what an emptied cell becomes. Saving row by row would leave a
half-applied table behind whenever one of the calls failed. The programme's own fields travel with
the mutation because the input payload requires them, and are sent back exactly as they were read, so
this screen cannot quietly rename a programme. Every *other* writer of a degree programme omits the
`semesters` field entirely, which the framework reads as «leave the child rows alone» — editing a
programme's name from the faculty list does not disturb its semester lengths.

**What reads it, so far: nothing.** «Формування розкладу» still divides by the
`semester_duration_weeks` global property for every semester of every programme — this tab records
the exception, and teaching the solver to read it is a separate change to
`faculty-timetable-list.ts`'s block arithmetic (see the known limitations). Entering a length here
today is correct and has no effect on a timetable yet.

`durationSemesters` is `NOT NULL` in the database and `Int!` on `DegreeProgramInputPayload`, so all
three forms that write a programme collect it: the generic table, `DegreeProgramList` on the faculty
page, and this page's own «Редагувати». The two hand-written ones refuse an empty or non-positive box
with a sentence before sending anything, because both ways of getting it wrong are answered badly
further down. A zero or a negative reaches `degree_programs_duration_semesters_check` and comes back
as `RELATED_NOT_FOUND` — the generic status every failed constraint arrives as here, which names the
wrong problem entirely (see [Generic CRUD
tables](#generic-crud-tables-entitiests--baseentity) for why a `CHECK` reads as a missing reference).
An empty box is worse: `buildInput` omits an empty value, and a payload with no `durationSemesters`
in it is refused by GraphQL validation before the resolver, in English and about a variable rather
than about a field somebody left blank. The generic table catches the first of those through the
`min: 1` on the field's metadata and not the second — `BaseEntity#validate` passes over a field that
is empty, and nothing else in that form treats `required` as more than a star beside the label —
which is the metadata-driven form's own long-standing shape rather than anything about this field.

#### Curriculum items and working curriculum items (`DegreeProgramDetailPage`)

The "Навчальні плани" tab (`CurriculumItemList`) lists the programme's `CurriculumItem`s (semester,
course, control form, ECTS, per-hour-type breakdown) with an add/edit modal whose **course**
dropdown is always scoped to courses allowed for the current degree programme — the
`courseConnection(degreeProgramId: ...)` filter, backed by the `course_degree_programs` join table
(see the backend README) — regardless of whether the modal's optional faculty/department sub-filter
(`DeptFacultySelect` pattern, defaulting to the programme's own faculty) is also set. Both this
dropdown and the resulting curriculum table display a course's tags (`Course.tags`, set on the
`Course` entity page — see [Generic CRUD tables](#generic-crud-tables-entitiests--baseentity) above)
after its name in parentheses, e.g. "Database Systems (англійською)"
(`CurriculumItemList.courseLabel`).

Picking a discipline that carries `courses.semester` **fills the «Семестр» field in and closes it**:
that course may be planned for that semester and no other, so the wrong value is unreachable rather
than caught on save (the same rule the editor beside it applies — see above). Two things keep the
lock honest against data written before the restriction existed: a stored position sitting in the
wrong semester is flagged in the table («лише семестр N») and re-opens the field with a message when
it is edited, and `save()` refuses it until it agrees. Both are reachable only that way — a course
can be restricted long after its positions were written, and a plan that silently disagrees with its
own disciplines is worse than one that says so.

#### The programme's headline figures (`CurriculumSummary`, both curriculum tabs)

Above both the table and the editor sits the same strip: programme volume in credits and hours, the
mandatory components, the **share of elective components** (tinted red below the 25 % of ст. 62 ч. 1
п. 15 of the Закон України «Про вищу освіту»), and the length of study the semesters span — then any
statutory rule the plan breaks, one line each.

`CurriculumSummary` is purely presentational: it renders a `CurriculumPlan` and computes nothing, so
the two tabs and the PDF cannot show three different numbers. The two hosts build that plan
differently, and deliberately: the table's comes from what is stored, while the **editor's is
computed from the drafts on screen, unsaved edits included**, so the 25 % share moves as fields are
typed into and a plan can be brought within ст. 5 and ст. 62 before anything is written. That works
only because every editable value in `CurriculumEditor` is its own signal — a `computed()` over
plain fields would memoise the first value it ever read (see the zoneless note above).

#### The printable curriculum (`curriculum-plan.ts`, `curriculum-report.ts`)

The "Навчальні плани" tab carries a **«Завантажити PDF»** button producing the sheet an academic
council approves — «НАВЧАЛЬНИЙ ПЛАН підготовки здобувачів вищої освіти» — for the degree programme
being looked at. Written **entirely on the client**, like the workload sheet: nothing is sent to the
server and the file downloads straight from a `Blob`, with the embedded font fetched once per
session.

- **`curriculum-plan.ts`** — the arithmetic and the norms. It folds the curriculum items into the
  parts a Ukrainian plan is read in (mandatory and elective components, course works, practical
  training, attestation, and optional subjects **outside** the programme), totals each of them and
  each semester, and measures the result against the Закон України «Про вищу освіту»: programme
  volume per degree (ст. 5), the 25 % elective share (ст. 62 ч. 1 п. 15), 30 hours per credit checked
  position by position, and 60 credits per year (ст. 1 п. 14), plus two advisory checks — disciplines
  and examinations per semester — labelled as **settled practice, not law**, so a deviation from them
  never reads as a violation.
- **`curriculum-report.ts`** — the document: a title sheet with the «ЗАТВЕРДЖЕНО / Вченою радою»
  approval block (a curriculum is approved by a collegial body — ст. 36 ч. 2 п. 8 — so the form
  differs from the workload sheet's «ЗАТВЕРДЖУЮ»), the summary figures, the summary by semester, the
  fifteen-column «План освітнього процесу» under a three-level header, the distribution of hours by
  kind of work, the compliance table and the signature chain.

**There is no state template for a curriculum**, and citing one is the mistake to avoid: the single
national form lived in the appendices to наказ МО України № 161 від 02.06.1993, which **was
repealed** (наказ МОН № 1310 від 13.11.2014). What the law fixes is the content, not the layout —
[CURRICULUM-PDF.md](./CURRICULUM-PDF.md) sets out which part of the document answers to which
article, which parts are the common practice of Ukrainian institutions, and what the data model
cannot yet fill in (the academic-year calendar, the name of the field of knowledge, the programme's
ЄДЕБО identifier).

The "Редагування робочих планів" tab of the degree programme page renders, for every
`CurriculumItem`: a header block ("Семестр 1, Дисципліна: …, Форма контролю: …, ECTS: …"), then one
child block per `CurriculumItemHours` row ("Лекції: 32", etc.), and inside each hours block a table
of `WorkingCurriculumItem` rows with an add/edit modal (`WorkingCurriculumList`) offering:

- an optional **faculty filter** (defaults to the programme's own faculty) that narrows the
  **department** dropdown (`DeptFacultySelect` pattern, reused from `CurriculumItemList`'s
  own faculty→department cascade),
  - lecturer count, teaching format (`TEACHING_FORMAT_OPTIONS`: Разом / Окремо / Індивідуально з
    кожним студентом),
- an **academic groups** multi-select (`MultiSelect`, backed by the `academicGroupIds`
  many-to-many mutation field), and
- when the curriculum item's course is an `ELECTIVE_GROUP`, an extra **elective course**
  dropdown scoped to that group's child courses.

#### Reading the working curriculum, and printing it (`WorkingCurriculumView`, `working-curriculum-plan.ts`, `working-curriculum-report.ts`)

Both working-curriculum tabs open with the same strip — volume, **how many blocks of hours have been
assigned to a department**, how many departments deliver them, and the projected load hours —
rendered by `WorkingCurriculumSummary` from the plan below it. On the editing tab that is the point:
a page of nested blocks cannot show whether the last block of hours has found an owner, and the
coverage figure moves as departments are assigned. It covers every course year there, since the
editor is not scoped to one; the reading tab's follows that tab's course-year filter.

The "Робочі навчальні плани" tab is the same rows read as a document rather than edited. The tab
above it nests three levels deep — curriculum item → hours block → working item — which is the right
shape for assigning one department to one block of hours and the wrong one for seeing what a year
actually looks like. This one flattens them into **one line per discipline**, carrying the department
(or departments, named with the kinds of work each took) behind it, and never writes.

A **course-year filter** scopes the page, because a working curriculum is drawn up **for one academic
year** — the one thing every institutional regulation agrees on. The model stores no cohort or intake
year, so
the year is chosen here rather than read; «усі курси» is offered too, and both the page and the
document say which of the two they are showing.

Below the table, the same plan **per department**: positions, disciplines, hours by kind, and the hours
each department is projected to teach. That projection is the point of the page — it is what
`LecturerWorkloadList` will later have to fit real people into — and it applies **the rule
`workload-stats.ts` already uses**: several lecturers on one position each accrue the *full* hours
(parallel subgroups, not a shared stream), and `INDIVIDUALLY` costs `hours × students`. There is no
state norm to apply — наказ МОН № 450 від 07.08.2002 was repealed (наказ МОН № 187 від 16.02.2022) —
so the sheet states its rule in its own text rather than implying an authority for it.

A discipline with hours nobody has been made responsible for is tinted, listed as «не закріплено»,
and counted in the header: closing those gaps is the whole job of a working curriculum, and hours
with no department behind them never become anyone's workload.

**The working curriculum has no legal footing at all** — a stronger statement than the one about the
curriculum. The only act that ever defined it (наказ МО України № 161 від 02.06.1993) said one
sentence about it and was repealed in 2014; the Закон «Про вищу освіту» does not use the term; the
Ліцензійні умови require a working curriculum of schools and kindergartens but ask higher education
institutions only for the curriculum.
[WORKING-CURRICULUM-PDF.md](./WORKING-CURRICULUM-PDF.md) has the full account,
including the trap that two legislation aggregators print the repealed order's sentence *inside*
ст. 10 ч. 4 of the current law.

#### One discipline end to end (`CourseDetailPage`, `/course/:id`)

A `Course` is referenced from four directions — it sits in curricula, those curricula's hour blocks
are handed to departments as working curriculum items, those become lecturer workloads, and those
become classes in the timetable. Until this page existed, seeing any of it meant walking the
degree programme and department pages one at a time and holding the result in your head.

The page walks the chain once and opens with what it adds up to: how many curricula the discipline
appears in and for how many credits, its contact hours against its normative volume, how many
departments deliver it, and how many lecturers and scheduled classes are behind it. Three tabs then
show the levels themselves — «Навчальні плани» (one row per curriculum item, with its hour
breakdown), «Робочі навчальні плани» (one row per delivery position, with its department, format and
groups) and
«Навантаження викладачів» (the same positions with the lecturers actually carrying them, rows
without one tinted).

It now edits, too. «Навчальні плани» creates, edits and deletes the discipline's `curriculum_items`
rows (their `hours` block included, as a nested list); «Робочі навчальні плани» does the same for
the `working_curriculum_items` that hand those hours to a кафедра, including the academic groups and
— when the discipline is an umbrella — the elective actually chosen. «Навантаження викладачів» edits
the `lecturer_workloads` themselves: lecturers, groups, combined groups, duration, the grid of
bells, and where the class may be held. An `ELECTIVE_GROUP` also gains a «Вибіркові дисципліни»
section that lists, adds, renames and detaches its children. The «Семестр» field of the edit form is
where a discipline is pinned to one semester — `courses.semester`, which both curriculum screens
then enforce (see [`V6`](../timetable/README.md#v6__course_semestersql)); it is offered on the child
form too, but a new elective deliberately does *not* inherit its group's value, since the group's
semester belongs to the slot the plan reserves and the child is never a plan position in its own
right. The point is to correct a discipline's whole chain from one page rather than walking degree
programme and department pages one at a time.

Three details there are load-bearing. A nested-list row is sent **with the id it was loaded with**,
because the framework reconciles by id — a row without one is an insert, and inserting a second
ЛЕКЦІЇ row beside the existing one is rejected by `UNIQUE (curriculum_item_id, hour_type)` while the
delete of the original has already been queued; `curriculum_item_hours` cascades to working items,
workloads and timetable entries, so getting this wrong destroys data rather than erroring cleanly.
«Відкріпити» clears `parent_course_id` rather than deleting, because `courses.parent_course_id` is
`ON DELETE CASCADE` and an elective that groups have already chosen and timetabled must not vanish
because someone reorganised a block — and that mutation echoes `name`/`courseType` back, both being
`String!` on `CourseInputPayload`, since an input carrying only the field being cleared is rejected
at coercion. Both destructive buttons state what they cascade to before doing it.

Permissions are asked per row, not per page. A Course grant authorises everything here — both
`CurriculumItem` and `WorkingCurriculumItem` name Course among their `@PermissionParent`s and the
server ORs over the ancestor closure — but it is not the only thing that does: a гарант of one
degree programme may edit that programme's plan positions without any right over the discipline
itself, so the page also asks `accessLevels` for the degree programmes and departments actually on
screen and takes the highest level any of the three scopes yields.

«Розклад занять» places this discipline's classes by hand: day, пара, week parity and room, per
workload, through the same `createTimetableEntry` / `updateTimetableEntry` mutations «Формування
розкладу» writes. The entries are read through `LecturerWorkload.timetableEntries`, so this tab
needed no connection filter at all.

Two rules the database explicitly does not enforce are kept here, because on this page they have no
solver keeping them. The пара picker offers only the slots of the workload's own
`class_start_time_set`, and the room picker only the union of `lecturer_workload_rooms` and the rooms
of `lecturer_workload_room_groups` (naming nothing means no restriction, and the picker falls back to
the faculty's rooms — the same fallback the generator uses). Both are re-checked on save, because a
grid of bells changed after a class was placed leaves stored values that were legal when written.

**Every save is checked for clashes first.** `timetable_entries` has no unique index — the database
cannot tell a double-booking from a legitimate row — and «Формування розкладу» keeps that rule by
handing the solver every competing class as a hard obstacle. Placing classes by hand has no such
step, so the editor asks directly, through the connection's `roomIds` / `lecturerIds` /
`academicGroupIds` filters: is this room, any of these lecturers, or any of these groups already busy
in that slot? A WEEKLY class overlaps both halves of a fortnight, so it clashes with everything;
NUMERATOR and DENOMINATOR pass each other. The card header also shows placed-versus-expected classes
(`hours ÷ weeks × durationHours`, the arithmetic the generator uses) — reported, not enforced, since
placing by hand has legitimate reasons to differ.

The workload editor deliberately leaves two things alone. **`studentAssignments` is never sent** —
a nested list absent from the input is untouched, and the student→supervisor distribution behind an
INDIVIDUALLY position is the department page's to write; for the same reason an individual workload
cannot be *created* here, since it would land with no lecturers, no groups and no pairings and be
completable nowhere on this page. **The candidate pool is never touched**, so the automatic
generator's input survives an edit made here.

Two things it does write are shared with other screens, and both are worth knowing. **Room
eligibility** (`lecturer_workload_rooms` / `lecturer_workload_room_groups`) is also written by the
faculty's «Призначення аудиторій» tab; both send the lists in full, so the later save wins and
neither merges — the faculty tab remains the place that answers "what has nobody assigned yet?"
across a whole faculty. And **combined groups** are offered only for a `SEPARATELY` position,
matching the department page, which force-clears them for every other format.

A workload hangs off *exactly one* of a working item or a combined item
(`lecturer_workloads_target_check`), so the tab walks both: a merged position's teaching is carried
by its combined item, reached through the member's own `combinedWorkingCurriculumItems` relation
rather than a second connection. A merged position therefore offers no «+ Навантаження» button —
adding one there would create a second, parallel assignment beside the combined one, double-counting
the lecturer's hours and double-booking the groups.

It needed three backend changes. `curriculumItemConnection` gained a **`courseId` filter**: `Course`
has no `curriculumItems` relation to walk — its `@OneToMany` fields are `childCourses` and `tags` —
and a filter was narrower than a relation, which would have appeared on every `Course` selection in
the schema. `courseConnection` gained **`parentCourseId`**, so a group's electives are a listable,
creatable collection rather than a read-only relation. And `workingCurriculumItemConnection` gained a
**`courseId`** relation filter that ORs the two senses in which a working item names a course: the
discipline it delivers (its curriculum item's `course_id`, two joins away) and the elective actually
chosen (its own `course_id`). Filtering on only the first would leave an elective's own page with an
empty РНП tab — an elective sits in no curriculum of its own, the umbrella holds the plan position —
and on only the second, every ordinary discipline's.

Its «Інформація» tab also **edits and deletes the discipline**, on the pattern set out under
[Editing and deleting from a drill-down page](#editing-and-deleting-from-a-drill-down-page) below.
The modal covers every `Course` field the generic table offers, `degreeProgramIds` and `tags`
included — so a discipline no longer has to be opened twice, once here to read it and once at
`/course` to change it. The one departure is the **«Група вибіркових»** picker: it lists the
`ELECTIVE_GROUP` courses rather than all several thousand, plus whatever is currently stored even if
it is not one, because an edit form must never silently drop a value the database holds.

#### Lecturer and room pages (`LecturerDetailPage`, `RoomDetailPage`)

The department pages already answer «who is overloaded?» and «who should take this?». The lecturer
page answers what a lecturer asks themselves: «Дисципліни та заняття» lists the workloads they hold —
discipline, kind of work, hours, semester, groups, and how many classes of each are actually
scheduled — and «Розклад» renders their own timetable. Its headline tints when someone holds
workloads but has nothing in the timetable, which is precisely the state that looks fine on every
other screen.

The room page is smaller: details, and the occupancy grid. That view is the one kind of timetable
institutions essentially never publish — ЛНУ offers it as an internal mode of «ПС-Розклад», КПІ has
no room filter at all — and the printed sheet says so.

Both «Інформація» tabs **edit and delete their subject** as well, on the pattern below.

#### Editing and deleting from a drill-down page

`/course/:id`, `/lecturer/:id` and `/room/:id` carry the same two controls `FacultyPage` has always
had, and carry them the same way: **«✎ Редагувати»** in the info tab's `page-header` opening a modal
over the entity's own fields, **«Видалити»** in the page header — shown only while the info tab is
open, since the button acts on the page's subject and not on whatever list is on screen — and a
confirmation modal naming what is about to go. They are gated
separately now — «Редагувати» on `EDIT` and «Видалити» on `FULL`, both derived from one
`accessLevel('COURSE' | 'LECTURER' | 'ROOM', id)` lookup — exactly as described under [Hiding UI the
user can't use](#hiding-ui-the-user-cant-use); the mutation is re-checked server-side regardless.

Three things about the payload are worth stating, because two of them are silent-data-loss traps
rather than preferences:

- **A cleared optional field is sent as an explicit `null`**, following `BaseEntity#buildInput`
  rather than the older `FacultyPage`/`BuildingPage` habit of omitting empty values — a field the
  update omits is left as it was, so on those two pages emptying a box still does nothing.
- **`degreeProgramIds` and `tags` are always sent in full.** Omitting a many-to-many field leaves
  the join table untouched and omitting a nested list leaves its rows untouched, so "I removed the
  last one" has to travel as an empty array.
- **Nothing else nested is sent at all**, and that is the point. `updateLecturer`'s payload also
  accepts `workloadConstraints` and `timetableConstraints`, and `updateRoom`'s accepts
  `timetableConstraints` — a *present* list reconciles, which would delete every rule not repeated
  in it. Leaving them out is what keeps «Обмеження навантаження» and «Обмеження розкладу» the sole
  writers of those rows.

After a delete each page navigates back to where its subject was reached from — a course to its
кафедра then its факультет, a lecturer to their кафедра, a room to its корпус then its факультет —
falling back to the entity's own table, because staying on the page of a row that no longer exists
would only render an empty shell.

#### The travel-time matrix (`BuildingTravelTimesPage`, `/building-travel-times`)

Nineteen корпуси, 342 directed journeys, one screen — the numbers the seeded data happens to hold;
the page draws whatever `buildingConnection` returns. Rows are where a journey starts, columns where
it ends, and every cell is an editable number of minutes. Rows and columns are ordered by address
with `compareUk`, falling back to the building's name where it has no address.

**Why a matrix and not 342 rows in a table.** The value being edited is not a row, it is a relation
between two buildings — and the thing a reader most wants to compare it against is the same journey
walked the other way. A table sorts those two apart; a matrix puts one at (i, j) and the other at
(j, i), so an asymmetry is read by glancing across the diagonal instead of by searching. Lviv is
built on hills and the two numbers genuinely differ, which is the whole reason `building_travel_times`
is directed at all.

Columns are numbered rather than named because nineteen building names will not fit across a screen;
the row headers carry the same numbers with the addresses, so the table is its own legend. The
diagonal is not a cell — a database CHECK forbids a row from a building to itself.

- **A blank cell is a real state**, not a hole. Every ordered pair gets an input whether or not the
  database has a row for it, because a missing journey is entered by typing into the blank; saving a
  cell that had a value and now does not **deletes** the row, which is the only way to take one back
  out.
- **One save for everything touched.** Each edited cell becomes a create, an update or a delete
  depending on what it was and what it now is, and the whole batch goes in one `forkJoin`. Values
  are validated *before* any of it is sent — a half-applied matrix is worse than a refused one — and
  the page reloads from the server afterwards whatever happened, so what is on screen is what was
  stored.
- **«Дзеркально»** copies the edits just made into the opposite direction, for the majority of pairs
  where the walk is flat and the two numbers are the same. It fills the fields; it does not save.
  **«Скасувати»** puts every cell back to what the server last returned.
- **What counts as a value.** A whole number of minutes, zero or more — `0` is legitimate and means
  "no walk worth counting", which is not the same as blank. Edited cells are highlighted until
  saved, and an invalid one is highlighted differently with its reason beside it.
- **Permissions follow the entity's two parents.** A cell is editable when the account holds `EDIT`
  on *either* корпус, which is the same OR the server applies — so a deanery holding one building can
  correct the walks into and out of it without a grant over the university. Emptying a cell deletes
  a row, so it needs `FULL`; that is checked before the batch is sent, so the whole save is refused
  together rather than half of it landing. An account that can edit no building at all is not shown
  the matrix at all: the page is a grid of inputs and a save bar, and with nothing editable in it
  there is no reading left to offer, so it answers «Немає доступу» instead and the sidebar drops the
  link — see [Which screens hide themselves](#which-screens-hide-themselves).

#### Getting to those pages (`.ent-link`)

A page nobody can reach is a page nobody uses, and `EntityMeta.detailRoute`'s «Відкрити →» only
covers the *generic* tables. The hand-written screens name the same three entities constantly —
every plan names disciplines, every workload names lecturers and rooms, every timetable cell names
all three — and until now every one of those was dead text. They are now links, everywhere they are
named:

| Screen | Links |
|---|---|
| degree programme → «Навчальні плани» (`CurriculumItemList`) | discipline |
| degree programme → «Редагування планів» (`CurriculumEditor`) | discipline, on each course block's heading |
| degree programme → «Робочі навчальні плани» (`WorkingCurriculumView`) | discipline |
| degree programme → «Редагування робочих планів» (`WorkingCurriculumList`) | discipline, and the elective actually taught |
| department → «Навантаження викладачів» (`LecturerWorkloadList`) | discipline (plain, elective and combined), every lecturer |
| department → «Зведене навантаження» (`DepartmentWorkloadSummary`) | lecturer |
| department → «Оцінка навантаження» (`LecturerWorkloadDetail`) | lecturer, and the discipline on every line |
| faculty → «Призначення аудиторій» (`RoomAssignmentList`) | discipline |
| faculty → «Формування розкладу» (`FacultyTimetableList`) | discipline, every lecturer |
| the timetable grid (`TimetableView`, all five mounts) | discipline and аудиторія in every cell; the lecturer in the cell, or in the column header where the column *is* the lecturer |
| department → «Об'єднані позиції РНП» (`CombinedWorkingCurriculumItemList`) | the proposal's discipline, and each member's |
| `/lecturer/:id` → «Дисципліни та заняття» | discipline on every line |
| `/me` → «Моє навантаження» and «Мій навчальний план» | discipline on every line |

**The grid links its column headers too**, and that is not symmetry for its own sake: in
`columnMode: 'lecturer'` — the department's «Розклад кафедри» — the cell deliberately omits the
lecturer, because repeating the column's own name under every class of that column is noise. The
header is therefore the *only* place that lecturer is named, and leaving it plain would have made
the one sheet that is entirely about lecturers the one sheet with no link to any of them. `room`
mode gets the same treatment; `group` and `single` headers stay plain (an academic group's page is
out of this pass's scope, and a single column names nothing).

**One class carries all of them.** `.ent-link` in `styles.css` renders as plain text and only
colours and underlines on hover — the rule `.faculty-list-name` and `.building-list-name` already
used. That is not decoration: a timetable cell names three linkable things and a plan table one per
row, so ordinary link colouring would turn a 6×8 grid into a wall of blue and make the *text* harder
to read than it was before. `.ent-link-arrow` is the variant for the one place where the name is
already a control — the surname in «Зведене навантаження» stays the "assess this lecturer" button it
has always been, and a small ↗ beside it goes to their page.

Four small additions to the pure modules carry the ids the templates needed, all of them alongside a
name that was already there: `GridEntry.courseId`, `WorkingPlanRow.courseId`, `StatItem.courseId` and
`WorkloadSource`/`Block.courseId` in the schedule builder. In each case **the id follows the name**:
where a view names the elective actually taught rather than its umbrella `ELECTIVE_GROUP`, the link
goes to the elective — `timetable-grid.ts`'s `courseOf` and `faculty-timetable-list.ts`'s
`courseRefFor` now resolve both together, precisely so the two cannot drift apart.

Two places are deliberately left as plain text. The **room picker** in «Формування розкладу» is a
`<select>`, not a label — the аудиторія there is being *chosen*, and it is reachable from the
timetable grid the moment it is saved. And the generated-plan **preview tables** («Показати зміни»)
describe a plan that has not been applied yet: navigating away from an unapplied plan discards it,
so an inviting link in that table would be a trap.

#### «Мій кабінет» (`MyDeskPage`, `/me`)

Every other screen in this app is a deanery instrument. They ask *how loaded is this department*,
*is this plan within ст. 5*, *where can this class go* — questions asked **about** people by someone
administering them. A lecturer and a student have a much narrower one, and it is about themselves:
**what am I carrying, and when do I have to be where.** Until this page existed, answering it meant
knowing your own id and typing `/lecturer/123`.

What makes it resolvable is `users.lecturer_id` / `users.student_id` (see the [service
README](../timetable/README.md#who-an-account-is-userslecturer_id--usersstudent_id)) — two optional,
mutually exclusive columns saying who an account *is*. `AuthService.personLink` reads them off
`Query.me` and the page renders itself from that: no route parameter, nothing to type, and nothing
to get wrong.

| The account is | Tabs |
|---|---|
| a lecturer | «Моє навантаження» · «Мій розклад» |
| a student | «Мій навчальний план» · «Мій розклад» |
| neither | an explanation, and where to go instead |

**The link is not a permission**, and the page is careful not to imply otherwise: everything on it is
read-only, and a завідувач who is also a lecturer still reaches their department exactly as before.
An account that is nobody in particular — most of the deanery, every administrator — gets a card
saying so rather than an empty grid, and no sidebar link at all.

**One semester control governs the page.** A student comparing their plan against their timetable has
to be looking at the same term in both, so the half-year picker sits in the page header and the
tables *and* the grid follow it; it starts on `current_semester_parity`. This is what
`TimetableView.externalSemesterParity` exists for (see *The five timetables* above) — the alternative
was two pickers that could disagree about which half-year was on screen.

**On the two table tabs that control can be cleared, and a cleared picker is the whole year.**
The reason `SEMESTER_PARITY_OPTIONS` offers only the two halves is about grids — both halves drawn at
once overlay classes that never coexist — and two of this page's three tabs are tables, where the
whole year is exactly what a person often wants: a lecturer's year of teaching, a student's year of
study, in one list, with the «Семестр» column already telling the halves apart. So «Моє
навантаження» and «Мій навчальний план» carry the ✕ (`[clearable]="parityClearable()"`, placeholder
«— весь рік —») and «Мій розклад» does not, and opening «Мій розклад» with the picker empty puts it
back to the half-year the page started on — the grid has to name one half, and the half that is
actually running is the only defensible one to pick on a reader's behalf.

Saying it with an empty value rather than a «Весь рік» option is the point: the absence of a choice
is what "no semester filter" *is*, so `SEMESTER_PARITY_OPTIONS` keeps holding two half-years and
nothing else. Every other picker built from it — the five other screens named under *Option lists are
declared once* — hard-codes `[clearable]="false"`, and this page's own control evaluates to the same
thing on its grid tab.

Three details follow. The reset lives in an `effect` on the open tab rather than in the
tab-click handler, since the tab is part of the URL and also changes on the back button and on a
pasted link. `gridParity()` coerces the value the grid is handed, covering the one change-detection
pass between the section changing and that effect running — an empty parity reaches the backend's
filter as `''`, which matches no row, so the grid would look like missing data rather than like a
filter nobody set. And everything that names the period on screen — the «Показано …» note, the
tiles' captions — reads one `parityTitle()`, so none of them can describe a period the tables are not
showing.

The two halves resolve their data differently, and both differences are forced by the model:

- **The lecturer's figures come from the department's whole tree.** `loadDepartmentWorkloads` +
  `computeStats` are reused unchanged, because distinct-discipline counting and the accounting rules
  (several lecturers on one item each accrue the *full* hours; individual work costs
  hours × students) need every position of the department, not just this lecturer's. Reusing them is
  what makes «Моє навантаження» and «Зведене навантаження» structurally unable to quote different
  totals for the same person — the third view of the same numbers described under *Workload
  statistics*. The annual total and the min/max band are always the **whole year**, whatever the
  picker says, because a ceiling is annual and measuring half a load against it would lie.
- **The student's plan is their programme's plan.** `curriculum_items` hang off a degree programme,
  not off a cohort, and there should be no per-student curriculum: what a student is entitled to see
  is the programme they are enrolled in. Which semesters that means is derived — `semester =
  (academic_groups.course_year − 1) × 2 + half`, the inverse of `courseYearOf` / `halfYearOf` in
  `entities.ts` — so the page needs no field the model does not have.

The timetable tab mounts `TimetableView` in `columnMode: 'single'` for both roles, including the
student. `'group'` would be the obvious choice and is the wrong one: the grid builds a column per
academic group it finds in the returned entries, so a lecture shared with a neighbouring group would
add a column that is not this student's. One column, with the groups named inside the cell, says the
same thing without pretending to be a faculty sheet.

#### The five timetables (`timetable-grid.ts`, `TimetableView`)

One grid, mounted five ways. `buildTimetableGrid(entries, { columnMode, academicHourMinutes })` puts
the day and the class slot down the side and whatever is being compared across the top, and
`columnMode` decides which of the five documents it is:

| Where | `columnMode` | Scope passed | What it is |
|---|---|---|---|
| faculty → «Розклад факультету» | `group` | the faculty's academic groups, narrowed by семестр / курс / освітня програма / група | the timetable a faculty publishes |
| department → «Розклад кафедри» | `lecturer` | the department's lecturers | the lecturer timetable a department works from |
| `/lecturer/:id` → «Розклад» | `single` | that lecturer | one person's classes |
| `/room/:id` → «Розклад» | `single` | that room | the room timetable |
| `/me` → «Мій розклад» | `single` | the signed-in lecturer, or their academic group | one person's own timetable |

`timetableEntryConnection` has no `facultyId` or `departmentId` filter — it filters by
`academicGroupIds`, `lecturerIds` and `roomIds` — so the faculty and department pages resolve their
ids first and pass them in. That is also why the grid is a *pure* module and the loading lives in
`TimetableView`: four pages sharing one query, one grid, one semester filter and one export is four
fewer chances for the same timetable to render four different ways.

An entry appears **once per column it belongs to**: a lecture given to three groups occupies three
cells of a group-column grid. That is what makes a group's column readable top to bottom, and it is
how the published sheets look.

**The semester filter is not optional, and it matters.** `timetable_entries` carry no semester of
their own — it lives two joins away on the curriculum item — so an unfiltered grid overlays autumn
and spring, and rooms appear double-booked when they are not. The picker therefore offers **one
half-year or the other and nothing else**: there is no "весь навчальний рік", because the grid it
produced was not a view of anyone's week — it was two weeks drawn on top of each other. («Мій
кабінет» does allow a whole year, by letting its own picker be cleared, but only for its tables and
never for this grid — see [«Мій кабінет»](#мій-кабінет-mydeskpage-me).) Each view
passes the backend's `semesterParity` relation filter, seeded from the `current_semester_parity`
setting and falling back to `ODD` when that setting cannot be read, so the value is never empty and
the picker always names the half-year on screen. Two consequences of "never empty" are enforced
rather than assumed: the picker passes `[clearable]="false"`, because `SearchSelect`'s ✕ emits `''`
and the backend's parity filter matches no row with it — clearing would empty the timetable and make
it look like the data was missing — and the seed is applied in an `effect` watching
`GlobalPropertiesService.loaded()`, not in a `queueMicrotask`. `ensureLoaded()` is an HTTP round
trip, so a microtask runs before the response and read `null` every time: the stored `EVEN` was
silently discarded on any direct load of a timetable page, and the sheet exported for spring was
headed «І семестр». `TimetableView` also holds its first query until that value is known, so it
fetches the right half-year once instead of the wrong one twice. The read-only
`/timetable` page, which had no such filter and no scope of any kind, has been removed rather than
fixed — `TimetableView` was already the better version of it.

**The faculty tab's bar is семестр, курс, освітня програма, група.** A faculty timetable is the
timetable of its academic groups — `timetableEntryConnection` has no `facultyId` filter — so the
group ids the page passes *are* the scope, and the three filters are a `computed()` over the loaded
group list (`courseYear` is a stored column on `academic_groups`; the connection already filters by
`degreeProgramId` and `facultyId`, so no backend change was needed). Two consequences are handled
explicitly. Filters that between them match no group render their own message rather than the grid's
«Занять у розкладі ще немає» — no groups and no classes look identical and are not the same thing.
And `restrictColumnsToScope` passes `buildTimetableGrid`'s `columnFilter`, because the server
matches an entry if *any* of its groups is in scope and a cell names every group taught together, so
a lecture shared across years would otherwise raise a column for a group the filter excluded. That
filter runs against the scope the entries on screen were **fetched** with, not the current input:
the two differ for the length of a round trip, and filtering the previous response by the new scope
rejects every column at once, which the grid reports as «N не розміщено» in red.

The семестр picker on that tab is the host's, not the view's — see the input below — so all four
controls sit in one bar in reading order, the half-year first: the other three only mean anything
once you know which half-year you are looking at. It alone survives a tab change; the other three
are narrowings of one list, while the half-year is which part of the year the reader is working in.

**One input decides who owns that filter.** `externalSemesterParity` is `null` on the pages that
mounted this component first, and they keep the picker they have always had. «Мій кабінет» and the
faculty's «Розклад факультету» tab set it, which hides the picker and makes the view follow the host — because that page shows a plan and a
timetable side by side, and two half-year controls that can disagree are worse than one. It is
applied in `ngOnChanges`, which runs *before* `ngOnInit`, so setting it also suppresses the
`current_semester_parity` default that would otherwise overwrite the host's choice a tick later.

The one number the grid needs — how long an academic hour is — comes from `global_properties` rather
than a constant, because institutions genuinely differ: ЛНУ and ЗНУ use 40 minutes, КПІ and
Грінченка 45, and a class runs 80 minutes at ЛНУ against 95 at КПІ.

#### The printable class timetable (`timetable-report.ts`)

All five views carry a **«Завантажити PDF»** button, and all five produce the layout ЛНУ actually
publishes — verified against the current sheets of the faculty of applied mathematics and
informatics and the economics and philosophy faculties: day → class slot down the side, groups
across, and a cell reading discipline → kind of class → room → position and surname.

**Only the faculty sheet is a document anyone signs**, and the split runs through one predicate,
`isOfficial(kind)`. The faculty sheet carries the «ЗАТВЕРДЖУЮ» approval block, the МОН → university
→ faculty letterhead, a «ПОГОДЖЕНО» countersignature and a signature block; the department, lecturer,
room and academic-group sheets carry a compact heading, the grid, the bells and the line «Довідковий
документ. Затвердженню не підлягає». This is not tidiness — it is what institutions do. What they approve and
publish is the timetable of academic groups; a lecturer timetable is served from a web service rather
than issued on paper, and a room timetable is an internal instrument of the dispatch office. An
approval block on those would assert an approval that never happened.

A sheet about **one** subject is laid out as a **list** rather than a one-column grid — day · slot ·
time · week · discipline · kind of class · room · plus the other party — because a lecturer reading
their own timetable wants "when and where" in order, and one column stretched across a landscape
sheet gives them neither. That choice is made on the column count, not on the kind, which is why the
fifth kind needed nothing but a title to work.

**`ACADEMIC_GROUP` is that fifth kind**, added for the student half of «Мій кабінет» — the same rows
as the approved faculty sheet, cut to one group, with the викладач in the far column instead of the
groups (a sheet about one group need not be told which group it is). Its note says outright that the
faculty timetable is the one that governs and this is a selection from it: a student printing their
own week should know which sheet wins if the two disagree. It is a довідковий document like the
other three, by the same predicate.

**The class timetable has no legal existence at all**, which is a stronger statement than for either
plan: the term is absent from the Закон «Про вищу освіту», absent from the list of documents
ст. 30 ч. 2 of the Закон «Про освіту» requires an institution to publish, and named in the Ліцензійні
умови only for schools and kindergartens. Even «академічна година 45 хв» and «пара = дві академічні
години» come from the repealed наказ № 161. [TIMETABLE-PDF.md](./TIMETABLE-PDF.md) has the full account, the
per-institution spread of every figure, and what the data model cannot yet express (two-shift days,
per-building bell grids, the order a timetable is put into effect by).

#### Measuring the workload generator (`scripts/workload-bench/`)

`workload-generator.ts` is the one algorithm in the app with a benchmark of its own, because it is
the one whose cost grows with the size of the department rather than with what is on screen.

Two Node scripts, no new dependencies. `generate-datasets.mjs` writes 48 synthetic but believable
department instances — eight scenarios × six sizes from 10 to 320 lecturers, exercising all 21
constraint types, both candidate constraints, every teaching format and both generation modes.
`run-benchmark.mjs` runs the **shipped TypeScript file** over all of them (loaded through Node's
type stripping, not a compiled copy) and reports wall-clock by phase, machine-independent operation
counts, solution quality against an upper bound, and an independent re-check of every plan against
`schema.sql`'s constraint semantics.

```bash
npm run bench:generate     # rebuild data/ — deterministic, byte-identical on any machine
npm run bench              # measure, write results/
npm run bench:check-data   # verify the committed fixtures match a fresh build
```

It was written to answer a specific question and did: the search was quadratic, 87 % of the time sat
in one statement, and fixing it made the whole 48-instance sweep 550× faster while cutting the hours
of load assigned above the statutory ceiling by 98 %. `scripts/workload-bench/README.md` has the
instances, the metric definitions, the before-and-after table, and a list of the things that were
tried and did not work.

#### Measuring the timetable solver (`scripts/timetable-bench/`)

The same idea applied to the harder algorithm, and it went further because the question was harder.

The trap with a timetabling benchmark is that a generated instance may simply have no good answer,
and then a stalled search and an impossible problem look identical. `build.mjs` avoids it by
**constructing a valid schedule first and deriving the instance from it** — it walks the week slot by
slot placing classes into free resources, then reads the courses, cohorts, eligibility and every
availability constraint back off the finished schedule. A perfect answer therefore provably exists
for every instance, and the hidden schedule doubles as the yardstick each result is quoted against.
`validate.mjs` re-scores what the solver returns from the schema semantics alone, sharing no code
with it — which caught two real bugs that a self-scoring solver would have reported as improvements.

```bash
cd scripts/timetable-bench
node experiment.mjs --repeats 25    # the full study: 10 sizes × 25 repetitions, resumable
node bestknown.mjs                  # refresh the best-known table
node fleet-sim.mjs                  # check the worker portfolio's completion arithmetic
```

50 instances (25 → 12,800 classes) are committed with the 375 measurements taken during the study.
`scripts/timetable-bench/README.md` explains the methodology and the flags;
[SOLVER-OPTIMISATION.md](./SOLVER-OPTIMISATION.md) records what the study concluded — including the
seven mechanisms that were built, measured and rejected.

#### Workload constraints (`LecturerConstraintList`, department "Обмеження навантаження" tab)

One card per lecturer of the department, each showing **all 21** `lecturer_workload_constraints`
types — set or not — as a compact grid: hours-per-year and the overall course maximum on top, then a
3×3 table of min/max pairs (Усі / Обов'язкові / Вибіркові × Лекції / Практичні / Лабораторні). A
blank field means "not set", and leaving it out of the saved nested list is what deletes a stored
row. `MAX_HOURS_PER_YEAR` shows the `default_max_hours_per_year` global property as its placeholder,
since that is the ceiling that applies when it isn't set.

The rules only make sense together, so a card is validated as a whole on every keystroke:
minimum ≤ maximum for each pair; a MANDATORY/ELECTIVE maximum never above the maximum for that hour
type or the overall course maximum; a per-hour-type maximum never above the overall one; the
MANDATORY and ELECTIVE *minimums added together* never above the maximum for that hour type (they
are disjoint subsets, so both have to fit); and a minimum-hours value never above the effective
maximum, whether that comes from the lecturer's own `MAX_HOURS_PER_YEAR` or from the global default.
A card that breaks any of these takes a red tint, the specific fields involved go a brighter red,
every broken rule is listed in plain Ukrainian, and **saving is blocked** — contradictory
constraints would make workload generation unsatisfiable rather than merely wrong.

Saving is one `updateLecturer` mutation per card (the constraints ride along as the
`workloadConstraints` nested list), so a lecturer's whole set is replaced atomically.

#### Timetable constraints (`TimetableConstraintList`, three tabs)

*When* a lecturer, an academic group or a room may be given classes — the inputs a scheduler has to
satisfy, as opposed to the hour ceilings above. **One component serves all three subjects**, because
the generated GraphQL schema gives them the same shape: a `SUBJECTS` record holds everything that
differs (namespace, connection, filter argument, mutation entity, the extra fields to select, the
label to show, and the Ukrainian titles), and two inputs pick a row of it — `subject` and `scopeId`.
It is mounted three times:

| Tab | `subject` | `scopeId` | Rows |
|---|---|---|---|
| department → "Обмеження розкладу" | `lecturer` | department id | every lecturer of the department |
| faculty → "Обмеження груп" | `academicGroup` | faculty id | every academic group of the faculty |
| faculty → "Обмеження аудиторій" | `room` | faculty id | every room of the faculty |

One card per subject, holding a small table of rules. Each rule is a day (`усі дні` or one weekday),
a kind, and a value whose editor follows the kind through an `@switch`: a number input for
**Не більше пар**, one `TimeSelect` for **Починати не раніше** / **Закінчувати не пізніше**, and a
pair of them for **Не займати проміжок**. Every card's rules are also summarised as chips on its
header, so a page of eighty lecturers can be skimmed without opening any of them, and a search box
plus a "лише з обмеженнями" toggle narrow the list.

The **"more specific wins"** rule documented in `schema.sql` is stated in the legend above the cards
and implemented in `effective(rules, type, day)`, which resolves what actually applies on a given
day — the day's own rule if it has one, otherwise the every-day rule. That resolution is what makes
the cross-rule check meaningful: a `NOT_BEFORE` later than the `NOT_AFTER` that governs the same day
leaves no room for anything, whether both are day-specific or one comes from the every-day rule.

Validation runs on every keystroke and, as in `LecturerConstraintList`, a card that fails takes a
red tint, the offending rows go brighter red, each broken rule is listed in plain Ukrainian and
**saving is blocked**. It covers everything the database would reject before the round trip —
a missing or non-integer count, a missing time, a window whose end is not after its start, and a
second rule of the same single-valued kind on the same day (the partial unique indexes) — plus the
contradictions only visible across rules.

Saving is one `update<Entity>` mutation per card, the rules riding along as the
`timetableConstraints` nested list, so a subject's whole set is replaced atomically and a removed
rule is deleted by not being sent. Because the mutation's input payload is the *whole* entity, the
component sends the subject's required scalars back unchanged alongside the list
(`meta.required(node)` — a lecturer's first and last name, a group's name/year/study form/degree
programme, a room's number); omitting them would blank them. "Очистити" only empties the card and
marks it dirty — the empty list reaches the server on the next "Зберегти", like any other edit, so a
mis-click is undone by "Скасувати" rather than by re-entering the rules.

#### Lecturer workloads (`LecturerWorkloadList`, department "Навантаження викладачів" tab)

Pre-loads every `WorkingCurriculumItem` delivered by the department (with its curriculum item /
hours context), grouped semester → discipline → hour-type → working-curriculum-item, and lets
the user assign, per item, a `LecturerWorkload`: lecturers (`MultiSelect`), academic groups
(`MultiSelect`, scoped to the item's own groups), combined groups (`MultiSelect`, only shown
when the item's `teachingFormat` is `SEPARATELY` — "together" has nothing to combine), and a
**duration** (`SearchSelect` over 1–4 academic hours) that defaults from the
`default_class_duration_hours` global property when creating a new workload, or from the
workload's own stored value when editing one.

One further field says *on which bells* the class runs, and appears whatever the teaching format —
it applies to individual consultations just as much:

- **Часи початку занять** (required) — the `ClassStartTimeSet` its classes are scheduled on, e.g.
  the separate grid physical education runs on. `lecturer_workloads.class_start_time_set_id` is
  `NOT NULL`, so an empty picker is caught here, in Ukrainian, rather than at the database; a new
  workload starts on the set marked as default.

It is echoed in the workload tree as the "Дзвінки" column. Its options are fetched **unfiltered and
narrowed client-side**, deliberately: the backend's `facultyId` filter matches the column exactly,
so asking for this faculty's sets would drop precisely the university-wide ones
(`faculty_id IS NULL`) that most workloads use.

**Where a class may be held is not set here.** It used to be — two further multi-selects in this
same modal, beside the lecturers and the duration — and that put a faculty-wide resource inside a
per-department form: a кафедра editing its own teaching load was also, in the same dialog, laying
claim to rooms shared with every other department, and there was nowhere to see which classes had
been given no room at all. Rooms belong to the faculty (`rooms.faculty_id`), the timetable that has
to fit in them is built at faculty level, and so is the assignment — see [«Призначення
аудиторій»](#where-each-class-is-held-roomassignmentlist-faculty-призначення-аудиторій-tab) below. Saving a workload
here cannot disturb it: `roomIds`/`roomGroupIds` are simply absent from this mutation's input, and a
many-to-many field left out is left untouched.

When the item's `teachingFormat` is **`INDIVIDUALLY`** (a coursework consultation, say) the modal
swaps shape entirely: the group pickers, the lecturer multi-select and the duration field all
disappear, replaced by a **roster** — every student of the item's academic groups, listed by
default, each with a lecturer dropdown — written through `LecturerWorkload.studentAssignments`
(see the backend's `lecturer_workload_students`). Listing the whole cohort up front rather than
adding pairs one at a time is what makes filling a group in quick; a "призначено N із M" counter
and a marker on assigned rows keep the remaining gaps scannable, and "Очистити всіх" starts the
roster over without reopening the modal.

An empty lecturer means "not assigned": that row is simply not sent, so clearing a student's
lecturer omits their entry from the nested list and the backend deletes the stored pairing. Four
details follow from the model rather than being cosmetic:

- `lecturerIds` is *derived* from the distinct lecturers actually assigned, so `lecturers` can
  never disagree with who supervises whom;
- `academicGroupIds` is force-cleared for individual items and `studentAssignments` force-cleared
  for group ones, so switching an item's format never leaves half a stale assignment behind;
- one row per student makes `UNIQUE (lecturer_workload_id, student_id)` structurally unreachable,
  rather than something to guard against;
- an existing pairing whose student is no longer in any of the item's groups is appended to the
  roster instead of being dropped, so opening the form never silently deletes it.

Independently of the teaching format, every workload's modal also carries a **candidate pool**:
each lecturer of the department with a desirability score from 1 (last resort) to 100 (ideal), a
blank score meaning "not a candidate". This is the input automatic workload generation reads — the
generator chooses among a workload's candidates rather than the whole department — so it is
deliberately separate from the lecturers actually assigned. Scores outside 1..100 (or fractional)
are highlighted and block the save rather than being clamped. The workload table lists the pool as
a muted "кандидати:" footnote under the lecturers cell, best score first, so no extra column is
needed.

For `INDIVIDUALLY` items each scored candidate also gets a **бажана** and a **максимальна кількість
студентів** (`lecturer_workload_candidate_constraints`): generation first tries to give everyone
their desired count, then hands out the remaining students among candidates with headroom, in
descending order of desirability. Blank means unset — an unset maximum is unbounded, not zero. The
fields only appear for individual work, and are never sent for any other format, so switching an
item's teaching format clears them rather than leaving them to apply silently.

Because a candidate owns those limits and the backend's nested lists only go one level deep, the
pool is **not** part of the workload's payload: `save()` writes the workload first, then reconciles
candidates through their own create/update/delete mutations, skipping rows whose values are
unchanged (an untouched pool costs no extra requests). If the workload saves but part of the pool
fails, the modal says so explicitly rather than reporting a clean save.

Duration is not offered because individual work is always one academic hour per student
(`INDIVIDUAL_DURATION_HOURS`), sent implicitly; the workload table drops its "Тривалість" column
for those items and shows "Викладач"/"Студент" as two aligned columns instead. Candidate students
come from the item's own academic groups, fetched in one round trip via aliased
`studentConnection` calls (that connection takes a single `academicGroupId`). Working curriculum items already merged into a
`CombinedWorkingCurriculumItem` (see below) are excluded from this tree — assigning a workload to
one of those covers every merged item at once, so they're handled in a dedicated section above
the tree instead, using the same modal (`openCreateCombined`/`openEditCombined`) with the
available academic groups widened to the union across every merged member.

#### Workload statistics (`workload-stats.ts`, `workload-tree.ts`, `department-workload-summary.ts`)

Three views read the same numbers, so they cannot disagree:

- the **department summary**, "Зведене навантаження" (`DepartmentWorkloadSummary`) — one row per
  lecturer with total annual hours, the hours falling in each half-year, their own minimum and
  maximum (blank when unset, with the global default shown in brackets when it is what applies),
  the signed deviation from the allowed band, hours by kind of work, and hours for
  lectures/practicals/labs split by mandatory and elective disciplines. Rows outside their band are
  tinted and the deviation itself rendered louder — `+6` for an overload, `−6` for a shortfall;
  lecturers carrying nothing are greyed. Any hours column can be sorted (largest first on the first
  click, since that is where the outliers are) and the list can be narrowed by name or to just the
  rows that deviate. **Filtering never changes the department's totals**: the page header and the
  "Разом по кафедрі" footer row always count every lecturer, and a separate "Разом за фільтром" row
  appears above it while rows are hidden — a total that silently switches to meaning "this one
  lecturer" is worse than no total. Clicking a name opens that lecturer's assessment, and the ↗
  beside it opens their own page;
- the **same table embedded** at the top of "Обмеження навантаження" (`embedded` mode: no header,
  no toolbar, no assessment link — the surname there is a plain link to the lecturer's page), so a
  limit can be read beside the load it governs;
- a **per-lecturer drill-down**, "Оцінка навантаження", where a picker selects one lecturer and
  shows the same totals, then every constraint measured against what they actually carry, then every
  position they deliver grouped into the first and second half-year, each with its own subtotal.

`workload-stats.ts` is the arithmetic (pure, and testable on its own — though see the note about
test infrastructure under [Notes / known limitations](#notes--known-limitations)); `workload-tree.ts` is the query that
flattens a department's working and combined curriculum items into its input. Both accounting rules
match the generator exactly: several lecturers on one item each accrue the **full** hours, and
individual work costs `hours × students supervised`. Items merged into a combined item are counted
once, through the combined item, rather than twice.

One subtlety worth knowing: `distinctCourses` counts only disciplines with LECTURE, PRACTICAL or LAB
hours, because that is how `MAX_COURSES` counts them. A course a lecturer only consults on consumes
hours but is not a discipline they "teach" for constraint purposes — counting it would make the
figure disagree with the limit it sits beside.

#### Printable workload calculation (`pdf-writer.ts`, `workload-report.ts`, `pdf-fonts.ts`)

"Оцінка навантаження" carries a **«Завантажити PDF»** button that produces the paper form a
department head signs — «РОЗРАХУНОК НАВЧАЛЬНОГО НАВАНТАЖЕННЯ науково-педагогічного працівника на
20\_\_/20\_\_ навчальний рік» — for the lecturer currently selected. It is written **entirely on the
client**: nothing is sent to the server, and the file downloads straight from a `Blob`.

Three files, and the split matters:

- **`pdf-writer.ts`** — a dependency-free PDF engine. It parses a TrueType file (`head`, `hhea`,
  `hmtx`, `maxp`, `cmap` formats 4/6/12), embeds it as a `CIDFontType2` under `Identity-H`, emits a
  `ToUnicode` CMap so the result stays selectable and searchable, and offers text, wrapping, lines,
  rectangles and a bordered table renderer that breaks across pages and repeats its header.
  Coordinates are **millimetres from the top-left corner**, because that is the vocabulary the
  document rules are written in; font sizes stay in points, as in Word. A table header may also be
  a **grid of several rows** (`headerRows`, whose cells carry `colSpan` *and* `rowSpan`), which is
  what lets the curriculum sheet write «Кількість годин» over «Аудиторні заняття» over «лекції /
  практичні / лабораторні» the way it is spoken; the block is measured once and repainted on every
  page the table runs onto.
- **`workload-report.ts`** — the document itself, pure and framework-free like `workload-stats.ts`:
  it takes a `LecturerStats` plus the department context and returns bytes, so it can be rendered
  under Node in a test as easily as in the browser. It does no arithmetic of its own beyond summing
  rows, so the sheet and the screen cannot disagree.
- **`pdf-fonts.ts`** — the browser-side glue: fetches the font subsets lazily on the first export,
  caches the parsed faces for the session, and triggers the download.

**The whole engine is a lazy chunk.** Every export handler reaches its report through a dynamic
`import()` — `pdf-fonts`, the report module and `workload-report` are pulled in only when the button
is pressed. Three sheets now share `pdf-writer.ts`, none of them on the path a user takes to look at
a timetable, and together they are ~90 kB of the bundle; keeping them out of `main` is the same
bargain the font subsets already make, and it is what brings the build back under its 1 MB budget.
The cost is that the three `downloadX()` methods are `async` and set `exporting` in a `finally`.

**Why a hand-written writer rather than jsPDF/pdfmake.** Two reasons. The project has no runtime
dependencies to speak of and every algorithm here is hand-written (`workload-generator.ts`,
`workload-stats.ts`, `sort.ts`), so a 300 KB library for one button is out of proportion. And it
would not have saved the hard part anyway: the fourteen fonts every PDF viewer ships are Latin-1
only, so a Ukrainian document needs an embedded Unicode face whichever route is taken.

**The font.** `public/fonts/LiberationSerif-{Regular,Bold}.ttf` are **subsets** — Latin, Cyrillic
and the punctuation these documents use — which brings each face from ~340 KB down to ~16 KB. They
are fetched on demand, so a user who never exports pays nothing. Liberation Serif is
metric-compatible with Times New Roman (the face ДСТУ documents are set in), covers Ukrainian
including ґ/є/і/ї, and is redistributable under the SIL Open Font License. To regenerate them:

```
pyftsubset LiberationSerif-Regular.ttf \
  --unicodes="U+0020-007E,U+00A0,U+00AB,U+00BB,U+00B0,U+00B7,U+0401,U+0404,U+0406,U+0407,\
U+0410-044F,U+0451,U+0454,U+0456,U+0457,U+0490,U+0491,U+2013,U+2014,U+2018,U+2019,U+201C,\
U+201D,U+2022,U+2026,U+2116,U+2212" \
  --layout-features='' --no-hinting --drop-tables+=GSUB,GPOS,GDEF,DSIG,kern,prep,fpgm,cvt \
  --output-file=LiberationSerif-Regular.ttf
```

A character outside that set renders as `.notdef` rather than failing — add its code point above and
re-subset if one is ever needed.

The document's structure, and what in Ukrainian practice each part answers to, is written up in
[WORKLOAD-PDF.md](WORKLOAD-PDF.md). In short: the «ЗАТВЕРДЖУЮ» approval block, the МОН → university
→ faculty → department letterhead, the title, the staff member's details and the legal basis on the
title sheet; then the summary figures, the distribution of hours by kind of work, and the load itself
by half-year with per-half and annual totals, followed by a signature block. Landscape A4, margins
30/10/20/20 mm, page numbers from the second sheet — ДСТУ 4163:2020.

**"Відповідність обмеженням" is deliberately left out.** Those bounds are an internal planning aid
of this system, not a reviewable attribute of the workload, and a signed form should not carry
them.

#### Automatic generation (`workload-generator.ts`)

The "Навантаження викладачів" tab opens with a generation panel offering two modes: **лише
незаповнені та неповні** (fill workloads with no lecturers, or fewer than their item's
`lecturerCount` — a lab needing two with only one assigned) and **перевизначити всіх** (reassign the
whole department from scratch). Nothing is written until you press «Застосувати»: generation produces
a plan, and the panel shows what would change, which slots it couldn't fill, and which lecturer
minimums remain unmet.

The algorithm lives in `workload-generator.ts`, deliberately free of Angular, GraphQL and I/O so it
can be unit-tested against plain objects — the component maps the loaded tree into its input shape
and applies the returned plan itself. **[WORKLOAD-GENERATION.md](./WORKLOAD-GENERATION.md)
documents it in full**: the constraint semantics, each phase with pseudocode, complexity bounds, a
worked example, what is and isn't guaranteed, and where to take it next. The summary below is the
short version.

Assigning lecturers to slots so as to maximise total desirability, subject to per-lecturer ceilings
on annual hours and on distinct-course counts, is an integer program. Rather than pretend otherwise,
it runs three passes:

1. **Most-constrained-first greedy.** Slots are filled in order of how few feasible candidates they
   have — a slot with one viable lecturer must claim them before a slot with ten takes them for a
   marginal gain — and each slot then prefers the highest desirability, breaking ties toward the
   lecturer with the most headroom so the pool doesn't bottleneck.
2. **Repair.** Where a lecturer sits below a `MIN_*` floor, move an assignment to them from someone
   above theirs, if both are candidates and the move stays feasible. Strictly decreasing total
   deficit, so it terminates.
3. **Improvement.** Single moves that raise total desirability without breaking a ceiling or
   undoing a satisfied floor, to a fixed point or an iteration cap.

Ceilings (`MAX_*`, plus `default_max_hours_per_year` when a lecturer sets none) are hard — never
violated, even at the cost of leaving a slot unfilled, which is reported instead. Floors (`MIN_*`)
are soft: reported when unmet rather than forced. Distinct-course counting is set-based, so a second
lab in a course a lecturer already teaches costs nothing. With several lecturers on one item each
accrues the **full** hours, matching subgroup teaching.

In **gaps** mode, assignments that already exist are locked — the repair and improvement passes
cannot move them however much desirability a swap would buy, since "only fill what's missing" is the
whole promise of that mode.

INDIVIDUALLY workloads are distributed by student rather than by slot: each candidate is brought up
to their `MIN_STUDENTS` in order of desirability, then the remainder goes to the most desirable
candidate with headroom below `MAX_STUDENTS`, load only breaking ties between equals. Students that
don't fit anywhere are reported.

#### Merging working curriculum items (`CombinedWorkingCurriculumItemList`, department "Об'єднані позиції РНП" tab)

Finds every `WorkingCurriculumItem` belonging to the department that **isn't** already merged
into a `CombinedWorkingCurriculumItem`, groups the candidates that share course + semester +
hour type + hours (these are the ones a single lecturer could plausibly teach together as one
shared class, e.g. the same lecture required by two degree programmes), and proposes merging each
group into a new combined item via the `workingCurriculumItemIds` many-to-many mutation field —
after which it shows up in `LecturerWorkloadList`'s "Об'єднані позиції" section instead of the
plain tree.

#### Where each class is held (`RoomAssignmentList`, faculty "Призначення аудиторій" tab)

One card per class — one `lecturer_workloads` row — carrying a **three-way choice** of where the
class is held, because the three are alternatives rather than three independent fields:

| Choice | What the card offers | What a save sends |
|---|---|---|
| **В аудиторії** | the two multi-selects **Аудиторії** and **Групи аудиторій**; the eligible rooms are the **union** of the two, and naming nothing means no restriction | `roomIds`, `roomGroupIds`, and `abstractRoomIds: []`; deletes any online row |
| **Абстрактна аудиторія** | one `SearchSelect` over `AbstractRoom` — a place several classes legitimately occupy at the same hour (спортивні зали, «дистанційно») | `roomIds: []`, `roomGroupIds: []`, `abstractRoomIds: [<one id>]`; deletes any online row |
| **Онлайн** | optional платформа, посилання and нотатка | all three lists empty, and the online row created or updated |

`LecturerWorkload.abstractRooms` is a list in GraphQL and at most one row in the database —
`lecturer_workload_abstract_rooms` is keyed on the workload alone — which is why the card offers a
single choice and sends a 0- or 1-element array. And the online row's **presence** is the fact that
the class is online; its three columns only say how to attend, and all of them may be empty. That is
why the mutation set is create/update/delete rather than a field on the workload's payload, and why
a save here is up to **two** requests: `updateLecturerWorkload` first, then the online row (the
namespace is `lecturerWorkloadOnlineClasss`, with three s's — the schema builder pluralises by
appending one). The order is chosen for its half-done state: clearing the rooms and failing to write
the online row leaves a class the board tints red, while the reverse would leave a class claiming to
be in two places at once with nothing on screen saying so. The card stays in «Збереження…» until both
have settled.

An unassigned class — no room, no room group, no abstract room, not online — is the reason this page
exists as a board of cards rather than a column in a table. "No restriction" is not an error — it
schedules perfectly well — but it is almost never what anyone *decided*, and until this page it was
invisible: a лекція for 120 students would quietly become eligible for a 12-seat lab, and nobody
found out until the generated timetable was read. **Such a card is tinted red**, and the header
counts them, so the question "what has nobody assigned yet?" is answered by looking rather than by
auditing.

The card is a sibling of «Формування розкладу»'s (`.tt-block`, same header and record rows), but the
unit is deliberately different: that page splits a workload into its individual weekly/biweekly
**sessions**, because each is scheduled separately. Eligibility is not per session — it is stored
per workload and every session of it shares one list — so splitting the cards there would show N
copies of one editable value.

Three filters, combinable, and each is server-side where the backend can express it:

| Filter | Where |
|---|---|
| Семестр (parity) | server — `semesterParity` on both working-item connections; defaults to `current_semester_parity` |
| Кафедра | server — `departmentId` on `workingCurriculumItemConnection`, `departmentIds` on the combined one |
| Освітня програма | **client** — neither connection carries a `degreeProgramId` relation filter, the degree programme being two levels down on the curriculum item |

The degree programme options are the faculty's own degree programmes **union every degree programme
actually on screen**, because the two sets differ in a way that matters: a department of this
faculty teaching a service discipline to another faculty's degree programme produces a class listed
here — it is this faculty's teaching load — whose degree programme
`degreeProgramConnection(facultyId:)` would never return, leaving that class unfilterable. The
converse gap is real and deliberate: a degree programme of this faculty whose discipline is
delivered by another faculty's department is that faculty's class to place, and is assigned on its
page.

The room half still writes the same two join tables through the same `updateLecturerWorkload`
mutation the department modal always used. Two details are load-bearing. All three id lists are sent
**in full**, including when empty, because an empty array is the meaningful value here ("no
restriction", or "not there any more") and an omitted many-to-many field would leave the stored rows
alone instead. And `durationHours` is echoed back untouched, because it is `NOT NULL` in the database
and therefore `Int!` on `LecturerWorkloadInputPayload` — an update that omits it is rejected by
GraphQL validation before it reaches the resolver, however little it has to do with rooms.

Anything already assigned but outside the offered options — a room of another faculty, a group
scoped elsewhere, an abstract room of another faculty — is merged into the option lists on load.
Without that, a multi-select would render the value as an unchecked blank and the first save would
silently drop it. The three option lists are all fetched **unfiltered** and narrowed client-side to
this faculty's rows plus the unscoped ones, because the server's `facultyId` filter is an equality on
the column and would drop exactly the shared rows most often wanted — which for an abstract room is
the usual case, not the exception.

One draft is not saveable: «Абстрактна аудиторія» with nothing chosen. It would write the same
emptiness as «В аудиторії» with nothing chosen, so the mode a reader saw afterwards would not be the
one they left the card in; saying "no restriction" is what «В аудиторії» is for.

#### Building the schedule (`FacultyTimetableList`, faculty "Формування розкладу" tab)

Auto-generates one schedulable **block** per class session required by every `LecturerWorkload`
delivered by the faculty's departments, and lets the user assign each block a day of week, class
start time and room (plus week parity for biweekly blocks), creating/updating/deleting the
corresponding `TimetableEntry`.

- A **semester parity** picker (ODD/EVEN) scopes which working/combined curriculum items are
  considered, defaulting to the `current_semester_parity` global property; changing it re-fetches
  from `workingCurriculumItemConnection`/`combinedWorkingCurriculumItemConnection` with the
  `facultyId` + `semesterParity` relation filters described in the backend README, so the
  frontend never has to fetch the whole system and filter client-side.
- **Block count** — how many weekly-recurring classes a workload's `curriculumItemHours.hours`
  requires — is `hours / (semester_duration_weeks × workload.durationHours)` (both the semester
  length and the per-class duration are configurable per-workload/global-property values, not
  hardcoded); a remainder of at least half a weekly class becomes one additional class held every
  other week (`NUMERATOR`/`DENOMINATOR` week parity). The semester length in that division is the
  one global property for every programme alike: the per-programme lengths entered on [«Тривалість
  семестрів»](#semester-lengths-degreeprogramsemesterlist-тривалість-семестрів) are stored but not
  read here yet, so a semester recorded as ten weeks is still planned as sixteen.
- The **start-time dropdown is per block**, not global: `classStartTimeOptionsFor(block)` offers
  only the times of the `ClassStartTimeSet` the block's workload runs on, and the block header names
  that set ("Дзвінки: …"). A flat list would be wrong twice over now that ordinals restart within
  each set — "2. 10:10" and "2. 10:40" would sit side by side with nothing to tell them apart, and a
  physical-education class could be put on the main bells, which is the very thing the sets exist to
  prevent.
- Each block shows a computed **end time** — `startTime + durationHours ×
  academic_hour_duration_minutes` — once a class start time is chosen, since `ClassStartTime`
  only stores possible start times, not a fixed end time.
- Blocks are keyed by position (`workloadId::wk|bi::index`) so an in-progress, not-yet-saved
  selection survives the reload that follows scheduling a different block, and sorted with every
  unscheduled block first, then by day → start-time ordinal → parity → course name.

#### Automatic timetable generation (`timetable-solver.ts`, `timetable-solver.worker.ts`)

The same tab opens with a generation panel offering the same two modes the workload generator does —
**лише невизначені заняття** (place only the blocks with no `TimetableEntry` yet) and
**перевизначити весь розклад** — plus a search budget (10 s … 2 min). Pressing «Згенерувати розклад»
opens a modal that reports the search live: the phase, the objective function `f(σ)` decomposed per
constraint, how many blocks are placed, and the iteration count with moves-since-improvement. (It
used to report an adaptive intensity and a temperature as well; both belonged to the annealing search
that measurement retired, so rather than show frozen numbers they were removed.) Nothing is written
until «Застосувати», which then shows exactly what would change.

The solver is a University Course Timetabling heuristic using the objective function of
*"Adaptive Memetic Algorithm for University Course Timetabling"* —
`f(σ) = Σ βᵢ·Πᵢ(σ)^αᵢ` with `β = (150, 100, 50, 90, 120, 50, 5, 20, 30)` over lecturer/group/room
conflicts, group/lecturer travel between buildings, abstract rooms holding more students than they
seat, lecturer/group windows and days that mix online with in-room classes — reached by a
most-constrained-first greedy construction followed by a **move-level stochastic local search**:
one move at a time from a composite neighbourhood, evaluated incrementally, accepted by late
acceptance, with an ejection chain that switches itself off once the search stops improving. The
article's two-phase annealing search was measured and retired — its repair phase reached a local
optimum in its first iteration and never moved again. Several searches run **concurrently** on
different seeds and the best schedule wins, which is worth about 20% at no cost in wall clock.
**[TIMETABLE-GENERATION.md](./TIMETABLE-GENERATION.md) documents it in full**: the formulation,
every deviation from the paper, the constraint semantics, complexity bounds, and what is and isn't
guaranteed. [SOLVER-OPTIMISATION.md](./SOLVER-OPTIMISATION.md) records the study that produced the
current search, including the negative results, and `scripts/timetable-bench/` is the harness it was
measured with — instances built around a hidden feasible schedule, an independent scorer, the raw
measurements, and `experiment.mjs`, which reruns the whole study on your own hardware. Measured
there: **12,800 class sessions scheduled with zero hard violations in two minutes** on two cores.

Four things about it are specific to scheduling *one faculty inside a shared university*:

- **Rooms, lecturers and groups are shared.** Before searching, the tab reads the current timetable
  of every room this faculty's workloads may use, of every lecturer of the faculty, and of every
  academic group involved — whoever owns those classes — through the `roomIds` / `lecturerIds` /
  `academicGroupIds` relation filters on `timetableEntryConnection` (three aliases in one request,
  since connection filters compose with AND and what is wanted is OR). Classes belonging to other
  faculties are loaded as **immovable**: the generator schedules around them and never rewrites
  them, but it will not clash with them either.
- **Every scheduling constraint is hard.** `NOT_BEFORE`, `NOT_AFTER`, `UNAVAILABLE` and
  `MAX_CLASSES_PER_DAY` for lecturers, groups *and* rooms filter candidate placements outright,
  resolved with the "more specific wins" rule; so do the workload's allowed rooms and its own grid
  of bells. A block with no admissible placement is reported by name rather than squeezed in.
- **The university is nineteen buildings, so distance is a constraint.** The same request reads each
  room's building and the whole of `building_travel_times`, and a pair of classes one group or one
  lecturer cannot walk between in the gap they are given counts against the objective as hard as a
  double booking does. Where no travel times are stored the terms are skipped and the generator
  behaves exactly as it did before they existed. See
  [TIMETABLE-GENERATION.md](./TIMETABLE-GENERATION.md) §1.2 and §2.5.
- **The plan is applied in batches, and never deletes.** Updates go out first (a move frees the slot
  it leaves), then creates, 25 per GraphQL document under aliases, so a full faculty is about twenty
  requests rather than several hundred. A block the solver could not place keeps whatever entry it
  already had and is reported as «не переплановано» — a heuristic running out of options is not a
  reason to remove a class.

#### Curriculum limits are settings (`plan-limits.ts`, `GlobalPropertiesService`)

Every figure a plan is measured against — hours per ЄКТС credit, programme volume per degree, the
elective share, the ceilings on disciplines and examinations per semester, the annual volume and its
tolerance — is a row in `global_properties`, not a constant. Fourteen of them, seeded by `data.sql`
with the figures the Закон «Про вищу освіту» states, and every one editable on «Глобальні
властивості».

They had to move for two different reasons. The statutory ones change when the law does — ст. 62
ч. 1 п. 15 was rewritten by Закон № 3642-IX in 2024 — and the practice ones differ between
institutions by design, since ст. 32 leaves the form of the educational process to each institution.
Neither is something an institution should have to fork the client to change.

Three consequences worth knowing:

- **A cleared limit is not a limit.** An emptied field means «не встановлено», and the check resting
  on it is dropped from the screens *and* from the printed «Відповідність» table — a signed sheet
  must not carry a verdict against a rule nobody put in force. `hours_per_ects_credit` is the sole
  exception: it is arithmetic rather than a rule, every total is computed from it, so clearing it
  falls back to 30 instead of leaving the totals undefined.
- **The screens name the figure, the documents name its source.** A `ComplianceCheck` now carries
  `norm` (a bare «180–240 кредитів ЄКТС») and `source` (ст. 5 …) separately. The tabs render `norm`
  alone — quoting an article beside a number an administrator chose would attribute their decision
  to the legislature — while the PDFs keep the citation, in a «Підстава норми» column of their own.
- **`GlobalPropertiesService` holds the table**, loaded once per session and re-read after a save,
  so a changed limit reaches all four plan tabs rather than only the page it was edited on. Its
  `limits` is a **computed signal**, which is what makes a component's own `computed()` re-run when
  the settings arrive instead of memoising the defaults (see the zoneless note above). Two older
  screens still fetch `default_max_hours_per_year` with a query of their own — see [Notes / known
  limitations](#notes--known-limitations).

#### Global settings (`GlobalPropertiesPage`, `/global-properties`)

The settings editor, **grouped and type-driven**. The table is a flat name/type/value store, and a
flat list of it reads as unrelated switches; what an administrator wants is "what an academic year
is" in one place and "what a curriculum must look like" in another. So the page renders five
sections —
Освітній процес · Навчальне навантаження · Обсяг освітньої програми · Обсяг за освітніми ступенями ·
Обмеження навчального плану — each with a sentence saying what it governs, and each property with a
hint under its label. A row seeded straight into the database that this build does not know about
still appears, under «Інші налаштування», labelled by its raw name: unknown is not the same as
uneditable.

**The type drives the editor and the validation instead of being a column.** `INTEGER` gets a
whole-number field that refuses a fraction, `DECIMAL` a fractional one, `BOOLEAN` a checkbox, `ENUM`
a dropdown (`current_semester_parity` is still the only one, and its ODD/EVEN options are still
hard-coded, since `global_properties` carries no allowed-values metadata). A column reading
"INTEGER" told a reader nothing they could act on; a field that will not accept `3.5`, and a save
button that stays disabled with «Потрібне ціле число» beside it, say the same thing where it
matters. A limit marked optional may be emptied — that is how a check is switched off — while a
property the system computes from is required and says so.

Saves still go through the single `updateGlobalProperty(name, value)` mutation described in the
backend README, and then refresh `GlobalPropertiesService` so the plan screens follow.

### Reusable form controls

All are standalone `ControlValueAccessor` components usable with `[(ngModel)]`:

- **`SearchSelect`** — select2-like single-value searchable dropdown (used for every to-one FK).
- **`MultiSelect`** — checkbox-list dropdown with tag display, for many-to-many fields (both
  hand-written pages, e.g. `academicGroupIds`, and the generic CRUD tables' `multiref` field
  type, e.g. `Course.degreeProgramIds`).
- **`TimeSelect`** — an hour dropdown (6–21 by default) and a minute dropdown (00–55, step 5)
  bound to a single `"HH:mm"` string, so only valid slot times can be entered. It emits a value
  only once both halves are chosen, and keeps an already-stored off-grid value (an imported
  `07:07`, say) selectable rather than dropping it from the list — opening an edit form must never
  silently rewrite what is in the database. Used by the `'time'` field type in `entities.ts`.
- **`DeptFacultySelect`** — a faculty filter paired with a department `SearchSelect` whose options
  are narrowed to the chosen faculty, defaulting to the edited entity's own faculty and clearable
  to reach a department elsewhere. The generic tables render it automatically for any `ref` field
  carrying a `parentFilter` — `Lecturer.departmentId` and `RoomGroup.departmentId`; the two drill-down child lists
  (`curriculum-item-list.ts`, `working-curriculum-list.ts`) build the same behaviour inline from a
  `filteredDepartmentOptions` computed signal, because their department select sits inside a larger
  hand-written form rather than the metadata-driven one. `LecturerDetailPage`'s edit modal is the
  third kind of consumer and the simplest: a hand-written form that mounts the component itself,
  since a кафедра picker with no faculty filter over every department in the university is the one
  field of that form nobody could use.

### Academic terms (`entities.ts`)

`curriculum_items.semester` counts semesters across the whole programme: 1–8 for a bachelor's,
up to 11 in the real data. Nobody at a department thinks in those numbers — they say "третій курс,
друге півріччя". The stored value is unchanged; only its presentation is, through four helpers in
`entities.ts`:

```ts
courseYearOf(6)   // 3      — Math.ceil(semester / 2)
halfYearOf(6)     // 2      — odd semesters are the first half-year, even the second
termLabel(6)      // "3 курс — друге півріччя"
termLabelShort(6) // "3 курс, 2 півр."   (compact form, for table cells)
```

plus `HALF_YEAR_LABELS` / `HALF_YEAR_TITLES` (lower case for use inside a phrase, capitalised for a
heading of its own) and `HALF_YEARS` — `[1, 2]`, so a view can render both halves in teaching order
even when one of them is empty, rather than only the halves the data happens to contain.

Keeping this in one place matters because the two directions are not symmetric: a semester maps to
exactly one (course year, half-year) pair, but a half-year spans every course year at once. The
grouping in "Оцінка навантаження" and the two half-year columns in "Зведене навантаження" both
group by `halfYearOf(...)` across the whole programme and still show the course year per row, which
only stays consistent while both read the same helper.

This vocabulary is applied in the two workload assessment views ("Зведене навантаження" and
"Оцінка навантаження"), and half-applied in "Робочі навчальні плани", which shows the course year
and the semester as separate columns because a working curriculum is scoped by the first and ordered
by the second. The workload
tree itself, the curriculum editor, the curriculum item and working curriculum item tables, the
combined-items section and the schedule builder still label things "Семестр N" — see [Notes / known
limitations](#notes--known-limitations).

### Ukrainian sorting (`sort.ts`)

Every alphabetical sort in the UI goes through `compareUk` from `sort.ts` — never
`String.prototype.localeCompare` directly:

```ts
const collator = new Intl.Collator('uk');
export const compareUk = (a, b) => collator.compare(a ?? '', b ?? '');
```

`localeCompare(b)` with no locale uses the *browser's* locale, so the same list comes out ordered
differently for a user running an English UI than a Ukrainian one — and the English ordering is
wrong for Ukrainian text, sorting `Ґ` before `Г` where Ukrainian puts it after. Pinning the locale
keeps the order identical for everyone and matches how the database sorts, since `schema.sql`
declares the same alphabet on its text columns via `COLLATE ukrainian` (see the backend README's
*Text collation*). This matters wherever the UI re-sorts what the API returned: if the two
disagreed, a client-side sort would visibly reshuffle a list the server had already ordered.

A shared `Intl.Collator` is also markedly faster than a `localeCompare` call per comparison, which
is noticeable on the larger lists (a degree programme can have 200+ courses).

### Routes (`app.routes.ts`)

| Path | Component | Notes |
|---|---|---|
| `/login` | `LoginPage` | one of five routes with no guard |
| `/register`, `/forgot-password` | `AccountRequestPage` | **lazy** — no guard; one component, `data.mode` apart: the form that asks for an address and reports what the service found |
| `/register/:token`, `/reset-password/:token` | `AccountLinkPage` | **lazy** — no guard; one component again: the form a link from an e-mail opens, which sets the password |
| `/change-password` | `ChangePasswordPage` | `authGuard` only — reachable while `mustChangePassword` is set |
| `/admin` | `AdminPage` | **lazy** — `authGuard` + `adminGuard`; user/group/access management and the person link |
| `/` | `FacultyHome` | faculty tiles, drill-down entry point |
| `/faculty/:id/:section` | `FacultyPage` | **lazy** — tabbed faculty detail, incl. the «Доступ» tab |
| `/building/:id/:section` | `BuildingPage` | building detail |
| `/department/:id/:section` | `DepartmentDetailPage` | **lazy** — department detail, incl. the «Доступ» tab |
| `/degree-program/:id/:section` | `DegreeProgramDetailPage` | degree programme detail incl. working curricula |
| `/academic-group/:id/:section` | `AcademicGroupDetailPage` | group detail |
| `/course/:id/:section` | `CourseDetailPage` | **lazy** (`loadComponent`) — one discipline across curricula, working curricula and workloads; edits/deletes it |
| `/lecturer/:id/:section` | `LecturerDetailPage` | **lazy** — one lecturer: workloads, classes taught, personal timetable; edits/deletes them |
| `/room/:id/:section` | `RoomDetailPage` | **lazy** — one room and its occupancy; edits/deletes it |
| `/me/:section` | `MyDeskPage` | **lazy** — «Мій кабінет»: own workload or curriculum, and own timetable |
| `/global-properties` | `GlobalPropertiesPage` | **lazy** — system-wide settings editor |
| `/building-travel-times` | `BuildingTravelTimesPage` | **lazy** — «Час переходу між корпусами»: the directed travel-time matrix |
| `/building` | `BuildingHome` | building tiles (this entity's table is a page of tiles, not a table) |
| `/:single` | generic `entity-pages.ts` component | one per remaining entity, at the kebab-case of its `single` — see [Generic CRUD tables](#generic-crud-tables-entitiests--baseentity) |

One piece of route `data` carries a permission decision: `gatePage`, set on the generic table routes
whose entity `entity-pages.ts` marks `editorsOnly`. It is what tells `BaseEntity` that this table
*is* the screen rather than a tab of one, and therefore that it should answer «Немає доступу» when
the caller can neither add a row nor edit one — see [Which screens hide
themselves](#which-screens-hide-themselves). The same components embedded in a faculty or department
page carry no such data and stay readable.

The four self-service routes carry no guard, and none may: a викладач with no account and a user who
has forgotten their password are exactly the two people who cannot sign in first.
The token is a **path segment** rather than a query parameter so that the service's
`FrontendController` serves it — that controller matches each segment as `[^.]*`, and a base64url
token contains no dot, so a reloaded or pasted link reaches this router rather than the
static-resource handler.

The sidebar (`app.html`) links to the drill-down entry point ("🎓 Факультети") and — only when the
signed-in account is linked to a lecturer or a student — to «📅 Мій кабінет»,
then a flat "Загальне" group of generic-table links for entities with no dedicated page
(`/building`, `/room-group`, `/abstract-room`, `/class-start-time-set`, `/class-start-time`,
`/academic-degree`) plus «Час переходу між корпусами» and the global settings page ("Глобальні
властивості"), and — only for an administrator — an
"Адміністрування" group holding the single "Користувачі та права" link.
Every link in that group except «Корпуси» is hidden from an account the screen behind it would
refuse, on exactly the answer that screen gives, so a visible link always opens something usable;
«Корпуси» stays because it is also the way to a корпус and its аудиторії, and its own buttons are
gated instead. The top bar carries the
signed-in user's name, an «АДМІН» badge where it applies, and the password / sign-out controls.
`CombinedGroup` has no sidebar link of its own — it's only reachable embedded in the Faculty page's
"Об'єднані групи" tab (see above), not as a route of its own.

«Мій кабінет» is hidden rather than shown-and-empty for an account that is neither: a deanery
administrator has no навантаження and no навчальний план of their own, and reaches every timetable
from the faculty, department, lecturer and room pages already. Typing `/me` still works and explains
itself.

The three detail pages added last — `/course/:id`, `/lecturer/:id`, `/room/:id` — have no sidebar
link either, and that is deliberate: nobody navigates to a discipline or a room from a menu, they
arrive from the list they were already reading. Every such list carries an «Відкрити →» link in its
last column, driven by `EntityMeta.detailRoute` (see [Generic CRUD
tables](#generic-crud-tables-entitiests--baseentity)), so the route is reachable from wherever the
entity is mentioned rather than from one place. They are three of the thirteen `loadComponent`
routes in the file. Each pulls in `TimetableView`, the grid and — on the Course page — the whole aggregation
of curricula and workloads, and the cost of deferring them is one extra request the first time a
user opens one.

The other ten are there on the same reasoning, and the list has grown as the application has. «Мій
кабінет» mounts `TimetableView` and is opened only by an account that is a person; the
administration console carries its own queries, including the full lecturer and student lists behind
the person pickers, and is opened only by an administrator; `/global-properties` and
`/building-travel-times` are single-purpose editors with stylesheets of their own; the four
self-service routes are two components between them, each a whole screen opened once in the lifetime
of an account. `FacultyPage` and `DepartmentDetailPage` moved the most: `FacultyPage` alone pulls in
every tab it can show — the department, degree programme and group lists, the room and course pages,
the constraint editors and the timetable view — and it is not on the path to the one screen most
people open the application for. Together the thirteen take the initial chunk from just over the
1.00 MB error budget to **738 kB**.

The budget is worth stating plainly, because it is the thing that keeps forcing these decisions: the
production build *fails* above 1.00 MB and warns above 500 kB. Anything added to a route that is
eager pays that toll on every cold load, including the student who only ever reads a розклад.

### The open tab is part of the URL (`section-route.ts`)

Each of the nine tabbed pages above is **two** route entries, not one:

```ts
{ path: 'faculty/:id', pathMatch: 'full', redirectTo: '/faculty/:id/info' },
{ path: 'faculty/:id/:section', canActivate: [authGuard],
  loadComponent: () => import('./faculty-page').then((m) => m.FacultyPage) },
```

The tab used to live in a component signal, which meant «Кафедри», «Освітні програми» and
«Аудиторії» were all the same address as «Інформація» — `/faculty/3`. That address could not be
bookmarked, sent to a colleague, reloaded, or reached with the browser's Back button; every one of
those led back to the first tab. Now the tab *is* the last path segment, so what is on screen and
what is in the address bar are the same thing.

The redirect is what keeps that from being a half-measure: a bare `/faculty/3` — an old bookmark, a
link written before this change, a `routerLink` in a list — resolves to `/faculty/3/info`, so every
screen has exactly one canonical URL and nothing that used to work stopped working. `:id`
substitution in a `redirectTo` string is the router's own, so the redirect needs no code. `/me` is
the one exception and the one function, because its default tab is not a constant: a викладач lands
on «Моє навантаження», a студент on «Мій навчальний план». A `RedirectFunction` runs in an injection
context, so it asks `AuthService` which of the two this account is.

`sectionNav` in `section-route.ts` is the whole of the component side — three lines per page:

```ts
private nav = sectionNav<FacultySection>(
  () => ['/faculty', this.facultyId], () => SECTION_KEYS, () => 'info');
readonly activeSection = this.nav.active;

selectSection(key: FacultySection) { this.nav.select(key); }
```

Four things it settles, each of which was a decision:

- **The section key stays camelCase and the URL slug is its kebab-case.** `roomAssignment` is the
  union member the templates `@switch` on and `/faculty/3/room-assignment` is the address;
  `kebabCase` is the only place the two forms meet, so no page carries a second table of names. The
  same function names the generic tables — `roomGroup` → `/room-group` — because there is one
  convention for identifiers in this app's URLs, not two.
- **`activeSection` is read-only.** Navigation is the only thing that changes it, which is what makes
  Back and Forward work; `DepartmentDetailPage.openAssessment` — the "who is overloaded?" → "why?"
  jump — goes through `selectSection` like a click does.
- **Switching tabs does not rebuild the page.** `/faculty/3/departments` and `/faculty/3/rooms` are
  the same route *configuration*, so the router reuses the component instance and only the parameter
  changes. The page's queries run once, exactly as when the tab was a signal — which is why the
  parameter is read from `paramMap` rather than from `snapshot`.
- **An unrecognised slug falls back rather than rendering nothing.** `keys()` may be a computed:
  `CourseDetailPage` passes `sections()`, whose «Вибіркові дисципліни» exists only on an
  `ELECTIVE_GROUP`, so a pasted `/course/:id/electives` for a course that is not one — like changing
  the course's type in the edit modal, or walking from an umbrella to one of its children — lands on
  «Інформація» instead of leaving `@switch` matching no case at all.

One consequence worth stating: work that used to hang off the *click* now hangs off the section
*changing*, in an `effect`, because a pasted URL and the Back button change it without a click.
`FacultyPage` clears each tab's filters that way, and `CourseDetailPage` loads the four picker
connections that only «Навантаження викладачів» and «Розклад занять» need — so a deep link to either
tab arrives with its pickers filled, which a click-handler version would not do.

Served from the packaged jar, a deep link is answered by `FrontendController`; see the [service
README](../timetable/README.md#serving-the-frontend-from-this-service) for how it tells a client
route from a request for a real file.

### One flat namespace, and the check that keeps it honest

The generic tables were once at `/e/:single` — `e` for entity, and the segment after it the entity's
GraphQL singular verbatim, so `/e/roomGroup`. Both halves of that were the schema showing through
rather than anything anyone chose: the prefix said "generated route" to whoever wrote the generator,
and camelCase in a path is what an identifier looks like when it is used as a URL without being asked
whether it reads like one. Neither survived being read next to `/faculty/3/room-assignment`, so the
prefix is gone and the singular is kebab-cased: `/room-group`, `/academic-degree`,
`/class-start-time-set`. The old `/e/…` paths were not kept alive — they fall through to `**`.

`pathMatch: 'full'` on each table is what lets `/faculty` (every faculty) and `/faculty/3/departments`
(one of them) be different screens without either shadowing the other, and it is why `BuildingHome`
now sits in `ENTITY_TABLE_ROUTES` rather than above them: `/building` *is* the Building table's path,
it just renders tiles instead of rows.

What the prefix bought for free was collision safety. `ENTITY_TABLE_ROUTES` is generated from
`entities.ts` and `PAGE_ROUTES` is written by hand, and in a flat namespace nothing stops the two from
claiming the same address — add an entity whose `single` is `admin`, `me` or `login` and one of the
pair simply stops opening, quietly, depending on which comes first in the array. A dev-mode check at
the bottom of `app.routes.ts` compares the two lists and throws at startup, where the entity is being
added, rather than leaving it to be found in whichever screen went dark. Today the sets are disjoint:
every hand-written path that shares a first segment with a table carries `/:id` after it.

---

## Authentication

An account arrives one of two ways. An administrator creates one (`/admin`, see below) with a
temporary password the account has to replace on first sign-in. Or a викладач or a студент whose
own row carries an e-mail address creates their own, by following a link sent to it — see
[Registration and password recovery](#registration-and-password-recovery-accountrequestpage--accountlinkpage).
There is no way to register as somebody the university has never entered: the service checks
`lecturers` and then `students` for the address before it will send anything.

### Session state (`AuthService`)

A single root-provided service, injected the same way `GraphqlService` is used everywhere else:

- `token` (signal) — the JWT, persisted to `localStorage` (`lnu_timetable_token`) so a page
  refresh doesn't sign the user out; `isAuthenticated` is just `token() !== null`. A stored token
  already past its `exp` never reaches the signal — see [When the session ends by
  itself](#when-the-session-ends-by-itself).
- `currentUser` (signal) — the result of `Query.me` (profile, `isAdmin`, `groups`,
  `permissions`, each grant carrying the `level` it was made at, and the two fields the service
  works out from those grants — `globalLevel` and `creatableResourceTypes`, see [What the client
  knows, and where it gets it](#what-the-client-knows-and-where-it-gets-it)), re-fetched via
  `refreshMe()` after login and on app bootstrap when a token is already stored. Deliberately
  **not** decoded from the JWT itself — the token only carries a user
  id — so a permission change or account deactivation is reflected the moment `refreshMe()` runs
  again, without needing a new token.
- `login(email, password)` / `logout()` / `changePassword(current, new)` — thin wrappers around the
  corresponding mutations. `login` clears any stored token first, because sign-in is an
  unauthenticated operation and a leftover token would only make the service report *its* failure on
  that response.
- `requestRegistration(email)` / `requestPasswordReset(email)` / `accountLink(kind, token)` /
  `redeemAccountLink(kind, token, password)` — the four self-service operations, all
  unauthenticated. The last one adopts the JWT the service hands back, so redeeming a link signs
  the caller in on the spot; `adoptSession(token)` is that step, and is what `login` does with its
  own token by another name.
- `endSession(reason)` / `clearSession(reason)` / `sessionEndReason` (signal) — ending a session
  that stopped working, as opposed to one the user signed out of. The reason is what `LoginPage`
  turns into «Термін дії сеансу минув…» instead of presenting an unexplained empty form.
- `accessLevels(resourceType, ids)` / `accessLevel(resourceType, id)` — given ids of one entity
  type, asks `Query.accessLevels` for the caller's level on each, backed by a per-`resourceType`
  cache (`clearAccessCache()` invalidates it, called after granting or revoking access) so
  re-rendering an already-checked list doesn't re-query. The cache stores "no access" as
  deliberately as it stores a level: without that, every re-render re-asked about every row the
  user cannot touch — which, on a faculty page seen by a visitor, is all of them.
- `globalLevel` (computed) — the caller's university-wide level, if they hold a `GLOBAL` grant.
  `MANAGE` is what `isAdmin` means; `EDIT` or `FULL` is somebody trusted with everything except
  handing the right away. It is `CurrentUser.globalLevel` as the service answers it now; the old
  scan of `permissions` for a `GLOBAL` row is kept behind it, so a client running against a service
  that predates the field still gates as it did rather than treating everybody as holding nothing.
- `canCreateType(type)` / `holdsGrantOfType(type)` / `canReachType(type)` — answered synchronously
  off `me`, because a sidebar link cannot wait for a round trip to decide whether to exist — plus
  `accessModel()`, the published cascade fetched at most once a session, `levelForNew(type, input)`
  built on it, and `resolveNeed(need)`. These are the questions a screen asks *before* it draws
  itself, as opposed to `accessLevels` above, which is about rows already loaded; see [What the
  client knows, and where it gets it](#what-the-client-knows-and-where-it-gets-it) and
  [Requirements as values](#requirements-as-values-access-needts-access-gatets).
- `personLink` / `hasPersonLink` (computed) — `'lecturer' | 'student' | null`, from the
  `lecturerId`/`studentId` on `Query.me`. **Deliberately not a permission**: it decides only whether
  «Мій кабінет» has anything to show, and therefore whether its sidebar link appears. Everything a
  user may *edit* still comes from `permissions` and is re-checked server-side (see below).

`authInterceptor` (an `HttpInterceptorFn`) attaches `Authorization: Bearer <token>` to every
outgoing GraphQL request when a token is present — and reads the service's verdict on that token off
every response coming back.

### When the session ends by itself

The service issues a token that lives 12 hours (`app.security.jwt-ttl-minutes`). A tab left open
overnight outlives it, and what used to happen next was nothing at all: `authInterceptor` kept
attaching the dead token, the service dropped it silently, `Query.me` returned `{ me: null }` with
no error, and no part of this client read that as "your session is over". Worse, `authGuard`
positively waved it through — a stored token made `isAuthenticated()` true, `refreshMe()` resolved
without throwing, and `decide()` then read `mustChangePassword()` off a `null` user as `false` and
returned `true`. The user stayed on a page whose every subsequent request failed.

Three independent mechanisms now end it, because no single one covers every way a session can die:

1. **Locally, from the token itself.** `AuthService` decodes the `exp` claim (base64url payload,
   UTF-8, no signature check — that is the service's job and only the service's job). A stored token
   already expired is dropped in the constructor rather than trusted for being present, and
   `tokenForRequest()` refuses to attach one that has expired since, with a 5-second skew allowance
   covering the flight time of the request and a clock or two that disagree. `isAuthenticated()` is
   therefore false by the time `authGuard` looks, and the redirect happens before a round trip.
2. **On a timer.** `armExpiryTimer()` fires at the moment the current token dies, so an idle tab
   showing «Мій кабінет» returns to the login page on its own instead of displaying data it can no
   longer refresh. It re-checks the token when it fires rather than trusting the delay — a laptop
   asleep across the expiry wakes to a late timer, not a skipped one.
3. **On the service's word.** `authInterceptor` watches every response for `X-Auth-Error` or an
   `errors` entry with `extensions.code = "UNAUTHENTICATED"`, and calls `endSession()` with the
   reason. This is the one that catches what the client cannot know by itself: a rotated signing
   key, an account deactivated mid-session, a clock far enough out that the local check passed.

All three converge on `clearSession(reason)`, and the reason survives the navigation so the login
page can say which of the three it was. `authGuard` also no longer reads a `null` `me` as success:
holding a token and being nobody is a contradiction, and it now clears the session and redirects —
keeping whatever more precise reason `authInterceptor` already recorded rather than overwriting it.

An `UNAUTHENTICATED` code is what ends a session; a `FORBIDDEN` one never does. The backend picks
between them by whether anyone is signed in at all (see the service README's [When a token
expires](../timetable/README.md#when-a-token-expires)), which is what stops "you may not edit this
faculty" from logging anybody out.

### Route guards (`auth.guard.ts`)

**Both guards can wait, and both have to.** Angular runs a route's `canActivate` guards
*concurrently*, not one after another, and takes the first non-`true` answer in declaration order.
`/admin` carries two — `authGuard` then `adminGuard` — so on a cold load they reach for the session
in the same tick, and `adminGuard` used to answer from an empty one: `isAdmin()` read `null` while
`authGuard` beside it was still fetching `me`, so it returned a redirect, and the redirect won. The
symptom was narrow enough to hide for a long time: `/admin` worked perfectly when clicked from the
sidebar, because the profile was already loaded by then, and bounced to the faculty home every time
it was bookmarked, pasted or reloaded. It now resolves the profile the same way `authGuard` does,
and `AuthService.refreshMe` shares one in-flight request between however many callers ask, so the
two guards cost one `me` query rather than two.

- **`authGuard`** — redirects to `/login` (with a `redirectTo` query param) when there's no
  signed-in user; redirects to `/change-password` when `mustChangePassword` is still set (except
  for that route itself). Applied to every route except `/login`. A stored token whose profile
  hasn't been fetched yet is resolved via `refreshMe()` first, and a `me` of `null` — or a thrown
  request — ends the session rather than passing.
- **`adminGuard`** — additionally requires `isAdmin`; applied only to `/admin`.

### Login → forced password change

`LoginPage` shows a notice above the form when the user did not choose to be there — an expired
session, a token the service refused, an account deactivated mid-session — read from
`sessionEndReason` and styled apart from the red of a rejected password, because it is information
rather than a failed attempt.

`LoginPage` (`/login`) posts to `AuthService.login`, then calls `refreshMe()` before navigating —
if the account still has `mustChangePassword` set, it's sent to `/change-password`
(`ChangePasswordPage`) regardless of where it was headed; otherwise it lands on the original
`redirectTo` target or `/`. `ACCOUNT_DISABLED` and invalid-credentials errors from `login` are
surfaced as distinct messages.

### Registration and password recovery (`AccountRequestPage` / `AccountLinkPage`)

Four routes, two components, and the pairing is the interesting part.

**`AccountRequestPage`** (`/register`, `/forgot-password`) is a field for an e-mail address, a
button, and a sentence about what the service found. Which of the two forms it is arrives as route
data, and it is a signal rather than a constant — so the page can switch from one to the other
**without a navigation**, which is the whole reason the two share a component.

That switch is what makes the registration screen worth having. Somebody who cannot get in does not
know whether they have an account; «зареєструватися» is what they reach for either way. Answering
«обліковий запис із такою адресою вже існує» and stopping there would leave them exactly as stuck,
so the answer carries the next step with it: one button, already holding the address they typed,
that sends the recovery link instead. The reverse runs in the other direction — `UNKNOWN_EMAIL` on
the recovery form offers registration.

The six statuses the service can answer with each get their own two sentences, in one of three
tones: a link is on its way (green), something is true of this address that the reader has to act on
(amber — already registered, not eligible, already linked, asked too recently), or the send itself
failed (red). `NOT_ELIGIBLE` is the one worth the longest text, because it is the one where nothing
the reader does on this screen can help: it says who may register themselves and that an
administrator is who to ask otherwise.

**`AccountLinkPage`** (`/register/:token`, `/reset-password/:token`) is what a link in an e-mail
opens. It asks the service what the link is worth **before anything is typed**, and the four answers
lead to four different places: expired or superseded by a newer mail → «замовте нове»; already
redeemed → «увійдіть»; not a link at all → «перевірте, чи скопійовано його повністю»; and
`UNAVAILABLE`, where the link is fine but what it points at has changed under it — the account was
deactivated, or came into being some other way, inside the thirty minutes — where nothing on this
screen can help and another link would fail the same way, so none is offered. A refusal that comes
back from the *submission* and is about the link rather than about the password re-renders the page
as that same dead-link screen, since there is nothing useful left to do with a form whose second
attempt cannot work either.

What it asks for is a password and its confirmation, and nothing else. The name above the form —
read off the викладач or студент row the link belongs to — is displayed rather than edited: it was
entered by the кафедра that entered the person, and a registration form is not where a surname is
corrected. On success the service returns a JWT, `redeemAccountLink` adopts it, `refreshMe()` runs,
and the user lands on `/` already signed in, with «Мій кабінет» in the sidebar if they are a person.
Asking somebody to sign in with a password they chose ten seconds ago, on the screen they chose it
on, is a step that exists only because sessions are usually created somewhere else.

Both are `loadComponent` routes. Each is a whole screen opened once in the lifetime of an account,
and the initial bundle is close to its budget; the cost is one request the first time a link from an
e-mail is followed.

### The shell, when there is nothing to navigate

`app.html` renders the sidebar only when `AuthService.canNavigate()` — signed in, `Query.me`
resolved, and past any forced password change. Signed out, the login form is the whole page: no menu
of «Корпуси» / «Наукові ступені» / «Глобальні властивості» beside it advertising links that bounce
straight to `/login`, and no user block in the header either.

`canNavigate` is deliberately stricter than `isAuthenticated()`, which is true in two states where a
menu would be a lie. It is true the instant a token is stored, before `Query.me` has said anything
about its owner — so the sidebar would render before the permissions that decide half of what it
shows. And it stays true through the whole forced change-password screen, where `authGuard` returns
every one of those links to `/change-password` anyway. Both states last about one request; a menu
that appears and then refuses to work is worse than one that waits.

The header stays throughout, because the crest and the university's name are not navigation — only
the user block inside it is gated. `.layout.no-sidebar` drops the content padding so the sign-in
card centres in exactly what is left below the header rather than in a viewport-tall block that
pushes a scrollbar.

### Hiding UI the user can't use

Access is not one boolean any more. A grant carries an ordered **level** — `EDIT` < `FULL` <
`MANAGE` — and the client mirrors the backend's `AccessLevel` in `access-level.ts`, which is the
only place the ordering, the Ukrainian labels and the one-line explanations live:

| Level | Label | What it opens in the UI |
|---|---|---|
| `EDIT` | Редагування | «+ Додати» and «Редагувати» |
| `FULL` | Повний доступ | the above, plus «Видалити» |
| `MANAGE` | Керування доступом | the above, plus the «Доступ» tab |

Every list/table in the app — both the generic `BaseEntity` tables and the hand-written drill-down
widgets (`DepartmentList`, `DegreeProgramList`, `AcademicGroupList`, etc.) — follows the same
pattern:

1. After loading a page of rows, batch-call `auth.accessLevels(resourceType, ids)` and store the
   resulting `id -> level` map. Rows the caller cannot reach at all are simply absent from it.
   The call is skipped only for a university-wide `MANAGE`; anything weaker still has to ask,
   because a grant on an individual row can be *stronger* than the global one.
2. `canEdit(row)` and `canDelete(row)` gate «Редагувати» and «Видалити» **separately** — the two
   buttons are no longer the same right, and this is the one place the split is visible to a user.
   Somebody who maintains a table every day sees «Редагувати» without «Видалити» beside it.
3. A separate check gates «+ Додати», and it asks about the row the new one would hang off rather
   than about the account in general. `DepartmentList` requires `EDIT` on its own faculty, since
   creating a `Department` needs `EDIT` on the `Faculty` it would belong to — exactly the edge
   `PermissionEvaluator#levelForNew` walks on the backend. `BaseEntity` does the same when it is
   embedded under a parent, reading which of its `presets` name a permission parent off
   `Query.accessModel` (below) rather than off a list kept here, and falls back to «could this
   account create one of these anywhere» when the parent is chosen inside the form instead.

   That replaced a heuristic worth naming, because its symptom is what this whole section was
   rewritten for: «+ Додати» used to appear whenever the account held *any* grant at all. A викладач
   whose grant was one кафедра was therefore offered «+ Додати корпус» on «Корпуси» — and a корпус
   belongs to no кафедра, so the service refused it with «Creating a Building here requires EDIT
   access.» The button was never the wrong colour; it was answering a different question than the
   server was.

#### What the client knows, and where it gets it

Two things have to be true before a control can be hidden honestly: the client has to know what this
account holds, and it has to know the shape of the hierarchy that turns a grant on a факультет into
the right to add a discipline under one of its кафедри. The first has always been on `Query.me`. The
second used to have nowhere to come from, which is why the guess above existed — the alternative was
a copy of the cascade written in TypeScript, correct on the day it was written and silently wrong the
first time an entity was added.

Both are answered by the service now, from the annotations it authorizes writes with:

| Where | What |
|---|---|
| `CurrentUser.globalLevel` | this account's university-wide level, or null — no longer scanned out of `permissions` by hand |
| `CurrentUser.creatableResourceTypes` | the entity types it could create something of *somewhere*, worked out from its grants and the cascade |
| `Query.accessModel` | the cascade itself: per resource type, its foreign-key parents (with the input field naming each), its join-table parents, and whether it is a `@PermissionRoot` that only a `GLOBAL` grant reaches |

`accessModel` is constant for the lifetime of the service, so `AuthService` fetches it once and
shares the one request; `me` was already fetched once, and the two new fields ride along on it. On
top of them sit three questions the rest of the client asks in one line each:
`canCreateType(type)`, `holdsGrantOfType(type)` and their union `canReachType(type)` — «is a screen
about this kind of thing worth offering at all».

`creatableResourceTypes` is a **type-level** answer: "possible somewhere", not "possible here". That
is the right resolution for deciding whether to draw a button or a whole screen, and the wrong one
for deciding whether a particular write will be accepted — which is why nothing in the client uses
it for the latter, and why the row-level `accessLevels` call above still exists.

#### Requirements as values (`access-need.ts`, `access-gate.ts`)

Every permission question above is asked in the component that has it. That works for a button next
to the row it belongs to, and stops working once the same answer has to be given twice — by a page
and by the sidebar link that leads to it, or by a tab strip and by the body behind the tab. Written
twice, they agree until one of them is edited.

An `AccessNeed` is that requirement stated as a value, in one of three shapes:

| Shape | Example | Asks |
|---|---|---|
| a row | `rowNeed('FACULTY', id)` | this account's level on that факультет, or on anything above it |
| university-wide | `globalNeed()` | the `GLOBAL` level — `global_properties` belongs to no entity, so nothing cascades into it |
| anywhere of a kind | `anywhereNeed('CLASS_START_TIME_SET')` | `canReachType` — something of this kind to add, or one already this account's to edit |

`AuthService.resolveNeed` answers all three, and `<app-access-gate [need]="…">` renders its content
when the answer is yes and `<app-no-access>` when it is no — nothing at all while the answer is in
flight, because a screen that shows its controls and then withdraws them is worse than one that
waits.

**«Немає доступу» is a card where the page would have been, not a redirect.** A guard that bounces
somebody to the faculty home answers a pasted `/faculty/3/timetable` with a screen they did not ask
for and no reason given; the URL stays meaningful this way, and the card names the level that is
missing, for the same reason the service's denial message does — somebody holding «Редагування» in
front of a screen that needs «Повний доступ» learns what to ask their deanery for.

One caution about binding it: `AccessGate` re-resolves whenever the bound need changes identity, so
the need must be a stable reference — a `computed`, or a value cached per key. A getter that builds
a fresh `rowNeed(...)` on every read never stops re-asking.

#### Which screens hide themselves

Three kinds, all gated through the same `AccessNeed`:

- **Whole screens that exist only to enter data.** «Глобальні властивості» (`GLOBAL` at `EDIT`),
  «Час переходу між корпусами» (`EDIT` on some корпус), and the reference-data tables marked
  `editorsOnly` in `entity-pages.ts` — «Наукові ступені», «Набори часів занять», «Часи початку
  занять», «Групи аудиторій», «Абстрактні аудиторії». A generic table refuses only when it is the
  whole screen (`data.gatePage` on its route) *and* the caller can neither add a row nor edit one it
  already holds; the same components embedded as a tab of a faculty or department page stay
  readable, because reading is open to any signed-in user by design.
- **Tabs of a drill-down page whose whole purpose is entering data** — «Призначення аудиторій»,
  «Обмеження груп», «Обмеження аудиторій» and «Формування розкладу» on a факультет; «Обмеження
  навантаження», «Обмеження розкладу» and «Навантаження викладачів» on a кафедра; the two
  «Редагування…» tabs and «Тривалість семестрів» on an освітня програма. On the two pages that keep
  a `SECTIONS` table — the факультет and the освітня програма — each such tab declares there *what
  kind of thing it maintains* (`writes: 'TIMETABLE_ENTRY'`), and that one string is both what the
  nav hides on and what the gate around the body resolves. The кафедра page writes its nav out by
  hand and has no such table, so its three name the two types in the template instead: the block of
  them appears for anybody who can reach a `LECTURER` **or** a `LECTURER_WORKLOAD`, while each body
  is gated on the one it actually writes — which makes «Навантаження викладачів» the one tab that
  can be offered and then refuse, to an account holding a викладач but no навантаження. The
  read-only tabs beside all of them — «Розклад факультету», «Зведене навантаження», «Розклад
  кафедри», the plan documents — are not touched.
- **Sidebar links**, on the answer the screen behind each one would give, so a visible link always
  opens something usable. «Час переходу між корпусами» is the one that asks a narrower question than
  `canReachType` — `canCreateType('BUILDING_TRAVEL_TIME')`, since that matrix is edited per cell and
  a cell is governed by the корпуси at its two ends, so a grant naming one travel-time row leaves
  its holder nothing to do there.

The tab rule deserves its reason. The obvious requirement — `EDIT` on the факультет the tab is shown
under — is wrong, and wrong in the direction that matters: the rows behind those tabs live further
down. «Формування розкладу» writes a `TimetableEntry`, which hangs off a навантаження and therefore
off a кафедра, and a завідувач holding that кафедра has always been allowed to place their own
classes. Asking about the факультет would have taken the screen away from the person whose work it
is. Asking about the *kind* over-shows instead — that завідувач sees the tab on a факультет where
nothing is theirs, and finds every control inside it inert — and over-showing is the error a
convenience like this is allowed to make.

**A tab that is hidden is not a tab that has been removed.** Its key stays in `SECTION_KEYS`, so
`/faculty/3/timetable` still resolves and the body explains itself; dropping the key would make
`sectionNav` fall back to «Інформація» and leave a pasted link looking merely broken.

**And a tab that is offered is not necessarily a form.** Because the tabs are offered on the *kind*,
somebody reaches «Формування розкладу» on a факультет where nothing is theirs, and the same is true
of every widget inside a tab they do hold: each asks its own row-level question and, where the
answer is no, renders what it knows instead of what it edits. Four shapes of that, and they are
deliberately not the same shape, because what is lost by hiding an editor differs:
`LecturerConstraintList` leaves its boxes in place and marks them `readonly`, since those numbers
*are* the constraints and a scheduler needs to read them; `TimetableConstraintList` drops its rule
grid entirely, because the chips on each card's header already say «Пн: з 09:00» and the grid is
nothing but editors; `RoomAssignmentList` and `FacultyTimetableList` replace their pickers with one
line naming where the class is held and when it sits (`placementLabel`, `scheduledLabel`), since the
pickers were the only place either board stated that at all, and without the line a board that
exists to answer "what has nobody assigned yet?" would answer nothing; and both automatic-generation
panels are not drawn at all, a two-minute search whose only outcome is «Застосувати» being worse than
useless to somebody who may not apply it. Each of them checks again in the handler and not only in
the template, so a card made dirty by some other route stops before the request rather than after
it — mostly with a sentence naming the level that is missing, in the same words the service would
have answered with.

A **detail page** does the same for a batch of one: `FacultyPage`, `DepartmentDetailPage`,
`CourseDetailPage`, `LecturerDetailPage`, `RoomDetailPage`, `BuildingPage`,
`DegreeProgramDetailPage` and `AcademicGroupDetailPage` each call `auth.accessLevel(<TYPE>,
routeId)` in `ngOnInit` and derive `canModifyX` / `canDeleteX` / `canManageAccess` from it as
computed signals — the last three joined the list when their «✎ Редагувати» stopped being drawn for
everybody. `BuildingPage` asks twice, because its «Аудиторії» tab is a list: once about the корпус,
and once, batched, about every аудиторія in it, since `Room` hangs off a факультет as well and a
grant on either reaches it. `CoursePage` composes three scopes, since a plan position can be reachable through
the discipline *or* through its degree programme, and a workload through the discipline *or* through
the кафедра holding it: the level in force is the highest of them.

The «Час переходу між корпусами» matrix applies the same split per cell — a корпус you hold at
`EDIT` lets you correct a walk, and emptying the cell (which deletes the row) needs `FULL`. That is
checked before the batch is sent, so the whole save is refused together rather than half of it
landing.

`resource-type.ts`'s `toResourceType()` converts an entity's PascalCase name (`WorkingCurriculumItem`)
to the `UPPER_SNAKE_CASE` identifier the backend's grants use (`WORKING_CURRICULUM_ITEM`) —
mirroring `EntityMetadata#resourceType()` on the backend so the two sides never need to agree on
a hand-maintained list.

**Every hidden button is a UI convenience, not the security boundary** — the corresponding
mutation re-checks the same level server-side regardless (see the backend README's
[Authentication & authorization](../timetable/README.md#authentication--authorization)); hiding a
button just avoids a wasted round trip through a request the server would reject anyway.

### Delegating access (`ResourceAccessPanel`)

`resource-access.ts` is one component used in three places: as the «Доступ» tab of a факультет, as
the «Доступ» tab of a кафедра, and on the administration console, where a resource is named by type
and id instead of being the page you are already on.

That reuse is the fix for something that had quietly made delegation unusable. The backend has
always allowed a non-administrator to hand out access within what they hold — but the only UI for it
lived on `/admin`, behind `adminGuard`. A deanery holding the right to delegate their own факультет
had nowhere to exercise it. Putting the panel on the resource's own page makes «дати завідувачу
кафедри право редагувати її навантаження» something the deanery does themselves, in the place they
are already looking at. The tab only renders for someone holding `MANAGE` there, and the panel
re-checks that itself rather than trusting its host.

The panel shows:

- **Direct grants** — who was given access *here*, with a level dropdown that re-grants in place
  (the mutation is an upsert, so changing somebody from «Редагування» to «Повний доступ» is one
  call and leaves no window where they have neither) and a «Відкликати» button.
- **Inherited grants** — greyed, with no controls, labelled with where they come from
  («Успадковано: Факультет прикладної математики та інформатики», or «Загальний доступ (уся
  система)»). They are the answer to "why can this person edit my кафедра?", and they are not
  withdrawable from here: revoking needs authority from *above* the grant, so peers cannot unseat
  each other and a delegate cannot lock out whoever appointed them.
- **A grant form** — a user or a group, plus the level, with its explanation shown under the
  dropdown so nobody has to guess what «Повний доступ» includes. The two grantee pickers are
  deliberately asymmetric: groups are few, so the whole list is offered; accounts are not, so a user
  is *found* — type at least two characters, press «Знайти», and `Query.searchUsers` answers with
  identity only. A picker preloaded with every account would be both a slow first paint and a
  directory of the university handed to anyone who can delegate.

Success is reported as «Доступ надано» or «Рівень доступу оновлено», the second being what the
mutation's `UPDATED` status means. Failures come back as named statuses and are shown in Ukrainian:
`FORBIDDEN`, `LEVEL_ABOVE_OWN` (you cannot give away more than you hold), `INVALID_GRANTEE`,
`UNKNOWN_RESOURCE_TYPE`, `UNKNOWN_ACCESS_LEVEL`, and — for revoke — `PERMISSION_NOT_FOUND` plus the
sentence that explains the strict-ancestor rule rather than just refusing. A failed level change
also reloads the list, so the row stops showing a value that was not accepted.

Two implementation notes worth keeping. The level dropdown binds `[selected]` on each `<option>`
rather than `[value]` on the `<select>`: Angular applies a select's own property binding before
`@for` has created any options, so the assignment matches nothing, the browser falls back to the
first option, and the binding is never re-applied because the value it holds has not changed — the
row then reads «Редагування» whatever the grant says. And when the caller does not hold `MANAGE` the
panel renders nothing at all; on the faculty and department pages the tab is hidden in that case, so
only `/admin`, where any resource can be named by hand, can show an empty area.

### Administration console (`AdminPage`, `/admin`)

Reachable only to admins (sidebar link + `adminGuard`), this page covers everything the product
spec asked an administrator to be able to do, in one screen:

- **Create users** with a temporary password (shown once on screen after creation, since the
  backend never returns a password) — the new account must change it on first login.
- **Activate/deactivate** existing accounts.
- **Create groups** and manage membership (add/remove a user to/from a group).
- **Link an account to a person** — say which викладач or which студент an account is
  (`users.lecturer_id` / `users.student_id`), through searchable pickers over every lecturer and
  every student, either when creating the account or afterwards from the «Прив'язати» button on its
  row. The one-of-two rule is enforced here by only ever sending the id matching the chosen kind,
  and again by the database; `ALREADY_LINKED`, `BOTH_LINKS_SET` and `INVALID_LINK` come back as named
  statuses and are shown in Ukrainian. The users table gains an «Особа» column so the current state
  of every account is visible without opening anything. This is administrator-only for a reason
  worth stating: an account able to point itself at a lecturer could read that lecturer's workload.
- **Access to any resource** — pick a resource type (every entity in `entities.ts` plus `GLOBAL` and
  the curriculum/scheduling entities that only have bespoke drill-down UI, e.g.
  `WORKING_CURRICULUM_ITEM`) and, unless the type is `GLOBAL`, an id; the same
  `ResourceAccessPanel` described above then opens on it. `GLOBAL` is the one scope with no page of
  its own, which is why this console keeps a way to name a resource by hand at all.

### Seeded accounts (local dev)

Matching the backend's `data.sql`: `admin@lnu.edu.ua` / `Admin#2026` signs in as the full `GLOBAL`
administrator, and it is the **only** seeded account. The forced change-password flow, a scoped
`FACULTY`/`DEPARTMENT` grant and the person link behind «Мій кабінет» all have to be set up from
`/admin` first — creating an account there always sets `mustChangePassword`, so the first of those
needs nothing more than one «+ Створити користувача».

The other road to a second account needs no administrator but does need working mail: give a
`Lecturer` or a `Student` an e-mail address you can read, set `MAIL_USERNAME`/`MAIL_PASSWORD` on the
service, and register at `/register`. Without those two variables the service starts normally and
answers `MAIL_FAILED`, which the page reports honestly rather than telling you to check an inbox
nothing was sent to.

---

## Adding a new entity to the UI

- **If it only needs a plain CRUD table**: append an `EntityMeta` to `ENTITIES` in
  `entities.ts`, add a one-line component to `entity-pages.ts`/`ENTITY_PAGES`, and link it
  from `app.html`. Two of those three now carry a permission decision as well. If the table is
  nothing but reference data somebody maintains — no reading anyone else needs — mark its
  `ENTITY_PAGES` entry `editorsOnly: true`, which is what gives its route `data.gatePage` and lets
  the screen answer «Немає доступу»; and wrap its sidebar link in `@if (auth.canReachType('…'))`,
  so the link and the screen give the same answer. Neither is needed for a table people look things
  up in — `/course` and `/lecturer` are deliberately readable by anyone signed in. Nothing else
  about the create/edit/delete gating has to be written: `BaseEntity` derives it from the entity's
  own metadata and the published cascade.
- **If it needs a dedicated drill-down page or child-list widget** (like
  `WorkingCurriculumList`): write a standalone component with its own GraphQL
  query/mutations via `GraphqlService`, register its route in `app.routes.ts`, and embed it
  where relevant (e.g. as a `@case` in a parent detail page's section switch). A widget that writes
  asks `auth.accessLevel(<TYPE>, <the row those writes hang off>)` in `ngOnInit` and derives
  `canEdit` / `canDelete` from it; a tab that exists only to write also declares `writes` in its
  page's `SECTIONS` table and is wrapped in `<app-access-gate>` — see [Which screens hide
  themselves](#which-screens-hide-themselves).

---

## Notes / known limitations

- `CombinedGroup ↔ AcademicGroup` membership (many-to-many) is still **read-only** in the UI,
  matching the backend — only `WorkingCurriculumItem ↔ AcademicGroup` has been wired up with
  an editable multi-select so far; seed `CombinedGroup` membership via the service's
  `data.sql`.
- The schedule builder (`FacultyTimetableList`) matches each already-scheduled `TimetableEntry`
  back to a generated block **by position**, not by any stored identity, and re-derives the
  block count from `hours / (semesterDurationWeeks × durationHours)` on every load. Changing
  `semester_duration_weeks` or a workload's `durationHours` *after* some of its classes are
  already scheduled can shift how many weekly/biweekly blocks that workload generates, so
  previously-scheduled entries may line up with a different position than before — review the
  affected workload's blocks after either change.
- **Manual scheduling still checks nothing.** The generator applies every timetable constraint as a
  hard filter, but the per-block form beside it does not: assigning a day/time/room by hand will
  happily put a class inside a lecturer's `UNAVAILABLE` window, past a group's `NOT_AFTER`, in a
  room the workload doesn't allow, or in a building the group cannot reach from its previous class
  in the gap between them — which the generator now treats as a hard rule. The one rule the form does apply is the start-time set, by
  offering each block only its own set's times. The machinery exists but is not reachable:
  `timetable-solver.ts` exports only `parseMinutes` and `solveTimetable`, keeping `resolveRules`,
  `timeAllowed` and the room / `MAX_CLASSES_PER_DAY` checks module-private, so applying the same
  rules to the manual form means exporting them first rather than merely calling them. Until that
  happens a hand-placed class can silently break a rule the generator would never break. See the
  backend README's *Scheduling constraints*.
- **A generated schedule is a heuristic result, not an optimum.** UCTP is NP-hard; on a saturated
  faculty the run finishes with conflicts rather than without, and reports them. A longer budget may
  also produce a wholly different arrangement of equal quality, because nothing rewards similarity
  to the timetable that was there before — which is what makes "перевизначити весь розклад"
  a start-of-semester operation rather than a mid-semester one.
- `TimetableConstraintList` loads its subjects with `limit: 500` and has no pagination — a faculty
  with more rooms or groups than that would silently show only the first page. It also re-sends each
  subject's own scalar fields on every save (the mutation payload is the whole entity), so a card
  saved from a stale page would overwrite a name someone changed in the meantime.
- **«Мій кабінет» reads the *current* plan, not the one the student was admitted under.** The
  curriculum tab shows the programme's plan as it stands today, narrowed to the semesters the
  student's course year names. `DegreeProgram` stores no year of intake and `curriculum_items` are
  not versioned, so a plan revised mid-programme is shown to every cohort alike — the same gap
  [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) lists for the printed plan, surfacing here for the first
  time in front of the person it concerns. It also means the page cannot show a student what they
  have already passed: there is no enrolment or grade in the model at all.
- **A route deeper than six path segments would 404 on reload** when the app is served from the
  packaged jar rather than from `ng serve`. The service's deep-link fallback matches a fixed list of
  patterns rather than a catch-all, so that requests for real files still reach the static resource
  handler; the deepest route in `app.routes.ts` is three (`/faculty/:id/:section`), so there is
  double the headroom, but adding a seventh segment means adding a pattern in `FrontendController`
  too. See the [service
  README](../timetable/README.md#serving-the-frontend-from-this-service).
- **There is no unit-test suite in the frontend** — no `*.spec.ts`, no runner in `devDependencies`,
  and `npm test` (`ng test`) fails. Anywhere this README says a module *can* be unit-tested, read it
  as a property of the code, not as a claim that it is. One module is an exception in practice rather
  than in form: `workload-generator.ts` is covered by
  [`scripts/workload-bench`](./scripts/workload-bench/README.md), which runs it over 48 generated
  department instances and re-derives every constraint check independently of the generator's own
  bookkeeping — feasibility, determinism and structural integrity, on every run. That is not a
  substitute for unit tests of the constraint families, and it says nothing about the GraphQL-tree →
  `GenInput` mapping in `lecturer-workload-list.ts`, which remains untested code. The backend, by
  contrast, has `SchemaBuildTest`.
- **`entity-pages.ts` declares sixteen components but routes fourteen.** `CombinedGroupPage` is
  deliberately unrouted (it is embedded in the Faculty page's "Об'єднані групи" tab). The other,
  `BuildingPage`, is dead code: `/building` is claimed by `BuildingHome`, and the `BuildingPage`
  that `app.routes.ts` imports is the unrelated drill-down component from `building-page.ts`. Two
  different classes share the name, and the generic one has no importer.
- **The printed curriculum measures every degree programme against the 25 % elective share of ст. 62
  ч. 1 п. 15, including those it should measure against 10 %.** The Закон № 3642-IX revision of that
  clause lowers the floor to 10 % for specialties giving access to professions under additional
  regulation (medicine, law, teacher training, …), but `degree_programs` carries no such flag, so
  the check always applies the stricter bound. Its verdict on a programme under a regulated
  specialty is therefore a lower bound, not a finding. The same section of
  [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) lists what else the model cannot fill in — the
  academic-year calendar, the name of the field of knowledge, the programme's ЄДЕБО identifier, the
  year of intake — each a field in `DegreeProgram` rather than a change to the document.
- **The working curriculum has no year of its own.** It belongs to one academic year and one intake,
  but `DegreeProgram` stores neither, so the course year is picked with a filter and the academic
  year comes from the date the file is generated. Two consequences: a sheet printed in July and one
  printed in September of the same planning round carry different years in their titles (the cutover
  is 1 August, matching `academicYearLabel`), and «усі курси» produces a document that is not a
  working curriculum in the usual sense — which is why the page says so and the sheet repeats it in
  its notes.
- **Two screens still read `default_max_hours_per_year` with a query of their own.**
  `department-workload-summary.ts` and `lecturer-workload-detail.ts` predate
  `GlobalPropertiesService` and each fetch that one property directly, so a change made on «Глобальні
  властивості» reaches them on their next load rather than immediately, and costs a round trip per
  screen. Moving them over is a two-line change in each; it was left out of the settings work to keep
  that change to the curriculum limits.
- **The faculty page's «Групи аудиторій» tab can only ever produce faculty-scoped groups.** It
  presets and filters on `facultyId`, which is what makes a row created there satisfy
  `room_groups_scope_check` (a group may carry a faculty **or** a department, not both). The
  consequence is that a department-scoped group is invisible on the faculty page even when it
  belongs to one of that faculty's departments, and can only be created from `/room-group` or from
  the department page's own list. The tab is a scoped view, not the full picture — which is the
  right default, since a faculty-level group is the common case, but it means "this faculty has no
  room groups" should be read as "no faculty-scoped ones".
- Lists are fetched with `limit: 1000` (no pagination UI); connections are offset-based only.
  `CurriculumEditor` renders a block per course of the degree programme, which can be 240 of them on
  the largest — hence its name filter and "лише заплановані" toggle rather than pagination.
- **`students` is empty in the checked-in `data.sql`** apart from one seeded group, so anything
  keyed on students looks broken when it isn't: the `INDIVIDUALLY` workload UI shows an empty
  student dropdown, and the academic-group "Студенти" tab shows an empty table, for every group
  that has no rows.
- The `INDIVIDUALLY` roster is built from the working curriculum item's own academic groups. That
  is the right default, but a consultation supervised for a student outside those groups can't be
  *added* through it (an existing one is preserved and editable). The roster is also fetched with
  `limit: 500` per group and has no filter of its own — fine for a group, awkward for an item
  spanning many.
- The course-year / half-year vocabulary (see [Academic terms](#academic-terms-entitiests)) has only been
  rolled out across the two assessment views — "Зведене навантаження" and "Оцінка навантаження".
  Six other places still speak in raw semester numbers: the curriculum editor, `CurriculumItemList`,
  `WorkingCurriculumList`, `CombinedWorkingCurriculumItemList`, the schedule builder's parity filter
  and `LecturerWorkloadList`'s own tree (including the generator preview). Nothing breaks — it is
  the same stored number — but the same semester reads two different ways depending on which tab
  you are on. `termLabel`/`termLabelShort` exist precisely so that sweep is a rename, not a
  rewrite; `termLabelShort` currently has no caller.
- The PDF report has no field for the fraction of a post held (ставка), because the data model has
  none: `Lecturer` stores position and academic degree but not that fraction, so the form shows the
  norm and the actual load without the «планове навантаження на займану частку ставки» line a paper
  calculation usually carries. An academic title (вчене звання) is likewise absent — `academicDegree`
  is a degree, not a title. Both would be a `Lecturer` field plus a column in `schema.sql`.
- `workload-report.ts` never inflects a stored name. Ukrainian needs the genitive for "завідувач
  кафедри *прикладної математики*" and "декан *механіко-математичного факультету*", and that
  cannot be derived reliably from a nominative name, so the signature block says just «Завідувач
  кафедри» / «Декан факультету» — both are already named in the letterhead above.
- Adding a value to `HOUR_TYPE_OPTIONS`/`TEACHING_FORMAT_OPTIONS` in `entities.ts` is not enough on
  its own — the value must also exist in the backing Postgres enum, and a few places hold their own
  copy of the ordering or of which values are meaningful: `HOUR_TYPE_ORDER` in
  `lecturer-workload-list.ts` (an `indexOf` lookup, so an unlisted type sorts *first*, not last)
  and `ADDABLE_HOUR_TYPES` in `working-curriculum-list.ts` (which hour types can carry a working
  curriculum item at all).
- If a request fails with a Postgres "column ... does not exist" (wrapped as a generic
  GraphQL "bad SQL grammar" error), the backend's `schema.sql`/`data.sql` most likely haven't
  been re-applied since a recent backend change — see the backend README's [Known
  limitations](../timetable/README.md#known-limitations).
- The JWT is kept in `localStorage`, readable by any script running on the page — acceptable for
  this deanery-internal tool, but worth knowing if this were ever exposed more broadly (an
  httpOnly cookie would be the safer default). There's also no proactive token-refresh or
  expiry countdown: a token that expires mid-session just starts failing requests with an auth
  error on the next mutation rather than warning ahead of time.
- Hiding a tab or a screen is decided at the level of the *kind* of thing it maintains, not the row
  it is shown under (see [Which screens hide themselves](#which-screens-hide-themselves)), so it
  over-shows: a завідувач кафедри sees «Формування розкладу» on every факультет, including those
  where every control inside it is inert. The precise question — "does this account hold `EDIT` on
  anything beneath *this* факультет" — is a downward walk over the whole subtree, which is the one
  direction `PermissionEvaluator` deliberately does not go. Over-showing is the safe error here;
  under-showing would hide somebody's own work from them.
- The per-semester lengths entered on «Тривалість семестрів» are **stored but not yet used**. The
  schedule builder still derives a workload's weekly block count from `hours / (semester_duration_weeks
  × durationHours)` — one number for every programme — so a semester recorded as ten weeks is planned
  as sixteen until that arithmetic is taught to look the override up. It needs the workload's own
  semester and degree programme, which `faculty-timetable-list.ts` does not currently load.
- Nothing re-asks after a grant changes. `AuthService` caches `me`, the access model and the
  per-resource levels for the session, and `clearAccessCache()` is called after granting or revoking
  from a «Доступ» panel — but a grant made by *somebody else* while a tab is open is not noticed
  until the page is reloaded. The server is unaffected: it re-reads the grants on every request.
