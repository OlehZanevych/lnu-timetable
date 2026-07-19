# Timetable UI

An **Angular 21** front-end for the [Timetable GraphQL Service](../timetable). It lets deanery
staff enter all the data needed to generate a university course timetable, and displays the
resulting schedule as a weekly grid. Styled after
[lnu.edu.ua](https://lnu.edu.ua/structure/faculties/) (navy + gold, serif headings).

- Angular 21 (standalone components, **signals**, **zoneless** change detection, new `@if`/`@for`/`@switch` control flow)
- Talks to the service over plain GraphQL-over-HTTP (`GraphqlService`, no Apollo Client dependency)

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

```
src/app/
├── entities.ts               # metadata for the generic CRUD tables: fields, FK refs, options
├── graphql.service.ts        # tiny GraphQL-over-HTTP client (POST /graphql, query + variables)
├── base-entity.ts            # BaseEntity: shared list/create/update/delete + option loading
├── entity-page.html          # shared table + modal-form template for the generic pages
├── entity-pages.ts           # thin components extending BaseEntity, one per entity, → /e/:single
├── search-select.ts          # SearchSelect: select2-like searchable single-value dropdown
├── multi-select.ts           # MultiSelect: checkbox-list dropdown for many-to-many fields
├── dept-faculty-select.ts    # DeptFacultySelect: faculty-filtered department picker
├── app.ts / app.html         # shell: LNU header + sidebar navigation
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
├── curriculum-item-list.ts/.html     # child-list widget: curriculum items (semester/course/ECTS/hours)
├── working-curriculum-list.ts/.html  # child-list widget: working curriculum items under each hours block
├── combined-working-curriculum-item-list.ts/.html  # department tab: propose/manage merges of
│                                                    #   working curriculum items into a shared
│                                                    #   CombinedWorkingCurriculumItem
├── lecturer-workload-list.ts/.html   # department tab: assign lecturers/groups/duration to each
│                                     #   working (or combined) curriculum item — "Навантаження викладачів"
├── faculty-timetable-list.ts/.html   # faculty tab: auto-generates schedulable blocks from
│                                     #   workload hours and assigns day/start-time/room —
│                                     #   "Формування розкладу" (see below)
├── global-properties-page.ts/.html   # "/global-properties" — edit the global_properties settings
│
└── timetable.ts/.html        # "/timetable" — read-only weekly grid (days × class start times)
```

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

`BaseEntity` (an abstract `@Directive`) builds the queries/mutations from this metadata —
list (`{ <namespace> { <list>(limit, offset) { nodes {...} } } }`), create/update (typed
`$input: <Name>InputPayload!`) and delete (`$id: ID!`) — and every entity page is a one-line
subclass rendered through the shared `entity-page.html` (table + modal form):

```ts
@Component({ selector: 'app-course', templateUrl: './entity-page.html', imports: [FormsModule, SearchSelect] })
export class CoursePage extends BaseEntity { meta = meta('Course'); }
```

`entity-pages.ts` currently registers 11 such pages (`academicDegree`, `faculty`,
`department`, `specialty`, `course`, `lecturer`, `student`, `academicGroup`,
`room`, `classStartTime`, `timetableEntry`), each routed at `/e/:single`. These are
the fallback / power-user screens — useful for bulk edits or entities without a dedicated
drill-down page (`Room`, `ClassStartTime`, `AcademicDegree`, `TimetableEntry`). `CombinedGroupPage`
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
  combined groups (`CombinedGroupPage`), courses, and schedule building (`FacultyTimetableList`,
  see below).
- **`BuildingHome`** (`/e/building`) → **`BuildingPage`** (`/building/:id`): info + rooms
  (each room shows/edits its own faculty; there's no separate "faculties in this building" tab).
- **`DepartmentDetailPage`** (`/department/:id`): info, lecturers, combined working curriculum
  items (`CombinedWorkingCurriculumItemList` — merge proposals, see below), and lecturer
  workloads (`LecturerWorkloadList` — "Навантаження викладачів", see below).
- **`SpecialtyDetailPage`** (`/specialty/:id`): info, curriculum items (`CurriculumItemList`
  tab) and, in a separate tab, working curriculum items (`WorkingCurriculumList`) per hour
  block — see below — plus academic groups (`AcademicGroupList`).
- **`AcademicGroupDetailPage`** (`/academic-group/:id`): info, students. (No workload tab here —
  workloads are managed per-department, not per-group.)

#### Curriculum items and working curriculum items (`SpecialtyDetailPage`)

The "Робочі навчальні плани" tab of the specialty page renders, for every `CurriculumItem`:
a header block ("Семестр 1, Дисципліна: …, Форма контролю: …, ECTS: …"), then one child block
per `CurriculumItemHours` row ("Лекції: 32", etc.), and inside each hours block a table of
`WorkingCurriculumItem` rows with an add/edit modal (`WorkingCurriculumList`) offering:

- an optional **faculty filter** (defaults to the specialty's own faculty) that narrows the
  **department** dropdown (`DeptFacultySelect` pattern, reused from `CurriculumItemList`'s
  own faculty→department cascade),
  - lecturer count, teaching format (`TEACHING_FORMAT_OPTIONS`: Разом/Окремо),
- an **academic groups** multi-select (`MultiSelect`, backed by the `academicGroupIds`
  many-to-many mutation field), and
- when the curriculum item's course is an `ELECTIVE_GROUP`, an extra **elective course**
  dropdown scoped to that group's child courses.

#### Lecturer workloads (`LecturerWorkloadList`, department "Навантаження викладачів" tab)

Pre-loads every `WorkingCurriculumItem` delivered by the department (with its curriculum item /
hours context), grouped semester → discipline → hour-type → working-curriculum-item, and lets
the user assign, per item, a `LecturerWorkload`: lecturers (`MultiSelect`), academic groups
(`MultiSelect`, scoped to the item's own groups), combined groups (`MultiSelect`, only shown
when the item's `teachingFormat` is `SEPARATELY` — "together" has nothing to combine), and a
**duration** (`SearchSelect` over 1–4 academic hours) that defaults from the
`default_class_duration_hours` global property when creating a new workload, or from the
workload's own stored value when editing one. Working curriculum items already merged into a
`CombinedWorkingCurriculumItem` (see below) are excluded from this tree — assigning a workload to
one of those covers every merged item at once, so they're handled in a dedicated section above
the tree instead, using the same modal (`openCreateCombined`/`openEditCombined`) with the
available academic groups widened to the union across every merged member.

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
- Each block shows a computed **end time** — `startTime + durationHours ×
  academic_hour_duration_minutes` — once a class start time is chosen, since `ClassStartTime`
  only stores possible start times, not a fixed end time.
- Blocks are keyed by position (`workloadId::wk|bi::index`) so an in-progress, not-yet-saved
  selection survives the reload that follows scheduling a different block, and sorted with every
  unscheduled block first, then by day → start-time ordinal → parity → course name.

#### Global settings (`GlobalPropertiesPage`, `/global-properties`)

Lists every row of the backend's `global_properties` table (name/type/value) with an inline
editable value: `INTEGER`/`DECIMAL` types render a number input, `current_semester_parity`
(the only `ENUM`-typed property today) gets a dedicated ODD/EVEN `SearchSelect` since
`global_properties` carries no allowed-values metadata to derive that generically from, and
everything else falls back to a plain text input. Saves go through the single
`updateGlobalProperty(name, value)` mutation described in the backend README.

### Reusable form controls

All three are standalone `ControlValueAccessor` components usable with `[(ngModel)]`:

- **`SearchSelect`** — select2-like single-value searchable dropdown (used for every to-one FK).
- **`MultiSelect`** — checkbox-list dropdown with tag display, for many-to-many fields.
- **`DeptFacultySelect`** *(pattern)* — a faculty filter paired with a department
  `SearchSelect` whose options are filtered by the chosen faculty, defaulting to the parent
  entity's own faculty; implemented inline in `curriculum-item-list.ts` and
  `working-curriculum-list.ts` via a `filteredDepartmentOptions` computed signal rather than
  as a single shared component.

### Routes (`app.routes.ts`)

| Path | Component | Notes |
|---|---|---|
| `/` | `FacultyHome` | faculty tiles, drill-down entry point |
| `/faculty/:id` | `FacultyPage` | tabbed faculty detail |
| `/building/:id` | `BuildingPage` | building detail |
| `/department/:id` | `DepartmentDetailPage` | department detail |
| `/specialty/:id` | `SpecialtyDetailPage` | specialty detail incl. working curricula |
| `/academic-group/:id` | `AcademicGroupDetailPage` | group detail |
| `/timetable` | `Timetable` | weekly grid |
| `/global-properties` | `GlobalPropertiesPage` | system-wide settings editor |
| `/e/building` | `BuildingHome` | building tiles (overrides the generic table for this entity) |
| `/e/:single` | generic `entity-pages.ts` component | one per remaining entity — see [Generic CRUD tables](#generic-crud-tables-entitiests--baseentity) |

The sidebar (`app.html`) links to the drill-down entry points ("🎓 Факультети", "📅 Розклад"),
the global settings page ("Глобальні властивості"), plus a flat "Загальне" group of
generic-table links for entities with no dedicated page (`Building`, `ClassStartTime`,
`AcademicDegree`). `CombinedGroup` also has no sidebar link of its own — it's only reachable
embedded in the Faculty page's "Об'єднані групи" tab (see above), not as a standalone `/e/…`
route.

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
- Lists are fetched with `limit: 1000` (no pagination UI); connections are offset-based only.
- If a request fails with a Postgres "column ... does not exist" (wrapped as a generic
  GraphQL "bad SQL grammar" error), the backend's `schema.sql`/`data.sql` most likely haven't
  been re-applied since a recent backend change — see the backend README's [Known
  limitations](../timetable/README.md#known-limitations).
