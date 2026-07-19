# Timetable GraphQL Service

A reactive **Spring Boot + GraphQL + R2DBC** service for university course timetabling at
Ivan Franko National University of Lviv (LNU). It ships a small **config-driven framework**:
you describe entities with annotations and declare GraphQL types/queries/mutations in a
configuration class — **no controllers, services or repositories, and no `.gqls` files**.
The schema, optimized SQL handlers, and N+1-safe batched relation loading are all generated
at startup.

- `groupId` `org.lnu`, `artifactId` `timetable`, root package `org.lnu.timetable`
- Spring Boot 4.0.6, Java 25, WebFlux, Spring for GraphQL, R2DBC (PostgreSQL)

---

## Why this design

The original `deanery-2026-graphql` app required, for every entity, a hand-written
repository + service + controller + `.gqls` schema fragment. This service replaces all of
that with two things the developer writes:

1. an **annotated entity** (a POJO), and
2. a few **declarative lines** in a `GraphQLSchemaConfig`.

At startup the framework scans entities, builds the GraphQL schema programmatically, and
creates data fetchers that translate each GraphQL selection set into an **optimized SQL
query selecting only the requested columns** — batching sibling-row relation lookups via
`DataLoader` so nested queries don't degrade into N+1 SQL calls (see
[Avoiding N+1 queries](#avoiding-n1-queries-dataloader-batching)).

---

## Requirements

- **JDK 25** (the project targets `release 25`; Maven running on an older JDK fails with
  "release version 25 not supported"). On macOS:
  ```bash
  export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home
  ```
- **PostgreSQL** running on `localhost:5432` with a database named `lnu-timetable`.
- Maven (the bundled `mvnw` wrapper also works).

---

## Database setup

```bash
# create database (psql from your PostgreSQL install)
createdb -h localhost -U postgres lnu-timetable
# load schema and seed data
psql -h localhost -U postgres -d lnu-timetable -f src/main/resources/db/schema.sql
psql -h localhost -U postgres -d lnu-timetable -f src/main/resources/db/data.sql
```

`schema.sql` starts with `DROP SCHEMA public CASCADE`, so it always recreates a clean
schema. Connection URL, credentials and pool sizing live in
`src/main/resources/application.properties` (also toggles GraphiQL and R2DBC SQL/param
debug logging, which is how the N+1 query problem described below was originally spotted).

---

## Run

```bash
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home mvn spring-boot:run
```

- GraphQL endpoint: `POST http://localhost:8080/graphql`
- GraphiQL (browser IDE): `http://localhost:8080/graphiql`
- `GET /` redirects to **Apollo Studio Sandbox** pointed at this service
- Apollo Federation `_service { sdl }` is served for schema introspection by gateways
- A permissive `CorsFilter` allows any origin/method — fine for local dev, tighten before
  deploying anywhere public

Run tests (schema assembly):
```bash
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home mvn test
```

---

## Domain model

The model follows the Ukrainian HEI / LNU structure and the UCTP model from the article
*"Adaptive Memetic Algorithm for University Course Timetabling"* (a *class requirement* =
lecturer + groups + periodicity; the schedule assigns it a day, slot, room and week parity).

| Entity | Table | Notes |
|---|---|---|
| `Building` | `buildings` | → faculties, rooms |
| `Faculty` | `faculties` | → building?, departments, specialties, rooms |
| `Department` (кафедра) | `departments` | → faculty, lecturers, courses |
| `Specialty` (спеціальність) | `specialties` | code, degree; → faculty, groups, curriculum items |
| `Course` (дисципліна) | `courses` | type (incl. `ELECTIVE_GROUP`/`ELECTIVE`); → faculty? *or* department? directly responsible for it, self-referential parent/child (an `ELECTIVE_GROUP` course's `childCourses` are its `ELECTIVE` options) |
| `CurriculumItem` | `curriculum_items` | semester, control form, ECTS; → **specialty directly** (no separate `Curriculum`/`curricula` table — removed), course, hours |
| `CurriculumItemHours` | `curriculum_item_hours` | hour type (LECTURE/PRACTICAL/LAB/INDEPENDENT_WORK) + count; → curriculum item, working curriculum items |
| `WorkingCurriculumItem` (робочий навчальний план) | `working_curriculum_items` | lecturer count, teaching format; → curriculum item hours, department, optional elective course, M-N academic groups, M-N combined working curriculum items |
| `CombinedWorkingCurriculumItem` | `combined_working_curriculum_items` | pure M-N hub, no scalar fields of its own; bundles several `WorkingCurriculumItem`s that share course/semester/hour-type (e.g. one shared lecture across specialties) so one `LecturerWorkload` can cover all of them at once; → M-N working curriculum items, workloads |
| `Lecturer` (викладач) | `lecturers` | position, degree; → department, workloads |
| `LecturerWorkload` (**class requirement**) | `lecturer_workloads` | durationHours (academic hours, 1-4); → M-N lecturers, M-N academicGroups, M-N combinedGroups, *exactly one of* workingCurriculumItem / combinedWorkingCurriculumItem, timetable entries |
| `Student` | `students` | → academic group |
| `AcademicGroup` (ПМі-31) | `academic_groups` | year, study form; → specialty, students, M-N combined groups |
| `CombinedGroup` (об'єднана група) | `combined_groups` | M-N academic groups (electives) |
| `Room` (аудиторія) | `rooms` | capacity, kind; → faculty? |
| `ClassStartTime` (пара) | `class_start_times` | ordinal, start time (end time is derived from the workload's duration) |
| `TimetableEntry` (**the schedule / "gene"**) | `timetable_entries` | dayOfWeek, weekParity; → workload, classStartTime, room |
| `AcademicDegree` | `academic_degrees` | name, abbreviation, level; → lecturers |

Relationships: one-to-one, one-to-many, many-to-one and many-to-many are all supported.
Notable unique constraints (`schema.sql`): `buildings.name`, `faculties.abbreviation`,
`departments.abbreviation`, `specialties(name, degree)`, `academic_groups.name`,
`lecturers.email`, `curriculum_items(course_id, specialty_id, semester)`,
`curriculum_item_hours(curriculum_item_id, hour_type)`.

> **History note**: earlier versions of this service modeled a *curriculum* as its own
> entity (`Curriculum` / `curricula`, one per specialty) with `CurriculumItem` pointing at
> it. Since a specialty only ever has one curriculum, that indirection was removed —
> `CurriculumItem` now references `Specialty` directly via `specialty_id`.

### `global_properties` — outside the entity framework

`global_properties` (`name` VARCHAR **primary key**, `type` a `property_type` enum, `value`
VARCHAR) is a generic name/type/value store for system-wide settings — currently
`academic_hour_duration_minutes`, `semester_duration_weeks`, `current_semester_parity`
(`ODD`/`EVEN`) and `default_class_duration_hours`. It deliberately has **no** annotated
`GlobalProperty` domain class: the whole framework (`EntityMetadataRegistry`,
`DynamicGraphQLSchemaBuilder`, `DynamicDataFetchers`, `R2dbcQueryEngine.selectOne`/`insert`/
`update`/`delete`) hardcodes the assumption that every entity has a `Long id` primary key, which
a `String`-keyed table can't satisfy. Rather than generalize that assumption across every
existing entity, the `GlobalProperty`/`GlobalPropertyQueries`/`GlobalPropertyMutations` GraphQL
types and their `list` / `globalProperty(name)` / `updateGlobalProperty(name, value)` fields are
hand-built directly in `DynamicGraphQLSchemaBuilder.buildGlobalPropertyTypes()` and wired to
hand-written fetchers in `DynamicDataFetchers` (`globalPropertyList()`, `globalProperty()`,
`updateGlobalProperty()`), following the same escape-hatch pattern already used for
`ConnectionPageInfo` and the Apollo Federation `_service` field. `R2dbcQueryEngine.updateWhere(table,
columnValues, whereColumn, whereValue)` — an `update()` variant keyed by an arbitrary column
instead of the conventional `id` — was added specifically to make `updateGlobalProperty` possible
without touching the generic `update()`/`selectOne()` methods every other entity relies on.

---

## The framework

```
org.lnu.timetable.framework
├── annotation/    @GraphQLEntity, @Description, @Nullable, @PgEnum,
│                  @OneToOne, @OneToMany, @ManyToOne, @ManyToMany
├── metadata/      EntityMetadataRegistry — scans @GraphQLEntity at startup,
│                  builds EntityMetadata (fields, columns, types, relations)
├── config/        GraphQLSchemaConfig + DSL: SchemaDefinition, TypeDefinition,
│                  QueryDefinition, MutationDefinition (create/update/delete,
│                  plus .nestedList(...) and .manyToMany(...) — see below)
├── schema/        DynamicGraphQLSchemaBuilder — builds GraphQLSchema from
│                  metadata + config; DataFetcherProvider
├── query/         R2dbcQueryEngine — table-driven optimized SQL: selectOne,
│                  selectList, selectWhere, count, insert, update, delete,
│                  plus the batched selectByIds / selectWhereIn /
│                  selectViaJoinTableBatch used by relation DataLoaders
└── runtime/       DynamicDataFetchers (query/connection/mutation/relation,
                   with per-request DataLoader batching), DynamicGraphQlConfiguration
                   (exposes the GraphQlSource bean)
```

### Define an entity

```java
@GraphQLEntity(table = "courses")
public class Course {
    private Long id;
    @Description("Discipline name") private String name;
    @PgEnum("course_type") @Description("MANDATORY, ELECTIVE_GROUP, ELECTIVE, …")
    private String courseType;
    @Nullable @ManyToOne(joinColumn = "department_id") private Department department;
}
```

Field → column names are derived `lowerCamel → lower_snake` (e.g. `ectsCredits` →
`ects_credits`). `@Description` text appears in the GraphQL schema. `@Nullable` makes a
field/relation optional; `@PgEnum("pg_type_name")` marks a `String` field backed by a native
Postgres `ENUM` column, so `R2dbcQueryEngine` adds the right `::type` cast on insert/update
(R2DBC otherwise binds it as a plain `VARCHAR`, which Postgres won't implicitly coerce).

### Declare the API (no service/repository/controller)

```java
@Component
public class CurriculumSchemaConfig implements GraphQLSchemaConfig {
    public void configure(SchemaDefinition s) {
        s.type(CurriculumItem.class)
            .fields("semester", "controlForm", "ectsCredits")
            .relation("specialty").relation("course").relation("hours");

        s.query("curriculumItemConnection").entity(CurriculumItem.class).connection()
            .orderBy("semester").filter("specialtyId", "specialty_id");
        s.query("curriculumItem").entity(CurriculumItem.class).findById();

        s.mutation("createCurriculumItem").entity(CurriculumItem.class).create()
            .inputFields("semester", "controlForm", "ectsCredits", "specialtyId", "courseId")
            .nestedList("hours", CurriculumItemHours.class, "curriculumItemId", "hourType", "hours")
            .errorStatus("RELATED_NOT_FOUND", "A referenced entity does not exist")
            .errorStatus("DUPLICATED_KEY", "A record with a duplicate unique value already exists")
            .errorStatus("INTERNAL_SERVER_ERROR", "Unexpected server error");
        // update/delete analogous
    }
}
```

`nullableRelation(...)` declares an optional to-one relation (e.g. a workload tied to either
an academic group *or* a combined group; an elective `WorkingCurriculumItem.course`).

**Nested one-to-many children in one mutation** — `.nestedList(fieldName, childClass,
fkField, ...childInputFields)` lets a single `createCurriculumItem`/`updateCurriculumItem`
call also create/update/delete the item's `hours` rows: on create, every list item is
inserted with the FK pointed at the new parent; on update, an item with a matching `id`
updates that row, an item with no matching `id` inserts one, and any existing row not
referenced by the incoming list is deleted.

**Many-to-many membership in one mutation** — `.manyToMany(fieldName, joinTable, joinColumn,
inverseJoinColumn)` exposes a plain `[ID!]` input field (e.g. `academicGroupIds`) that
replaces the join-table membership wholesale on save:

```java
s.mutation("createWorkingCurriculumItem").entity(WorkingCurriculumItem.class).create()
    .inputFields("lecturerCount", "teachingFormat", "curriculumItemHoursId", "departmentId", "courseId")
    .manyToMany("academicGroupIds", "working_curriculum_item_groups", "working_curriculum_item_id", "academic_group_id")
    .errorStatus(/* … */);
```

On create, one join row is inserted per incoming id. On update, if the field is present, all
of the parent's existing join rows are deleted and replaced with one row per incoming id
(omit the field entirely to leave membership untouched).

**Filtering by a related table's column** — a plain `.filter(paramName, column)` only works
for a column that lives directly on the entity's own table. `CombinedWorkingCurriculumItem`
has no `department_id`/`faculty_id`/semester of its own — those only exist on its *members'*
`working_curriculum_items` — so filtering its connection by faculty, a list of departments, or
semester parity needs an `EXISTS (...)` subquery instead. `QueryDefinition.relationFilter(paramName,
condition)` / `.relationFilterList(...)` / `.relationFilterString(...)` declare exactly that: a
named, nullable GraphQL argument (exposed as `ID`, `[ID!]`, or `String` respectively) bound into a
raw SQL condition supplied by the caller:

```java
s.query("combinedWorkingCurriculumItemConnection").entity(CombinedWorkingCurriculumItem.class).connection()
    .relationFilterList("departmentIds",
        "EXISTS (SELECT 1 FROM combined_working_curriculum_item_members m " +
        "JOIN working_curriculum_items w ON w.id = m.working_curriculum_item_id " +
        "WHERE m.combined_working_curriculum_item_id = combined_working_curriculum_items.id " +
        "AND w.department_id = ANY(:departmentIds))")
    .relationFilterString("semesterParity", /* … an EXISTS through curriculum_item_hours/curriculum_items … */ "");
```

`condition` references the entity's own table unaliased (queries select from it without an
alias) and contains a named bind placeholder matching `paramName`. `R2dbcQueryEngine.RawFilter`
carries these alongside the plain `Filter` records through `selectList`/`countWhere`, and
`ID_LIST` arguments are bound as a `Long[]` for `= ANY(:paramName)`. The same mechanism now backs
`facultyId` filtering on both `workingCurriculumItemConnection` and
`combinedWorkingCurriculumItemConnection` (through their department), and `semesterParity`
filtering on both (through `curriculum_items.semester`), so the frontend's schedule builder can
ask the database for "everything this faculty needs to schedule this semester" in two queries
instead of fetching every working curriculum item in the system and filtering client-side.

### Generated GraphQL shape

Queries/mutations are grouped per entity, matching the original deanery API:

```graphql
query {
  faculties { facultyConnection(limit: 1000, offset: 0) { nodes { id name } pageInfo { total hasNextPage nextPageOffset } } }
  departments { department(id: 1) { id name faculty { id name } } }
}
mutation {
  faculties { createFaculty(faculty: { name: "…" }) { isSuccess errorStatus data { id } } }
}
```

### Optimized field selection

Each fetcher reads the GraphQL selection set and selects **only** the requested columns,
e.g. `department(id:1){ id name faculty{ id name } }` runs:

```sql
SELECT id AS "id", name AS "name", faculty_id AS "facultyId" FROM departments WHERE id = $1
SELECT id AS "id", name AS "name" FROM faculties WHERE id = $1
```

---

## Avoiding N+1 queries (DataLoader batching)

Because a GraphQL relation field's data fetcher is invoked **once per parent row**, a naive
implementation issues one SQL query per row for every relation a query touches. With a
nested query like `curriculumItems → hours → workingCurriculumItems → department/course`,
that used to fan out into dozens of tiny queries per page load, visible in the R2DBC debug
logs (enabled via `application.properties`) as a wall of near-identical
`SELECT id FROM faculties WHERE id = $1` calls.

`DynamicDataFetchers.relation(...)` now resolves every relation field (to-one, to-many,
many-to-many) through a per-request `org.dataloader.DataLoader`:

- One `DataLoader` is registered per `(ownerGraphQLType, relationField)` pair — e.g.
  `"WorkingCurriculumItem.department"` — the first time that relation is built (at
  schema-build/startup time, via Spring's `BatchLoaderRegistry` bean), never per request.
- Instead of querying immediately, the data fetcher calls `loader.load(key, cols)` (`cols`
  is the resolved column list for that field occurrence, passed as the loader's *key
  context*). All calls made to the same loader within one GraphQL execution tick — i.e. by
  every sibling row requesting that relation — are automatically batched by graphql-java's
  dataloader dispatching (this graphql-java version dispatches automatically whenever a
  `DataLoaderRegistry` is present; no extra instrumentation wiring needed) into **one** SQL
  call:
  - many-to-one / one-to-one → `R2dbcQueryEngine.selectByIds` (`WHERE id = ANY(:ids)`)
  - one-to-many → `selectWhereIn` (`WHERE fk_column = ANY(:ids)`, paired with the owning fk
    value so rows can be grouped back per parent)
  - many-to-many → `selectViaJoinTableBatch` (a single join-table query for every parent id)
- Rows come back grouped per requested key (`Map<key, row>` or `Map<key, List<row>>`), so
  every sibling gets its slice without a second round trip.

This is entirely transparent to `GraphQLSchemaConfig` classes and to clients — the generated
schema and the queries you send are unchanged; only the number of SQL round trips drops.

---

## Adding a new entity (the whole workflow)

1. Create the annotated POJO in `org.lnu.timetable.domain`.
2. Add its table to `src/main/resources/db/schema.sql` (and seed rows to `data.sql`).
3. Add a `type` + queries + mutations block in the relevant `*SchemaConfig` (or a new one,
   registered as a `@Component` implementing `GraphQLSchemaConfig` — all of them are picked
   up automatically via `List<GraphQLSchemaConfig>` injection).
4. Restart — the schema, SQL handlers and relation batch loaders are regenerated
   automatically.

---

## Known limitations

- **`schema.sql`/`data.sql` are applied manually, not on startup.** Unlike a Flyway/Liquibase
  setup, nothing re-runs them when the app boots — see [Database setup](#database-setup). After
  pulling a change that touches either file, you must re-run both against your local database
  yourself, or requests against the new/changed columns fail with a Postgres "column ... does
  not exist" error (surfaced as a generic `BadSqlGrammarException` / "bad SQL grammar" message,
  which doesn't make the real cause obvious).
- The entity framework hardcodes a `Long id` primary key for every entity (`EntityMetadataRegistry`,
  the GraphQL `id: ID!` field, `R2dbcQueryEngine.selectOne`/`insert`/`update`/`delete`). The one
  table that doesn't fit — `global_properties`, keyed by `name` — is handled by a fully hand-rolled
  schema/fetcher slice instead of a generic generalization; see [global_properties — outside the
  entity framework](#global_properties--outside-the-entity-framework). A second string-keyed (or
  composite-keyed) entity would need the same treatment, not a `@GraphQLEntity` annotation.
- `lecturer_workloads.duration_hours` has a `CHECK (duration_hours BETWEEN 1 AND 4)` constraint,
  but a violation surfaces through the generic mutation error-mapping as `LECTURERWORKLOAD_NOT_FOUND`
  rather than something naming the real problem: `DynamicDataFetchers`' generic error handler maps
  any `DataIntegrityViolationException` (which is also what a foreign-key violation throws) to
  whichever declared error status *contains* the substring `"NOT_FOUND"`, and doesn't distinguish a
  CHECK-constraint failure from a missing related row. In practice this is only reachable by
  bypassing the UI (which only offers 1–4 via a select), so the impact is limited to direct API use.
- Not every many-to-many relation is wired for mutation yet — `CombinedGroup ↔
  AcademicGroup` membership is queryable but still read-only through the generated
  mutations (seed it via `data.sql` or direct SQL). `WorkingCurriculumItem ↔ AcademicGroup`
  demonstrates the pattern (`.manyToMany(...)`); applying it to `CombinedGroup` would be a
  small, mechanical change.
- Query/mutation namespace pluralization is a naive suffix rule (`+s`, or `y → ies`) — it
  mishandles a name that already ends in "s", e.g. `CurriculumItemHours` becomes the
  namespace `curriculumItemHourss` (double s) rather than something more natural.
- Connections are offset/limit only (`pageInfo.total` / `hasNextPage` / `nextPageOffset`) —
  no cursor-based pagination.
