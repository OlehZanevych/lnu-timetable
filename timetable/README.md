# Timetable GraphQL Service

A reactive **Spring Boot + GraphQL + R2DBC** service for university course timetabling at
Ivan Franko National University of Lviv (LNU). It ships a small **config-driven framework**:
you describe entities with annotations and declare GraphQL types/queries/mutations in a
configuration class — **no controllers, services or repositories, and no `.gqls` files**.
The schema and optimized SQL handlers are generated at startup.

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
query selecting only the requested columns**.

---

## Requirements

- **JDK 25** (the project targets `release 25`; Maven running on an older JDK fails with
  "release version 25 not supported"). On macOS:
  ```bash
  export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home
  ```
- **PostgreSQL** running on `localhost:5432` with a database named `timetable`.
- Maven (the bundled `mvnw` wrapper also works).

---

## Database setup

```bash
# create database (psql from your PostgreSQL install)
createdb -h localhost -U postgres timetable
# load schema and seed data
psql -h localhost -U postgres -d timetable -f src/main/resources/db/schema.sql
psql -h localhost -U postgres -d timetable -f src/main/resources/db/data.sql
```

`schema.sql` starts with `DROP SCHEMA public CASCADE`, so it always recreates a clean
schema in the `timetable` database. Connection settings live in
`src/main/resources/application.properties`.

---

## Run

```bash
JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home mvn spring-boot:run
```

- GraphQL endpoint: `POST http://localhost:8080/graphql`
- GraphiQL (browser IDE): `http://localhost:8080/graphiql`
- `GET /` redirects to **Apollo Studio Sandbox** pointed at this service
- Apollo Federation `_service { sdl }` is served for schema introspection by gateways

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
| `Faculty` | `faculties` | → departments, specialties, rooms |
| `Department` (кафедра) | `departments` | → faculty, lecturers, courses |
| `Specialty` (спеціальність) | `specialties` | code, degree; → faculty, groups, curricula |
| `Course` (дисципліна) | `courses` | ECTS; → department |
| `Curriculum` (навчальний план) | `curricula` | admission year, degree; → specialty, items |
| `CurriculumItem` | `curriculum_items` | semester, control form; → curriculum, course |
| `WorkingCurriculum` (робочий план) | `working_curricula` | academic year, semester; → curriculum |
| `WorkingCurriculumItem` | `working_curriculum_items` | hours by class type; → course |
| `Lecturer` (викладач) | `lecturers` | position, degree; → department, workloads |
| `LecturerWorkload` (**class requirement**) | `lecturer_workloads` | classType, periodicity; → lecturer, course, academicGroup?, combinedGroup?, workingCurriculum? |
| `Student` | `students` | → academic group |
| `AcademicGroup` (ПМі-31) | `academic_groups` | year, study form; → specialty, students, M-N combined groups |
| `CombinedGroup` (об'єднана група) | `combined_groups` | M-N academic groups (electives) |
| `Room` (аудиторія) | `rooms` | capacity, kind; → faculty? |
| `TimeSlot` (пара) | `time_slots` | ordinal, start/end time |
| `TimetableEntry` (**the schedule / "gene"**) | `timetable_entries` | dayOfWeek, weekParity; → workload, timeSlot, room |

Relationships: one-to-one, one-to-many, many-to-one and many-to-many are all supported.

---

## The framework

```
org.lnu.timetable.framework
├── annotation/    @GraphQLEntity, @Description, @Nullable,
│                  @OneToOne, @OneToMany, @ManyToOne, @ManyToMany
├── metadata/      EntityMetadataRegistry — scans @GraphQLEntity at startup,
│                  builds EntityMetadata (fields, columns, types, relations)
├── config/        GraphQLSchemaConfig + DSL: SchemaDefinition, TypeDefinition,
│                  QueryDefinition, MutationDefinition
├── schema/        DynamicGraphQLSchemaBuilder — builds GraphQLSchema from
│                  metadata + config; DataFetcherProvider
├── query/         R2dbcQueryEngine — table-driven optimized SQL (selectOne,
│                  selectList, selectWhere, count, insert, update, delete,
│                  selectViaJoinTable)
└── runtime/       DynamicDataFetchers (query/connection/mutation/relation),
                   DynamicGraphQlConfiguration (exposes the GraphQlSource bean)
```

### Define an entity

```java
@GraphQLEntity(table = "courses")
public class Course {
    private Long id;
    @Nullable private String code;            // @Nullable → nullable in schema; non-null otherwise
    @Description("Discipline name") private String name;
    @Nullable private Integer ectsCredits;
    @ManyToOne(joinColumn = "department_id") private Department department;
}
```

Field → column names are derived `lowerCamel → lower_snake` (e.g. `ectsCredits` →
`ects_credits`). `@Description` text appears in the GraphQL schema.

### Declare the API (no service/repository/controller)

```java
@Component
public class TimetableSchemaConfig implements GraphQLSchemaConfig {
    public void configure(SchemaDefinition s) {
        s.type(Course.class).fields("code", "name", "ectsCredits").relation("department");
        s.query("courseConnection").entity(Course.class).connection().orderBy("name");
        s.query("course").entity(Course.class).findById();
        s.mutation("createCourse").entity(Course.class).create().inputFields("code", "name", "ectsCredits", "departmentId");
        // update/delete analogous
    }
}
```

`nullableRelation(...)` declares an optional to-one relation (e.g. a workload tied to either
an academic group *or* a combined group).

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

## Adding a new entity (the whole workflow)

1. Create the annotated POJO in `org.lnu.timetable.domain`.
2. Add its table to `src/main/resources/db/schema.sql` (and seed rows to `data.sql`).
3. Add a `type` + queries + mutations block in `TimetableSchemaConfig` (a `crud(...)` helper
   does connection + findById + create/update/delete with standard error statuses).
4. Restart — the schema and SQL handlers are regenerated automatically.

---

## Known limitations

- **Many-to-many membership** (e.g. `CombinedGroup ↔ AcademicGroup`) is queryable but not
  editable through the generated mutations; seed it via `data.sql` or direct SQL.
- Relations are resolved per parent row (no DataLoader batching yet); column-level
  optimization is in place, N+1 batching is not.
- Generated query namespaces are pluralized simply (`Curriculum` → `curriculums`,
  not the Latin "curricula").
