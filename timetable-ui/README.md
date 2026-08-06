# Timetable UI

An **Angular 21** front-end for the [Timetable GraphQL Service](../timetable). It lets deanery
staff enter all the data needed to generate a university course timetable, and displays the
resulting schedule as a weekly grid. Styled after
[lnu.edu.ua](https://lnu.edu.ua/structure/faculties/) (navy + gold, serif headings).

- Angular 21 (standalone components, **signals**, **zoneless** change detection, new `@if`/`@for`/`@switch` control flow)
- Automatic lecturer-workload generation runs **in the browser** — see
  [WORKLOAD-GENERATION.md](./WORKLOAD-GENERATION.md) for the algorithm in full
- Automatic **timetable** generation runs in the browser too, in a Web Worker — a UCTP solver
  built on the objective function of *"Adaptive Memetic Algorithm for University Course
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
npm run build      # production build into dist/
```

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
   → departments → specialties → academic groups, each with an information page and
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
├── graphql.service.ts        # tiny GraphQL-over-HTTP client (POST /graphql, query + variables)
├── base-entity.ts            # BaseEntity: shared list/create/update/delete + option loading,
│                             #   now also gated by modifiableIds/canShowCreate (see Authentication)
├── entity-page.html          # shared table + modal-form template for the generic pages
├── entity-pages.ts           # thin components extending BaseEntity, one per entity, → /e/:single
├── search-select.ts          # SearchSelect: select2-like searchable single-value dropdown
├── multi-select.ts           # MultiSelect: checkbox-list dropdown for many-to-many fields
├── time-select.ts            # TimeSelect: hour + minute dropdown pair bound to one "HH:mm" string
├── dept-faculty-select.ts    # DeptFacultySelect: faculty-filtered department picker
├── sort.ts                   # compareUk(): the one Ukrainian-alphabet string comparator
├── auth.service.ts           # AuthService: session state (JWT, CurrentUser), login/logout,
│                             #   changePassword, canModifyIds() permission lookups — see Authentication
├── auth.interceptor.ts       # authInterceptor: attaches "Authorization: Bearer <jwt>" to requests
├── auth.guard.ts             # authGuard (must be signed in + password changed), adminGuard
├── resource-type.ts          # toResourceType(): entity name → backend permission resource type
├── login-page.ts/.html       # "/login"
├── change-password-page.ts/.html  # "/change-password" — forced after signing in with a temporary password
├── admin-page.ts/.html       # "/admin" — user/group/permission management console (admin-only)
├── app.ts / app.html         # shell: LNU header + sidebar navigation
├── app.css                    # empty — every style in this app is global, in src/styles.css
├── app.config.ts             # bootstrap providers: router + HttpClient with authInterceptor
├── app.routes.ts             # route table (see below)
│
├── faculty-home.ts/.html         # "/" — faculty tiles (drill-down entry point)
├── faculty-page.ts/.html         # "/faculty/:id" — faculty detail with tabbed sections
├── building-home.ts/.html        # "/e/building" — building tiles
├── building-page.ts/.html        # "/building/:id" — building detail (rooms)
├── department-page.ts/.html      # "/department/:id" — department detail (lecturers, combined
│                                 #   working curriculum items, lecturer workloads)
├── specialty-page.ts/.html       # "/specialty/:id" — specialty detail (curricula, groups)
├── academic-group-page.ts/.html  # "/academic-group/:id" — group detail (students)
├── department-list.ts/.html          # child-list widget: departments within a faculty
├── specialty-list.ts/.html           # child-list widget: specialties within a faculty
├── academic-group-list.ts/.html      # child-list widget: academic groups within a specialty
├── curriculum-editor.ts/.html        # specialty tab: course-first inline curriculum editor —
│                                     #   "Редагування планів" (see below)
├── curriculum-item-list.ts/.html     # specialty tab: curriculum items (semester/course/ECTS/hours)
│                                     #   and the printable «Навчальний план» — "Навчальні плани"
├── curriculum-summary.ts/.html       # the programme's headline figures, shown on both curriculum
│                                     #   tabs — presentational, renders a CurriculumPlan
├── curriculum-plan.ts                # what a curriculum adds up to, and where it departs from
│                                     #   the limits set for it — pure
├── plan-limits.ts                    # those limits, read from global_properties — pure
├── global-properties.service.ts      # GlobalPropertiesService: the settings table, loaded once
├── curriculum-report.ts              # the printable «НАВЧАЛЬНИЙ ПЛАН» sheet — pure, returns bytes
├── working-curriculum-list.ts/.html  # specialty tab: assign a department to each hours block —
│                                     #   "Редагування робочих планів"
├── working-curriculum-view.ts/.html  # specialty tab: the same plan read as a document, by course year,
│                                     #   with the printable working curriculum — "Робочі навчальні плани"
├── working-curriculum-summary.ts/.html # the working curriculum's headline figures, shown on both
│                                     #   curriculum tabs — presentational
├── working-curriculum-plan.ts        # which department delivers what, and what it adds up to
│                                     #   per department — pure
├── working-curriculum-report.ts      # the printable «РОБОЧИЙ НАВЧАЛЬНИЙ ПЛАН» — pure, returns bytes
├── course-page.ts/.html              # "/course/:id" — one discipline across curricula, working
│                                     #   curricula and workloads (lazy route)
├── lecturer-page.ts/.html            # "/lecturer/:id" — one lecturer: classes and timetable (lazy)
├── room-page.ts/.html                # "/room/:id" — one room: details and occupancy (lazy)
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
├── faculty-timetable-list.ts/.html   # faculty tab: auto-generates schedulable blocks from
│                                     #   workload hours and assigns day/start-time/room —
│                                     #   "Формування розкладу" (see below)
├── timetable-solver.ts               # the UCTP solver itself — pure, no Angular/GraphQL/I-O
├── timetable-solver.worker.ts        # runs it off the main thread and reports progress
├── global-properties-page.ts/.html   # "/global-properties" — edit the global_properties settings
│
└── me-page.ts/.html          # "/me" — «Мій кабінет»: the signed-in user's own навантаження or
                              #   навчальний план, and their own розклад (lazy route)
```

The `/timetable` page that used to sit at the end of this list is **gone**. It was a read-only
weekly grid over `timetableEntryConnection(limit: 1000)` with no faculty scope and no
`semesterParity`, against a `data.sql` carrying 1428 entries spanning both halves of the year — so it
silently dropped 428 rows to its limit and overlaid autumn on spring in the cells it did show. Every
other consumer of that table has filtered by semester since the filter existed. `TimetableView`
already does everything that page did and does it correctly, five times over; `me-page.ts` is what
took its place in the sidebar.

### The pure modules

Thirteen files carry the logic that is not UI. All of them are free of Angular, GraphQL and I/O: they
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
| `curriculum-plan.ts` | what a specialty's curriculum adds up to, and its compliance with those limits | [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) |
| `curriculum-report.ts` | the printable «Навчальний план» sheet | [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) |
| `working-curriculum-plan.ts` | which department delivers what, and the hours that projects onto each | [WORKING-CURRICULUM-PDF.md](./WORKING-CURRICULUM-PDF.md) |
| `working-curriculum-report.ts` | the printable «Робочий навчальний план» sheet | [WORKING-CURRICULUM-PDF.md](./WORKING-CURRICULUM-PDF.md) |
| `timetable-grid.ts` | timetable entries → day × class slot × subject, for every view and the sheet | *The five timetables*, below |
| `timetable-report.ts` | the printable «Розклад занять» sheet | [TIMETABLE-PDF.md](./TIMETABLE-PDF.md) |
| `workload-report.ts` | the printable «Розрахунок навчального навантаження» sheet | [WORKLOAD-PDF.md](./WORKLOAD-PDF.md) |
| `pdf-writer.ts` | a PDF, from scratch, including the TrueType subsetting | *Printable workload calculation*, below |
| `sort.ts` | `compareUk` — the one Ukrainian-alphabet comparator | *Ukrainian sorting*, below |

Only one of them needs a host that is not a component: `timetable-solver.worker.ts` runs the solver
on its own thread. `workload-generator.ts` does not, because it is three greedy passes over a
department rather than a search with a time budget — it returns before a frame is missed.

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
`app-multi-select` bound to a many-to-many id-list input field (`Course.specialtyIds`, which
specialties the course may be added to a curriculum for — see the backend's
`.manyToMany(...)`), replacing the join-table membership wholesale on save; `tags(name, label,
relation, tagField)` renders a plain comma-separated text input that's split/joined against a
nested-list mutation field (`Course.tags` — see the backend's `.nestedList(...)`) — an empty
comma-separated entry is filtered out, so "тег1, , тег2" becomes two tags, not three.

A `time(name, label, required, minHour, maxHour, minuteStep)` helper declares an `"HH:mm"` string
edited through `TimeSelect`'s hour + minute dropdowns instead of a free-text box — used by
`ClassStartTime.startTime`, where only valid slot times should be enterable. Because the form is
metadata-driven, any future time field gets the same widget for free.

A `'boolean'` field type renders a checkbox (`ClassStartTimeSet.isDefault` is the only one so far)
and needs three small departures from how every other type is handled, all in `base-entity.ts`:
the table cell shows «Так» or a **blank**, not "Ні" repeated down the column — the point of the
column is to show which row *is* the default one; `edit(row)` seeds the form with a real boolean
rather than `?? ''`, because `''` would also be read as "empty"; and `buildInput` always sends the
value, since an unticked box is a value rather than an absence. Without the last two, a set could
be made the default but never un-made.

An entity may also declare `detailRoute` — the path of its own drill-down page. Set it, and every
generic table of that entity grows an **«Відкрити →»** link in its actions column: not only the
standalone `/e/…` page but every embedding of it, so the faculty page's «Дисципліни» and «Аудиторії»
tabs and the department page's «Викладачі» tab all lead somewhere without a line of their own.
`Course`, `Lecturer`, `Room`, `Specialty` and `AcademicGroup` carry one. That the link is metadata
rather than markup is the point: the alternative was the same anchor pasted into four call sites and
forgotten in the fifth.

A `ref` field may also carry `parentFilter: { namespace, list, label }`. That swaps its plain
dropdown for `DeptFacultySelect` — a second select above it, loaded from that connection, which
narrows the first one's options (used by `Lecturer.departmentId`: pick a faculty, then one of its
departments). Nothing else in the form changes; the field still saves the same FK.

Field order in `fields[]` drives **both** the table columns and the modal form, so reordering one
reorders the other — `Student` is listed Прізвище → Ім'я → По батькові for that reason.

The enum option lists (`DEGREE_OPTIONS`, `POSITION_OPTIONS`, `COURSE_TYPE_OPTIONS`,
`CONTROL_FORM_OPTIONS`, `HOUR_TYPE_OPTIONS`, `TEACHING_FORMAT_OPTIONS`, …) are exported, and the
hand-written pages read them too rather than keeping their own copies — `courseTypeLabel(value)`
and `positionLabel(value)` are the shared value → Ukrainian label lookups for `courses.course_type`
and `lecturers.position`. `POSITION_OPTIONS` was inline in the `Lecturer` metadata until the PDF
report needed the same labels; anything that renders a stored enum should reach for the exported
list rather than repeat it. A page that hand-rolls its own map is a
bug waiting to happen: the one that existed showed raw `INTERNSHIP` / `COURSE_WORK` in a column
because its private map only covered three of the eight values. One exception is still in the tree:
`specialty-page.ts` declares its own `DEGREE_OPTIONS` literal rather than importing the shared one
(its sibling `specialty-list.ts` imports it). The two agree today, which is exactly what makes the
duplication easy to miss.

`BaseEntity` (an abstract `@Directive`) builds the queries/mutations from this metadata —
list (`{ <namespace> { <list>(limit, offset) { nodes {...} } } }`), create/update (typed
`$input: <Name>InputPayload!`) and delete (`$id: ID!`) — and every entity page is a one-line
subclass rendered through the shared `entity-page.html` (table + modal form):

```ts
@Component({ selector: 'app-course', templateUrl: './entity-page.html', imports: [FormsModule, SearchSelect] })
export class CoursePage extends BaseEntity { meta = meta('Course'); }
```

`entity-pages.ts` currently registers 13 such pages (`academicDegree`, `faculty`,
`department`, `specialty`, `course`, `lecturer`, `student`, `academicGroup`,
`room`, `roomGroup`, `classStartTimeSet`, `classStartTime`, `timetableEntry`), each routed at
`/e/:single`. These are the fallback / power-user screens — useful for bulk edits or entities
without a dedicated drill-down page (`Room`, `RoomGroup`, `ClassStartTimeSet`, `ClassStartTime`,
`AcademicDegree`, `TimetableEntry`). Two of them lean on the metadata in ways worth noting:
`RoomGroup` uses `multiref` for its rooms and offers both a faculty and a department picker even
though the two are mutually exclusive — the database rejects a row that sets both
(`room_groups_scope_check`), so a form that does fails on save rather than being prevented here;
`ClassStartTime` carries a `filterParam: 'classStartTimeSetId'` — ten of the fifteen entities carry
a `filterParam`, but this is the one where it is not merely convenient: `ordinal` only numbers
periods *within* a set, so an unfiltered list interleaves every set's and two rows both read "2.". `CombinedGroupPage`
(the same `BaseEntity` table) is also registered as a component but not routed standalone — it's
embedded directly as the Faculty page's "Об'єднані групи" tab instead. `CurriculumItem`,
`CurriculumItemHours`, `WorkingCurriculumItem` and `LecturerWorkload` have no generic page at all;
they're managed exclusively through the hand-written drill-down pages below
(`SpecialtyDetailPage`'s working-curriculum-items tab and the department's "Навантаження
викладачів" tab, via `LecturerWorkloadList`).

### Hierarchical drill-down pages

The main browsing flow is a set of hand-written pages, each fetching its own GraphQL query
and composing purpose-built child-list components rather than going through `BaseEntity`:

- **`FacultyHome`** (`/`) → tiles for all faculties → **`FacultyPage`** (`/faculty/:id`),
  tabbed into "Факультет / Структура / Люди та групи / Навчальні плани / Розклад" sections:
  info, departments (`DepartmentList`), specialties (`SpecialtyList`), rooms, academic groups,
  combined groups (`CombinedGroupPage`), courses, schedule building (`FacultyTimetableList`,
  see below) and — under the same "Розклад" group — "Обмеження груп" and "Обмеження аудиторій",
  two instances of `TimetableConstraintList` (see below). Every list on this page is scoped to the
  faculty, including the two that have no
  `faculty_id` of their own: "Академічні групи" passes `[facultyId]` alongside its optional
  specialty sub-filter (so clearing that sub-filter means "all specialties *of this faculty*",
  not "every group in the university"), and "Об'єднані групи" passes the same scope to the
  generic table through `extraFilterParam`/`extraFilterValue` — both backed by the
  `facultyId` relation filters described in the backend README.
- **`BuildingHome`** (`/e/building`) → **`BuildingPage`** (`/building/:id`): info + rooms
  (each room shows/edits its own faculty; there's no separate "faculties in this building" tab).
- **`DepartmentDetailPage`** (`/department/:id`): info, lecturers, combined working curriculum
  items (`CombinedWorkingCurriculumItemList` — merge proposals, see below), workload constraints
  and department statistics (`LecturerConstraintList` — "Обмеження навантаження", see below),
  per-lecturer scheduling constraints (`TimetableConstraintList` — "Обмеження розкладу", see
  below), lecturer workloads (`LecturerWorkloadList` — "Навантаження викладачів", see below), the
  department-wide summary (`DepartmentWorkloadSummary` — "Зведене навантаження") and the
  per-lecturer assessment (`LecturerWorkloadDetail` — "Оцінка навантаження", see below).
- **`SpecialtyDetailPage`** (`/specialty/:id`): info, then **each plan twice — once to edit, once to
  read** — plus academic groups (`AcademicGroupList`). The curriculum is entered course-first
  (`CurriculumEditor`, "Редагування планів") and read as a table with its printable «Навчальний
  план» (`CurriculumItemList`, "Навчальні плани"); the working curriculum is entered by hanging a
  department off each hours block (`WorkingCurriculumList`, "Редагування робочих планів") and read as
  a document with its own printable sheet (`WorkingCurriculumView`, "Робочі навчальні плани"). All
  four see
  below. The editors are shaped for *entering* data and the readers for *checking* it, which is why
  neither shape serves both.
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

#### Editing a curriculum course-first (`CurriculumEditor`, specialty "Редагування планів" tab)

The same `curriculum_items` rows as the tab below it, inverted: one block per **course** the
specialty is allowed to teach (`courseConnection(specialtyId:)`, backed by `course_specialties`),
each holding its semester blocks, each of those holding a row per hour type. Courses with no
curriculum items yet are listed too — sorted to the top alphabetically — so gaps in the plan are
visible rather than merely absent, which a table of existing rows cannot show. Everything is edited
inline, one save per semester block, rather than through a modal.

- **Ordering** — courses sort by their lowest semester, ties broken by course name; semester blocks
  sort by semester. Unplanned courses come first.
- **No duplicate semesters** — the semester dropdown only offers values no sibling block already
  uses, and `save()` re-checks (two new blocks can both be unsaved at once), with
  `UNIQUE (course_id, specialty_id, semester)` as the backstop.
- **Hours** — a fixed row per hour type, always shown. A blank or `0` field means "not set": it is
  omitted from the nested `hours` list, which is what makes the backend *delete* an existing row
  (see the backend's `.nestedList(...)` reconciliation). A field that would drop a stored row is
  flagged "буде вилучено" before you save, since clearing a box is otherwise a silent deletion.
- **Concurrent edits** — saving one course reloads only that block, preserving unsaved edits
  elsewhere on the page.
- A course-name filter and a "лише заплановані" toggle keep the page usable: a specialty can have
  200+ courses.

Editable state is a signal per field (see the zoneless note above), which is also what makes
sibling blocks re-render when a neighbour changes — a block reading `sibling.semester()` while
computing its own dropdown options registers as a consumer of that signal.

#### Curriculum items and working curriculum items (`SpecialtyDetailPage`)

The "Навчальні плани" tab (`CurriculumItemList`) lists the specialty's `CurriculumItem`s
(semester, course, control form, ECTS, per-hour-type breakdown) with an add/edit modal whose
**course** dropdown is always scoped to courses allowed for the current specialty — the
`courseConnection(specialtyId: ...)` filter, backed by the `course_specialties` join table (see
the backend README) — regardless of whether the modal's optional faculty/department sub-filter
(`DeptFacultySelect` pattern, defaulting to the specialty's own faculty) is also set. Both this
dropdown and the resulting curriculum table display a course's tags (`Course.tags`, set on the
`Course` entity page — see [Generic CRUD tables](#generic-crud-tables-entitiests--baseentity)
above) after its name in parentheses, e.g. "Database Systems (англійською)"
(`CurriculumItemList.courseLabel`).

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
council approves — «НАВЧАЛЬНИЙ ПЛАН підготовки здобувачів вищої освіти» — for the specialty being
looked at.
Written **entirely on the client**, like the workload sheet: nothing is sent to the server and the
file downloads straight from a `Blob`, with the embedded font fetched once per session.

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

The "Редагування робочих планів" tab of the specialty page renders, for every `CurriculumItem`:
a header block ("Семестр 1, Дисципліна: …, Форма контролю: …, ECTS: …"), then one child block
per `CurriculumItemHours` row ("Лекції: 32", etc.), and inside each hours block a table of
`WorkingCurriculumItem` rows with an add/edit modal (`WorkingCurriculumList`) offering:

- an optional **faculty filter** (defaults to the specialty's own faculty) that narrows the
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
specialty and department pages one at a time and holding the result in your head.

The page walks the chain once and opens with what it adds up to: how many curricula the discipline
appears in and for how many credits, its contact hours against its normative volume, how many
departments deliver it, and how many lecturers and scheduled classes are behind it. Three tabs then
show the levels themselves — «Навчальні плани» (one row per curriculum item, with its hour
breakdown), «Робочі навчальні плани» (one row per delivery position, with its department, format and
groups) and
«Навантаження викладачів» (the same positions with the lecturers actually carrying them, rows
without one tinted).

It needed one backend change: `curriculumItemConnection` gained a **`courseId` filter**. `Course` has
no `curriculumItems` relation to walk — its `@OneToMany` fields are `childCourses` and `tags` — and a
filter was narrower than a relation, which would have appeared on every `Course` selection in the
schema.

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

The two halves resolve their data differently, and both differences are forced by the model:

- **The lecturer's figures come from the department's whole tree.** `loadDepartmentWorkloads` +
  `computeStats` are reused unchanged, because distinct-discipline counting and the accounting rules
  (several lecturers on one item each accrue the *full* hours; individual work costs
  hours × students) need every position of the department, not just this lecturer's. Reusing them is
  what makes «Моє навантаження» and «Зведене навантаження» structurally unable to quote different
  totals for the same person — the third view of the same numbers described under *Workload
  statistics*. The annual total and the min/max band are always the **whole year**, whatever the
  picker says, because a ceiling is annual and measuring half a load against it would lie.
- **The student's plan is their specialty's plan.** `curriculum_items` hang off a specialty, not off
  a cohort, and there should be no per-student curriculum: what a student is entitled to see is the
  programme they are enrolled in. Which semesters that means is derived —
  `semester = (academic_groups.course_year − 1) × 2 + half`, the inverse of `courseYearOf` /
  `halfYearOf` in `entities.ts` — so the page needs no field the model does not have.

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
| faculty → «Розклад факультету» | `group` | the faculty's academic groups | the timetable a faculty publishes |
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

**The semester filter is on by default, and it matters.** `timetable_entries` carry no semester of
their own — it lives two joins away on the curriculum item — so an unfiltered grid overlays autumn
and spring, and rooms appear double-booked when they are not. Each view passes the backend's
`semesterParity` relation filter, defaulting to the `current_semester_parity` setting. The read-only
`/timetable` page, which had no such filter and no scope of any kind, has been removed rather than
fixed — `TimetableView` was already the better version of it.

**One input decides who owns that filter.** `externalSemesterParity` is `null` on the four pages
that mounted this component first, and they keep the picker they have always had. «Мій кабінет» sets
it, which hides the picker and makes the view follow the host — because that page shows a plan and a
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
component sends the subject's required scalars back unchanged alongside the list (`meta.required(node)`
— a lecturer's first and last name, a group's name/year/study form/specialty, a room's number);
omitting them would blank them. "Очистити" only empties the card and marks it dirty — the empty list
reaches the server on the next "Зберегти", like any other edit, so a mis-click is undone by
"Скасувати" rather than by re-entering the rules.

#### Lecturer workloads (`LecturerWorkloadList`, department "Навантаження викладачів" tab)

Pre-loads every `WorkingCurriculumItem` delivered by the department (with its curriculum item /
hours context), grouped semester → discipline → hour-type → working-curriculum-item, and lets
the user assign, per item, a `LecturerWorkload`: lecturers (`MultiSelect`), academic groups
(`MultiSelect`, scoped to the item's own groups), combined groups (`MultiSelect`, only shown
when the item's `teachingFormat` is `SEPARATELY` — "together" has nothing to combine), and a
**duration** (`SearchSelect` over 1–4 academic hours) that defaults from the
`default_class_duration_hours` global property when creating a new workload, or from the
workload's own stored value when editing one.

Three further fields say *where* and *on which bells* the class runs, and appear whatever the
teaching format — they apply to individual consultations just as much:

- **Часи початку занять** (required) — the `ClassStartTimeSet` its classes are scheduled on, e.g.
  the separate grid physical education runs on. `lecturer_workloads.class_start_time_set_id` is
  `NOT NULL`, so an empty picker is caught here, in Ukrainian, rather than at the database; a new
  workload starts on the set marked as default.
- **Аудиторії** and **Групи аудиторій** (`MultiSelect` each) — where the class may be held. The
  eligible rooms are the **union** of the two, and choosing nothing means no restriction, which the
  hint says in words. Both lists are always sent in full, including when empty: omitting a
  many-to-many field leaves the stored membership untouched, so "clear the restriction" has to be
  an explicit empty array.

All three are echoed in the workload tree as "Дзвінки" and "Аудиторії" columns, the latter joining
named rooms and `«group» (група)` entries into one cell and reading «будь-яка» when nothing is set.
The options for all three are fetched **unfiltered and narrowed client-side**, deliberately: the
backend's `facultyId` filter matches the column exactly, so asking for this faculty's sets or groups
would drop precisely the university-wide ones (`faculty_id IS NULL`) that most workloads use. What
survives the narrowing is this faculty's rows plus the unscoped ones — and, for room groups, this
department's own.

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
  lecturer" is worse than no total. Clicking a name opens that lecturer's assessment;
- the **same table embedded** at the top of "Обмеження навантаження" (`embedded` mode: no header,
  no toolbar, no links), so a limit can be read beside the load it governs;
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
shared class, e.g. the same lecture required by two specialties), and proposes merging each
group into a new combined item via the `workingCurriculumItemIds` many-to-many mutation field —
after which it shows up in `LecturerWorkloadList`'s "Об'єднані позиції" section instead of the
plain tree.

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
  other week (`NUMERATOR`/`DENOMINATOR` week parity).
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
constraint, how many blocks are placed, and the adaptive intensity and temperature. Nothing is
written until «Застосувати», which then shows exactly what would change.

The solver is a University Course Timetabling heuristic using the objective function of
*"Adaptive Memetic Algorithm for University Course Timetabling"* —
`f(σ) = Σ βᵢ·Πᵢ(σ)^αᵢ` with `β = (150, 100, 50, 5, 20)` over lecturer/group/room conflicts and
lecturer/group windows — reached by a most-constrained-first greedy construction followed by the
article's two-phase multi-neighbourhood local search (reassign / swap / chain move under simulated
annealing and a tabu list, then bounded window reduction) under an effectiveness-adaptive intensity.
**[TIMETABLE-GENERATION.md](./TIMETABLE-GENERATION.md) documents it in full**: the formulation,
every deviation from the paper, the constraint semantics, complexity bounds, and what is and isn't
guaranteed.

Three things about it are specific to scheduling *one faculty inside a shared university*:

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
  type, e.g. `Course.specialtyIds`).
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
  hand-written form rather than the metadata-driven one.

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
is noticeable on the larger lists (a specialty can have 200+ courses).

### Routes (`app.routes.ts`)

| Path | Component | Notes |
|---|---|---|
| `/login` | `LoginPage` | the only route with no guard |
| `/change-password` | `ChangePasswordPage` | `authGuard` only — reachable while `mustChangePassword` is set |
| `/admin` | `AdminPage` | **lazy** — `authGuard` + `adminGuard`; user/group/permission management and the person link |
| `/` | `FacultyHome` | faculty tiles, drill-down entry point |
| `/faculty/:id` | `FacultyPage` | tabbed faculty detail |
| `/building/:id` | `BuildingPage` | building detail |
| `/department/:id` | `DepartmentDetailPage` | department detail |
| `/specialty/:id` | `SpecialtyDetailPage` | specialty detail incl. working curricula |
| `/academic-group/:id` | `AcademicGroupDetailPage` | group detail |
| `/course/:id` | `CourseDetailPage` | **lazy** (`loadComponent`) — one discipline across curricula, working curricula and workloads |
| `/lecturer/:id` | `LecturerDetailPage` | **lazy** — one lecturer: workloads, classes taught, personal timetable |
| `/room/:id` | `RoomDetailPage` | **lazy** — one room and its occupancy |
| `/me` | `MyDeskPage` | **lazy** — «Мій кабінет»: own workload or curriculum, and own timetable |
| `/global-properties` | `GlobalPropertiesPage` | system-wide settings editor |
| `/e/building` | `BuildingHome` | building tiles (overrides the generic table for this entity) |
| `/e/:single` | generic `entity-pages.ts` component | one per remaining entity — see [Generic CRUD tables](#generic-crud-tables-entitiests--baseentity) |

The sidebar (`app.html`) links to the drill-down entry point ("🎓 Факультети") and — only when the
signed-in account is linked to a lecturer or a student — to «📅 Мій кабінет»,
then a flat "Загальне" group of generic-table links for entities with no dedicated page
(`Building`, `RoomGroup`, `ClassStartTimeSet`, `ClassStartTime`, `AcademicDegree`) plus the global
settings page ("Глобальні властивості"), and — only for an administrator — an
"Адміністрування" group holding the single "Користувачі та права" link. The top bar carries the
signed-in user's name, an «АДМІН» badge where it applies, and the password / sign-out controls.
`CombinedGroup` has no sidebar link of its own — it's only reachable embedded in the Faculty page's
"Об'єднані групи" tab (see above), not as a standalone `/e/…` route.

«Мій кабінет» is hidden rather than shown-and-empty for an account that is neither: a deanery
administrator has no навантаження and no навчальний план of their own, and reaches every timetable
from the faculty, department, lecturer and room pages already. Typing `/me` still works and explains
itself.

The three detail pages added last — `/course/:id`, `/lecturer/:id`, `/room/:id` — have no sidebar
link either, and that is deliberate: nobody navigates to a discipline or a room from a menu, they
arrive from the list they were already reading. Every such list carries an «Відкрити →» link in its
last column, driven by `EntityMeta.detailRoute` (see [Generic CRUD
tables](#generic-crud-tables-entitiests--baseentity)), so the route is reachable from wherever the
entity is mentioned rather than from one place. They are three of the five `loadComponent` routes
in the file. Each pulls in `TimetableView`, the grid and — on the Course page — the whole aggregation
of curricula and workloads; eagerly bundled they took the initial chunk to 995.66 kB against a
1.00 MB error budget. Lazily loaded it sits at 963.53 kB, and the cost is one extra request the
first time a user opens one of the three.

`/me` and `/admin` are the other two, on the same reasoning. «Мій кабінет» mounts `TimetableView`
and is opened only by an account that is a person; the administration console carries its own
queries including the full lecturer and student lists behind the person pickers, and is opened only
by an administrator. Making `/admin` lazy in the same round more than paid for the new page: the
initial chunk is **949.06 kB**, below where it stood before either existed.

---

## Authentication

There is no sign-up screen anywhere — accounts are created by an administrator (`/admin`, see
below) with a temporary password, matching the backend's no-self-registration rule.

### Session state (`AuthService`)

A single root-provided service, injected the same way `GraphqlService` is used everywhere else:

- `token` (signal) — the JWT, persisted to `localStorage` (`lnu_timetable_token`) so a page
  refresh doesn't sign the user out; `isAuthenticated` is just `token() !== null`.
- `currentUser` (signal) — the result of `Query.me` (profile, `isAdmin`, `groups`,
  `permissions`), re-fetched via `refreshMe()` after login and on app bootstrap when a token is
  already stored. Deliberately **not** decoded from the JWT itself — the token only carries a user
  id — so a permission change or account deactivation is reflected the moment `refreshMe()` runs
  again, without needing a new token.
- `login(email, password)` / `logout()` / `changePassword(current, new)` — thin wrappers around the
  corresponding mutations.
- `canModifyIds(resourceType, ids)` — given a batch of ids of one entity type, asks
  `Query.canModifyResources` which of them the signed-in user may edit/delete, backed by a
  per-`resourceType` cache (`clearModifyCache()` invalidates it, called after granting/revoking a
  permission in the admin console) so re-rendering an already-checked list doesn't re-query.
- `personLink` / `hasPersonLink` (computed) — `'lecturer' | 'student' | null`, from the
  `lecturerId`/`studentId` on `Query.me`. **Deliberately not a permission**: it decides only whether
  «Мій кабінет» has anything to show, and therefore whether its sidebar link appears. Everything a
  user may *edit* still comes from `permissions` and is re-checked server-side (see below).

`authInterceptor` (an `HttpInterceptorFn`) attaches `Authorization: Bearer <token>` to every
outgoing GraphQL request when a token is present.

### Route guards (`auth.guard.ts`)

- **`authGuard`** — redirects to `/login` (with a `redirectTo` query param) when there's no
  signed-in user; redirects to `/change-password` when `mustChangePassword` is still set (except
  for that route itself). Applied to every route except `/login`.
- **`adminGuard`** — additionally requires `isAdmin`; applied only to `/admin`.

### Login → forced password change

`LoginPage` (`/login`) posts to `AuthService.login`, then calls `refreshMe()` before navigating —
if the account still has `mustChangePassword` set, it's sent to `/change-password`
(`ChangePasswordPage`) regardless of where it was headed; otherwise it lands on the original
`redirectTo` target or `/`. `ACCOUNT_DISABLED` and invalid-credentials errors from `login` are
surfaced as distinct messages.

### Hiding UI the user can't use

Every list/table in the app — both the generic `BaseEntity` tables and the hand-written
drill-down widgets (`DepartmentList`, `SpecialtyList`, `AcademicGroupList`, etc.) — follows the
same pattern:

1. After loading a page of rows, batch-call `auth.canModifyIds(resourceType, ids)` (skipped
   entirely for admins, who can modify everything) and store the resulting id set.
2. `canModify(row)` (`isAdmin() || modifiableIds().has(row.id)`) gates the row's "Редагувати"/
   "Видалити" buttons in the template.
3. A separate, coarser check gates the "+ Додати" (create) control: for the generic tables,
   `BaseEntity.canShowCreate` is simply "is admin, or holds *any* permission grant at all" (cheap,
   since the real check happens server-side anyway); the drill-down list widgets do the precise
   check instead — e.g. `DepartmentList` calls `canModifyIds('FACULTY', [facultyId])` on its own
   parent faculty, since creating a `Department` requires modify permission on the `Faculty` it
   would belong to (`PermissionService#canCreate` on the backend walks the same edge).

`resourceType.ts`'s `toResourceType()` converts an entity's PascalCase name (`WorkingCurriculumItem`)
to the `UPPER_SNAKE_CASE` identifier the backend's grants use (`WORKING_CURRICULUM_ITEM`) —
mirroring `EntityMetadata#resourceType()` on the backend so the two sides never need to agree on
a hand-maintained list.

**Every hidden button is a UI convenience, not the security boundary** — the corresponding
mutation re-checks the same permission server-side regardless (see the backend README's
[Authentication & authorization](../timetable/README.md#authentication--authorization)); hiding a
button just avoids a wasted round trip through a request the server would reject anyway.

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
- **Grant/revoke permissions** — pick a grantee (a user or a group), a resource type (every entity
  in `entities.ts` plus `GLOBAL` and the curriculum/scheduling entities that only have bespoke
  drill-down UI, e.g. `WORKING_CURRICULUM_ITEM`), and — unless the type is `GLOBAL` — a resource
  id; `grantPermission`/`revokePermission` enforce the delegation rule server-side (you can only
  grant a scope you already hold). Selecting a resource also lists everyone who currently has a
  grant on it (`Query.grantsForResource`), so an admin (or anyone with modify rights on that
  resource) can review and revoke existing access.

### Seeded accounts (local dev)

Matching the backend's `data.sql`: `admin@lnu.edu.ua` / `Admin#2026` signs in as the full `GLOBAL`
administrator, and it is the **only** seeded account. The forced change-password flow, a scoped
`FACULTY`/`DEPARTMENT` grant and the person link behind «Мій кабінет» all have to be set up from
`/admin` first — creating an account there always sets `mustChangePassword`, so the first of those
needs nothing more than one «+ Створити користувача».

---

## Adding a new entity to the UI

- **If it only needs a plain CRUD table**: append an `EntityMeta` to `ENTITIES` in
  `entities.ts`, add a one-line component to `entity-pages.ts`/`ENTITY_PAGES`, and link it
  from `app.html`.
- **If it needs a dedicated drill-down page or child-list widget** (like
  `WorkingCurriculumList`): write a standalone component with its own GraphQL
  query/mutations via `GraphqlService`, register its route in `app.routes.ts`, and embed it
  where relevant (e.g. as a `@case` in a parent detail page's section switch).

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
  happily put a class inside a lecturer's `UNAVAILABLE` window, past a group's `NOT_AFTER`, or in a
  room the workload doesn't allow. The one rule the form does apply is the start-time set, by
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
  curriculum tab shows the specialty's plan as it stands today, narrowed to the semesters the
  student's course year names. `Specialty` stores no year of intake and `curriculum_items` are not
  versioned, so a plan revised mid-programme is shown to every cohort alike — the same gap
  [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) lists for the printed plan, surfacing here for the first
  time in front of the person it concerns. It also means the page cannot show a student what they
  have already passed: there is no enrolment or grade in the model at all.
- **A route deeper than three path segments would 404 on reload** when the app is served from the
  packaged jar rather than from `ng serve`. The service's deep-link fallback matches a fixed list of
  patterns rather than a catch-all, so that requests for real files still reach the static resource
  handler; nothing today comes close (`/faculty/:id` is the deepest route in `app.routes.ts`), but
  adding one means adding a pattern in `FrontendController` too. See the [service
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
- **`entity-pages.ts` declares fifteen components but routes thirteen.** `CombinedGroupPage` is
  deliberately unrouted (it is embedded in the Faculty page's "Об'єднані групи" tab). The other,
  `BuildingPage`, is dead code: `/e/building` is claimed by `BuildingHome`, and the `BuildingPage`
  that `app.routes.ts` imports is the unrelated drill-down component from `building-page.ts`. Two
  different classes share the name, and the generic one has no importer.
- **The printed curriculum measures every specialty against the 25 % elective share of
  ст. 62 ч. 1 п. 15, including those it should measure against 10 %.** The Закон № 3642-IX revision
  of that clause lowers the floor to 10 % for specialties giving access to professions under
  additional regulation (medicine, law, teacher training, …), but `specialties` carries no such flag,
  so the check always applies the stricter bound. Its verdict on a regulated specialty is therefore a
  lower bound, not a finding. The same section of [CURRICULUM-PDF.md](./CURRICULUM-PDF.md) lists what
  else the model cannot fill in — the academic-year calendar, the name of the field of knowledge, the
  programme's ЄДЕБО identifier, the year of intake — each a field in `Specialty` rather than a change
  to the document.
- **The working curriculum has no year of its own.** It belongs to one academic year and one intake,
  but `Specialty` stores neither, so the course year is picked with a filter and the academic year
  comes from the date the file is generated. Two consequences: a sheet printed in July and one
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
  belongs to one of that faculty's departments, and can only be created from `/e/room-group` or from
  the department page's own list. The tab is a scoped view, not the full picture — which is the
  right default, since a faculty-level group is the common case, but it means "this faculty has no
  room groups" should be read as "no faculty-scoped ones".
- Lists are fetched with `limit: 1000` (no pagination UI); connections are offset-based only.
  `CurriculumEditor` renders a block per course of the specialty, which can be 240 of them on the
  largest — hence its name filter and "лише заплановані" toggle rather than pagination.
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
- `BaseEntity.canShowCreate` is a coarse "has *any* permission at all" check, not a precise "can
  create under this exact parent" check (unlike the drill-down widgets, which do check the exact
  parent) — a user with only a narrow grant elsewhere in the system will still see the generic
  tables' "+ Додати" button, and only find out via the server error that this particular create
  isn't allowed.
