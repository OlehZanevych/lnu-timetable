# Timetable UI

An **Angular 21** front-end for the [Timetable GraphQL Service](../timetable). It lets deanery
staff enter all the data needed to generate a university course timetable, and displays the
resulting schedule as a weekly grid. Styled after
[lnu.edu.ua](https://lnu.edu.ua/structure/faculties/) (navy + gold, serif headings).

- Angular 21 (standalone components, **signals**, **zoneless** change detection, new `@if`/`@for`/`@switch` control flow)
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
├── base-entity.ts            # BaseEntity: shared list/create/update/delete + option loading,
│                             #   now also gated by modifiableIds/canShowCreate (see Authentication)
├── entity-page.html          # shared table + modal-form template for the generic pages
├── entity-pages.ts           # thin components extending BaseEntity, one per entity, → /e/:single
├── search-select.ts          # SearchSelect: select2-like searchable single-value dropdown
├── multi-select.ts           # MultiSelect: checkbox-list dropdown for many-to-many fields
├── dept-faculty-select.ts    # DeptFacultySelect: faculty-filtered department picker
├── auth.service.ts           # AuthService: session state (JWT, CurrentUser), login/logout,
│                             #   changePassword, canModifyIds() permission lookups — see Authentication
├── auth.interceptor.ts       # authInterceptor: attaches "Authorization: Bearer <jwt>" to requests
├── auth.guard.ts             # authGuard (must be signed in + password changed), adminGuard
├── resource-type.ts          # toResourceType(): entity name → backend permission resource type
├── login-page.ts/.html       # "/login"
├── change-password-page.ts/.html  # "/change-password" — forced after signing in with a temporary password
├── admin-page.ts/.html       # "/admin" — user/group/permission management console (admin-only)
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

Two more field-builder helpers cover relations `ref(...)` can't express, both used by the
`Course` entity: `multiref(name, label, ref, relation, refLabel)` renders an
`app-multi-select` bound to a many-to-many id-list input field (`Course.specialtyIds`, which
specialties the course may be added to a curriculum for — see the backend's
`.manyToMany(...)`), replacing the join-table membership wholesale on save; `tags(name, label,
relation, tagField)` renders a plain comma-separated text input that's split/joined against a
nested-list mutation field (`Course.tags` — see the backend's `.nestedList(...)`) — an empty
comma-separated entry is filtered out, so "тег1, , тег2" becomes two tags, not three.

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
- **`MultiSelect`** — checkbox-list dropdown with tag display, for many-to-many fields (both
  hand-written pages, e.g. `academicGroupIds`, and the generic CRUD tables' `multiref` field
  type, e.g. `Course.specialtyIds`).
- **`DeptFacultySelect`** *(pattern)* — a faculty filter paired with a department
  `SearchSelect` whose options are filtered by the chosen faculty, defaulting to the parent
  entity's own faculty; implemented inline in `curriculum-item-list.ts` and
  `working-curriculum-list.ts` via a `filteredDepartmentOptions` computed signal rather than
  as a single shared component.

### Routes (`app.routes.ts`)

| Path | Component | Notes |
|---|---|---|
| `/login` | `LoginPage` | the only route with no guard |
| `/change-password` | `ChangePasswordPage` | `authGuard` only — reachable while `mustChangePassword` is set |
| `/admin` | `AdminPage` | `authGuard` + `adminGuard` — user/group/permission management |
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
- **Grant/revoke permissions** — pick a grantee (a user or a group), a resource type (every entity
  in `entities.ts` plus `GLOBAL` and the curriculum/scheduling entities that only have bespoke
  drill-down UI, e.g. `WORKING_CURRICULUM_ITEM`), and — unless the type is `GLOBAL` — a resource
  id; `grantPermission`/`revokePermission` enforce the delegation rule server-side (you can only
  grant a scope you already hold). Selecting a resource also lists everyone who currently has a
  grant on it (`Query.grantsForResource`), so an admin (or anyone with modify rights on that
  resource) can review and revoke existing access.

### Seeded accounts (local dev)

Matching the backend's `data.sql` (see its README for the full list): `admin@lnu.edu.ua` /
`Admin#2026` signs in as the full `GLOBAL` administrator; `dean.fpmi@lnu.edu.ua` and
`o.melnyk@lnu.edu.ua` (both temporary password `Temp#12345`) exercise the forced
change-password flow and a scoped `FACULTY`/`DEPARTMENT` grant respectively.

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
