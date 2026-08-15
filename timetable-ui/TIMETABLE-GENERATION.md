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
| room `a_r` | `timetable_entries.room_id` | `gene.room: number` | nullable — and a null is a real placement, not an absent one |
| — | `abstract_rooms` / `lecturer_workload_online_classes` | `gene.placeKind`, `gene.abstractRoom` | the two ways a class is held somewhere that is not a room |
| timeslot `s_r` | `class_start_times.id` | `gene.timeIdx` → `(start, end)` in minutes | not a uniform grid, see §1.3 |
| day `d_r` | `timetable_entries.day_of_week` | `gene.day`, 1 = Monday | |
| parity `π_r` | `timetable_entries.week_parity` | `gene.parity`: 0 `WEEKLY` / 1 `NUMERATOR` / 2 `DENOMINATOR` | |
| — | — | **block** | the UI's name for a requirement; `Block.key = workloadId::wk\|bi::index` |

In the code, everything is interned to a dense integer index: lecturers, groups, rooms, buildings
and abstract rooms each get their own `Map<string, number>`, and class start times become positions
in one array sorted by start time. Strings never appear in the inner loops.

### 1.2 The objective function

The article's Eq. (1), with four terms of our own:

```
f(σ) = Σ_{i=1..9} β_i · Π_i(σ)^{α_i},   β = (150, 100, 50, 90, 120, 50, 5, 20, 30),   α_i = 2
```

| i | Π_i | β_i | Meaning |
|---|---|---|---|
| 1 | lecturer conflicts | 150 | **H1** — two classes of one lecturer at overlapping times |
| 2 | group conflicts | 100 | **H2** — two classes one academic group attends, overlapping |
| 3 | room conflicts | 50 | **H3** — two classes in one room, overlapping |
| 4 | group travel | 90 | **H4** — a group given less time between two classes than the journey between them takes |
| 5 | lecturer travel | 120 | **H5** — the same for a lecturer |
| 6 | abstract room overflow | 50 | **H6** — a place several classes share holding, at one instant, more students than it seats |
| 7 | lecturer windows | 5 | **S7** — idle academic hours between a lecturer's first and last class of a day |
| 8 | group windows | 20 | **S8** — the same for an academic group |
| 9 | mixed online days | 30 | **S9** — a (group, day, week) on which the group is sent both online and into a room |

The first six are **hard** — `hardOf` sums Π₁..Π₆ — which is why they are numbered together: each of
them describes a schedule somebody cannot physically keep. The last three are comfort.

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

**Π₄, Π₅ — travel.** Not in the article, and the reason they are here is that ЛНУ is not one
building: it is nineteen, spread across Lviv, and a group sent from вул. Університетська 1 to вул.
Черемшини 31 in the ten minutes between two bells does not arrive. A pair counts when one entity has
both classes on the same day, in overlapping weeks, **not** overlapping in time, and

```
second.start − first.end  <  journeyMinutes(first, second)
```

`journeyMinutes` has one rule per way a class can be held, because a class is not always in a room:

- **two rooms** — `building_travel_times`, which is *directed*: the journey made is the one checked,
  and the return leg may cost something else. Two rooms of one building are free.
- **an abstract room that has a building** — behaves exactly like that building. An address is an
  address whoever owns it.
- **an abstract room with no address at all** — one flat `abstract_room_travel_time_minutes`, to or
  from anywhere, because there is nothing to measure between. Except from itself: two classes in the
  *same* abstract room are in the same place, and the same place is free.
- **online on one side** — `university_commute_time_minutes`: the student goes home, or comes in.
  Symmetric, and charged to a lecturer as readily as to a group — they make the same trip. Online on
  *both* sides is no journey at all; nobody leaves the desk.

Every absence is read as "no journey" rather than as a constraint: a room with no `building_id`, a
building pair with no stored time, a blank global property, and — the one that matters most in
practice — a database with no travel figures of any kind, which skips the whole pass (`travelKnown`).
Inventing a walk out of missing data would reject schedules the data does not object to. A stored
time of zero counts as no journey too: the matrix accepts `0` as a legitimate value (two rooms in one
building, entered explicitly), and the solver reads any non-positive figure as "nothing to cross". A
pair in which **both** classes are immovable is skipped exactly as it is for the conflict terms — no
run could fix it, so counting it would only put a floor under `f`.

Overlapping pairs are excluded deliberately: such a pair is already a clash counted by Π₁/Π₂/Π₃, and
charging it again here would make one mistake cost two penalties and pull the search toward fixing
it twice. Both terms are hard, because a class nobody can reach is a class nobody attends. They sit
just below their conflict counterparts (90 against 100, 120 against 150) on the reading that a clash
makes a timetable impossible while an unreachable pair makes it late; when the search must choose, it
should resolve the double booking first.

**Π₆ — a shared place over its capacity.** An `abstract_rooms` row is a place several classes
legitimately occupy at the same hour («Спортивні зали»), so nothing that reasons about room
exclusivity may see it — that is the whole point of the entity, and it is why abstract rooms have
buckets of their own rather than living in `roomBuckets`. What such a place does have is a
`capacity`, and unlike a room's it is a ceiling on the **total** students of everything sharing it at
once. So Π₃ asks "is more than one class here?" and Π₆ asks "are more students here than fit?", which
is why they carry the same β.

The sum of a set of intervals reaches its maximum at one of their starts, so testing every distinct
start instant of a (place, day) bucket finds every breach; charging one breach per instant rather
than per class keeps a crowded hour from costing as much as the number of classes in it. External
classes count — «Спортивні зали» does not care whose groups are in it — and a group whose
`students_count` is unset contributes 0, an unentered figure being no evidence of a crowd. The two
calendar weeks are walked separately and, unlike the window terms, **not** averaged: a weekly class
over capacity is over it every week, and counting it twice is the honest reading.

**Π₇, Π₈ — windows.** A window is **a whole пара the entity was free for**, between two of its
classes on the same day. For one entity, one day and one calendar week: sort that day's classes by
start, walk them keeping `reach = max(end so far)`, and wherever the next class starts after `reach`,
count the **distinct bell start times `t` with `reach ≤ t < start_k`** — one per пара nobody used.
Overlapping classes contribute nothing. This is computed for the numerator week and the denominator
week separately, summed over every entity and day, and the two weeks are **averaged** so that a
purely weekly schedule is not charged twice for the same gap.

The tick set is every `class_start_time_sets` start on *any* grid, deduplicated and sorted — not one
set's ordinals — because a lecturer with a пара on the main grid and one on the спорткомплекс grid
has to be measured against both.

Counting raw idle **minutes** instead, floored to academic hours, is the natural-looking definition
and it is wrong: the ordinary ~20-minute break between consecutive bells accumulates across a day,
so a perfectly packed six-class day scored about two window units and Π₇/Π₈ could never reach zero
on a full day. That is not what a деканат means by «без вікон», and it also meant the zero-cost exit
of §5.9 could only fire on a sparse instance. Under the definition above a back-to-back day scores
exactly 0, and a skipped пара costs exactly 1 whatever the bells' spacing.

**Π₉ — mixed online days.** Groups only. The deanery's stated preference is that online classes take
place on their own days and in-person classes on others, so what is counted is the *day*: one online
class dropped into a campus day costs the same as three, because the damage is the trip home and
back, and that happens once. Averaged over the two calendar weeks exactly as the windows are. It is
soft — a group with a single online class in the week may have nowhere else to put it — and its
weight sits above a group window (30 against 20) and below one doubled. Above, because a mixed day
costs the group a whole `university_commute_time_minutes` journey — two academic hours, where a
window unit is one. Below, because Π₉ is bounded by groups × days while Π₇/Π₈ grow with the class
count, so at a higher weight the squared mixed term would swamp the window reduction that is most of
what a run's budget goes on. And below every hard β, so the modal's table still reads
hard-above-soft.

### 1.3 Four deviations from the article, and why

1. **Intervals, not slot numbers.** The article assumes one uniform grid of `S` timeslots per day,
   so a conflict is "same (day, slot)". Here a class lasts 1–4 academic hours
   (`lecturer_workloads.duration_hours`) and different workloads run on different grids of bells
   (`class_start_time_sets` — physical education starts on its own). Two classes therefore conflict
   when their **time intervals overlap**, which is why `ScheduleIndex` holds lists of genes per
   (entity, day) rather than the paper's bucket counters: a counter cannot answer "do these two
   overlap partially". The lists are short (one entity's day), so the test stays cheap, and unlike
   counters it is exact.

2. **Windows are counted in unused пари, not in idle minutes.** The paper counts unoccupied
   timeslots on one uniform grid. With variable durations and two interleaved bell grids there is no
   single slot index to count, so what stands in for it is the set of distinct start times a gap
   spans — the same quantity the paper means, reconstructed from a non-uniform grid. A ten-minute
   break is not a window; a skipped пара is exactly one.

3. **The incumbent is compared lexicographically.** `f(σ)` is computed exactly as in Eq. (1), but
   the *best-so-far* is chosen by `(hard, cost)` — where `hard` is `Π₁..Π₆`, every term a schedule
   has to satisfy to be usable at all — rather than by one number alone. Because Π₇/Π₈ are
   aggregates over the whole faculty, they grow much larger than the conflict counts, and squaring
   them would eventually make `f` prefer a schedule with a lecturer clash and fewer windows — never
   the trade a deanery wants. (Concretely: on a 300-class faculty Π₈ ≈ 230, so `20·230² ≈ 1.06 M`,
   while one group conflict is `100·1² = 100`; a single window removed is worth ~9 200, ninety-two
   times a whole group clash.) Fewer hard violations therefore always wins the incumbent, whatever
   it costs in comfort.

   The *acceptance* test is the one place this ordering is deliberately not absolute: there a hard
   violation is priced, finitely, at `hardWeight` (§5.5). An absolute rank there would forbid the
   intermediate states through which a stuck violation is repaired, which was measured to matter —
   the two decisions are separate on purpose.

4. **The search is not the paper's.** The construction, the objective, the neighbourhoods and the
   adaptive-intensity idea come from the article; the loop that drives them no longer does. The
   article's two-phase local search — descend to a fixpoint, re-measure, reduce windows, perturb on
   stagnation — was implemented here first, then measured, and the measurement was that the descent
   reaches its local optimum in the first iteration and is inert forever after (§5.10). What runs now
   is a move-level stochastic local search under late acceptance, which is the shape the current
   timetabling results use. §5 describes it; §5.10 says exactly what was replaced and on what
   evidence.

---

## 2. Inputs

### 2.1 Blocks (class requirements)

Exactly the blocks the tab already shows: one per class session a workload's hours require, derived
as `hours / (semester_duration_weeks × workload.durationHours)`, with a remainder of at least half a
weekly class becoming one biweekly class. Every block carries

- its lecturers (all of them — a lab split between two lecturers needs both free),
- the academic groups actually attending: the workload's own groups **plus** every combined group's
  member groups,
- **where it is held**, which is one of three alternatives and not a combination of them:
  - the rooms it may use — the **union** of `lecturer_workload_rooms` and the rooms of
    `lecturer_workload_room_groups`, an empty union meaning *any room of the faculty*;
  - or the one `abstract_rooms` row it is held in — a place several classes legitimately share at
    the same hour, which *replaces* the rooms rather than joining them;
  - or `lecturer_workload_online_classes`, whose presence is the whole fact: the class is online and
    has no place at all.

  An online class is online whatever else the workload names, and an abstract room beats a room
  list; the solver reads them in that order,
- how many students attend, summed over the groups (`academic_groups.students_count`) — what an
  abstract room's capacity caps. The column is nullable and an unknown count contributes 0,
- the `ClassStartTimeSet` its classes run on, which is the only grid of bells it may be put on,
- its duration in academic hours, and whether it is weekly or biweekly,
- its current `timetable_entries` row, if it has one, and whether this run may move it.

### 2.2 The timetable around this faculty

A faculty never schedules in isolation, so three further slices of the *current* timetable are read
and treated as **immovable**:

| Slice | Query | Why |
|---|---|---|
| classes in the rooms this faculty may use | `timetableEntryConnection(roomIds:)` | its rooms also host other faculties' classes |
| classes of this faculty's lecturers | `timetableEntryConnection(lecturerIds:)` | its lecturers also teach other faculties' degree programmes |
| classes of this faculty's academic groups | `timetableEntryConnection(academicGroupIds:)` | its groups are also taught by other faculties' departments |

An external class is held one of the same three ways, and carries the same figures: its room, or
its abstract room, or the fact that it is online, plus its students. Another faculty's cohort counts
against a shared place's capacity exactly as ours does — «Спортивні зали» does not care whose groups
are in it.

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
us, a room belonging to another faculty, a group studying on another faculty's degree programme.

### 2.4 Global properties

`academic_hour_duration_minutes` (to turn a start time and a duration into an interval, and to
measure windows), `semester_duration_weeks` (how many class sessions a workload's hours require),
`current_semester_parity` (which the tab already reads as the default for its own picker), and two
journeys that are properties rather than table rows because there is nothing to measure between:

- `abstract_room_travel_time_minutes` — the trip to or from an abstract room that has no address;
- `university_commute_time_minutes` — the trip between home and the university, which is the gap a
  day mixing an online class with an in-room one has to leave.

Both read as "no journey" when blank, exactly as an absent `building_travel_times` row does.

### 2.5 Buildings and the walks between them

Two maps, both read in the same request as the constraints above:

- **`roomBuilding`** — each room's `building_id`, from `rooms { … building { id } }` on the scoped
  room connection and on the by-id lookup for rooms belonging to other faculties. A room with no
  building simply has no entry.
- **`buildingTravel`** — every row of `building_travel_times`, keyed `"<from>><to>"`. Directed, so
  the two directions are separate entries and may differ.

Abstract rooms carry a `building` of their own and it is interned into the **same** table as the
rooms': a shared place that has an address is, for every purpose in the objective, that address.

Neither map is required. With no journey of any kind known — no travel rows, no abstract-room
figure, no commute figure — the Π₄/Π₅ pass is skipped outright and the solver behaves exactly as it
did before these terms existed, which is what makes the feature additive for an institution that has
not measured its walks.

---

## 3. Constraints

### 3.1 Hard — filtered out, never violated

A placement that breaks any of these is never even considered:

| Rule | Source | Enforced in |
|---|---|---|
| the room must be one the workload allows | `lecturer_workload_rooms` ∪ `lecturer_workload_room_groups` | `gene.rooms`, built once |
| a class held in an abstract room, or online, gets no room at all | `abstract_rooms` / `lecturer_workload_online_classes` | `gene.rooms = [-1]`, built once |
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

Note what is *not* in that table: an abstract room's capacity. It is Π₆, not a filter, because a
shared place is over capacity as a function of everything else in it at that instant, and refusing
placements on that basis would leave a class unplaced where the right answer is to move the class it
is crowding. The same reasoning the article gives for treating conflicts as an objective rather than
as a filter.

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

A class that is in no room — held in an abstract room, or online — has the single-element room
domain `[-1]`. That `-1` is a real, admissible choice, not an absence: an *empty* array would make
the scan find nothing and report a perfectly placeable class as unplaceable, and the unrestricted
fallback below must never be handed to it, because its `roomIds` is empty for the opposite reason
(there is nothing to restrict, not "any room will do").

The fallback room domain of a workload with no room restriction is **this faculty's** rooms — not
every room the problem happens to mention. Rooms reach the solver from three directions (the
faculty's own, those named by a workload, and those of the external classes loaded as obstacles),
and only the first is a room the faculty may schedule into freely; the third in particular belongs
to another faculty and does not even have its own constraints loaded.

### 3.2 Optimised — the objective

H1/H2/H3 conflicts, H4/H5 travel, H6 shared-place overflow and the S7/S8/S9 comfort terms are what
`f(σ)` minimises. They are *not* filtered out, because
a heavily loaded faculty may have no conflict-free schedule at all and a schedule with two clashes
you can see is more useful than a refusal. What remains is listed in the result, by day and by the
two classes involved — up to a cap of 200 entries, since a genuinely over-subscribed instance can
produce thousands and the point of the list is to be read.

The report distinguishes six kinds, not three: `LECTURER`, `GROUP` and `ROOM` for the overlaps,
`GROUP_TRAVEL` / `LECTURER_TRAVEL` for a pair nobody can travel between in the gap they were given,
and `ABSTRACT_ROOM_CAPACITY` for a shared place holding more students than it seats. The tab labels
each line accordingly, so an unreachable pair is not read as a double booking.

The capacity lines are reported once per breaching instant, naming two of the classes sharing the
place and the numbers involved («… — Спортивні зали: 240 студентів, місткість 200»). Π₆ counts a
weekly breach twice, once per calendar week, deliberately; the *list* does not, because printing the
same two names twice would only read as a bug. So that list is shorter than the number beside it
whenever a weekly class is involved.

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
  rooms: Int32Array       // admissible room indices, or the single -1 of a roomless class
  day, timeIdx, room, parity: number     // current placement; day = -1 means unplaced
  start, end: number                     // minutes since midnight, derived from timeIdx
  building: number                       // where it currently is, interned; -1 when nowhere or unknown
  placeKind: number                      // ROOM / ABSTRACT_HERE / ABSTRACT_NOWHERE / ONLINE
  abstractRoom: number                   // interned shared place, -1 when it is not in one
  homeBuilding: number                   // the building it is in regardless of any room, -1 if none
  students: number                       // what a shared place's capacity caps
  anyRoom: boolean                       // its room domain is the unrestricted faculty fallback
}
```

`placeKind` is the four-way split of the three ways a class is held — the two halves of "an abstract
room" behave differently in Π₄/Π₅, one being an address and the other a flat journey from anywhere.
It is a property of the *requirement*, decided once when the gene is built and never by `place`, and
it is kept explicitly rather than inferred from `building`, which is `-1` for three different reasons
(no room yet, a room whose `building_id` is unset, and no address at all) that must not be conflated.

`building` is maintained alongside `room` on every placement — via `buildingFor`, which follows the
room for a class in one and the abstract room otherwise — so Π₄/Π₅ can be evaluated without a map
lookup per pair, and so a roomless class does not lose the building it is genuinely in every time it
moves. `travelMatrix` is interned the same way — a flat `Int32Array` indexed `from · buildings + to`
— and `travelKnown` records whether *any* journey is known: the matrix, the flat abstract-room
figure, or the commute.

`anyRoom` exists for one measured reason. A class naming no room has the whole faculty as its domain
— 1,620 rooms on the largest instance measured — so a linear membership test made every swap attempt
O(rooms), and held the search to 2,285 moves/s at n=31,000 against 13,000/s at n=12,800. Such a class
needs no scan at all: the only question is whether the room belongs to this faculty, which is one
array read into `isFacultyRoom`.

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
lecBuckets[ℓ · 8 + d]   grpBuckets[g · 8 + d]   roomBuckets[a · 8 + d]   absBuckets[x · 8 + d]
```

`absBuckets` — the shared places — is deliberately a family of its own rather than part of
`roomBuckets`: nothing that tests room exclusivity may see an abstract room, which is the entire
reason the entity exists. What is asked of those buckets is the opposite question (§1.2, Π₆).

The stride is 8 rather than 7 so that `d` (1…7) can be used directly with no arithmetic; index 0 is
never written. Three operations maintain them, and only three:

- `indexInsert(i)` / `indexRemove(i)` — push/splice the gene into every bucket it belongs to:
  `|lecturers| + |groups|`, plus its room *or* its shared place, and neither when it is online;
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

`clashesIn(bucket, self, start, end, parity)` is the inner sum, and it is what the live code calls:
`scanBest` accumulates it over a candidate's lecturers, groups and room, and `tryTargetedSwap` uses
it to find who is occupying the placement it wants.

A class in no room contests no room: `room = -1` simply contributes nothing to the sum.

### 4.3 Domains

Two per gene, both computed once while the genes are built:

- **`slots`** — every `(day, time, parity)` triple such that `day` is a working day, `time` belongs
  to the workload's own `ClassStartTimeSet`, and every one of the gene's lecturers and groups
  tolerates the resulting `[start, end)` interval on that day. A biweekly gene contributes two
  triples per (day, time), one per parity; a weekly gene one, with parity `WEEKLY`.
- **`rooms`** — the workload's allowed rooms, or the faculty's rooms if it names none, or the
  single `-1` of a class that is in no room at all (§3.1).

They are kept separate rather than crossed into one list of `(day, time, parity, room)` because the
product is large (6 days × 6 bells × 50 rooms ≈ 1 800 per gene, and 1 400 genes would be 2.5 M
entries) and because room admissibility depends on the room's own rules, which are cheap to test
lazily. The scan therefore iterates ≤ ~72 slots and, inside each, walks rooms only until a
conflict-free one is found — and, on a domain large enough for that to be expensive, only a bounded
sample of them (§5.3).

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

### 4.5 Snapshots, counters, RNG

- **`Snapshot`** — four typed arrays (`Int16Array day`, `Int32Array timeIdx`, `Int32Array room`,
  `Int8Array parity`) of length `movableCount`. Taking one is a flat copy of four numbers per
  requirement gene; restoring one is a `place` call per *movable* gene (a locked one is skipped —
  it never moved). The incumbent is kept as a snapshot rather than as a second index, so "best so
  far" costs no bookkeeping during the search. `snapshotInto` writes into the existing arrays rather
  than allocating: on a good run the incumbent is replaced on most of the early moves, and one
  allocation per improvement would be its own cost.
- **`C`** — the twelve running counters the search actually steers by: the three conflict totals,
  the two travel totals, the shared-place overflow, and windows and mixed days as their two *weekly*
  sums rather than the rounded average the reported `Violations` carry (§5.4).
- **`lahcHistory: Float64Array(L)`** — the late-acceptance history, the cost accepted L moves ago
  (§5.5). A flat typed array indexed `moveCount mod L`; there is no queue and nothing is shifted.
- **`rnd`** — a seeded mulberry32. The same inputs and the same seed give the same schedule; the
  wall-clock budget is the only source of run-to-run variation.

---

## 5. The algorithm

### 5.1 Top level

```
solveTimetable(problem, opts, onProgress, shouldStop):
    build genes, domains, index                          # §4
    emit(PREPARE)
    construct()                                          # §5.2
    best ← snapshot();  bestV ← measure();  bestF ← f(bestV)
    emit(CONSTRUCT)

    rebuildCounters()                                    # §5.4
    hardWeight   ← max(1e6, surrogate() · 0.02)          # §5.5
    acceptedCost ← hard · hardWeight + surrogate()
    lahcHistory  ← [acceptedCost] × L
    bestHard, bestCost ← hard, acceptedCost

    while iteration < maxIterations and not shouldStop():
        every 1024th iteration: if now ≥ deadline: break
        iteration ← iteration + 1

        if hard > 0 and iteration − hotStamp > hotRefresh:      # §5.7
            refreshHot();  hotStamp ← iteration
        i ← (hard > 0 and rnd() < hotShare) ? a random hot gene
                                            : a random movable gene
        if i has no slot or no room domain: continue
        moveCount ← moveCount + 1

        if rnd() < swapRate:  tryTargetedSwap(i)                # §5.6
        else:                 tryMove(i, a random slot of i, a random room of i)

        lahcHistory[moveCount mod L] ← min(lahcHistory[moveCount mod L], acceptedCost)

        if (hard, acceptedCost) < (bestHard, bestCost):         # lexicographic, §1.3
            bestHard, bestCost ← hard, acceptedCost
            snapshotInto(best);  sinceBest ← 0
        else:
            sinceBest ← sinceBest + 1

        if hard = 0 and no windows and no mixed days: break     # f(σ) = 0

        if sinceBest > stagnationLimit · 2000:                  # §5.8
            emit(PERTURB);  perturb(0.10 … 0.20);  rebuildCounters()
            acceptedCost ← hard · hardWeight + surrogate()
            lahcHistory  ← [acceptedCost] × L;  sinceBest ← 0

        every 4096th iteration, throttled to ~8/s: emit(REPAIR | WINDOWS)
    restore(best)
    emit(DONE)
    return assignments, violations, unplaced, conflicts, history
```

**An iteration is one move.** That is the single most important thing to know about this loop, and
it is what every parameter in §6 has to be read against: `maxIterations` is 2 × 10⁹ because a
30-second run does tens of millions of iterations, and `stagnationLimit · 2000` is 60,000 moves
because that is the scale on which a stochastic move generator can be said to have stopped finding
anything. §5.10 describes what an iteration used to be.

Two things about the loop are worth stating plainly. It keeps **one** solution, not a population —
the part of the article that survives here is its objective, its construction and its
neighbourhoods, not its crossover (§13 explains what adding one would involve). And the incumbent is
only ever *replaced*, never degraded: the run ends with `restore(best)`, so it cannot return a
schedule worse than the best point it passed through. The measure by which "best" is decided is
`(hard, acceptedCost)` — see §5.5 for the one place that is not exactly `(hard, f)`.

### 5.2 Construction — most-constrained-first greedy

```
construct():
    for i in movable: unplace(i)
    order ← movable sorted by  (|slots(i)| · |rooms(i)|) ascending,
                          then (|lecturers(i)| + |groups(i)|) descending
    for i in order:
        best ← scanBest(i, wantWindows = true)                 # sampled room list
        if best = null or best.overlap > 0:
            full ← scanBest(i, wantWindows = true, wide = true)   # every room
            if full has fewer conflicts: best ← full
        if best ≠ null:
            place(i, best)
        else:
            report i as unplaced
            if i has a current placement that placementAllowed still accepts: put it back there
```

(That fallback re-checks only the *dynamic* rules — room time rules and per-day caps — not the
gene's own slot domain, which the existing row satisfied when it was written. It cannot smuggle a
bad placement into the database either way: restoring the current placement makes the block
"unchanged", and `buildPlan` writes nothing for it. A class that is supposed to be roomless is put
back roomless; only a class that is supposed to be *in* a room needs one restored.)

A requirement with one viable placement has to claim it before a requirement with a hundred takes it
for a marginal gain. This is the saturation-degree idea behind DSATUR, which is where the timetabling
literature's greedy heuristics come from, applied to the size of a domain rather than to a colour
count. The tie-break sends the gene with the most people first, because it is the one whose
placement constrains the most other genes.

Unlike the article — whose initial population is uniformly random, with no repair — this run starts
from a constructed schedule. With one individual instead of a population of twenty, a random start
would spend a large part of the budget doing what the greedy pass does in one sweep. Construction
alone typically clears most or all of Π₁/Π₂/Π₃; what it does not do is anything about comfort, so
everything after it is soft-cost reduction with the occasional stuck violation to unpick. Feasibility
is what greedy gives you cheaply; quality is what the rest of the run is for.

**The two-stage scan is a measured compromise, not a refinement.** A single `scanBest` walks a
bounded *sample* of the room domain (§5.3); only a class the sample could not place cleanly pays for
a second, full scan. Doing it the other way round — a full scan always — is what made construction
quadratic in the room count: 1.3 s at n = 3,200, 17.8 s at 12,800 and **123 s at 31,000**, two
minutes of a budget before the search took its first move. With the sample and its gate, construction
at n = 31,000 costs **4.6 s**. (Below `ROOM_SCAN_FULL_BELOW` the first scan is already a full one,
so the second is the same scan from a second random offset — cheap, and it costs only the classes
the first attempt could not place cleanly.)

Note that the ordering is static — computed once from the domain sizes — rather than the dynamic
saturation degree DSATUR recomputes after every colouring. Dynamic re-ranking was measurably not
worth its cost here, because the local search that follows repairs exactly the mistakes a static
order makes.

### 5.3 The candidate scan — `scanBest`

`scanBest` is now **construction's** instrument alone: the search loop does not call it, because a
move that scans a whole domain costs what hundreds of sampled moves cost and buys less (§5.4). It
still deserves reading, because how well the run starts is decided here.

```
scanBest(i, wantWindows, avoid = -2, wide = false):
    best ← null
    offset ← random             # so ties are not always broken toward Monday
    for each slot (day, time, parity) of gene i, starting at offset:
        start, end ← time, time + duration(i)

        peopleOverlap ← Σ clashes with i's lecturers and groups at (day, start, end, parity)
        if best ≠ null and peopleOverlap > best.overlap: continue        # (P1)

        roomOffset ← random
        limit ← (wide or |rooms(i)| ≤ ROOM_SCAN_FULL_BELOW) ? |rooms(i)|
                                                           : min(|rooms(i)|, ROOM_SAMPLE)
        for `limit` rooms a of gene i, starting at roomOffset:
            if a = avoid: continue
            if not placementAllowed(i, day, start, end, parity, a): continue
            overlap ← peopleOverlap + (a ≥ 0 ? clashes in room a : 0)
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
- **(E1)/(E2)** are its "early termination when ov(i) = 0 is found".
- The two random offsets matter more than they look. Without them every gene would prefer Monday's
  first bell and the lowest-numbered room, and the greedy construction would pile the whole faculty
  into the top-left corner of the week before the local search ever ran.
- `ROOM_SAMPLE = 96` and `ROOM_SCAN_FULL_BELOW = 256` are the room candidate list. The gate is there
  because sampling *hurts* where a full scan is affordable: at n = 3,200 (167 rooms) sampling made
  the answer about 30% worse, while at n = 31,000 (1,620 rooms) the full scan was the 123 seconds
  above. So the full scan stays wherever it is cheap, and the sample takes over only above the
  threshold.
- `avoid` defaults to `-2` rather than `-1`, because `-1` is a *real* room value — the entire room
  domain of a class held in an abstract room or online — and "nothing to avoid" must not collide
  with it.
- `scanBest` returns `null` only when *every* admissible slot × room pair it looked at was rejected
  by `placementAllowed` — that is, by a per-day cap or a room rule, since everything else was already
  filtered into the domain.

`windowCostAt(i, day)` is the soft cost the gene would live inside on its own day:

```
windowCostAt(i, d) = Σ_{ℓ ∈ lecturers(i)} (windowsIn(lec[ℓ][d], NUM) + windowsIn(lec[ℓ][d], DEN))
                 + Σ_{g ∈ groups(i)}    ( 4 · (windowsIn(grp[g][d], NUM) + windowsIn(grp[g][d], DEN))
                                        + 6 · (mixedIn(grp[g][d], NUM)  + mixedIn(grp[g][d], DEN)) )
```

Everything is expressed in units of one *lecturer* window using the objective's own exchange rates —
4 = β₈/β₇ = 20/5 and 6 = β₉/β₇ = 30/5 — so the local decision trades the three soft terms against
each other exactly as `f` does. Π₉ is in here and not only in `measure` because a term the scan
cannot see is a term the search only ever scores and never steers by: without it a class would be as
happy to land on a group's campus day as on its online one.

### 5.4 One move, evaluated incrementally

Every Π is a sum over buckets, so a move only needs the buckets it *touches* recomputed. That is the
whole of the rewrite, and the difference between a search that can afford one candidate per full
`measure()` and one that can afford hundreds of thousands.

The buckets a move of gene `i` touches are those of its lecturers, its groups, its room and its
abstract room, on the day it leaves and the day it arrives — a handful, against the whole schedule.
`collectTouched` gathers them, and `accumulate(±1)` adds or subtracts their per-bucket components
(`bucketConf`, `bucketTrav`, `windowsIn`, `mixedIn`, `absBucketOver`) into the running counters `C`.
So a candidate is: subtract the touched buckets, `place`, add them back, read the counters. A
rejection is the same three steps in reverse, which is why the counters cannot drift — they are
never *adjusted*, only recomputed for the small set of buckets whose contents changed.

The per-bucket functions mirror the aggregate ones exactly: same predicates, same "both immovable is
not our problem" skips. That duplication is deliberate and load-bearing — the moment the two
disagree, the search steers by one number and the modal reports another.

Two counters are kept in a form the reported `Violations` do not use. Windows and mixed days are held
as their two *weekly* sums rather than as the rounded average, because rounding is not incrementally
maintainable and a search steered by a rounded counter is blind to every move that shifts the total
by less than a whole unit. The cost the search descends is therefore a **surrogate**:

```
surrogate() = Σ_{i=1..6} β_i · C_i²  +  β₇ · ((lecWinN + lecWinD)/2)²
                                     +  β₈ · ((grpWinN + grpWinD)/2)²
                                     +  β₉ · ((grpMixN + grpMixD)/2)²
```

— the same expression as Eq. (1) except that the three soft terms are not rounded first. The
schedule that is finally returned is re-measured exactly by `measure()`, so **nothing that is
reported was ever computed this way**.

### 5.5 Acceptance — late acceptance, and the price of a hard violation

A candidate is accepted when

```
cost = hard · hardWeight + surrogate()
accept  ⇔  cost ≤ lahcHistory[moveCount mod L]  ∨  cost ≤ acceptedCost
```

**Late Acceptance Hill Climbing**: a move is kept if it is no worse than the state accepted `L` moves
ago, or no worse than the current one. It was chosen over simulated annealing for a blunt reason —
temperature was measured to be *irrelevant* here (T₀ from 2.5 to 8,000 gave identical answers to
three significant figures), because the search it was attached to never consulted it (§5.10). LAHC
needs no temperature and no schedule: the history is the schedule.

After each attempt the history slot is *lowered* to the current accepted cost if it stands above it,
and never raised. So the bar a move must clear only tightens as the run goes on, until a perturbation
refills the whole array (§5.8).

**`L` is the dominant parameter, and its optimum is small and does not grow with the instance.**
Measured at n = 3,200: soft 638 at L = 100 against 876 at L = 500 and 3,935 at L = 1,600. At
n = 12,800: 4,508 at L = 100 against 23,366 at L = 500. (These are on the superseded window scale of
§1.2 — both sides of each comparison were measured the same way, so the ranking holds, but the
absolute figures are not those of §8.) The reading is that a long history lets the
uphill drift outrun the descent, and the larger the instance the more damage that does — which is the
opposite of the intuition that a bigger problem wants a longer memory. Default `lahcLength: 100`.

**`hardWeight` is finite on purpose, and scale-free on purpose.** The obvious encoding of "hard
always wins" is `hard · 1e12`, an absolute rank. It does not work: repairing one stuck violation
usually requires passing through a state with two, and under an absolute rank that state costs a
trillion and is never accepted. Measured, an n = 6,400 instance with a single stuck violation returned
byte-identical results at 30 s, 60 s **and** 120 s — the extra budget could not buy the one step it
needed.

A *fixed* finite weight is wrong in the other direction. `f` is a sum of squared counters, so it grows
with the square of the instance: 1e8 is an enormous penalty at n = 400 (f ≈ 1e5) and a rounding error
at n = 31,000 (f ≈ 2e10). That is exactly what the measurements showed — best-in-class up to
n = 12,800, then soft 57,584 at n = 31,000 against 9,343 for the scale-free version, because
feasibility had stopped mattering to the search at all.

So the weight is taken from the instance itself: `max(1e6, surrogate() · 0.02)`, evaluated once, on
the constructed schedule. One hard violation then always costs about what a 2% swing in the whole
soft cost costs — enough to dominate any single comfort move, finite enough to let the search walk
through a worse state to repair a stuck one.

The **incumbent** is not chosen this way. It is still lexicographic: fewer hard violations always
wins, whatever it costs in windows (§1.3). Only the acceptance test is allowed to cross the cliff.

### 5.6 The neighbourhood — N1, a targeted N2, and an ejection chain

Three move families. While the search is still descending, `chainRate: 0.15` of candidates are
**ejection chains** (below); of the remainder, half are plain reassignments — `tryMove` with a slot
and a room drawn uniformly from the gene's own domains — and half are targeted swaps.

**The swap is targeted** (`tryTargetedSwap`). A reassignment cannot move a class into an occupied
slot, so on a dense timetable the single-move neighbourhood is mostly blocked, which is exactly when
a swap is the only way through — this is the "composite neighbourhood" every current result uses. But
a *uniformly random* partner almost never admits the other's slot and room, so it is a cheap
rejection rather than a candidate: raising the rate of random swaps to 0.5 raised the iteration count
by 60% and made the answer worse. So the partner is chosen by what is actually in the way:

```
tryTargetedSwap(i):
    pick a random slot and a random room from i's domains
    if that room is -1: give up          # a roomless class has nobody to trade a room with
    j ← the first movable class occupying that room at that time, in overlapping weeks
    if there is none: tryMove(i, that placement)     # it was free after all
    else:             trySwap(i, j)
```

`trySwap` requires each gene's placement to be in the *other's* domain — both the packed slot and the
room — applies the exchange, and re-checks `placementAllowed` for both afterwards, because
`MAX_CLASSES_PER_DAY` is the one hard rule the domains do not carry and a swap can break it even
though neither placement is new. The two halves are evaluated as **one** candidate against the
acceptance test, since either half alone is usually worse than both. If it is rejected, or illegal,
both genes go back.

The bucket bookkeeping is the union of the two moves' touched buckets, collected before either
`place` runs — a swap whose two genes share a lecturer must not count that lecturer's day twice.

With the partner chosen this way nearly every attempt is a real candidate, and the rate can be
raised: the sweep put the best value between 0.4 and 0.6, rising with the size of the instance,
because a denser timetable has more trading to do. `swapRate: 0.5`.

One class of move the swap cannot make: a class that is in no room has no room to trade, so
`tryTargetedSwap` gives up immediately on it and abstract-room and online classes are moved by
reassignment alone. They are also the classes least in need of a swap, since neither contests a
room.

#### N4 — the ejection chain, and why it turns itself off

A swap is a chain of length one with a forced closure: B has to accept precisely A's old placement,
which is usually a placement B has already rejected. The chain lifts that restriction — A takes the
placement it wants, whoever was in the way is re-placed **where it would choose to go**, and whoever
*that* displaces is handled the same way, to depth 3.

```
tryEjectionChain(i):
    put i at a random admissible placement from its own domains
    repeat up to 3 times:
        j ← a movable class now double-booked with the last link
        if there is none: stop                    # the chain closed cleanly
        move j to scanBest(j)                     # its own best free placement
    cost the whole chain once; accept or unwind it as a unit
```

The chain is one candidate. Every link is applied through the same `collectTouched` / `accumulate`
delta machinery as a single move, and an `undo` stack replays them in reverse if the acceptance test
rejects — so a four-class rearrangement costs one evaluation, not four.

It reaches rearrangements a move-at-a-time search cannot: every intermediate state of the equivalent
move sequence is worse than both endpoints, and late acceptance will not walk through a valley that
deep.

**It is switched off once the incumbent stops moving** (`sinceBest < chainOffAfter`, 20,000 barren
moves). Measured, the chain is worth 28–46% on every instance still improving and *costs* 28% on
every instance that has converged — same instance, same rate, same seed, n = 12 800 gives 652
against the plain search's 913 at two minutes and 560 against its 438 at five. A chain displaces up
to four classes at once: a coarse instrument, which is what a descent wants and an endgame does not.
With the taper, n = 12 800 at two minutes reaches **596** — better than both the plain search (−35%)
and the untapered chain (−9%).

### 5.7 Endgame focus — min-conflicts

While anything is still infeasible, `hotShare = 0.7` of candidates are drawn not from all movable
genes but from `hotList`: the classes actually taking part in a hard violation.

The arithmetic is what makes this necessary rather than clever. A run at n = 31,000 ends with a
handful of violations among 29,760 classes, so a uniformly drawn class is one of the guilty parties
about 0.03% of the time, and effectively the entire remaining budget goes on polishing a schedule
that is already feasible everywhere else. Drawing from the offenders is the min-conflicts heuristic,
and it is what turns "nearly feasible" into feasible.

`refreshHot` is a full scan of every conflict, travel and overflow bucket, so it is rebuilt only
every `hotRefresh = 50,000` moves and only while `hard > 0` — amortised to nothing, and absent
entirely from a feasible run.

### 5.8 Perturbation

After `stagnationLimit · 2000` = 60,000 moves with no new incumbent:

```
perturb(0.10 + 0.10 · rnd()):
    n ← ⌊|movable| · strength⌋
    repeat n times:
        i ← a random movable gene
        up to 6 times: draw a random (day, time, parity) from slots(i) and a random room
                       if placementAllowed: place(i, …); break
rebuildCounters();  acceptedCost ← cost of the new state;  lahcHistory ← [acceptedCost] × L
```

10–20% of the genes are re-placed at random within their domains, the counters are rebuilt from
scratch (the one place they are, since the perturbation touches too much for the touched-bucket
bookkeeping to pay), and the late-acceptance history is refilled at the new level so the search is
not immediately fenced in by the bar it had reached before the kick.

Two things differ from the loop this replaced. The kick fires on **moves** without a new incumbent,
not on outer iterations without one, and 60,000 moves is a genuinely long silence for a generator
running tens of thousands of them a second — under late acceptance, most runs never perturb at all,
which is the intent: the acceptance rule is already a diversification mechanism, and the kick is
there only for when it has run out of room. And the perturbation is applied to the **current** state
rather than to a restored incumbent, because with late acceptance the current state is deliberately
not the incumbent and restoring first would throw away the drift that is doing the work.

`perturb` picks genes *with replacement*, so the fraction actually disturbed is slightly below the
nominal strength; and it only ever produces admissible placements, so a perturbation can never break
a hard rule, only create violations for the search to repair.

### 5.9 Termination

Whichever comes first:

- the wall-clock budget (`timeLimitMs`, chosen in the panel: 10 s / 30 s / 1 min / 2 min), read once
  every 1,024 iterations — `Date.now()` on every move would be a measurable fraction of the work at
  this move rate;
- `f(σ) = 0` — no hard violations, no windows and no mixed days, so there is nothing left to find.
  This is now genuinely reachable: under the window definition of §1.2 a fully packed day scores 0,
  and small instances (n ≤ 50) do exit this way in well under a second. On a full faculty a residual
  window or two normally survives, so the budget is the usual bound;
- `maxIterations`, which defaults to 2 × 10⁹ and exists only as a backstop against a pathological
  zero-cost loop. The old default of 1,000,000 was *not* such a backstop once an iteration became a
  single move: it was reached in 13 s of a 30 s budget and silently ended the search less than half
  way through;
- `shouldStop()`, which the worker cannot actually deliver mid-run — see §9.

### 5.10 What the old loop was, and why it went

The document described a different algorithm until this rewrite, and the reason it changed is worth
keeping, because the old one is not obviously wrong on paper.

It was the article's two-phase local search: per outer iteration, `repairPhase(40 passes)` — N0 retry
the unplaced, N1 reassignment, N2 swap, N3 chain move, under a simulated-annealing acceptance and a
tabu list — then a full `measure()`, then `windowPhase` on a conflict-free schedule, then another
full `measure()`, with an adaptive intensity and a perturbation after 30 barren iterations.

Measured, it was inert. `repairPhase` is a deterministic descent: it reaches its local optimum in the
**first** iteration and never moves again. With perturbation disabled, a run logged **1 improvement
in 89,070 iterations** and never left the value construction had handed it. Every improvement the
loop ever made came from the perturb → re-descend → keep-if-better cycle, which is a very coarse
instrument, and the 40 repair passes plus one or two full `measure()` calls per iteration were, after
the first, pure overhead. It also explains why the acceptance rule was irrelevant: an acceptance
rule needs a stream of candidates to accept or reject, and there was none.

What replaced it is §5.4–§5.7. Three of the removals were the whole of the speed-up: the full
`measure()` per improvement (which fires on most moves early in a run, and made the search O(faculty)
per move again), the quadratic room scan in construction, and the linear room-membership test on
unrestricted classes. Throughput at n = 12,800 went from 6,980 to **35,874 moves/s**, and at
n = 31,000 from 1,860 to **18,022 moves/s**.

**All of it has been deleted:** `repairPhase`, `swapPlacements`, `windowPhase`, `totalWindowScore`,
`overlapAt` / `overlapOf`, the `tabu` map with `tabuKey`, the temperature schedule,
`WINDOW_SCAN_SAMPLE`, and the nine options that fed them (§6). They were kept for one revision on
the argument that the neighbourhood definitions were the reference for what N0–N3 meant; the
argument does not survive git history existing. `results/solver-before-optimisation.ts` in the
benchmark harness is the whole of the old solver, runnable, which is a better reference than dead
code in the live file.

---

## 6. Parameters

Everything lives in `DEFAULT_OPTIONS` or, for the handful added by the rewrite, as an
`opts.x ?? default` at its point of use. The UI still overrides exactly one.

**Live — the search reads these.**

| Option | Default | What it controls |
|---|---|---|
| `timeLimitMs` | 30 000 | wall-clock budget. **The only value the UI sets** (10 s / 30 s / 1 min / 2 min) |
| `maxIterations` | 2 000 000 000 | moves; a backstop against a zero-cost loop, not a real bound (§5.9) |
| `lahcLength` (`L`) | 100 | late-acceptance history length — the dominant parameter (§5.5) |
| `hardWeight` | `max(1e6, surrogate() · 0.02)` | what one hard violation costs the acceptance test; scale-free, computed once after construction (§5.5) |
| `swapRate` | 0.5 | fraction of candidates drawn from the targeted swap rather than a reassignment (§5.6) |
| `hotShare` | 0.7 | fraction drawn from the classes currently in a hard violation (§5.7) |
| `hotRefresh` | 50 000 | moves between hot-list rebuilds (§5.7) |
| `roomSample` | 96 | rooms examined per slot when the domain is large (§5.3) |
| `roomScanFullBelow` | 256 | room-domain size below which a scan always looks at every room (§5.3) |
| `stagnationLimit` | 30 | ×2000 = moves without a new incumbent before a perturbation (§5.8) |
| `seed` | 20260802 | PRNG seed; same seed + same **move count** ⇒ same schedule (see §10) |

`ROOM_SAMPLE`, `ROOM_SCAN_FULL_BELOW`, `hotShare`, `hotRefresh` and `hardWeight` are options rather
than constants because each of them was swept to get its value, and the sweeps are worth being able
to repeat; nothing in the UI sets them.

**Removed.** Nine options that the old two-phase loop read no longer exist: `repairIterations`,
`windowMoves`, `tabuTenure`, `initialTemperature`, `coolingFactor`, `intensity`, `minIntensity`,
`maxIntensity` and `adaptationStep`. They were kept for one revision after the phases that read them
were deleted, which meant `DEFAULT_OPTIONS` advertised a temperature and an adaptive intensity that
reached nothing — a knob that silently does nothing is worse than no knob. The adaptive intensity
had a real job in the old loop, deciding how much of the schedule one repair pass examined; a
move-level search has no such quantity to adapt, since it examines exactly one gene at a time.

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
   intervals, and A ends at 10:20 while C starts at 10:40. `windowCostAt(C, Tue) = 0` too — no bell
   starts inside that 20-minute gap, so it is not a вікно. Placed.

Result after construction: every Π is 0, so `f = 0` and the loop's exit condition fires before a
single move is sampled.

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
| `clashesIn` on one bucket | `O(k)` |
| one `scanBest` | `O(S · A′ · E · k)` worst case, `A′ = min(A, ROOM_SAMPLE)` unless the domain is small or the scan is `wide`; far less with (P1)/(P2) and (E1)/(E2) |
| construction | `V` sampled scans, a full scan for each block the sample could not place cleanly, plus `O(V log V)` for the order |
| **one candidate move** | `O(E)` buckets, each `O(k²)` for conflicts and travel and `O(k log k)` for windows — proportional to the classes sharing a day with the one being moved, **not** to `V` |
| one targeted swap | the same over the union of two genes' buckets, plus `O(k)` to find the partner |
| `refreshHot` | `O(Σ_buckets k²)` — a full pass, amortised over 50 000 moves and only while infeasible |
| `windowTotal` (Π₇, Π₈) | `O(entities · days · k log k)` — a sort per bucket per week |
| `conflictTotal` (Π₁, Π₂, Π₃) | `O(entities · days · k²)` — all pairs inside each bucket |
| `travelTotal` (Π₄, Π₅) | the same, over the group and lecturer buckets only — a room does not travel anywhere. Skipped entirely when no journey of any kind is known |
| `abstractOverflowTotal` (Π₆) | `O(places · days · k²)`, over the shared-place buckets only |
| `measure()` (all nine Π) | the above, summed — now paid only by the ~8 progress messages a second and once at the end |
| `snapshot` / `snapshotInto` | `O(V)` — a flat copy |
| `restore` | `O(V · E · k)` — a `place` per movable gene, and each one re-indexes |

The consequence worth holding on to is the fifth row. The cost of a candidate does not depend on the
size of the faculty, only on how crowded the days it touches are, which is what makes a fixed
wall-clock budget buy a comparable *number* of moves on a 400-class instance and on a 31,000-class
one. It is not quite flat in practice — a larger instance has longer buckets and worse cache
behaviour — but it is the difference between a search that scales and one that does not.

**Measured.** On instances from `scripts/timetable-bench` (§12), each built around a hidden feasible
schedule so that a perfect answer provably exists, on a two-core sandbox under Node. 30-second
budget, median of 5 seeds unless noted; `n` is class sessions, which is what the search places.

| n (class sessions) | budget | feasible | soft cost | hidden-reference soft |
|---|---|---|---|---|
| 400 | 30 s | 5/5 | 6 | 362 |
| 800 | 30 s | 4/4 | 17 | 777 |
| 1 600 | 30 s | 5/5 | 40 | 1 582 |
| 3 200 | 30 s | 5/5 | 121 | 3 153 |
| 6 400 | 30 s | 5/5 | 594 | 6 205 |
| 6 400 | 120 s | 1/1 | 212 | 6 205 |
| 12 800 | 120 s | 3/3 | 600 | 12 464 |
| 12 800 | 300 s | 2/2 | 466 | 12 411 |
| 31 000 | 470 s | 2/2 | 1 294 | 30 247 |

Hard violations are **0** on every row, and the residue is overwhelmingly windows: at n = 12 800 it
is roughly 370 lecturer windows + 190 group windows + 40 mixed online days, out of 12 800 classes.
Every row is measured on the shipped solver. The 31 000 row is where the ejection chain of §5.6 paid
best of anywhere — 2 503 → 1 463 and 2 135 → 1 125 on its two seeds, 42% and 47% — because an
instance that size is still descending when its budget runs out, which is the regime the chain is
for. The last
column is the soft cost of the hidden schedule the instance was generated around — a feasible,
human-plausible answer, not an optimum — so the solver is between 10× and 60× better than the
schedule it had to find.

The largest instance is 31,000 class sessions = 12,873 courses, 2,067 academic groups, 3,444
lecturers and 1,620 rooms across several buildings, with the full constraint vocabulary: all four
constraint types on all three subjects, abstract rooms with and without an address, online classes,
biweekly parity, combined groups, external fixed entries and unrestricted-room classes. For scale,
the published ITC-2007 benchmarks are 138–434 lectures, so everything above n ≈ 400 is beyond the
range the literature reports on and had to be engineered rather than borrowed.

**Throughput**, for reading the two numbers that mattered most: removing the full `measure()` from
the improvement branch took n = 12,800 from 6,980 to **35,874 moves/s** and n = 31,000 from 1,860 to
**18,022 moves/s**; replacing the quadratic room scan took construction at n = 31,000 from **123 s to
4.6 s**.

**Budget beats everything.** Two independent measurements say the same thing: a run at 300 s scores
438 where the same run at 120 s scores 913, and four runs of 75 s each keep only 1,907 between them.
Time in one continuous search is worth more than any way of dividing it that has been tried.

**The escape mechanism does not run at faculty scale.** The perturbation fires after
`stagnationLimit × 2000` = 60,000 moves without a new incumbent. Counted directly: 24 events in a
30-second run at n = 400 and 21 at n = 800, but **zero** at n = 12 800 over 120 seconds, where
stagnation peaks at 23,459 — the search is still genuinely improving at that budget, so the kick is
correctly not reached. It is reached only in benchmark-length runs, which means the panel's
two-minute maximum never exercises it on a full faculty.

**Where the budget stops paying.** At n = 12 800 the same instance and seed returns soft 913 at
120 s, 438 at 300 s, and 438 again at 540 s — the last figure with an identical objective, from a
run that made 22.8 million moves against the 300-second run's 11.8 million. Convergence completes
somewhere between two and five minutes and nothing happens afterwards, so the panel's two-minute
maximum is worth roughly half of what the solver can actually do at that size, and anything past
five minutes is worth nothing at all without a restart mechanism (§13).

Read all of this as indicative rather than as a fixture. The search is deterministic *given the
number of moves it gets through*, and a wall-clock budget buys a different number on a different
machine.

**A parallel portfolio was measured and rejected.** Running six independent seeds and keeping the
best beat the median of those seeds by only 6% — six times the CPU for a few per cent of soft cost,
against a single run that is already an order of magnitude better than the reference. The variance
between seeds is simply not where the remaining value is.

---

## 8a. The search portfolio — k workers, best answer wins

The search is stochastic and its trajectory decides which local optimum it lands in, so the same
instance at the same budget gives materially different answers from different seeds: measured,
438 / 510 / 547 / 665 across four (§8). **Best-of-four beats the median by about 20%**, and because
the runs are concurrent it costs nothing in wall clock.

The concurrency is the whole of the gain, not an implementation detail. Splitting one budget across
four *sequential* runs is **4.3× worse** at n = 3 200 and 4.4× worse at n = 12 800 — quality climbs
steeply enough with budget that a quarter-length run is nowhere near a quarter as good. Every worker
therefore gets the full budget, and the fleet only makes sense on cores that would otherwise idle.

```
runSolver:
    k ← fleetSize(blocks)
    for i in 0..k-1:
        spawn worker, solve(problem, {...options, seed: BASE_SEED + i·7919})
    progress → keep the best (hard, objective) seen from any worker
    all done → keep the best (hard, objective) result
```

**Fleet size** is `min(4, cores − 1)`, reduced to 3 above 4 000 blocks and to 2 above 8 000. One core
is left for the page, which still has a modal animating on it. The size cap is memory, not CPU: each
worker holds its own copy of the schedule and its indexes, about 250 MB at 12 800 classes, so four
of them would ask a browser tab for a gigabyte to win 20%. A faculty is a few thousand classes and
stays on the full fleet.

**Seeds are strided by 7919**, a prime well clear of the mulberry32 state size, so the k streams
start far apart. Two searches whose random sequences overlap are one search that costs twice as much.

**One worker failing is not the run failing.** Any of the others can answer, so a failure is counted
and the run continues; only a fleet that has *all* failed raises an error. Symmetrically, the run
finishes when every worker has either returned or failed.

**Progress** shows whichever worker is currently ahead, by `(hardTotal, objective)` — not the most
recent message. Four progress bars would tell a reader nothing they can act on, and more importantly
the schedule attached to these messages is what «Зупинити й показати результат» plans against, so it
has to be the best anyone has found rather than the latest anyone sent.

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

Each `SolverProgress` carries the phase, the elapsed time, an objective figure, all nine Π_i
separately, how many blocks are placed out of how many this run may move, and how many are unplaced.
The Π decomposition is shown as a table with each term's β and its contribution — H1…H6 then S7, S8,
S9 — so it is visible at a glance whether the run is still fighting violations or has moved on to
comfort.

Three things about that display are worth knowing when reading it:

- The Π table is an exact `measure()` of the schedule **as it stands right now**, which under late
  acceptance is deliberately not the incumbent: the figures can tick upwards for a while, and that is
  the search drifting on purpose rather than losing ground.
- The `objective` number beside it is the *incumbent's* acceptance cost — `hard · hardWeight +
  surrogate()` (§5.5), not Eq. (1). Only the figure shown when the run finishes is `f(σ)` proper. The
  two are the same shape and the same order of magnitude, but they are not the same number, and
  `result.history` carries the same mixture: its first point is `f` after construction and the rest
  are acceptance costs.
- The meta line reads «Ітерація N · без покращення: M». It used to carry a temperature and an
  intensity as well; both described nothing once the phases were replaced, so they were removed from
  `SolverProgress` rather than left to read as live knobs.

---

## 10. What is and isn't guaranteed

**Guaranteed.**

- No hard rule is ever broken: a written entry is always in an allowed room (or in no room at all,
  when that is what the workload says), on the workload's own bells, outside every `UNAVAILABLE`
  window, within `NOT_BEFORE`/`NOT_AFTER`, and within `MAX_CLASSES_PER_DAY` counted per calendar
  week.
- No class belonging to another faculty is created, moved or deleted.
- No `timetable_entries` row is ever **deleted** by generation, in either mode.
- In "лише невизначені" mode, no existing entry of this faculty is touched at all.
- The result is never worse than the best point the search passed through: the incumbent is only
  replaced by a lexicographically better one, and the run ends by restoring it.
- The run terminates: the loop is bounded by the wall-clock budget, read every 1 024 moves, and by
  `maxIterations` behind it.
- **Reproducibility, up to the clock.** The search itself is fully deterministic: same inputs, same
  seed, same number of moves ⇒ byte-identical assignments. What is *not* reproducible is how many
  moves a wall-clock budget buys, so two runs of the same problem at the same `timeLimitMs` can end
  at different points of the same trajectory and return different — usually equally good —
  schedules. Pin `maxIterations` instead of `timeLimitMs` when a test needs an exact answer; that is
  what the solver's own tests do.

**Not guaranteed.**

- **Optimality.** UCTP is NP-hard; this is a heuristic. `f(σ) = 0` is reachable on small instances
  and is reached there, but on a full faculty a run converges to a residue of windows and then goes
  **completely** inert: at n = 12 800 a 540-second run returns the byte-identical objective a
  300-second run did, having spent 11 million moves finding nothing. Budget past convergence is
  wasted rather than slowly useful — see §8.
- **Feasibility.** The benchmark family of §8 comes out with zero hard violations at every size
  measured, but nothing in the algorithm guarantees it. If the constraints admit no conflict-free
  schedule — or the budget was too short to find one — the result carries the violations, listed by
  day and by the two classes involved (the first 200 of them). It is offered rather than refused,
  because a schedule with two visible clashes is more useful than none.
- **The incumbent is chosen on the surrogate, not on `f`.** `(hard, acceptedCost)` orders two
  schedules the same way `(hard, f)` does except where they differ by less than the rounding of a
  window or mixed-day count (§5.4). The reported figures are always the exact ones; it is the choice
  between two nearly identical schedules that can go the other way.
- **Stability across runs with different budgets.** A longer budget may produce a wholly different
  arrangement of equal quality. There is no term rewarding similarity to the previous timetable.
- **Atomicity of the write.** See §9.
- **Anything the model does not know.** A *room's* capacity versus the size of the cohort in it (a
  shared place's capacity is modelled, Π₆; an ordinary room's is not), a lecturer's preference for
  mornings that they never entered as a constraint.
- **A class construction could not place is unlikely to be rescued.** The old loop had a
  neighbourhood of its own for this (N0: re-scan every unplaced gene each pass); the move-level
  search has none. An unplaced gene is a movable gene like any other and does get drawn, but nothing
  in the objective counts a class as *missing* — an unplaced class contributes to no Π — so any
  placement for it can only leave the cost equal or raise it, and the acceptance test has no reason
  to prefer one. In practice it is rescued only when it lands somewhere that costs nothing at all.
  This is the clearest gap the rewrite left: the honest fix is a term for "not scheduled", weighted
  above everything else, which would also let the search trade a window for a placed class. Until
  then, the safety net is the one that has always mattered — such a block keeps its existing entry
  and is reported by name, never deleted (§3.1).

  A smaller consequence: `pendingUnplaced`, the counter behind the «неможливо розмістити» figure in
  the progress line, is decremented nowhere on the live path, so it can overstate the problem
  mid-run. The final report does not — it is filtered against where each gene actually ended up.
- **`pendingUnplaced` overstates mid-run.** As above — the final report is filtered against where
  each gene actually ended up, so only the live progress figure is affected.

---

## 11. Code map

`timetable-solver.ts`, top to bottom:

| Symbol | Role |
|---|---|
| `SolverProblem`, `SolverRequirement`, `SolverFixedEntry`, `SolverAbstractRoom`, `SolverPlacement`, `SolverConstraint`, `SolverClassTime` | the input shapes (§2) |
| `SolverOptions`, `DEFAULT_OPTIONS` | the parameters (§6) |
| `OBJECTIVE_WEIGHTS`, `OBJECTIVE_EXPONENT` | β and α of Eq. (1) |
| `Violations`, `SolverPhase`, `SolverProgress`, `SolverConflict`, `SolverAssignment`, `SolverUnplaced`, `SolverResult` | the output shapes |
| `parseMinutes`, `makeRandom`, `weeksOverlap`, `timesOverlap`, `parityCode`, `PARITY_*`, `DAY_SLOTS` | small helpers |
| `DayRules`, `NO_RULES`, `resolveRules`, `timeAllowed` | constraint resolution (§4.4) |
| **`solveTimetable`** | everything below is a closure inside it |
| `lecturerIdx` / `groupIdx` / `roomIdx` / `buildingIdx` / `abstractIdx`, `times`, `timesBySet` | interning (§1.1) |
| `roomBuildingIdx`, `travelMatrix`, `travelBetween`, `abstractTravelMinutes`, `commuteMinutes`, `travelKnown` | the journeys (§1.2, §2.5) |
| `abstractCapacity`, `abstractBuilding`, `abstractNames` | the shared places (§1.2) |
| `PLACE_ROOM` / `PLACE_ABSTRACT_HERE` / `PLACE_ABSTRACT_NOWHERE` / `PLACE_ONLINE`, `buildingFor` | how a class is held (§4.1) |
| `Gene`, `genes`, `movable`, `movableCount`, `allRoomIndices`, `isFacultyRoom`, `packSlot` / `unpack*` | genes and domains (§4.1, §4.3) |
| `lecBuckets` / `grpBuckets` / `roomBuckets` / `absBuckets`, `indexInsert`, `indexRemove`, `place` | the occupancy index (§4.2) |
| `clashesIn` | Eq. (2) — the form the live code calls |
| `dayLoadExceeds`, `placementAllowed` | the dynamic hard rules (§3.1) |
| `windowsIn`, `windowTotal`, `conflictTotal`, `journeyMinutes`, `unreachablePair`, `travelTotal`, `abstractOverflowTotal`, `mixedIn`, `mixedTotal` | the objective's aggregates (§1.2) |
| `bucketConf`, `bucketTrav`, `absBucketOver` | the same, one bucket at a time (§5.4) |
| `C`, `rebuildCounters`, `surrogate`, `hardNow` | the running counters and the cost the search descends (§5.4) |
| `touchedLec` / `touchedGrp` / `touchedRoom` / `touchedAbs`, `addUnique`, `collectTouched`, `accumulate` | which buckets one move disturbs (§5.4) |
| `tryMove`, `hasSlot`, `hasRoom`, `trySwap`, `tryTargetedSwap` | the neighbourhood and the acceptance test (§5.5, §5.6) |
| `hotList`, `hotStamp`, `refreshHot` | endgame min-conflicts focus (§5.7) |
| `measure`, `objectiveOf`, `hardOf` | the exact, reported objective (§1.2) |
| `ROOM_SAMPLE`, `ROOM_SCAN_FULL_BELOW`, `scanBest`, `windowCostAt` | the candidate scan (§5.3) |
| `construct`, `constructionFailures`, `pendingUnplaced` | construction (§5.2) |
| `perturb` | the kick (§5.8) |
| `Snapshot`, `snapshot`, `snapshotInto`, `restore`, `assignmentsFrom` | incumbent bookkeeping (§4.5) |
| `emit`, the `while` loop, `collectConflicts` | the top level (§5.1) and the report |
| `pendingUnplaced` | written by `construct`, read by `emit` — the «неможливо розмістити» figure |

`timetable-solver.worker.ts` is the message boundary: `SerializedProblem` (the three constraint
`Map`s plus `roomBuilding` and `buildingTravel`, all five flattened to entry arrays — the abstract
rooms are already an array and pass through untouched), `SolverRequest` (`solve` / `cancel`) and
`SolverResponse` (`progress` / `done` / `error`).

`faculty-timetable-list.ts` holds everything that talks to the outside: `buildProblem` (up to three
GraphQL requests — the faculty-scoped constraints, abstract rooms and buildings, the by-id extras
when a workload reaches outside the faculty, and the three aliased timetable slices — plus the
mapping into `SolverProblem`), `solverOptions` (which sets `timeLimitMs` and nothing else),
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

### 12.1 The benchmark harness

The most valuable test is not a unit test, and it now exists: `scripts/timetable-bench/`.

- `build.mjs` generates an instance **around a hidden feasible schedule**. It walks the week slot by
  slot and places classes into free resources, so a conflict is impossible by construction and the
  pass cannot fail. `emit.mjs` then derives every scheduling constraint *from* that schedule — a
  `NOT_BEFORE` at or below the earliest class actually held, an abstract room's capacity at its
  busiest slot — and writes out a `SolverProblem` plus the hidden schedule as a reference solution.
  **A perfect answer therefore provably exists**, and any residual hard violation is the algorithm's
  fault rather than an impossible instance. The self-test that must stay true: the hidden schedule
  itself validates as `hard = 0` at every size.
- `validate.mjs` re-scores a returned schedule independently — all nine Π terms and every hard filter
  — written from the schema semantics and **never calling into the solver**. A validator that shares
  code with what it validates agrees with it even where both are wrong.
- `run.mjs` loads a solver variant, runs it and scores it. `results/measurements.jsonl` holds the
  ~270 measurements the ablations produced (LAHC, the move-level search, random and targeted swaps,
  the hot list, the finite hard weight, the L sweep), and `results/solver-before-optimisation.ts` is
  the solver as it stood before the rewrite — so any number in §5 and §8 is re-derivable rather than
  remembered.
- `experiment.mjs` is the full study in one command: every size, 25 repetitions each, writing a
  JSONL of per-run detail plus a CSV of medians and dispersion. It is resumable, and it records
  time-to-feasibility live because that moment cannot be recovered from a finished schedule.
- `instances/` holds 50 archived instances (10 sizes × 5 seeds, 4.1 MB gzipped) so a published
  result stays tied to the exact bytes it came from. `materialise.mjs` regenerates them; the
  generator is deterministic, so `(n, seed)` always reproduces the same instance.
- Sizing follows Ukrainian HEI norms: groups ≈ n/15, lecturers ≈ n/9, rooms ≈ n/22, six working days
  × six 80-minute bells plus a separate спорткомплекс grid, with 4% external fixed entries and 15%
  unrestricted-room classes.

`scripts/timetable-bench/README.md` explains the methodology and the flags; `SOLVER-OPTIMISATION.md`
records what the study concluded, including the negative results.

The independence of the validator has already paid for itself twice, and in both directions. The
first comparison had the solver reporting `f = 0` against the validator's `f = 3625`, and it was the
**validator** that was wrong: it converted each gap to academic hours separately and *rounded*, so
`round(20/40) = 1` turned the ordinary inter-bell break into a window every time. Later, the
validator read directed travel times in bucket order rather than in time order, and invented a
feasibility wall at n = 800 that cost a whole measurement cycle to disprove. Chasing the first
disagreement is what produced the exact statement of the window definition in §1.2.

### 12.2 Cases worth pinning individually

- the "more specific wins" resolution of day-specific versus every-day rules, including the
  `UNAVAILABLE` exception (windows accumulate rather than override);
- `MAX_CLASSES_PER_DAY` counted per calendar week: a `WEEKLY` plus a `NUMERATOR` class under a cap
  of 2 is legal; three `WEEKLY` classes are not;
- a biweekly pair on opposite parities is *not* a conflict, while a weekly class over either of them
  *is*;
- an immovable external entry blocking a room, a lecturer and a group;
- a locked requirement appearing in no assignment at all;
- a requirement whose domain is empty being reported and, if it has a current placement, kept there;
- determinism: two runs with the same seed and the same move bound produce identical assignments;
- travel: a directed pair whose two directions differ, so that the journey actually made is the one
  charged; a room with no `building_id` and a building pair with no row, both of which must cost
  nothing; no journey figures at all, which must skip the pass and reproduce the pre-travel result
  exactly; and a pair of immovable classes in different buildings, which must not be counted;
- the roomless kinds: a class in an abstract room and an online class must each write a `NULL` room
  and still be *placed*, must take part in no room conflict, and must never be handed the
  unrestricted room fallback;
- a shared place over its capacity, counted per breaching instant, twice for a weekly class and once
  in the conflict list; and a group whose `students_count` is unset contributing 0;
- `university_commute_time_minutes` charged between an online class and an in-room one on the same
  day, in either order, for a lecturer as well as for a group.

---

## 13. Where to take it next

- **Tune the fleet size against real hardware.** §8a caps the portfolio at four workers and reduces
  it above 4 000 blocks, both on a memory argument reasoned from Node's heap figures rather than
  measured in a browser. The right cap on a 16-core machine with a large faculty is an open question
  and needs a profiler, not an estimate.
- **Something other than a decaying chain rate.** The obvious refinement — decay the rate instead of
  switching it off — was measured and is worse overall: it fixes n = 12 800 at five minutes
  (480 → 447) but surrenders the largest win, n = 3 200 at one minute falling from 80 back to the
  chainless 115. A mid-size run sits near convergence for most of its budget, so a decaying rate is
  near zero for most of it. Whatever closes that last regime is not a gentler version of the same
  idea.
- **A penalty for a class that is not scheduled at all.** Nothing in `f(σ)` counts a missing class,
  so the search has no reason to place one construction could not fit (§10). A tenth term, weighted
  above every hard one, would close that hole and cost one counter — and it is the only place where
  the current objective is silent about something the user can see.
- **Report `f(σ)` during the run, not the acceptance cost.** The modal's headline number is the
  incumbent's `hard · hardWeight + surrogate()` (§9). Recomputing the exact `f` on the ~8 progress
  messages a second costs what the Π table beside it already costs, so this is a small fix with a
  real payoff in comprehensibility — and it would let `result.history` be a single, plottable unit.
- **Building-aware construction.** `construct` orders by domain size and knows nothing about
  buildings, so it scatters a lecturer's day across корпуси and leaves the search to unpick it. When
  the search last hit a wall — n = 800, before the finite hard weight and the hot list — *every*
  residual hard violation was a travel one, with all lecturer, group and room conflicts already
  cleared. Travel violations are cheap to avoid and expensive to fix; preferring a room in the
  building an entity is already in that day is the obvious cheap avoidance.
- **Soft preferences with weights.** `lecturer_workload_candidates.desirability` already
  demonstrates the shape a weighted preference takes in this schema; the constraint tables carry no
  weight column, which is why every rule there is hard today.
- **Ordinary room capacity.** `rooms.capacity` and `academic_groups.students_count` are both stored,
  and the shared-place version of the constraint is already modelled as Π₆. For an ordinary room the
  rule is simpler — one class, so it is a filter on the room domain rather than an objective term —
  and it would also give `scanBest` a better room ordering than "first free one".
- **Minimal-change rescheduling.** A term penalising distance from the current timetable would make
  "перевизначити весь розклад" usable mid-semester, where the cost of moving a class is real.
- **Compaction as an explicit objective.** Windows measure gaps but not spread: a group with two
  classes on five days scores as well as one with ten classes on two. A "days used" term would be a
  small addition to the counters and is what deaneries usually ask for next.
- **Server-side generation.** Everything here is pure and portable; running it in the backend would
  let a whole university be scheduled at once, across faculties, rather than one faculty at a time
  around the others.

**Two things not to do**, both measured rather than argued. A **parallel portfolio** of independent
seeds: best-of-6 beat the median by 6% (§8), which does not repay six cores. And a **population** —
the article's memetic algorithm with crossover — is a much larger version of the same bet on
diversity between runs, and it would need one occupancy index per individual, multiplying the memory
by the population size. Neither is ruled out, but both should be measured against the 6% before
anything is built.
