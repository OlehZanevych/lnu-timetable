---
name: orient
description: Get oriented in the lnu-timetable project by reading its Markdown documentation selectively rather than exhaustively. Use at the start of a session, when the user asks you to familiarize yourself with the project, read the READMEs, learn the architecture, or invokes /orient — and before the first substantive change in any session that did not already do this.
---

# Orientation (lnu-timetable)

The project's documentation is ~10,200 lines across fourteen Markdown files. Reading it end to end is
both slow and unnecessary: most of it is depth on subsystems a given task never touches. Read the
**map** in full, then only the **sections your task lands in**.

This section is the substitute for a first pass. Take it as given and do not spend a read
confirming it.

## What the project is

A timetabling system for Ivan Franko National University of Lviv (LNU) — a dissertation project.
Two halves in one repository, deployed as a single jar.

**`timetable/`** — Spring Boot 4.0.6, Java 25, WebFlux, Spring for GraphQL, R2DBC, PostgreSQL 15+
(built with ICU, for the `ukrainian` collation).

**`timetable-ui/`** — Angular 21, standalone components, signals, **zoneless**. Every style is
global and lives in `src/styles.css`.

### The two ideas everything else follows from

**The service has no controllers, services, repositories or `.gqls` files.** Entities are annotated
POJOs in `domain/`; the four `*SchemaConfig` classes in `config/` declare the API; the GraphQL schema
and the SQL are generated at startup from that metadata by `framework/`. Adding an entity means
adding a POJO and a `configure<Entity>` method — nothing else. When asked to add or change an
endpoint, work through the config, never by writing a controller. The exceptions — `GlobalProperty`,
the auth surface, self-service registration — are hand-written GraphQL, and a new one is a
`HandWrittenApi` bean rather than an edit to the schema builder.

**The client has two architectures side by side.** Generic metadata-driven CRUD tables
(`entities.ts` + `BaseEntity` + `entity-page.html`, one route per entity) *and* hand-written
drill-down pages (faculty, department, degree programme, course, lecturer, room, «Мій кабінет»). Both are
intentional: the generic half is for reference data, the hand-written half for the screens where the
work actually happens. Know which half you are in before changing anything.

### Conventions that are easy to violate

- **Every value sent to GraphQL travels as a variable**, never written into the document.
  Runtime-assembled documents use `GqlVars` (`v.arg` / `v.ref` / `v.optionalArg` / `v.declaration`).
  `npm run lint:graphql` enforces this and several traps around it — run it after touching any query.
- **Authorization is entity-scoped and cascading**, at three ordered levels: `EDIT` < `FULL` <
  `MANAGE`. A grant names one resource (or `GLOBAL`) and covers everything below it via
  `@PermissionParent`/`@PermissionJoinParent` — and every entity must declare one of those or
  `@PermissionRoot`, or the service refuses to start. Create/update need `EDIT`, delete needs
  `FULL`, delegation needs `MANAGE`. The client hides what a caller cannot use — down to whole pages
  and tabs — reading the same cascade from `Query.accessModel` rather than a copy of it
  (`access-need.ts`, `access-gate.ts`); UI gating is a convenience, never the boundary.
- **A drill-down page's open tab is part of its URL** (`/faculty/:id/:section`), via
  `section-route.ts`. Tabs are addresses, not component state.
- **`schema.sql` is always the current schema**; anything that has to carry an existing database
  forward is a Flyway migration in `db/migration/`, written to be a no-op on a second run. `data.sql`
  is a real dump the user maintains — do not hand-edit it.
- **UI text is Ukrainian.** In prose, Ukrainian domain nouns appear bare inside English sentences
  (кафедра, факультет, викладач, розклад, навантаження…); UI labels and report names go inside « ».
  Match the surrounding file; do not introduce new Ukrainian vocabulary.

## How to read

**Always, in full:** the root `README.md` (~320 lines). It is the map — what the system does, how
the halves divide, the repository layout, and a table pointing at every other document.

**Then, selectively.** Get a heading map first and read only what you need:

```bash
grep -n "^## \|^### " timetable/README.md
grep -n "^## \|^### " timetable-ui/README.md
```

| Working on | Read |
|---|---|
| Database, entities, a table, a migration | `timetable/README.md` → *Domain model*, *Migrations (Flyway)* |
| Adding/changing a GraphQL query or mutation | `timetable/README.md` → *The framework* (esp. *The query catalogue*, *Where each entity is declared*) |
| Login, registration, permissions, delegation | `timetable/README.md` → *Authentication & authorization*; then `timetable-ui/README.md` → *Authentication* |
| A client page or widget | `timetable-ui/README.md` → *Two architectures, side by side* (find the page's own `####` subsection) |
| Routing, tabs, URLs | `timetable-ui/README.md` → *Routes*, *The open tab is part of the URL* |
| The timetable solver | `timetable-ui/TIMETABLE-GENERATION.md`, and `timetable-ui/SOLVER-OPTIMISATION.md` + `scripts/timetable-bench/README.md` for the measurements |
| Workload generation | `timetable-ui/WORKLOAD-GENERATION.md`, and `scripts/workload-bench/README.md` for the measurements |
| A printable form | the matching `timetable-ui/*-PDF.md` |
| Performance, batching, N+1 | `timetable/README.md` → *Avoiding N+1 queries* |
| Deploying it, keeping it running, the update job | `scripts/deploy/README.md` |

**Do not bulk-read the topic files** (`TIMETABLE-GENERATION.md`, `SOLVER-OPTIMISATION.md`,
`WORKLOAD-GENERATION.md`, the four
`*-PDF.md`) unless the task is that topic. Between them they are ~3,900 lines of depth that no
unrelated change needs.

**Read the *Known limitations* section** of whichever README you are working in before proposing a
change in that area — several apparent bugs are documented decisions, and a few are known gaps
somebody may be asking you to close.

## How to use what you read

The documentation explains **why**, not just what, and it is unusually reliable — treat a stated
rationale as a real constraint rather than something to redesign around. Where a document explains a
decision, follow it or say explicitly why you are departing from it.

Two cautions. Counts, tables and file trees drift faster than prose, so **verify any number, route
table or field list against the code** before relying on it for a change. And the documentation is
part of the deliverable here: a change that alters documented behaviour is not finished until the
matching document says so — `/docs-check` is the end-of-session counterpart to this skill.

Do not summarise the architecture back to the user. They wrote it. Report what you read only insofar
as it changes what you are about to do.

## Practicalities

The repository lives on the user's Mac; reach it with `mcp__remote-devices__device_bash` under the
mounted path, not with the sandbox's own tools. There is no JDK 25 or reachable Maven Central in the
sandbox, so **the Java cannot be compiled here** — say so plainly rather than implying it was
checked. What can be verified locally:

```bash
cd timetable-ui && npx tsc -p tsconfig.app.json --noEmit
cd timetable-ui && node scripts/check-graphql-variables.mjs
cd timetable-ui && npx ng build --configuration production --no-progress   # initial bundle < 1.00 MB
```

PostgreSQL 16 *is* available in the sandbox, so a migration can be rehearsed for real against a
throwaway database — do that rather than reasoning about SQL in the abstract.

## Maintenance

This file lives at `.claude/skills/orient/SKILL.md` and is versioned with the project. `/docs-check`
is responsible for keeping it current: it adds a row to the routing table when a document a task
could route to is added, fixes the row when one is renamed or removed, and corrects the architecture
summary above when something structural changes. It deliberately does *not* update this file for
ordinary documentation edits — this is a map, and a map that grows with the territory stops being one.
