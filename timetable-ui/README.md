# Timetable UI

An **Angular 21** front-end for the [Timetable GraphQL Service](../timetable). It lets deanery
staff enter all the data needed to generate a university course timetable, and displays the
resulting schedule as a weekly grid. Styled after
[lnu.edu.ua](https://lnu.edu.ua/structure/faculties/) (navy + gold, serif headings).

- Angular 21 (standalone components, **signals**, **zoneless** change detection, new `@if`/`@for`/`@switch` control flow)
- Automatic lecturer-workload generation runs **in the browser** — see
  [WORKLOAD-GENERATION.md](./WORKLOAD-GENERATION.md) for the algorithm in full
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

> **The app is zoneless** (Angular 21's default — there is no `zone.js` dependency and no
> `provideZonelessChangeDetection()` call needed). Change detection is driven by signal reads and
> by template event bindings, *not* by monkey-patched async APIs. In practice that means a
> component holding editable state in a plain mutable object may not re-render when that object is
> mutated. Widgets whose state is a flat form bound with `[(ngModel)]` are fine, because the
> control-value-accessor's own event binding marks the view dirty; anything holding a *tree* of
> editable rows should make each editable value its own `WritableSignal` and replace arrays
> immutably. `CurriculumEditor` is the worked example of that pattern.

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
├── curriculum-item-list.ts/.html     # child-list widget: curriculum items (semester/course/ECTS/hours)
├── working-curriculum-list.ts/.html  # child-list widget: working curriculum items under each hours block
├── combined-working-curriculum-item-list.ts/.html  # department tab: propose/manage merges of
│                                                    #   working curriculum items into a shared
│                                                    #   CombinedWorkingCurriculumItem
├── lecturer-constraint-list.ts/.html # department tab: per-lecturer workload constraints with
│                                     #   cross-field validation — "Обмеження навантаження"
├── workload-generator.ts             # the automatic assignment algorithm — pure, no Angular
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

A `time(name, label, required, minHour, maxHour, minuteStep)` helper declares an `"HH:mm"` string
edited through `TimeSelect`'s hour + minute dropdowns instead of a free-text box — used by
`ClassStartTime.startTime`, where only valid slot times should be enterable. Because the form is
metadata-driven, any future time field gets the same widget for free.

Field order in `fields[]` drives **both** the table columns and the modal form, so reordering one
reorders the other — `Student` is listed Прізвище → Ім'я → По батькові for that reason.

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
  see below). Every list on this page is scoped to the faculty, including the two that have no
  `faculty_id` of their own: "Академічні групи" passes `[facultyId]` alongside its optional
  specialty sub-filter (so clearing that sub-filter means "all specialties *of this faculty*",
  not "every group in the university"), and "Об'єднані групи" passes the same scope to the
  generic table through `extraFilterParam`/`extraFilterValue` — both backed by the
  `facultyId` relation filters described in the backend README.
- **`BuildingHome`** (`/e/building`) → **`BuildingPage`** (`/building/:id`): info + rooms
  (each room shows/edits its own faculty; there's no separate "faculties in this building" tab).
- **`DepartmentDetailPage`** (`/department/:id`): info, lecturers, combined working curriculum
  items (`CombinedWorkingCurriculumItemList` — merge proposals, see below), workload constraints
  (`LecturerConstraintList` — "Обмеження навантаження", see below), and lecturer workloads
  (`LecturerWorkloadList` — "Навантаження викладачів", see below).
- **`SpecialtyDetailPage`** (`/specialty/:id`): info, the course-first curriculum editor
  (`CurriculumEditor`, "Редагування планів"), curriculum items (`CurriculumItemList`,
  "Навчальні плани") and, in a separate tab, working curriculum items (`WorkingCurriculumList`)
  per hour block — all three see below — plus academic groups (`AcademicGroupList`).
- **`AcademicGroupDetailPage`** (`/academic-group/:id`): info, students. (No workload tab here —
  workloads are managed per-department, not per-group.)

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

The "Робочі навчальні плани" tab of the specialty page renders, for every `CurriculumItem`:
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

#### Lecturer workloads (`LecturerWorkloadList`, department "Навантаження викладачів" tab)

Pre-loads every `WorkingCurriculumItem` delivered by the department (with its curriculum item /
hours context), grouped semester → discipline → hour-type → working-curriculum-item, and lets
the user assign, per item, a `LecturerWorkload`: lecturers (`MultiSelect`), academic groups
(`MultiSelect`, scoped to the item's own groups), combined groups (`MultiSelect`, only shown
when the item's `teachingFormat` is `SEPARATELY` — "together" has nothing to combine), and a
**duration** (`SearchSelect` over 1–4 academic hours) that defaults from the
`default_class_duration_hours` global property when creating a new workload, or from the
workload's own stored value when editing one.

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

#### Automatic generation (`workload-generator.ts`)

The "Навантаження викладачів" tab opens with a generation panel offering two modes: **лише
незаповнені та неповні** (fill workloads with no lecturers, or fewer than their item's
`lecturerCount` — a lab needing two with only one assigned) and **перевизначити всіх** (reassign the
whole department from scratch). Nothing is written until you press Застосувати: generation produces
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
- **`DeptFacultySelect`** *(pattern)* — a faculty filter paired with a department
  `SearchSelect` whose options are filtered by the chosen faculty, defaulting to the parent
  entity's own faculty; implemented inline in `curriculum-item-list.ts` and
  `working-curriculum-list.ts` via a `filteredDepartmentOptions` computed signal rather than
  as a single shared component.

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
