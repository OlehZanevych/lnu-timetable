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
├── faculty-home.ts           # "/" — faculty tiles (drill-down entry point)
├── faculty-page.ts/.html     # "/faculty/:id" — faculty detail with tabbed sections
├── building-home.ts          # "/building" home — building tiles
├── building-page.ts/.html    # "/building/:id" — building detail (faculties, rooms)
├── department-page.ts/.html  # "/department/:id" — department detail (lecturers, courses)
├── specialty-page.ts/.html   # "/specialty/:id" — specialty detail (curricula, groups)
├── academic-group-page.ts/.html  # "/academic-group/:id" — group detail (students, workloads)
├── department-list.ts        # child-list widget: departments within a faculty
├── specialty-list.ts         # child-list widget: specialties within a faculty
├── academic-group-list.ts    # child-list widget: academic groups within a specialty
├── curriculum-item-list.ts   # child-list widget: curriculum items (semester/course/ECTS/hours)
├── working-curriculum-list.ts# child-list widget: working curriculum items under each hours block
│
└── timetable.ts/.html        # "/timetable" — weekly grid (days × time slots)
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

`entity-pages.ts` currently registers 16 such pages (`academicDegree`, `faculty`,
`department`, `specialty`, `course`, `curriculumItem`, `curriculumItemHours`,
`workingCurriculumItem`, `lecturer`, `lecturerWorkload`, `student`, `academicGroup`,
`combinedGroup`, `room`, `classStartTime`, `timetableEntry`), each routed at `/e/:single`. These are
the fallback / power-user screens — useful for bulk edits or entities without a dedicated
drill-down page (`Room`, `ClassStartTime`, `CombinedGroup`, `AcademicDegree`, `LecturerWorkload`,
`TimetableEntry`).

### Hierarchical drill-down pages

The main browsing flow is a set of hand-written pages, each fetching its own GraphQL query
and composing purpose-built child-list components rather than going through `BaseEntity`:

- **`FacultyHome`** (`/`) → tiles for all faculties → **`FacultyPage`** (`/faculty/:id`),
  tabbed into "Факультет / Структура / Люди та групи / Навчальні плани / Розклад" sections:
  info, departments (`DepartmentList`), specialties (`SpecialtyList`), rooms, students,
  academic groups, combined groups, courses, curriculum items, curriculum item hours, working
  curriculum items, workloads.
- **`BuildingHome`** (`/e/building`) → **`BuildingPage`** (`/building/:id`): faculties housed
  in the building, rooms.
- **`DepartmentDetailPage`** (`/department/:id`): lecturers, courses owned by the department.
- **`SpecialtyDetailPage`** (`/specialty/:id`): academic groups, curriculum items
  (`CurriculumItemList`) and, per curriculum item, its hour blocks and working curriculum
  items (`WorkingCurriculumList`) — see below.
- **`AcademicGroupDetailPage`** (`/academic-group/:id`): students, workloads for the group.

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
| `/e/building` | `BuildingHome` | building tiles (overrides the generic table for this entity) |
| `/e/:single` | generic `entity-pages.ts` component | one per remaining entity |

The sidebar (`app.html`) links to the drill-down entry points ("🎓 Факультети", "📅 Розклад")
plus a flat "Загальне" group of generic-table links for entities with no dedicated page
(`Building`, `ClassStartTime`, `CombinedGroup`, `AcademicDegree`).

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
- `timetable.ts` requests `workload { classType course { name } … }`, but the current
  `LecturerWorkload` GraphQL type only exposes `lecturer`, `academicGroup`, `combinedGroup`,
  `workingCurriculumItem` and `timetableEntries` — there's no `classType` scalar or direct
  `course` relation. The timetable grid's per-cell subject/type label is stale relative to the
  backend schema and needs to be reworked to read the class/course from
  `workingCurriculumItem` instead.
- Lists are fetched with `limit: 1000` (no pagination UI); connections are offset-based only.
- The `CurriculumItemHours` entity's generic-table namespace is `curriculumItemHourss`
  (naive `+s` pluralization of a name already ending in "s") — cosmetic only, doesn't affect
  the dedicated `CurriculumItemList`/`WorkingCurriculumList` pages which don't go through
  `entities.ts`.
