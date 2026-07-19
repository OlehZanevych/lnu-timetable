# Timetable GraphQL Service

A reactive **Spring Boot + GraphQL + R2DBC** service for university course timetabling at
Ivan Franko National University of Lviv (LNU). It ships a small **config-driven framework**:
you describe entities with annotations and declare GraphQL types/queries/mutations in a
configuration class — **no controllers, services or repositories, and no `.gqls` files**.
The schema, optimized SQL handlers, and N+1-safe batched relation loading are all generated
at startup.

- `groupId` `org.lnu`, `artifactId` `timetable`, root package `org.lnu.timetable`
- Spring Boot 4.0.6, Java 25, WebFlux, Spring for GraphQL, R2DBC (PostgreSQL)
- JWT authentication + entity-scoped, cascading "modify" permissions for users/groups — see
  [Authentication & authorization](#authentication--authorization)

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
- Every operation except `login` requires an `Authorization: Bearer <jwt>` header — sign in via
  `mutation { login(email: "admin@lnu.edu.ua", password: "Admin#2026") { token } }` and pass the
  returned token, or see [Authentication & authorization](#authentication--authorization) for the
  full seeded credential list

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

### `users` / `groups` / `permissions` — outside the entity framework

Like `global_properties`, the four auth tables have no `@GraphQLEntity` domain class — a `User`'s
`password_hash` must never be reachable through the fully-generic, selection-set-driven query
machinery, so `User`/`Group`/`PermissionGrant` are hand-built GraphQL types with hand-written
fetchers instead (see [Authentication & authorization](#authentication--authorization) below).

| Table | Notes |
|---|---|
| `users` | email (unique), first/last name, BCrypt `password_hash`, `must_change_password`, `is_active` |
| `groups` | name (unique), description |
| `user_groups` | `(user_id, group_id)` — a user may belong to any number of groups |
| `permissions` | a single grant: `grantee_type` (`USER`/`GROUP`) + exactly one of `user_id`/`group_id`, `resource_type` + `resource_id` (or `resource_type = 'GLOBAL'` with a `NULL` id for full admin access), `granted_by` |

### Permission cascade annotations on domain entities

Most domain classes carry class-level `@PermissionParent`/`@PermissionJoinParent` annotations
(see [Authentication & authorization](#authentication--authorization)) declaring which ancestor
entity a "modify" grant cascades down from. The resulting graph:

| Entity | Cascades down from (any one path is sufficient) |
|---|---|
| `Faculty` | `Building`? |
| `Department`, `Specialty` | `Faculty` |
| `Room` | `Faculty`?, `Building`? |
| `Course` | `Department`?, `Faculty`?, parent `Course`? (elective group → its options) |
| `Lecturer` | `Department` |
| `AcademicGroup` | `Specialty` |
| `CombinedGroup` | any member `AcademicGroup` (via `combined_group_academic_groups`) |
| `Student` | `AcademicGroup` |
| `CurriculumItem` | `Specialty`, `Course` |
| `CurriculumItemHours` | `CurriculumItem` |
| `WorkingCurriculumItem` | `Department`, `CurriculumItemHours`, elective `Course`? |
| `CombinedWorkingCurriculumItem` | any member `WorkingCurriculumItem` (via `combined_working_curriculum_item_members`) |
| `LecturerWorkload` | `WorkingCurriculumItem`?, `CombinedWorkingCurriculumItem`?, any linked `Lecturer`/`AcademicGroup`/`CombinedGroup` (join tables) |
| `TimetableEntry` | `LecturerWorkload`, `Room` |
| `Building`, `AcademicDegree`, `ClassStartTime` | *(none — top-level; only an administrator can create/modify these)* |

`?` marks a `nullable = true` edge (the FK may be unset, in which case that path just doesn't
apply). Following these edges upward from any row yields the full set of resources whose grant
would cover it — e.g. a grant on a `Faculty` covers its `Department`s, `Specialty`s, `Room`s,
`Course`s, and — by walking further — every `Lecturer`, `AcademicGroup`, `CurriculumItem`,
`WorkingCurriculumItem`, `LecturerWorkload` and `TimetableEntry` beneath them, exactly matching the
cascade the product spec asked for.

---

## The framework

```
org.lnu.timetable.framework
├── annotation/    @GraphQLEntity, @Description, @Nullable, @PgEnum,
│                  @OneToOne, @OneToMany, @ManyToOne, @ManyToMany,
│                  @PermissionParent(s), @PermissionJoinParent(s) — see below
├── metadata/      EntityMetadataRegistry — scans @GraphQLEntity at startup,
│                  builds EntityMetadata (fields, columns, types, relations,
│                  resourceType, permissionParents, permissionJoinParents)
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

org.lnu.timetable.security   — authentication/authorization; see below
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

## Authentication & authorization

Users never self-register. An administrator creates an account (`createUser`) with a temporary
password; the account is forced to change it (`must_change_password = TRUE`) before it can do
anything else. Authentication is a stateless JWT (`io.jsonwebtoken`/jjwt) carrying only the user
id as its subject — no roles or permissions are baked into the token, so revoking a user's access
(deactivating the account, or removing a permission grant) takes effect on their *next* request
rather than waiting for the token to expire. Passwords are hashed with BCrypt
(`spring-security-crypto` only — this project does **not** pull in full Spring Security, since
authorization here is entity-scoped rather than the role/URL-based model that framework is built
around).

### Request flow

1. `AuthenticationGraphQlInterceptor` (a `WebGraphQlInterceptor`) reads the `Authorization: Bearer
   <jwt>` header of every request, resolves it to a `Principal` (id, email, name,
   `mustChangePassword`) via `JwtService`/`PermissionRepository`, and places it on the GraphQL
   context. A missing/invalid/expired token simply leaves the request anonymous rather than
   rejecting it outright — this keeps `login` reachable through the same `/graphql` endpoint,
   while every other field enforces its own requirement.
2. `AuthorizingDataFetcherProvider` wraps the generic `DynamicDataFetchers` and is the
   `DataFetcherProvider` actually wired into `DynamicGraphQLSchemaBuilder` (via
   `DynamicGraphQlConfiguration`) — the schema builder itself has no authorization awareness.
   It enforces two rules for every reflectively-generated query/mutation:
   - any operation requires a signed-in caller (reads are open to any authenticated user);
   - `create`/`update`/`delete` mutations additionally require "modify" permission on the target
     (or, for creates, on whichever declared parent the new row is being attached to) — see
     `PermissionService` below.
3. Hand-rolled operations (`login`, `me`, `changePassword`, `createUser`, group/permission
   management) bypass this decorator entirely — they're wired directly in
   `DynamicGraphQLSchemaBuilder.buildAuthTypes()`/`registerAuthFetchers()`, the same escape-hatch
   pattern used for `GlobalProperty` (see above), so a `User`'s password hash is never reachable
   through the generic, selection-set-driven machinery.

### The permission model

A grant (`permissions` table) names a `resource_type` — an entity's simple class name in
`UPPER_SNAKE_CASE`, e.g. `FACULTY`, derived the same way both sides of the stack independently
compute it (`EntityMetadata#resourceType()` on the backend via Guava's `CaseFormat`, `toResourceType()`
in the frontend) — plus a `resource_id`, or the special `resource_type = 'GLOBAL'` (`resource_id`
`NULL`) for full-access admin grants. "Modify" permission on a resource means update, delete, *and*
the right to create new child rows underneath it (and to modify those children in turn) — exactly
the cascade the product spec asked for (e.g. a grant on a `Faculty` also covers its `Department`s,
`Specialty`s, `Room`s, `Course`s, and transitively everything beneath those).

That cascade is declared, not hardcoded, via two repeatable class-level annotations in
`org.lnu.timetable.framework.annotation`:

```java
@GraphQLEntity(table = "departments")
@PermissionParent(value = Faculty.class, joinColumn = "faculty_id")
public class Department { ... }

@GraphQLEntity(table = "combined_groups")
@PermissionJoinParent(value = AcademicGroup.class,
    joinTable = "combined_group_academic_groups",
    selfColumn = "combined_group_id", parentColumn = "academic_group_id")
public class CombinedGroup { ... }
```

`@PermissionParent` covers a direct foreign key on the entity's own table; `@PermissionJoinParent`
covers an ancestor reached through a many-to-many join table (e.g. a `LecturerWorkload` is also
covered by a grant on any `Lecturer` assigned to it). Either may be repeated
(`@PermissionParents`/`@PermissionJoinParents`) when an entity has more than one path to an
ancestor — coverage through *any one* declared path is enough. See [Permission cascade
annotations on domain entities](#permission-cascade-annotations-on-domain-entities) above for the
full graph as actually declared across the domain model.

`PermissionService` (`org.lnu.timetable.security`) is the central decision point:

- `canModify(userId, entityClass, id)` walks **up** from the row (cheaper than walking down from
  every grant) along the declared edges, up to a depth of 15 (`MAX_DEPTH`, guarding against an
  accidental annotation cycle), collecting every ancestor `(resourceType, id)` pair reachable —
  then checks whether the user (directly, or via any group they belong to) holds a grant on any
  one of them, or a `GLOBAL` grant.
- `canCreate(userId, entityClass, input)` does the same starting from whichever
  `@PermissionParent` foreign keys are present in the proposed input, since the row doesn't exist
  yet to walk up from. An entity with no applicable parent reference in the input (e.g. a
  top-level `Building`, or an optional-FK entity created with none of its FKs set) can then only be
  created by an administrator.
- `canManageGrantsOn(userId, resourceType, resourceId)` is the delegation rule: **you can only
  grant (or revoke) access to a scope you already hold yourself.** A user with modify permission
  on a `Faculty` can grant that same `Faculty` — or anything beneath it — to another user or
  group; they cannot grant access to an unrelated faculty, or promote anyone to `GLOBAL`
  admin unless they're a `GLOBAL` admin themselves.

### GraphQL API

| Field | Kind | Notes |
|---|---|---|
| `login(email, password)` | mutation | returns a JWT + whether the account must change its password |
| `me` | query | the signed-in `CurrentUser` (profile, `isAdmin`, groups, effective permissions), or `null` |
| `changePassword(currentPassword, newPassword)` | mutation | minimum 8 characters; clears `mustChangePassword` |
| `createUser(email, firstName, lastName, temporaryPassword)` | mutation | **admin-only**; the created account must change its password on first login |
| `setUserActive(userId, active)` | mutation | **admin-only**; deactivates/reactivates an account |
| `users` | query | **admin-only**; all accounts |
| `createGroup(name, description)`, `addUserToGroup`/`removeUserFromGroup` | mutation | **admin-only** group management |
| `groups` | query | any authenticated user |
| `grantPermission(granteeType, userId\|groupId, resourceType, resourceId)` | mutation | delegatable — see `canManageGrantsOn` above |
| `revokePermission(permissionId)` | mutation | same delegation check, resolved from the grant's own resource |
| `canModifyResources(resourceType, resourceIds)` | query | given candidate ids of one type, returns the subset the caller may modify — what the frontend uses to hide edit/delete buttons |
| `grantsForResource(resourceType, resourceId)` | query | lists who currently has access on a resource; requires the caller to already be able to manage grants there |

All admin-only fields fail with a `GraphQlAuthException` for non-admins; unauthenticated calls to
anything except `login` fail the same way with "You must be signed in to do this."

### Configuration & seed data

`app.security.jwt-secret` (≥32 bytes for HS256) and `app.security.jwt-ttl-minutes` (default 720 =
12 hours) live in `application.properties`. The checked-in secret is a generated dev-only value —
**override it before deploying anywhere real** (e.g. via `SPRING_APPLICATION_JSON` or an
environment variable).

`data.sql` seeds two groups ("Деканат ФПМіІ", "Завідувачі кафедр") and three accounts for local
testing:

| Email | Password | Role |
|---|---|---|
| `admin@lnu.edu.ua` | `Admin#2026` | `GLOBAL` admin grant, no forced password change |
| `dean.fpmi@lnu.edu.ua` | `Temp#12345` | member of "Деканат ФПМіІ" (holds a `FACULTY` grant); must change password on first login |
| `o.melnyk@lnu.edu.ua` | `Temp#12345` | direct `DEPARTMENT` grant; must change password on first login |

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
- **JWTs are stateless and not revocable individually.** `login` issues a token valid for
  `app.security.jwt-ttl-minutes` (default 12h); there's no refresh-token flow, and no server-side
  session to invalidate on logout — a leaked token keeps working until it expires. Deactivating
  the account (`setUserActive`) or revoking a permission grant takes effect immediately on the
  *next* request, but the token itself remains "valid" until it expires.
- Only one permission level exists: **modify** (update + delete + create/modify children). There's
  no separate read-restriction — any authenticated user can query any entity; permission grants
  only govern which edit/delete buttons the frontend shows and which mutations succeed.
- `grantsForResource` requires already knowing the exact `resourceType`/`resourceId` to audit — 
  there's no single query that lists every grant in the system across all resource types.
- The ancestor-closure check in `PermissionService.ancestryOf` walks the permission graph with one
  SQL round trip per edge (via sequential/parallel reactive composition, capped at depth 15) rather
  than a single recursive CTE. Fine at this project's scale; a much larger entity graph or
  permission volume would want that consolidated into one query.
