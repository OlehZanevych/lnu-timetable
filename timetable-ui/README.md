# Timetable UI

An **Angular 21** front-end for the [Timetable GraphQL Service](../timetable). It lets staff
conveniently enter all the data needed to generate a university course timetable, and
displays the resulting schedule as a weekly grid. Styled after
[lnu.edu.ua](https://lnu.edu.ua/structure/faculties/) (navy + gold, serif headings).

- Angular 21 (standalone components, **signals**, **zoneless** change detection, new control flow)
- Talks to the service over plain GraphQL-over-HTTP (no Apollo dependency)

---

## Requirements

- Node.js 20+ (developed on Node 24, npm 11)
- The GraphQL service running on `http://localhost:8080` (see `../timetable`)

---

## Run

```bash
npm install        # first time only
npm start          # ng serve on http://localhost:4200
```

`npm start` proxies `/graphql` → `http://localhost:8080` (see `src/proxy.conf.json`), so the
backend must be running. Then open **http://localhost:4200**.

```bash
npm run build      # production build into dist/
```

---

## How it works

The UI mirrors the backend's **config-driven** philosophy: a single metadata file describes
every entity, and generic components render the CRUD screens and forms from it.

```
src/app/
├── entities.ts          # METADATA: all 16 entities, their fields and FK relations
├── graphql.service.ts   # tiny GraphQL-over-HTTP client (POST /graphql, query + variables)
├── base-entity.ts       # BaseEntity: shared CRUD logic (list/create/update/delete + option loading)
├── entity-page.html     # shared template (table + modal form) used by every entity page
├── entity-pages.ts      # 16 thin components that extend BaseEntity and supply their `meta`
├── search-select.ts     # SearchSelect: a select2-like searchable dropdown (ControlValueAccessor)
├── timetable.ts/.html   # weekly timetable grid (days × time slots)
├── app.ts/.html         # shell: LNU header + grouped sidebar navigation
└── app.routes.ts        # routes generated from ENTITY_PAGES + /timetable
```

### Entity metadata (`entities.ts`)

Each entity declares the GraphQL field names and its form fields. Foreign keys are `ref`
fields that point at another entity for the dropdown:

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

`BaseEntity` builds the queries/mutations from this metadata:
- **list**: `{ <namespace> { <list>(limit, offset) { nodes { id …fields… <relation { id label }> } } } }`
- **create/update/delete**: typed GraphQL variables (`$input: <Name>InputPayload!`, `$id: ID!`).

### Per-entity components (inheritance)

There is a real component per entity (`FacultyPage`, `LecturerWorkloadPage`, …) so each can
be customized later, but all share `BaseEntity` (logic) and `entity-page.html` (view):

```ts
@Component({ selector: 'app-course', templateUrl: './entity-page.html', imports: [FormsModule, SearchSelect] })
export class CoursePage extends BaseEntity { meta = meta('Course'); }
```

### Searchable selects

Every foreign-key field uses `<app-search-select>` — type to filter the options (like
select2), with a clear button and outside-click close. It implements `ControlValueAccessor`,
so it works with `[(ngModel)]`.

### Navigation

The sidebar groups entities for convenient top-down data entry:

1. **Структура / Structure** — Faculties → Departments → Specialties → Rooms → Time slots
2. **Навчальні плани / Curricula** — Courses → Curricula → Curriculum items → Working curricula → items
3. **Люди та групи / People & groups** — Lecturers, Students, Academic groups, Combined groups
4. **Розклад / Scheduling** — Workloads → Timetable entries

The **Timetable** view renders `timetableEntries` as a grid (rows = time slots, columns =
Mon–Sat); bi-weekly (numerator/denominator) classes are highlighted.

---

## Adding a new entity to the UI

When you add an entity to the backend, add it here too:

1. Append an `EntityMeta` to `ENTITIES` in `entities.ts`.
2. Add a one-line component in `entity-pages.ts` and register it in `ENTITY_PAGES`.
3. Add its `single` key to the appropriate section in `app.ts`.

---

## Notes / limitations

- Suggested data-entry order: Faculties → Departments → Specialties → Rooms / Time slots →
  Courses → Curricula → Working curricula → Lecturers / Groups → Workloads → Timetable entries.
- Combined-group ↔ academic-group membership (many-to-many) is **read-only** in the UI,
  matching the backend; seed it via the service's `data.sql`.
- Lists are fetched with `limit: 1000` (no pagination UI yet).
