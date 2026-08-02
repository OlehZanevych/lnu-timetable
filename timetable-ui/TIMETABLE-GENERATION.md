# Automatic generation of the timetable

The faculty page's **«Формування розкладу»** tab (`/faculty/:id`, section *Розклад*) can fill in the
whole weekly schedule by itself. This document describes what it solves, what it is allowed to
touch, the algorithm in full detail, and where it stops short.

The solver is `src/app/timetable-solver.ts` — pure TypeScript, no Angular, no GraphQL, no I/O, so it
can be unit-tested against plain objects and run under Node as easily as in the browser. It runs in
a **Web Worker** (`src/app/timetable-solver.worker.ts`), because the search is a tight synchronous
loop with no natural yield point and would otherwise freeze the page for exactly as long as the
progress modal is supposed to be animating. `faculty-timetable-list.ts` maps the loaded data into
the solver's input shape, shows progress, and applies the returned plan itself.

Everything happens **in the browser**. The server is only read from and, once the user presses
«Застосувати», written to — it contains no scheduler.

**Contents**

1. [What the problem actually is](#1-what-the-problem-actually-is)
2. [Inputs](#2-inputs)
3. [Constraints](#3-constraints)
4. [Data structures](#4-data-structures)
5. [The algorithm](#5-the-algorithm)
6. [Parameters](#6-parameters)
7. [A worked example](#7-a-worked-example)
8. [Complexity and measured behaviour](#8-complexity-and-measured-behaviour)
9. [Applying the plan](#9-applying-the-plan)
10. [What is and isn't guaranteed](#10-what-is-and-isnt-guaranteed)
11. [Code map](#11-code-map)
12. [Testing](#12-testing)
13. [Where to take it next](#13-where-to-take-it-next)

---

## 1. What the problem actually is

This is the University Course Timetabling Problem (UCTP): assign each class session a day, a start
time, a room, and — for classes held every second week — a week parity, so that no lecturer, group
or room is in two places at once, and so that the resulting days have as few idle gaps as possible.
It is NP-hard by reduction from graph colouring, and even the feasibility subproblem is NP-complete,
so what follows is a heuristic that finds good schedules quickly rather than an exact method.

The formulation follows **«Adaptive Memetic Algorithm for University Course Timetabling»**
(`~/Education/Articles/memetic-algorithms`), whose model is the same one this database was built
around: a *class requirement* is a lecturer + groups + periodicity, and the schedule assigns it a
day, slot, room and week parity.

### 1.1 Vocabulary: the article, the database, the code

The three speak slightly different languages, and most confusion when reading the solver comes from
not having the mapping to hand:

| Article | Database | Solver | Note |
|---|---|---|---|
| class requirement `r ∈ R` | one class session required by a `LecturerWorkload` | `SolverRequirement`, then a **gene** | not a row of its own: derived from the workload's hours |
| — | `LecturerWorkload` | `workloadId` on the requirement | one workload usually yields several requirements |
| gene `g_i = (r, d, s, a, π)` | `timetable_entries` row | `Gene` + `SolverPlacement` | |
| lecturer `ℓ(r)` | `lecturer_workload_lecturers` | `gene.lecturers: number[]` | **plural** here: a lab split between two lecturers needs both free |
| groups `G(r)` | `lecturer_workload_academic_groups` ∪ combined groups' members | `gene.groups: number[]` | |
| room `a_r` | `timetable_entries.room_id` | `gene.room: number` | |
| timeslot `s_r` | `class_start_times.id` | `gene.timeIdx` → `(start, end)` in minutes | not a uniform grid, see §1.3 |
| day `d_r` | `timetable_entries.day_of_week` | `gene.day`, 1 = Monday | |
| parity `π_r` | `timetable_entries.week_parity` | `gene.parity`: 0 `WEEKLY` / 1 `NUMERATOR` / 2 `DENOMINATOR` | |
| — | — | **block** | the UI's name for a requirement; `Block.key = workloadId::wk\|bi::index` |

In the code, everything is interned to a dense integer index: lecturers, groups and rooms each get
their own `Map<string, number>`, and class start times become positions in one array sorted by start
time. Strings never appear in the inner loops.

### 1.2 The objective function

Straight from the article's Eq. (1):

```
f(σ) = Σ_{i=1..5} β_i · Π_i(σ)^{α_i},     β = (150, 100, 50, 5, 20),   α_i = 2
```

| i | Π_i | β_i | Meaning |
|---|---|---|---|
| 1 | lecturer conflicts | 150 | **H1** — two classes of one lecturer at overlapping times |
| 2 | group conflicts | 100 | **H2** — two classes one academic group attends, overlapping |
| 3 | room conflicts | 50 | **H3** — two classes in one room, overlapping |
| 4 | lecturer windows | 5 | **S4** — idle academic hours between a lecturer's first and last class of a day |
| 5 | group windows | 20 | **S5** — the same for an academic group |

The quadratic exponent penalises large accumulated violations of one kind more heavily than
isolated ones, which pushes the search to eliminate a whole class of violations rather than shave a
few off each. `f(σ) = 0` is an optimal schedule. The weights and the exponent are exported as
`OBJECTIVE_WEIGHTS` / `OBJECTIVE_EXPONENT` and are shown, decomposed per Π_i, in the progress modal
while the search runs.

**Π₁, Π₂, Π₃ — conflicts.** An unordered pair of classes counted once *per shared entity*: two
classes sharing a lecturer and a room, at overlapping times, contribute 1 to Π₁ and 1 to Π₃. Two
classes overlap when

```
sameDay ∧ (a.start < b.end ∧ b.start < a.end) ∧ weeksOverlap(a.parity, b.parity)
weeksOverlap(p, q) ≡ p = WEEKLY ∨ q = WEEKLY ∨ p = q
```

A pair in which **both** classes are immovable is not counted — see §3.

**Π₄, Π₅ — windows.** For one entity, one day and one calendar week: sort that day's classes by
start, walk them keeping `reach = max(end so far)`, and sum `start_k − reach` wherever the next
class starts after `reach` (so overlapping classes contribute no idle time). The sum is then divided
by `academic_hour_duration_minutes` and floored, which is what turns "35 idle minutes" into 0
windows and "95 idle minutes" into 2. This is computed for the numerator week and the denominator
week separately, summed over every entity and day, and the two weeks are **averaged** so that a
purely weekly schedule is not charged twice for the same gap.

### 1.3 Three deviations from the article, and why

1. **Intervals, not slot numbers.** The article assumes one uniform grid of `S` timeslots per day,
   so a conflict is "same (day, slot)". Here a class lasts 1–4 academic hours
   (`lecturer_workloads.duration_hours`) and different workloads run on different grids of bells
   (`class_start_time_sets` — physical education starts on its own). Two classes therefore conflict
   when their **time intervals overlap**, which is why `ScheduleIndex` holds lists of genes per
   (entity, day) rather than the paper's bucket counters: a counter cannot answer "do these two
   overlap partially". The lists are short (one entity's day), so the test stays cheap, and unlike
   counters it is exact.

2. **Windows are measured in academic hours.** The paper counts unoccupied timeslots; with variable
   durations there are no uniform slots to count, hence the definition above. A ten-minute break is
   not a window.

3. **The incumbent is compared lexicographically.** `f(σ)` is computed exactly as in Eq. (1), but
   the *best-so-far* is chosen by `(Π₁+Π₂+Π₃, f)` rather than by `f` alone. Because Π₄/Π₅ are
   aggregates over the whole faculty, they grow much larger than the conflict counts, and squaring
   them would eventually make `f` prefer a schedule with a lecturer clash and fewer windows — never
   the trade a deanery wants. (Concretely: on a 300-class faculty Π₅ ≈ 230, so `20·230² ≈ 1.06 M`,
   while one group conflict is `100·1² = 100`; a single window removed is worth ~9 200, ninety-two
   times a whole group clash.) The search structure in the paper already implies the ordering —
   Phase 2 only runs on a conflict-free schedule and checks constraint safety — so making it
   explicit in the comparison only stops a perturbation from undoing it.

---

## 2. Inputs

### 2.1 Blocks (class requirements)

Exactly the blocks the tab already shows: one per class session a workload's hours require, derived
as `hours / (semester_duration_weeks × workload.durationHours)`, with a remainder of at least half a
weekly class becoming one biweekly class. Every block carries

- its lecturers (all of them — a lab split between two lecturers needs both free),
- the academic groups actually attending: the workload's own groups **plus** every combined group's
  member groups,
- the rooms it may use — the **union** of `lecturer_workload_rooms` and the rooms of
  `lecturer_workload_room_groups`, an empty union meaning *any room of the faculty*,
- the `ClassStartTimeSet` its classes run on, which is the only grid of bells it may be put on,
- its duration in academic hours, and whether it is weekly or biweekly,
- its current `timetable_entries` row, if it has one, and whether this run may move it.

### 2.2 The timetable around this faculty

A faculty never schedules in isolation, so three further slices of the *current* timetable are read
and treated as **immovable**:

| Slice | Query | Why |
|---|---|---|
| classes in the rooms this faculty may use | `timetableEntryConnection(roomIds:)` | its rooms also host other faculties' classes |
| classes of this faculty's lecturers | `timetableEntryConnection(lecturerIds:)` | its lecturers also teach other faculties' specialties |
| classes of this faculty's academic groups | `timetableEntryConnection(academicGroupIds:)` | its groups are also taught by other faculties' departments |

All three are additionally narrowed by `semesterParity`, because `timetable_entries` has no semester
column and both halves of the year are stored at once — an unfiltered read reports room clashes that
do not exist. The relation filters behind these were added to the backend for this consumer; the
service README's *Reading the current timetable* documents them, including the exact selection each
slice asks for.

They are asked for under three aliases in one request and merged client-side, because connection
filters compose with AND and what is wanted here is OR.

Entries belonging to **this** run's own workloads are dropped from that merge: they are represented
as requirements, and asking a class to avoid the slot it is being moved out of would be nonsense.
Everything else stays exactly where it is — the generator schedules around it and never rewrites a
row that belongs to another faculty.

### 2.3 Scheduling constraints

Every `lecturer_timetable_constraints`, `academic_group_timetable_constraints` and
`room_timetable_constraints` row that applies, resolved with the **"more specific wins"** rule from
`schema.sql` (a day-specific rule overrides the every-day rule of its type; `UNAVAILABLE` windows
accumulate). They are read for every lecturer, group and room of the faculty in one request, plus —
by id — for the handful a workload reaches outside it: a lecturer of another department teaching for
us, a room belonging to another faculty, a group studying on another faculty's specialty.

### 2.4 Global properties

`academic_hour_duration_minutes` (to turn a start time and a duration into an interval, and to
measure windows), `semester_duration_weeks` (how many class sessions a workload's hours require) and
`current_semester_parity` (which the tab already reads as the default for its own picker).

---

## 3. Constraints

### 3.1 Hard — filtered out, never violated

A placement that breaks any of these is never even considered:

| Rule | Source | Enforced in |
|---|---|---|
| the room must be one the workload allows | `lecturer_workload_rooms` ∪ `lecturer_workload_room_groups` | `gene.rooms`, built once |
| the start time must belong to the workload's own grid of bells | `lecturer_workloads.class_start_time_set_id` | `gene.slots`, built once |
| the class must not start before `NOT_BEFORE` | the three `*_timetable_constraints` tables | `gene.slots` (people) / `placementAllowed` (rooms) |
| the class must not end after `NOT_AFTER` | ” | ” |
| the class must not overlap an `UNAVAILABLE` window | ” | ” |
| the subject must not exceed `MAX_CLASSES_PER_DAY` | ” | `placementAllowed`, per candidate |
| an immovable class stays exactly where it is | locked entries, external entries | never in `movable` |

Two of these need care.

**The end of a class is stored nowhere.** It is `class_start_times.start_time + duration_hours ×
academic_hour_duration_minutes`. Only `NOT_BEFORE` can be answered from the start alone.

**`MAX_CLASSES_PER_DAY` counts per calendar week, not per row.** A `WEEKLY` entry falls in both
weeks and `NUMERATOR`/`DENOMINATOR` in one each, so the cap has to hold for (`WEEKLY` +
`NUMERATOR`) and for (`WEEKLY` + `DENOMINATOR`) *separately* — counting all three together would
reject a legal timetable that merely alternates two classes in one slot. This is also why the cap
cannot live in the static domain: it depends on where everything else currently sits, so it is
re-checked on every candidate placement (`dayLoadExceeds`).

A block with **no** admissible placement at all is left unplaced and reported by name, with the
reason. It is never squeezed in by breaking a rule. Two things follow, both of which matter more
than they look:

- If such a block is *already* scheduled, it is frozen where it is rather than dropped, so the rest
  of the run does not schedule into a slot the timetable still occupies.
- A block the solver could not place **never causes a delete**. Its `timetable_entries` row is left
  exactly as it is. A heuristic running out of options is not evidence that the deanery wanted the
  class removed, and the alternative would make "перевизначити весь розклад" strictly destructive
  against some inputs.

The two cases surface differently in the modal, which is worth knowing when reading a result. Every
block the solver could not place is named in the **«Не вдалося розмістити»** list, with its reason.
The **«Не переплановано»** tile counts only the subset that has an existing entry *and* took part in
the search — a block frozen before the search began (empty domain, §4.1) simply never produced an
assignment, so it lands in **«Не змінювались»** alongside the locked ones.

The fallback room domain of a workload with no room restriction is **this faculty's** rooms — not
every room the problem happens to mention. Rooms reach the solver from three directions (the
faculty's own, those named by a workload, and those of the external classes loaded as obstacles),
and only the first is a room the faculty may schedule into freely; the third in particular belongs
to another faculty and does not even have its own constraints loaded.

### 3.2 Optimised — the objective

H1/H2/H3 conflicts and S4/S5 windows are what `f(σ)` minimises. They are *not* filtered out, because
a heavily loaded faculty may have no conflict-free schedule at all and a schedule with two clashes
you can see is more useful than a refusal. What remains is listed in the result, by day and by the
two classes involved — up to a cap of 200 entries, since a genuinely over-subscribed instance can
produce thousands and the point of the list is to be read.

A clash between two classes that are **both** immovable is not counted: no run could resolve it, and
counting it would put a floor under `f` that the search would chase forever. (The seeded ФПМІ data
contains a few of these — they are printed that way on the faculty's own sheets.)

---

## 4. Data structures

Everything below lives inside one call to `solveTimetable`, as closures over the problem. Nothing is
global, so two runs cannot interfere.

### 4.1 Genes

```ts
interface Gene {
  reqIndex: number        // -1 for an external entry
  key: string             // the block key, or "external:<entryId>"
  label: string           // for the conflict report
  movable: boolean
  lecturers: number[]     // interned indices
  groups: number[]
  durationMinutes: number
  slots: Int32Array       // admissible (day, time, parity), packed — empty when immovable
  rooms: Int32Array       // admissible room indices
  day, timeIdx, room, parity: number     // current placement; day = -1 means unplaced
  start, end: number                     // minutes since midnight, derived from timeIdx
}
```

The array is laid out in one deliberate order:

```
[ 0 .. movableCount )        one gene per SolverRequirement that got one — movable and locked alike
[ movableCount .. V )        one gene per external SolverFixedEntry
```

"that got one" is the exception worth knowing: a requirement whose slot or room domain came out
empty **and** which is not currently scheduled gets no gene at all. There is nothing to place and
nothing to schedule around, so it is only reported (§3.1). One with an empty domain that *is*
scheduled does get a gene — an immovable one, pinned to its existing placement.

`movable: number[]` holds the indices this run may move. Assignments are only ever emitted for
those, which is what guarantees a locked requirement produces no write.

`slots` is packed as `day · 100000 + parity · 10000 + timeIdx` into an `Int32Array` — a typed array
because it is scanned in the innermost loop of the search and this keeps it contiguous and free of
per-element boxing.

### 4.2 ScheduleIndex

One bucket per (entity, day), holding the indices of the genes placed there:

```
lecBuckets[ℓ · 8 + d]   grpBuckets[g · 8 + d]   roomBuckets[a · 8 + d]
```

The stride is 8 rather than 7 so that `d` (1…7) can be used directly with no arithmetic; index 0 is
never written. Three operations maintain them, and only three:

- `indexInsert(i)` / `indexRemove(i)` — push/splice the gene into every bucket it belongs to
  (`|lecturers| + |groups| + 1` of them);
- `place(i, day, timeIdx, parity, room)` — remove, mutate the gene, insert. This is the **only**
  way a placement ever changes, which is why the index can never drift out of step with the genes.

Lists rather than the article's counters, because a conflict here is an interval overlap rather than
an equality of slot numbers (§1.3). The lists are short — one lecturer's classes on one day, rarely
more than six — so the linear scan inside them is cheaper than the bookkeeping a smarter structure
would need.

The overlap of a candidate placement is the article's Eq. (2), interval-aware:

```
ov(i) = Σ_{ℓ ∈ lecturers(i)} |{ j ∈ lec[ℓ][d] : j ≠ i ∧ weeksOverlap ∧ timesOverlap }|
      + Σ_{g ∈ groups(i)}    |{ j ∈ grp[g][d] : … }|
      +                      |{ j ∈ room[a][d] : … }|
```

`overlapAt(i, day, start, end, parity, room)` evaluates it for a *hypothetical* placement without
touching the index; `overlapOf(i)` is the same for where the gene currently sits.

### 4.3 Domains

Two per gene, both computed once while the genes are built:

- **`slots`** — every `(day, time, parity)` triple such that `day` is a working day, `time` belongs
  to the workload's own `ClassStartTimeSet`, and every one of the gene's lecturers and groups
  tolerates the resulting `[start, end)` interval on that day. A biweekly gene contributes two
  triples per (day, time), one per parity; a weekly gene one, with parity `WEEKLY`.
- **`rooms`** — the workload's allowed rooms, or the faculty's rooms if it names none.

They are kept separate rather than crossed into one list of `(day, time, parity, room)` because the
product is large (6 days × 6 bells × 50 rooms ≈ 1 800 per gene, and 1 400 genes would be 2.5 M
entries) and because room admissibility depends on the room's own rules, which are cheap to test
lazily. The scan therefore iterates ≤ ~72 slots and, inside each, walks rooms only until a
conflict-free one is found.

If either domain is empty the gene is never placed by search: it is reported, and — if it already
had an entry — frozen there (§3.1).

### 4.4 Resolved rules

`resolveRules(constraints)` turns one subject's constraint rows into one `DayRules` per day, applying
"more specific wins" once, up front:

```ts
interface DayRules {
  notBefore: number   // minutes, -1 when unset
  notAfter: number    // minutes, MAX_SAFE_INTEGER when unset
  windows: number[]   // flattened [from, to) pairs — UNAVAILABLE accumulates
  maxPerDay: number   // -1 when unset
}
```

so the hot path is `timeAllowed(rules, start, end)`: two comparisons plus one pass over a windows
array that is empty for almost every subject. Resolving once is what makes it affordable to check
the rules on every candidate placement rather than only on the final schedule.

### 4.5 Snapshots, tabu, RNG

- **`Snapshot`** — four typed arrays (`Int16Array day`, `Int32Array timeIdx`, `Int32Array room`,
  `Int8Array parity`) of length `movableCount`. Taking one is a flat copy of four numbers per
  requirement gene; restoring one is a `place` call per *movable* gene (a locked one is skipped —
  it never moved). The incumbent is kept as a snapshot rather than as a second index, so "best so
  far" costs no bookkeeping during the search.
- **`tabu: Map<string, number>`** — keyed `i:day:parity:timeIdx:room`, valued with the pass number
  the entry expires at. A string key rather than a packed integer because there is no bound on the
  number of class start times (every set's times share one array), and any fixed stride would alias
  one gene's placement onto another's — both forbidding legal moves and letting tabu ones through.
- **`rnd`** — a seeded mulberry32. The same inputs and the same seed give the same schedule; the
  wall-clock budget is the only source of run-to-run variation.

---

## 5. The algorithm

### 5.1 Top level

```
solveTimetable(problem, opts, onProgress, shouldStop):
    build genes, domains, index                       # §4
    emit(PREPARE)
    construct()                                       # §5.3
    best ← snapshot();  bestV ← measure();  bestF ← f(bestV)
    emit(CONSTRUCT)

    stagnation ← 0;  intensity ← 0.35;  T ← 2.5
    while iteration < maxIterations
          and now < deadline
          and not shouldStop():
        iteration ← iteration + 1

        repairPhase(repairIterations)                 # §5.4 — Phase 1
        v ← measure()
        if hard(v) = 0:
            windowPhase(W_max)                        # §5.5 — Phase 2
            v ← measure()

        if (hard(v), f(v)) < (hard(bestV), bestF):     # lexicographic, §1.3
            best ← snapshot();  bestV ← v;  bestF ← f(v)
            stagnation ← 0
            intensity ← min(1.00, intensity + 3δ)     # §5.6
        else:
            stagnation ← stagnation + 1
            intensity ← max(0.15, intensity − 0.5δ)

        if hard(bestV) = 0 and Π₄ = Π₅ = 0: break     # f(σ) = 0, nothing left to find

        if stagnation ≥ 30:                           # §5.7
            restore(best);  emit(PERTURB)
            perturb(0.15 … 0.30);  T ← 2.5;  stagnation ← 0

        emit(REPAIR | WINDOWS)                        # throttled to ~8/s
    restore(best)
    emit(DONE)
    return assignments, violations, unplaced, conflicts, history
```

Two things about this loop are worth stating plainly. It keeps **one** solution, not a population —
the "memetic" part of the article that survives here is its local search, its adaptive intensity and
its restart, not its crossover (§13 explains what it would take to add). And the incumbent is only
ever *replaced*, never degraded: a perturbation always starts from the restored best, so the run
cannot end worse than any point it passed through.

### 5.2 The candidate scan — `scanBest`

Every neighbourhood except N3 goes through one function, so it is worth reading first.

```
scanBest(i, wantWindows):
    best ← null
    offset ← random             # so ties are not always broken toward Monday
    for each slot (day, time, parity) of gene i, starting at offset:
        start, end ← time, time + duration(i)

        peopleOverlap ← Σ clashes with i's lecturers and groups at (day, start, end, parity)
        if best ≠ null and peopleOverlap > best.overlap: continue        # (P1)

        roomOffset ← random
        for each room a of gene i, starting at roomOffset:
            if not placementAllowed(i, day, start, end, parity, a): continue
            overlap ← peopleOverlap + clashes in room a
            if best ≠ null and overlap > best.overlap: continue          # (P2)
            windows ← (wantWindows and overlap = 0) ? windowCostAt(i, day) : 0
            if overlap < best.overlap or (overlap = best.overlap and windows < best.windows):
                best ← (day, time, parity, a, overlap, windows)
            if overlap = 0 and not wantWindows: return best              # (E1)
            if overlap = 0 and windows = 0: return best                  # (E2)
    return best
```

- **(P1)** is the article's "timeslots where the lecturer already has conflicts are skipped as a
  fast filter", generalised: if the people alone already clash more than the best full placement
  found so far, no room can rescue this slot. It prunes the majority of the room loop on a loaded
  instance.
- **(P2)** is the same test one level down.
- **(E1)/(E2)** are its "early termination when ov(i) = 0 is found". During repair (`wantWindows =
  false`) the first conflict-free placement wins outright; during construction and window reduction
  the scan keeps looking for a conflict-free placement that also sits in no window, and stops the
  moment it finds one.
- The two random offsets matter more than they look. Without them every gene would prefer Monday's
  first bell and the lowest-numbered room, and the greedy construction would pile the whole faculty
  into the top-left corner of the week before the local search ever ran.
- `scanBest` returns `null` only when *every* admissible slot × room pair is rejected by
  `placementAllowed` — that is, by a per-day cap or a room rule, since everything else was already
  filtered into the domain.

`windowCostAt(i, day)` is the window contribution of the gene's own day:

```
windowCostAt(i, d) = Σ_{ℓ ∈ lecturers(i)} (windowsIn(lec[ℓ][d], NUM) + windowsIn(lec[ℓ][d], DEN))
                 + 4 Σ_{g ∈ groups(i)}    (windowsIn(grp[g][d], NUM) + windowsIn(grp[g][d], DEN))
```

The factor 4 is β₅/β₄ = 20/5 — a group's window is worth four lecturer windows in the objective, so
the local decision uses the same exchange rate as the global one.

### 5.3 Construction — most-constrained-first greedy

```
construct():
    for i in movable: unplace(i)
    order ← movable sorted by  (|slots(i)| · |rooms(i)|) ascending,
                          then (|lecturers(i)| + |groups(i)|) descending
    for i in order:
        best ← scanBest(i, wantWindows = true)
        if best ≠ null:
            place(i, best)
        else:
            report i as unplaced
            if i has a current placement that placementAllowed still accepts: put it back there
```

(That fallback re-checks only the *dynamic* rules — room time rules and per-day caps — not the
gene's own slot domain, which the existing row satisfied when it was written. It cannot smuggle a
bad placement into the database either way: restoring the current placement makes the block
"unchanged", and `buildPlan` writes nothing for it.)

A requirement with one viable placement has to claim it before a requirement with a hundred takes it
for a marginal gain. This is the saturation-degree idea behind DSATUR, which is where the timetabling
literature's greedy heuristics come from, applied to the size of a domain rather than to a colour
count. The tie-break sends the gene with the most people first, because it is the one whose
placement constrains the most other genes.

Unlike the article — whose initial population is uniformly random, with no repair — this run starts
from a constructed schedule. With one individual instead of a population of twenty, a random start
would spend the whole budget doing what the greedy pass does in one sweep. On the 120-class instance
of §8, construction alone already reaches Π₁ = Π₂ = Π₃ = 0 — every hard conflict gone before the
local search has run once — so everything that follows is window reduction. It is not close to
finished, though: `f` after construction is 352 225 (Π₄ = 109, Π₅ = 121) against 6 705 (Π₄ = 21,
Π₅ = 15) at the end of a three-second budget. Feasibility is what greedy gives you cheaply; quality
is what the rest of the run is for.

Note that the ordering is static — computed once from the domain sizes — rather than the dynamic
saturation degree DSATUR recomputes after every colouring. Dynamic re-ranking was measurably not
worth its cost here, because the local search that follows repairs exactly the mistakes a static
order makes.

### 5.4 Phase 1 — overlap repair

One `repairPhase(rounds)` call per outer iteration. Each round applies four neighbourhoods in
sequence: N0 and N1 always run, N2 runs only if neither improved anything, and N3 only if none of
the three did. The "stop at the first that improves" rule therefore applies to the two fallback
neighbourhoods, not to the pass as a whole.

```
repairPhase(rounds):
    for round in 1..rounds:
        clock ← clock + 1;  improved ← false

        # ── N0: retry the unplaced ────────────────────────────────
        if pendingUnplaced > 0:
            for i in movable with day(i) = -1:
                spot ← scanBest(i, false)
                if spot ≠ null: place(i, spot); pendingUnplaced−−; improved ← true

        conflicted ← [ (i, ov(i)) for i in movable if ov(i) > 0 ]
        if conflicted is empty: return                     # feasible — hand over to Phase 2
        sort conflicted by ov descending
        slice ← first ⌈|movable| · clamp(intensity, 0.02, 1)⌉ of conflicted

        # ── N1: reassignment ──────────────────────────────────────
        for i in slice:
            before ← ov(i)
            if before = 0: continue                        # fixed by an earlier move this round
            cand ← scanBest(i, false)
            if cand = null: continue
            Δ ← cand.overlap − before
            if tabu(i → cand) and Δ ≥ 0: continue
            if Δ < 0 or rnd() < exp(−Δ / T):
                tabu[i → current placement] ← clock + tenure
                place(i, cand)
                if Δ < 0: improved ← true

        # ── N2: swap ──────────────────────────────────────────────
        if not improved and |slice| ≥ 2:
            improved ← swapPlacements(slice[0], slice[1])

        # ── N3: chain move ────────────────────────────────────────
        if not improved and |slice| ≥ 1:
            i ← slice[0]
            up to 12 times: pick a random admissible (day, time, parity, room) for i
                            if ov would be 0 there: place(i, …); improved ← true; break

        T ← max(0.01, T · 0.92)
        if not improved and round > 4: return
```

**N0 — retry the unplaced.** Every block construction could not fit is offered the whole scan again.
Its admissible placements were all closed by per-day caps or room rules *at the time*; by now the
classes that closed them have moved, so a block left out at the start is regularly placeable a few
passes later. Without it nothing but a random perturbation would ever rescue one: an unplaced block
has `ov = 0` by definition, so the conflict-driven neighbourhoods below cannot see it. The scan is
skipped entirely while nothing is outstanding, which is the normal case and keeps it free.

**N1 — reassignment.** The workhorse. Each of the most conflicted genes gets one `scanBest`, and
moves to the best placement it found. Note what is *not* here: N1 does not enumerate improving
moves and pick the best across genes, it takes the best move per gene in conflict order. That is
what keeps a pass linear in the slice size.

**N2 — swap.** Exchanging two genes' placements reaches configurations no single move can: when A
sits where B belongs and vice versa, every one-gene move is worse than the pair. It is tried only
when N1 found nothing, and only between the two most conflicted genes, because a full swap
neighbourhood is quadratic. `swapPlacements` is careful in a way worth spelling out: it requires
each gene's placement to be in the *other's* domain (both the packed slot and the room), applies the
exchange, re-checks `placementAllowed` for both — per-day caps can be broken by a swap even though
neither placement was new — and reverts unless the exchange is admissible and either improves or
passes the SA test.

**N3 — chain move.** Twelve random draws from the gene's domain, accepting only a placement with
zero overlap. Pure diversification: it fires only when N1 and N2 both failed, which is the situation
where the deterministic neighbourhoods have run out of ideas.

**Simulated annealing.** A non-improving N1 or N2 move is accepted with probability `exp(−Δ/T)`,
where `Δ` is the increase in overlap and `T` cools by 0.92 per round from 2.5, with a floor of 0.01.
At `T = 2.5` a move that adds one conflict is accepted about 67% of the time; by round 20 (`T ≈
0.47`) about 12%; by round 40 (`T ≈ 0.09`) essentially never. Note that `T` is *not* reset between
outer iterations — it keeps cooling across them, and only a restart (§5.7) puts it back to 2.5. So
the anneal spans the whole run, not one `repairPhase` call.

**Tabu.** After a move, the gene's *previous* `(day, time, parity, room)` is forbidden for
`tabuTenure = 6` rounds. The check is on the *destination* of a proposed move, with the standard
aspiration criterion: a tabu destination is taken anyway when the move strictly improves (`Δ < 0`),
since a ban is a heuristic and a genuine improvement is not. This stops the immediate reversal, and
the two- and three-cycles that follow from it, which are the failure mode a first-improvement local
search on a dense instance falls into within a dozen rounds.

**Early exit.** `if not improved and round > 4: return` — after five rounds with nothing to show,
the remaining rounds of this call are not going to find anything either, and the outer loop's
stagnation counter is a better place to decide what to do about it.

### 5.5 Phase 2 — window reduction

Runs only on a conflict-free schedule.

```
windowPhase(maxMoves):
    for move in 1..maxMoves:
        worst ← argmax over a sample of ≤250 placed movable genes of windowCostAt(i, day(i))
        if none has a positive cost: return
        beforeScore ← 5·Π₄² + 20·Π₅²
        cand ← scanBest(worst, wantWindows = true)
        if cand = null, or cand has the same (day, time, room), or cand.overlap > 0: return
        place(worst, cand)
        if 5·Π₄² + 20·Π₅² ≥ beforeScore: undo the move; return
```

(The "same placement" test compares day, time and room but not parity, so a candidate that only
flips a biweekly class between numerator and denominator is treated as a real move and evaluated on
its merits — which is right, since the parity is exactly what a window-reducing move on a biweekly
class often wants to change.)

Three details carry the weight.

**Constraint safety.** `scanBest` only ever returns admissible placements, and the move is rejected
outright unless `overlap = 0`. Window reduction therefore cannot create a new clash — which matters
most at high room utilisation, where free rooms are scarce and a naive "move it earlier" would trade
a window for a room conflict.

**Bounded depth.** At most `W_max = 5` moves per invocation. Unbounded window reduction would let a
single call solve the whole soft-constraint subproblem and leave the outer loop nothing to
contribute, which the article identifies as a real failure mode of unbounded local search. With the
bound, the outer loop alternates repair and reduction thousands of times, and the perturbation gets
to reshuffle between them.

**Sampling.** Finding the worst gene means evaluating `windowCostAt` for each candidate, and that
sorts a short list per entity per week. On a 1 400-gene faculty a full sweep per move would dominate
the phase, so a stride is taken through `movable` to sample at most 250 of them, from a random
offset. The worst offenders are numerous — any of them is worth moving — so the sample loses very
little and the phase stays proportional to the move budget rather than to the faculty.

The acceptance test is on the **global** weighted window score, not on the moved gene's own cost.
Moving a class out of one lecturer's window and into a group's is not an improvement, and only the
global measure can tell.

### 5.6 Adaptive local-search intensity

`intensity` is the fraction of movable genes Phase 1 examines per round. It is adapted on **global**
improvement, exactly as in the article's Eq. (5):

```
intensity ← min(1.00, intensity + 3δ)    if the best schedule improved this iteration
intensity ← max(0.15, intensity − 0.5δ)  otherwise                         (δ = 0.02)
```

The asymmetry — fast increase, slow decay — makes effort climb quickly while local search is
contributing to global progress and fall gradually during stagnation, instead of oscillating. Rising
from the floor to the ceiling takes 15 improving iterations; falling back takes 85 stagnant ones.

The key point the article makes, and which is preserved here: the signal is *global* improvement, not
whether an individual move helped. Almost any move helps a bad schedule; that says nothing about
whether the search is getting anywhere. The observable consequence is that intensity drifts down
through the long window-reduction tail, where global improvements are rare, and is pulled back up
whenever a perturbation opens a run of them — the modal shows the current value live, which is the
easiest way to see which regime a run is in.

### 5.7 Perturbation and restart

After 30 outer iterations with no global improvement:

```
restore(best)                       # never perturb a degraded solution
perturb(0.15 + 0.15 · rnd()):
    n ← ⌊|movable| · strength⌋
    repeat n times:
        i ← a random movable gene
        up to 6 times: draw a random (day, time, parity) from slots(i) and a random room
                       if placementAllowed: place(i, …); break
T ← 2.5;  stagnation ← 0
```

15–30% of the genes are re-placed at random within their domains, and the temperature is reset so
the next `repairPhase` can climb out again. Diversity without throwing away what was found — the
single-solution analogue of the article's "replace the bottom 50% of the population with random
schedules".

Note that `perturb` picks genes *with replacement*, so the actual fraction disturbed is slightly
below the nominal strength; and it only ever produces admissible placements, so a perturbation can
never break a hard rule, only create conflicts for Phase 1 to repair.

### 5.8 Termination

Whichever comes first:

- the wall-clock budget (`timeLimitMs`, chosen in the panel: 10 s / 30 s / 1 min / 2 min);
- `f(σ) = 0` — no conflicts and no windows at all, so there is nothing left to find;
- `maxIterations`, which defaults to 1 000 000 and exists only as a backstop against a pathological
  zero-cost loop;
- `shouldStop()`, which the worker cannot actually deliver mid-run — see §9.

The clock is checked once per outer iteration, so the real stop is up to one `repairPhase` late.
With 40 rounds over an `intensity`-sized slice that is milliseconds on a normal faculty, and about a
third of a second on the pathological 900-class instance in §8.

---

## 6. Parameters

All of them live in `DEFAULT_OPTIONS`; the UI overrides exactly one.

| Option | Default | Article | What it controls |
|---|---|---|---|
| `timeLimitMs` | 30 000 | — | wall-clock budget. **The only value the UI sets** (10 s / 30 s / 1 min / 2 min) |
| `maxIterations` | 1 000 000 | `T_max` | outer iterations; a backstop, not a real bound |
| `repairIterations` | 40 | 30–50 | Phase 1 rounds per outer iteration |
| `windowMoves` | 5 | `W_max` = 3–5 | Phase 2 moves per invocation |
| `tabuTenure` | 6 | 5–7 | rounds a vacated placement stays forbidden |
| `initialTemperature` | 2.5 | — | SA start; ≈67% acceptance of a +1 conflict move |
| `coolingFactor` | 0.92 | 0.92 | per Phase 1 round |
| `stagnationLimit` | 30 | 30 | outer iterations without global improvement before a restart |
| `intensity` | 0.35 | `p_init` | starting fraction of genes Phase 1 examines |
| `minIntensity` | 0.15 | `p_min` = 0.15 | floor |
| `maxIntensity` | 1.00 | `p_max` = 1.0 | ceiling |
| `adaptationStep` | 0.02 | `δ` = 0.02 | adaptation step (up 3δ, down 0.5δ) |
| `seed` | 20260802 | — | PRNG seed; same seed + same **iteration count** ⇒ same schedule (see §10) |

Two more constants are not options because nothing has wanted to tune them: `WINDOW_SCAN_SAMPLE =
250` (§5.5) and the 12 draws N3 makes (§5.4).

The article's population parameters — `S = 20`, tournament `k = 3`, `CR_min`/`CR_max`, `MR = 0.25` —
have no counterpart here, because there is no population. §13 says what adding one would involve.

---

## 7. A worked example

A deliberately tiny instance, to show the mechanics rather than the scale. Two days, three bells
(09:00 / 10:40 / 12:20), one academic hour = 40 min, classes of 2 academic hours (80 min), two rooms
`R1` `R2`, one lecturer `L`, two groups `G1` `G2`, and one external class.

| Gene | Lecturer | Groups | Rooms allowed | Weekly? |
|---|---|---|---|---|
| A | L | G1 | R1, R2 | yes |
| B | L | G1, G2 | R1 only | yes |
| C | L | G2 | R1, R2 | yes |
| X *(external, immovable)* | L | — | R2 | Mon 10:40 |

`L` also has `NOT_AFTER 13:00` every day, so the 12:20 bell (ending 13:40) is out for every gene.

**Domains.** Two days × two usable bells = 4 slots each; rooms as listed. `|slots| · |rooms|`:
A → 8, B → **4**, C → 8. Construction order: B first, then A and C, which tie on both keys and keep
their input order.

**Construction** (one possible trace — the scan starts at a random offset, so the particular slots
vary while the outcome does not):

1. **B** (`|domain| = 4`) — every slot but Mon 10:40 is free of everything; say the offset lands it
   on Mon 09:00, R1 (its only room). `overlap = 0` and `windowCostAt = 0` — not because the index is
   empty (X is in `lec[L][Mon]` already) but because a bucket holding a single class can never
   contain a window. Early exit (E2). Placed.
2. **A** — Mon 09:00 is out: `L` is busy with B, and so is `G1`. Mon 10:40 clashes with X on `L`
   (immovable, but very much present in `lec[L][Mon]`). Tue 09:00 is free, with `overlap = 0` and no
   window, so E2 fires there. Placed, in whichever room the room offset reached first.
3. **C** — Mon 09:00 held by B on `L`; Mon 10:40 by X on `L`; Tue 09:00 by A on `L`. Tue 10:40 is
   free of `L` and of `G2`, and **either** room will do: rooms are only contested for *overlapping*
   intervals, and A ends at 10:20 while C starts at 10:40. `windowCostAt(C, Tue) = 0` too — that
   20-minute gap floors to zero academic hours. Placed.

Result after construction: Π₁ = Π₂ = Π₃ = 0 and Π₄ = Π₅ = 0, so `f = 0` and the outer loop's first
check breaks before a single local-search round runs.

**Now change one thing** that looks harmless: give `G2` a `NOT_BEFORE 10:00`. The 09:00 bell leaves
the domain of every gene `G2` attends — which is **B and C**, not just C, because `slots` requires
*every* lecturer and *every* group of a gene to tolerate the interval. Domains become B → 2 × 1 = 2,
C → 2 × 2 = 4, A → 4 × 2 = 8, so the order is B, C, A.

B and C are now both confined to the 10:40 bell, on Monday or Tuesday. X already holds Monday 10:40
on `L`, and B and C share `L`, so the two of them have exactly one clash-free 10:40 slot between
them. **One lecturer conflict is unavoidable**, and no amount of searching removes it: the run ends
with Π₁ = 1, `f = 150`, and the modal names the clash — the day, and the two classes involved —
under «Залишились накладки». (Confirmed across seeds: B always ends up on a 10:40 bell, and Π₁ is
always exactly 1.)

That is the shape of every over-subscribed result. Not a refusal, and not a rule quietly broken to
make the numbers work: a schedule with the residue named, so that whoever entered `NOT_BEFORE 10:00`
can see what it cost.

---

## 8. Complexity and measured behaviour

Let `V` be the number of blocks, `S` the admissible slots per block (≤ days × bells of its set ×
parities — so ~36 for a weekly block and ~72 for a biweekly one on a 6 × 6 grid), `A` its admissible
rooms, `E = |lecturers| + |groups| + 1` the entities a block touches (~5), and `k` the average
number of classes an entity has in one day (~5).

| Step | Cost |
|---|---|
| interning + domain construction | `O(V · S · E)` |
| `ov(i)` for one candidate placement | `O(E · k)` |
| one `scanBest` | `O(S · A · E · k)` worst case; far less with (P1)/(P2) and (E1)/(E2) |
| construction | `V` scans, plus `O(V log V)` for the order |
| one Phase 1 round | `O(V · intensity · S · A · E · k)` |
| `windowTotal` (Π₄, Π₅) | `O(entities · days · k log k)` — a sort per bucket per week |
| `conflictTotal` (Π₁, Π₂, Π₃) | `O(entities · days · k²)` — all pairs inside each bucket |
| `measure()` (all five Π) | the two above, summed |
| one Phase 2 move | picking the gene: `O(min(V, 250) · E · k log k)`; then one `scanBest` and **two** `totalWindowScore()` sweeps, each of `windowTotal`'s order |
| `snapshot` | `O(V)` — a flat copy |
| `restore` | `O(V · E · k)` — a `place` per movable gene, and each one re-indexes |

Two consequences worth knowing. `measure()` is called once per outer iteration while conflicts
remain and twice once they are gone, and it is proportional to the whole faculty regardless of how
little changed — which is why the outer iteration count collapses on very large instances. And
Phase 2's cost is dominated not by the ≤250-gene sampling but by the two full window sweeps its
accept/reject test needs. Making Π incremental — deltas inside `place`, plus per-(entity, day)
window caches invalidated on the days a move touches — is the single highest-value optimisation left
(§13).

**Measured**, on a synthetic generator with 20 lecturers, 15 groups, 12 rooms, 6 days and a 6-bell
main grid plus a 2-bell PE grid, under Node 22 on one core:

| Instance | Budget | Outcome | Outer iterations |
|---|---|---|---|
| 120 classes | 3 s | conflict-free; Π₄ = 21, Π₅ = 15 | 8 146 |
| 300 classes + constraint tables | 5 s | conflict-free; Π₄ = 240, Π₅ = 227 | 3 440 |
| 300 classes + 12 external | 5 s | Π₁ = 1 (provably unavoidable), Π₂ = Π₃ = 0; Π₄ = 329, Π₅ = 240 | 6 579 |
| 900 classes on 12 rooms (over-subscribed) | 8 s | 874 placed, 26 unplaceable under a 2-per-day cap; Π₁ = 187, Π₂ = 338, Π₃ = 458 | 23 |

Read these as indicative, not as fixtures. The search is deterministic *given the number of
iterations it gets through*, and a wall-clock budget buys a different number on a different machine
— 10–20% either way between hosts here. On the first three rows that makes no visible difference,
because the run has converged long before the budget ends; on the fourth, which is still improving
when the clock runs out, the conflict counts move by a few percent between runs. Only the structural
figures — 874 placed, 26 unplaceable, and *which* 26 — are stable there, because they follow from
the constraints rather than from the search.

The third row is worth reading: the single remaining lecturer conflict is not a search failure. That
lecturer has a PE class whose grid offers only 09:00 and 10:40, both of which overlap an external
class present at 10:10 on every one of the six days — there is no admissible placement without a
clash, and the solver reports it rather than pretending otherwise.

Feasibility is reached in the first few hundred milliseconds on all the tractable instances;
everything after that is window reduction, which is why the objective curve in `result.history` is a
steep drop followed by a long shallow tail.

---

## 9. Applying the plan

Nothing is written while the search runs. When it finishes, the modal shows what would change —
**додати / перенести / без змін / не змінювались / не переплановано** — plus the remaining
conflicts, the blocks that could not be placed, and a full table of the individual changes. Only
«Застосувати» writes.

The writes are `updateTimetableEntry` then `createTimetableEntry` — moves before additions, so a
class created into a slot never briefly shares it with the class being moved out of it — batched 25
per GraphQL document under aliases, so a full faculty is ~20 requests rather than ~500. **No entry
is ever deleted** by generation. A failing operation aborts the run and reports which kind of write
failed; the tab reloads either way, so what did land is visible immediately. There is no
transaction across batches: an abort halfway leaves the earlier batches committed, which is why the
result is reloaded rather than assumed.

### Two modes

- **лише невизначені заняття** — only blocks with no `timetable_entries` row are placed. Everything
  already scheduled is locked: it is loaded into the index so the new classes fit around it, but it
  is not in `movable`, so the search may not move it however much the objective would gain. "Only
  fill what's missing" is the whole promise of that mode.
- **перевизначити весь розклад** — every block of the faculty is free to move. External classes are
  still immovable.

### Stopping early

«Зупинити й показати результат» **terminates the worker**. It has to: the solver is one synchronous
loop, so the worker cannot dequeue a `cancel` message until it has already finished, and posting one
would do nothing for up to two minutes. Terminating discards whatever the worker held, which is why
roughly one progress message a second carries the best schedule so far — that snapshot is what the
button plans against. The cost is one array of placements per second, which is nothing next to the
search itself. (`shouldStop` is still honoured by the inline, no-worker path used in tests.)

### What the modal reports while it runs

Each `SolverProgress` carries the phase, the elapsed time, `f(σ)` and all five Π_i separately, how
many blocks are placed out of how many this run may move, how many are currently unplaced, plus the
temperature, the adaptive intensity and the stagnation counter. The Π decomposition is shown as a
table with each term's β and its contribution, so it is visible at a glance whether the run is still
fighting conflicts or has moved on to windows.

---

## 10. What is and isn't guaranteed

**Guaranteed.**

- No hard rule is ever broken: a written entry is always in an allowed room, on the workload's own
  bells, outside every `UNAVAILABLE` window, within `NOT_BEFORE`/`NOT_AFTER`, and within
  `MAX_CLASSES_PER_DAY` counted per calendar week.
- No class belonging to another faculty is created, moved or deleted.
- No `timetable_entries` row is ever **deleted** by generation, in either mode.
- In "лише невизначені" mode, no existing entry of this faculty is touched at all.
- The result is never worse than the best point the search passed through: the incumbent is only
  replaced by a lexicographically better one, and every perturbation starts from a restore.
- The run terminates: the outer loop is bounded by the wall-clock budget, and every phase by an
  iteration cap.
- **Reproducibility, up to the clock.** The search itself is fully deterministic: same inputs, same
  seed, same number of iterations ⇒ byte-identical assignments. What is *not* reproducible is how
  many iterations a wall-clock budget buys, so two runs of the same problem at the same
  `timeLimitMs` can end at different points of the same trajectory and return different — usually
  equally good — schedules. Pin `maxIterations` instead of `timeLimitMs` when a test needs an exact
  answer; that is what the solver's own tests do.

**Not guaranteed.**

- **Optimality.** UCTP is NP-hard; this is a heuristic. `f(σ) = 0` is reached on lightly loaded
  faculties, not on saturated ones.
- **Feasibility.** If the constraints admit no conflict-free schedule — or the budget was too short
  to find one — the result carries conflicts, listed by day and by the two classes involved (the
  first 200 of them). It is offered rather than refused, because a schedule with two visible clashes
  is more useful than none.
- **Stability across runs with different budgets.** A longer budget may produce a wholly different
  arrangement of equal quality. There is no term rewarding similarity to the previous timetable.
- **Atomicity of the write.** See §9.
- **Anything the model does not know.** Room capacity versus group size, travel time between
  buildings, a lecturer's preference for mornings that they never entered as a constraint.

---

## 11. Code map

`timetable-solver.ts`, top to bottom:

| Symbol | Role |
|---|---|
| `SolverProblem`, `SolverRequirement`, `SolverFixedEntry`, `SolverConstraint`, `SolverClassTime` | the input shapes (§2) |
| `SolverOptions`, `DEFAULT_OPTIONS` | the parameters (§6) |
| `OBJECTIVE_WEIGHTS`, `OBJECTIVE_EXPONENT` | β and α of Eq. (1) |
| `SolverProgress`, `SolverResult`, `SolverAssignment`, `SolverUnplaced`, `SolverConflict`, `Violations` | the output shapes |
| `parseMinutes`, `makeRandom`, `weeksOverlap`, `timesOverlap`, `parityCode` | small helpers |
| `resolveRules`, `timeAllowed`, `DayRules` | constraint resolution (§4.4) |
| **`solveTimetable`** | everything below is a closure inside it |
| `lecturerIdx` / `groupIdx` / `roomIdx`, `times`, `timesBySet` | interning (§1.1) |
| `Gene`, `genes`, `movable`, `movableCount`, `packSlot`/`unpack*` | genes and domains (§4.1, §4.3) |
| `lecBuckets` / `grpBuckets` / `roomBuckets`, `indexInsert`, `indexRemove`, `place` | ScheduleIndex (§4.2) |
| `clashesIn`, `overlapAt`, `overlapOf` | Eq. (2) |
| `dayLoadExceeds`, `placementAllowed` | the dynamic hard rules (§3.1) |
| `windowsIn`, `windowTotal`, `conflictTotal`, `measure`, `objectiveOf` | the objective (§1.2) |
| `scanBest`, `windowCostAt` | the candidate scan (§5.2) |
| `construct`, `constructionFailures`, `pendingUnplaced` | construction (§5.3) |
| `repairPhase`, `swapPlacements`, `tabu`, `tabuKey`, `temperature` | Phase 1 (§5.4) |
| `windowPhase`, `totalWindowScore`, `WINDOW_SCAN_SAMPLE` | Phase 2 (§5.5) |
| `perturb` | restart (§5.7) |
| `Snapshot`, `snapshot`, `restore`, `assignmentsFrom` | incumbent bookkeeping (§4.5) |
| `emit`, the `while` loop, `collectConflicts` | the top level (§5.1) and the report |

`timetable-solver.worker.ts` is the message boundary: `SerializedProblem` (the three constraint
`Map`s flattened to entry arrays), `SolverRequest` (`solve` / `cancel`) and `SolverResponse`
(`progress` / `done` / `error`).

`faculty-timetable-list.ts` holds everything that talks to the outside: `buildProblem` (up to three
GraphQL requests — the faculty-scoped constraints, the by-id extras when a workload reaches outside
the faculty, and the three aliased timetable slices — plus the mapping into `SolverProblem`),
`runSolver`, `buildPlan` (assignments → writes), `applyUpdates`/`applyCreates` (§9), and the modal's
state machine (`loading → solving → preview → applying → done`, with `error` reachable from any of
them). The blocks, bells and global properties it also feeds in are already in memory: the tab loads
them to render itself.

---

## 12. Testing

`timetable-solver.ts` is deliberately free of Angular, GraphQL and I/O, so it can be driven from
plain objects:

```ts
const result = solveTimetable(problem, { timeLimitMs: 2000, seed: 1 });
expect(result.violations.lecturerConflicts).toBe(0);
```

The most valuable test is not a unit test but an **independent re-checker**: build a random instance,
solve it, then verify the returned assignments against a second implementation of the rules that
shares no code with the solver — every placement's room is in the requirement's allow-list (or in
the faculty's rooms when it has none), its start time belongs to the workload's set, its parity
matches its periodicity, no `NOT_BEFORE`/`NOT_AFTER`/`UNAVAILABLE` is broken, no per-day cap is
exceeded in either calendar week, and a from-scratch pairwise conflict count matches the reported
Π₁/Π₂/Π₃. That last equality is what catches index bookkeeping bugs, which are otherwise silent.

Cases worth pinning individually:

- the "more specific wins" resolution of day-specific versus every-day rules, including the
  `UNAVAILABLE` exception (windows accumulate rather than override);
- `MAX_CLASSES_PER_DAY` counted per calendar week: a `WEEKLY` plus a `NUMERATOR` class under a cap
  of 2 is legal; three `WEEKLY` classes are not;
- a biweekly pair on opposite parities is *not* a conflict, while a weekly class over either of them
  *is*;
- an immovable external entry blocking a room, a lecturer and a group;
- a locked requirement appearing in no assignment at all;
- a requirement whose domain is empty being reported and, if it has a current placement, kept there;
- determinism: two runs with the same seed and the same iteration bound produce identical
  assignments.

---

## 13. Where to take it next

- **Make `measure()` incremental.** It is the one part of the loop that costs `O(faculty)` per
  iteration regardless of how little moved. Maintaining Π₁–Π₃ as deltas inside `place` is
  straightforward; Π₄/Π₅ need per-(entity, day) window caches invalidated on the days a move
  touches. This is what would lift the 900-class instance in §8 from 23 iterations to thousands.
- **A full memetic algorithm.** The article's population of 20 with three-parent crossover, adaptive
  mutation and selective LS is a strict superset of what runs here; the objective, the index and the
  neighbourhoods are already shared, so it is an outer loop, not a rewrite. The one real design
  question is that each individual needs its own index, which multiplies memory by the population
  size — worth it on the hardest instances, at several times the runtime.
- **Soft preferences with weights.** `lecturer_workload_candidates.desirability` already
  demonstrates the shape a weighted preference takes in this schema; the constraint tables carry no
  weight column, which is why every rule there is hard today.
- **Room capacity.** `rooms.capacity` and `academic_groups.students_count` are both stored; adding
  "the room must hold the cohort" is one more filter on the room domain, and would also give
  `scanBest` a better room ordering than "first free one".
- **Minimal-change rescheduling.** A term penalising distance from the current timetable would make
  "перевизначити весь розклад" usable mid-semester, where the cost of moving a class is real.
- **Compaction as an explicit objective.** Windows measure gaps but not spread: a group with two
  classes on five days scores as well as one with ten classes on two. A "days used" term would be a
  small addition to `measure()` and is what deaneries usually ask for next.
- **Server-side generation.** Everything here is pure and portable; running it in the backend would
  let a whole university be scheduled at once, across faculties, rather than one faculty at a time
  around the others.
