---
name: docs-check
description: Audit the lnu-timetable Markdown documentation against uncommitted code changes and bring it up to date. Use at the end of a session or a stage of work, when the user asks to check whether the *.md files are updated, whether anything was missed, whether the docs still match the code, or invokes /docs-check.
---

# Documentation check (lnu-timetable)

Audit every `*.md` file in the repository against the code changes in the working tree, fix what is
wrong or missing, and report. The docs in this project are load-bearing — they are read as the
explanation of the system, not as a summary of it — so a false sentence costs more than a missing one.

## 1. Get the diff

Prefer a `patch.diff` at the repository root if one exists and is current. Otherwise generate one:

```bash
git diff HEAD > patch.diff        # add --staged if the work is staged
```

Extract the sections you need with `awk`/`sed` between `diff --git` markers rather than reading the
whole file. For a large diff, split the audit across parallel subagents — backend, frontend, and
anything with its own topic document — and give each the explicit cross-check list from §3.

## 2. Where each fact belongs

Put every fact in the **nearest-scoped** file and link to it from anywhere else that needs it. Never
explain the same thing twice.

| Subject | File |
|---|---|
| Domain model, schema, migrations, GraphQL surface, framework, authorization | `timetable/README.md` |
| Pages, components, routing, client state, permission-aware UI | `timetable-ui/README.md` |
| The timetable solver | `timetable-ui/TIMETABLE-GENERATION.md` |
| The workload generator | `timetable-ui/WORKLOAD-GENERATION.md` |
| A printable form | the matching `timetable-ui/*-PDF.md` |
| The benchmark | `timetable-ui/scripts/workload-bench/README.md` |
| Running it as a service, the systemd unit, the update job | `scripts/deploy/README.md` |

The root `README.md` gets **one or two sentences and a link** — what the system now does, never how
it does it. If a change is only mechanical (a rename, a bulk refactor already covered by a stated
rule), it may need no documentation at all; say so rather than inventing a paragraph.

## 3. What to check, in priority order

**First — statements the code now makes false.** These matter most and are the easiest to miss,
because the sentence still reads perfectly. Include contradictions between two files, or between two
sections of one file. Quote the stale sentence in your report.

**Second — stale counts, tables and trees.** These rot silently while the prose around them gets
updated. Verify each against the code, not against the surrounding text:

- the `src/app` file tree and the repository-layout tree — is every new file listed, is every
  description still true
- the routes table vs `app.routes.ts` — every path, component, redirect and `loadComponent`
- the GraphQL API tables vs `DynamicGraphQLSchemaBuilder` and the four `*SchemaConfig` classes —
  fields, arguments, error statuses, **in both directions** (in code but not documented, and
  documented but no longer in code)
- the query catalogue vs the `QueryDefinition` config, including the "N entities are missing on
  purpose" claim
- the schema tables, enum list, unique constraints and cascade graph vs `schema.sql` and the
  `@PermissionParent`/`@PermissionJoinParent` annotations
- the migration list vs `db/migration/` — every `V*.sql` named, and what its backfill does
- class/entity/route counts stated as words ("thirteen classes", "28 entities", "three of the five")
- every `#anchor` cross-reference still resolves

**Third — omissions that change what a reader would do.** New behaviour, new failure modes, a rule
that now has an exception. Skip pure trivia (an accessor missing from a method table, an argument's
exact clamping) unless it is load-bearing.

## 4. Language

English prose. A bare Ukrainian domain noun inside an English sentence is house style, but **only**
for vocabulary already used that way before this change:

> кафедра, факультет, викладач, студент, розклад, навантаження, навчальний план, корпус, пара,
> аудиторія, гарант, завідувач, семестр, курс, освітня програма, спеціальність, група, лекція,
> РНП, примітки

Do not introduce new Ukrainian vocabulary — use English instead (*deanery*, not деканат). UI labels,
report names, document captions and database values stay Ukrainian inside « ». If a file contained no
bare Ukrainian before the change, keep it that way. Proper nouns (ЛНУ, ФПМІ, street names) are fine
anywhere.

To find strays, mask quoted spans first, then look for what survives:

```bash
python3 - <<'PY'
import io, re
cyr = re.compile(r'[Ѐ-ӿ]+')
for f in ['README.md', 'timetable/README.md', 'timetable-ui/README.md']:
    t = io.open(f, encoding='utf-8').read()
    m = re.sub(r'«[^»]*»|"[^"\n]*"|`[^`\n]*`', ' ', t)
    for i, l in enumerate(m.splitlines(), 1):
        if cyr.search(l):
            print(f, i, ' '.join(cyr.findall(l)))
PY
```

Compare the result against `git show HEAD:<file>` to tell an established usage from one just added.

## 5. Code bugs

A documentation gap is often the visible end of a code bug. If the docs are right and the code is
wrong, if a symbol is dead, or if two sources of truth disagree — **fix the code and report it
separately** from the documentation changes, with what it breaks. Do not quietly reword the
documentation to match broken code.

## 6. Keep `/orient` current

`/orient` lives at `.claude/skills/orient/SKILL.md` in this repository, so it is an ordinary file you
can edit — and it is the one document that goes stale invisibly, because nobody reads it on purpose.

**Check it whenever the set of `*.md` files changes.** Compare against the diff:

```bash
git status --short -- '*.md'      # added, renamed or deleted documents
```

Update `/orient` only when a change alters **where a future session should look**:

- **A new document a task could route to** — add one row to its *Working on → Read* table, and to
  the §2 placement table in this skill. One line each. If the new file is a sub-README for something
  already covered by a broader row, or a note nobody would need before starting work, leave both
  alone.
- **A document renamed, deleted or split** — fix or drop the row.
- **A structural change to the architecture summary it carries** — a new UI architecture, a fourth
  access level, a framework replaced. That page is a snapshot presented as fact, so a wrong line
  there is worse than a missing one. Fix the sentence, do not add a paragraph.
- **The YAML `description:`** — only if the change alters when the skill should *trigger*, which a
  new document almost never does. Leave it alone by default.

Do **not** update `/orient` for ordinary documentation edits, new sections inside an existing file,
or anything that only adds detail. It is a map, and a map that grows with the territory stops being
one. If in doubt, leave it and say so in your report.

Say in the report whether you changed `/orient`, and if not, why the change did not warrant it.

## 7. Verify before reporting done

Run whatever the project can check without a running service, and say which passed:

```bash
cd timetable-ui && npx tsc -p tsconfig.app.json --noEmit
cd timetable-ui && node scripts/check-graphql-variables.mjs
cd timetable-ui && npx ng build --configuration production --no-progress   # must stay under 1.00 MB
python3 -c "import xml.dom.minidom; xml.dom.minidom.parse('timetable/pom.xml')"
```

Then confirm no cross-reference is broken (GitHub anchor rules: lowercase, drop punctuation other
than hyphens and underscores, spaces to hyphens — so `&` leaves a double hyphen).

## 8. Report

Group by file: what changed and why. List separately (a) any code bug found and fixed, (b) whether
`/orient` needed updating, and (c) anything deliberately left alone, with the reason. Decide as much
as you can yourself; ask only when a choice genuinely changes the outcome and no default is
defensible.
