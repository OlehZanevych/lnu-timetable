# Automatic generation of lecturer workloads

Reference for `src/app/workload-generator.ts` — the algorithm that decides **which lecturer teaches
what** for one department. It runs entirely in the browser, reads only plain objects, and returns a
plan; writing that plan is the caller's job.

- [1. What the problem actually is](#1-what-the-problem-actually-is)
- [2. Inputs](#2-inputs)
- [3. Constraints](#3-constraints)
- [4. The algorithm](#4-the-algorithm)
- [5. Individual work: distributing students](#5-individual-work-distributing-students)
- [6. Termination and complexity](#6-termination-and-complexity)
- [7. What is and isn't guaranteed](#7-what-is-and-isnt-guaranteed)
- [8. Worked example](#8-worked-example)
- [9. Testing](#9-testing)
- [10. Where to take it next](#10-where-to-take-it-next)

---

## 1. What the problem actually is

Each **working curriculum item** says how many lecturers should deliver it (`lecturer_count`) — one
for a lecture stream, often two for labs taught in parallel subgroups. Each of its
**lecturer workloads** therefore has some number of *slots* to fill, and a slot may only be filled
from that workload's own **candidate pool**, where every candidate carries a desirability from 1
(last resort) to 100 (ideal).

Every lecturer carries ceilings — annual hours, and counts of distinct courses by hour type and by
mandatory/elective — plus floors of the same shape.

> Assign lecturers to slots so as to maximise total desirability, subject to each lecturer's
> ceilings, while meeting as many floors as possible.

This is a **generalised assignment problem**. Without the side constraints it would be a bipartite
matching solvable exactly in polynomial time (Hungarian algorithm, or min-cost flow); *with* the
per-lecturer capacity and distinct-course constraints it is an integer program and NP-hard in
general. Two properties make it worse than a textbook GAP:

- **Course counts are set-valued, not additive.** A lecturer's second lab in a course they already
  teach costs nothing against `MAX_LAB_COURSES`. Feasibility therefore depends on *which* slots a
  lecturer already holds, not merely how many — the constraint is submodular rather than linear.
- **Floors cannot be satisfied by refusing work.** A ceiling is respected by declining; a floor is
  only met by *taking* work, which is why the search needs a repair phase rather than a filter.

The implementation does not pretend to solve this exactly. It is a **constructive heuristic
followed by local search**, chosen because a department is small (tens of slots), the result is
previewed and edited by a human before it is written, and a plan that is explainable beats a plan
that is optimal-but-opaque.

---

## 2. Inputs

The component flattens the loaded department tree into `GenInput`. Nothing else is read — no
network, no Angular, no globals.

```ts
interface GenInput {
  workloads: GenWorkload[];
  lecturers: GenLecturer[];
  defaultMaxHoursPerYear: number | null;   // global_properties
  mode: 'gaps' | 'all';
}
```

**`GenWorkload`** — one `lecturer_workloads` row, plus the context needed to score it:

| Field | Source | Used for |
|---|---|---|
| `lecturerCount` | `working_curriculum_items.lecturer_count` | how many slots this workload has |
| `assignedLecturerIds` | `lecturer_workload_lecturers` | the starting point in `gaps` mode |
| `candidates` | `lecturer_workload_candidates` (+ their `constraints`) | who may fill a slot, and how much we want them to |
| `hours` | `curriculum_item_hours.hours` | annual-hour accounting |
| `hourType` | `curriculum_item_hours.hour_type` | which course-count constraints apply |
| `courseId`, `courseType` | the **effective** course | distinct-course counting; mandatory/elective scoping |
| `teachingFormat` | `working_curriculum_items.teaching_format` | selects the slot algorithm or the student one |
| `studentIds`, `assignedStudents` | groups' students, `lecturer_workload_students` | individual work only |

*Effective course* matters: for an elective group, `working_curriculum_items.course_id` names the
chosen elective, and that — not the container course — is what counts toward the lecturer's
elective totals.

**`GenLecturer`** is an id, a display name and a flat `constraintType → value` map read straight
from `lecturer_workload_constraints`.

### Hours accounting

When several lecturers deliver one item, **each accrues the full hours** — the model is parallel
subgroups, not a shared stream. A 32-hour lab with `lecturer_count = 2` costs each of them 32 hours.
For individual work the cost is `hours × students supervised`.

This is the single most consequential modelling choice in the file. If a faculty treats
`lecturer_count` as *sharing* one stream, change `Load.add` and the individual-hours line at the end
of `distributeStudents`; nothing else depends on it.

---

## 3. Constraints

### Hard — ceilings, never violated

Checked by `Load.canTake(workload)` before any assignment. If no candidate passes, the slot is left
**unfilled and reported** rather than forced.

| Constraint | Rule |
|---|---|
| `MAX_HOURS_PER_YEAR` | `hours + w.hours ≤ limit`. Falls back to `default_max_hours_per_year`; if neither is set, unbounded. |
| `MAX_COURSES` | distinct courses with any taught hour type |
| `MAX_{LECTURE,PRACTICAL,LAB}_COURSES` | distinct courses with that hour type |
| `MAX_MANDATORY_*_COURSES` | as above, restricted to `courseType = MANDATORY` |
| `MAX_ELECTIVE_*_COURSES` | as above, restricted to `ELECTIVE` or `ELECTIVE_GROUP` |

Only `LECTURE`, `PRACTICAL` and `LAB` carry course-count constraints. `CONSULTATION` and
`ASSESSMENT` consume hours but count toward no course total; `INDEPENDENT_WORK` never produces a
workload at all.

Counting is **set-based**. `Load` keeps `Set<courseId>` per (hour type × scope), so a course already
present costs nothing to add again — and `Load.remove` only drops a course from a set once no
*other* held workload still puts it there. That bookkeeping is what makes moves and swaps safe to
undo during local search.

### Soft — floors, reported when unmet

`MIN_HOURS_PER_YEAR` and the `MIN_*_COURSES` family. These drive `Load.deficit()`, the quantity the
repair phase minimises:

```
deficit = Σ max(0, MIN_HOURS_PER_YEAR − hours)
        + Σ max(0, MIN_*_COURSES − distinct count) × 10
```

The `× 10` makes one missing course outweigh ten missing hours — without it, a repair pass would
happily shuffle hours around while leaving a lecturer short of a required discipline, because hours
move in units of 20–40 and course counts in units of 1.

---

## 4. The algorithm

### Phase 0 — seed

`INDIVIDUALLY` workloads are split off (§5). For the rest:

- **`gaps` mode** — existing assignments are replayed into each lecturer's `Load` so they consume
  capacity, and are recorded in a `locked` set. A locked pair is untouchable: phases 2 and 3 may not
  move it however much desirability a swap would buy. "Only fill what's missing" is the mode's whole
  promise, and an unlocked improvement pass silently broke it (this was a real bug, caught by the
  test suite).
- **`all` mode** — every load starts empty and nothing is locked.

A lecturer already assigned but *not* in this department (possible on a combined item) is kept in
the output but not tracked for capacity: we have no constraint data for them and no right to move
them.

Slots are then materialised: `max(0, lecturerCount − alreadyChosen)` per workload.

### Phase 1 — most-constrained-first greedy

```
while slots remain:
    re-evaluate feasible candidates for every remaining slot
    take the slot with the fewest feasible candidates
    if none are feasible: report 'unfilled', continue
    assign the candidate with:
        1. highest desirability
        2. then lowest fill ratio (hours ÷ ceiling)     ← spreads the work
        3. then lowest lecturer id                      ← determinism
```

Two decisions worth naming:

**Why fewest-options-first.** This is the *minimum remaining values* heuristic from constraint
satisfaction. A slot with one viable lecturer must claim them before a slot with ten takes them for
a marginal desirability gain. Filling in workload order instead measurably strands slots that only
one person could have covered.

**Why re-evaluate every round.** Feasibility is not static: each assignment consumes hours and may
close a course-count ceiling, so a slot that had four options can drop to one. Sorting once up front
would use stale counts. This is what makes the phase quadratic (§6) — a deliberate trade, since the
input is department-sized.

The fill-ratio tie-break matters more than it looks. With it, two equally desirable candidates get
comparable loads; without it, whoever sorts first absorbs work until their ceiling closes, and the
later slots they could have covered go unfilled.

### Phase 2 — repair

Greedy maximises desirability and is blind to floors. Repair walks assignments looking for a move
that reduces the **total** deficit: take a slot from a lecturer who holds it, give it to another of
that workload's candidates, keep it only if `Σ deficit` strictly decreased and the receiver could
legally take it.

Each accepted move strictly decreases a non-negative integer, so the phase terminates; a 50-pass cap
guards against a pathological input regardless.

### Phase 3 — improvement

Hill-climbing on total desirability. For each held slot, try replacing the holder with a *strictly
more desirable* candidate; keep the swap if the receiver can take it and the total deficit does not
worsen. Repeats until a pass changes nothing, capped at 30 passes.

Only **single moves** are attempted — never a pairwise exchange between two slots. A swap can escape
a local optimum that no single move can (A holds slot 1 and wants slot 2, B holds slot 2 and wants
slot 1), and adding it is the most obvious available improvement. It is left out because the
implementation stays simple and the observed gap is small at department scale; §10 says what it
would take.

---

## 5. Individual work: distributing students

`INDIVIDUALLY` workloads (coursework consultations and the like) never go through the slot machinery
at all. The unit of assignment is a **student**, and the rule is the one the candidate limits were
designed to express:

```
Round 1 — desired counts, best candidates first:
    for each candidate, by descending desirability:
        give them students until they hold min(MIN_STUDENTS, MAX_STUDENTS)

Round 2 — the remainder:
    while students remain:
        among candidates below MAX_STUDENTS, take the one with
            1. highest desirability
            2. then fewest students above their desired count
            3. then lowest id
        give them one student
    if nobody has headroom: report the leftover and stop
```

`MIN_STUDENTS` is a *target*, not a guarantee — it is clamped by that candidate's own
`MAX_STUDENTS`, and there may simply not be enough students to go round.

Round 2 hands out one student at a time rather than filling each candidate to the brim, but
desirability leads the ordering, so a candidate scored 90 takes every surplus student before one
scored 10 gets any. Load only separates candidates of **equal** desirability — which is what makes
two equally-rated supervisors end up with an even split instead of one taking everything.

In `gaps` mode, pairings that already exist are kept and only the unassigned students are placed.
Supervision hours (`hours × students`) are added to each lecturer's `Load`, so individual work
competes for the same annual ceiling as everything else.

---

## 6. Termination and complexity

Let **S** = slots to fill, **C** = candidates per workload, **W** = workloads, **L** = lecturers.

| Phase | Bound | Why |
|---|---|---|
| 1 — greedy | `O(S² · C · log S)` | S iterations; each re-sorts ≤S slots, and each comparison recomputes feasibility over C candidates |
| 2 — repair | `O(50 · W · C · L)` | capped passes; a pass scans assignments and recomputes total deficit |
| 3 — improve | `O(30 · W · C · L)` | same shape |
| 5 — students | `O(N log N + N · C)` | N students, one placement each |

Termination is unconditional: phase 1 removes one slot per iteration; phase 2 strictly decreases a
non-negative integer; phase 3 strictly increases desirability. All three additionally carry
iteration caps, so no input can spin.

**Measured**, on a synthetic run far larger than any real department — 200 workloads, 60 lecturers,
400 slots, 8 candidates each: **≈600 ms**, single-threaded, in the browser. A real department is
tens of slots, so the quadratic term is comfortable. It would not be at faculty or university scale;
§10 covers that.

---

## 7. What is and isn't guaranteed

**Guaranteed**

- No ceiling is ever violated — including the fallback annual maximum.
- No lecturer is assigned to the same workload twice.
- In `gaps` mode, an assignment that existed before the run still exists after it, unchanged.
- Deterministic: identical input yields byte-identical output (every tie-break bottoms out in an id
  comparison).
- Terminates on every input.
- Nothing is written. The result is a plan; the user previews it and presses Застосувати.

**Not guaranteed**

- **Not optimal.** Total desirability is a good local optimum under single moves, not a global one.
- **Not maximal coverage.** Filling the most slots and maximising desirability can conflict; the
  MRV ordering favours coverage but does not guarantee it. An unfilled slot is always reported.
- **Floors may go unmet** — they are objectives, not constraints. Reported per lecturer with the
  exact shortfall (`годин на рік: 120 з 300`).
- **No fairness criterion.** The fill-ratio tie-break spreads work among equally desirable
  candidates, but nothing bounds the spread between lecturers of differing desirability.
- **No cross-department view.** Input is one department. A lecturer teaching for two departments has
  their annual hours counted separately in each, so both can independently believe they are within
  the ceiling.

---

## 8. Worked example

One department. `default_max_hours_per_year = 600`.

| Workload | Course | Hours | Type | Slots | Candidates (desirability) |
|---|---|---|---|---|---|
| W1 | Algorithms | 32 | LECTURE | 1 | Petrenko 90, Kovalchuk 60 |
| W2 | Algorithms | 32 | LAB | 2 | Petrenko 80, Kovalchuk 70, Shevchuk 40 |
| W3 | Databases | 30 | LECTURE | 1 | Petrenko 85 |

Constraints: Petrenko `MAX_LECTURE_COURSES = 1`; Shevchuk `MIN_HOURS_PER_YEAR = 30`.

**Phase 1.** Feasible counts: W3 has 1 candidate, W1 has 2, W2 has 3 — so **W3 goes first** and
Petrenko takes Databases/lecture (85). That closes their `MAX_LECTURE_COURSES`.

W1 next: Petrenko is now infeasible (a second distinct lecture course), so **Kovalchuk** takes it
(60). Had W1 been processed first, Petrenko would have taken it at 90 and W3 — with only Petrenko as
a candidate — would have gone unfilled. *This is the MRV heuristic paying for itself.*

W2's two slots: Petrenko 80 (labs, a course they already have — no lecture constraint applies), then
Kovalchuk 70.

Running total: 85 + 60 + 80 + 70 = **295**. Shevchuk holds nothing; deficit 30 hours.

**Phase 2.** Shevchuk is below their floor. Moving W2's second slot from Kovalchuk to Shevchuk drops
the deficit from 30 to 0, and Shevchuk can take it — accepted. Desirability falls to 265, and the
trade is deliberate: floors before desirability.

**Phase 3.** No single move raises desirability without reopening the deficit. Fixed point.

**Result** — 4 of 4 slots filled, 265 desirability, no unmet minimums, no ceiling breached.

---

## 9. Testing

`workload-generator.ts` is framework-free precisely so it can be tested as a pure function. The
suite compiles it with `tsc --strict` and exercises it against plain objects — 45 cases across two
files covering:

- desirability preference, and both `gaps` / `all` modes;
- every ceiling family, including the global fallback and set-based course counting (two labs in one
  course cost one course; a second course does not);
- mandatory/elective scoping;
- MRV ordering (the §8 scenario);
- repair satisfying a floor by moving work;
- reporting of unfilled slots, empty pools and unmet minimums;
- the full student-distribution rule — desired counts first, ceilings, even split among equals,
  surplus by desirability, leftovers reported;
- determinism and termination at 200 workloads / 60 lecturers / 400 slots.

Two real defects were found this way and are worth recording, since both produced *plausible* output:

1. In `gaps` mode the improvement pass moved pre-existing assignments — the mode's core promise,
   violated silently. Fixed by the `locked` set.
2. Round 2 of the student distribution spread the surplus evenly instead of by desirability,
   contradicting the specification. Fixed by leading the sort with desirability.

A third came from reading the schema rather than testing: `durationHours` is non-null in
`LecturerWorkloadInputPayload`, so applying a plan had to echo it or every mutation would have been
rejected before reaching the resolver.

---

## 10. Where to take it next

Roughly in order of value per unit of effort:

1. **Pairwise swaps in phase 3.** The cheapest real gain: for two slots held by A and B, exchange
   them if both remain feasible and the total rises. Escapes local optima single moves cannot.
2. **Min-cost flow for the unconstrained core.** With course-count constraints ignored, the problem
   is exactly min-cost bipartite matching and solvable optimally in `O(V²E)`. Solving that first and
   repairing only the course-count violations would give a much stronger starting point than greedy.
3. **Lagrangian relaxation of the floors.** Rather than the ad-hoc `× 10` weight, price each floor
   with a multiplier and adjust it between rounds — makes the desirability-versus-floors trade
   explicit and tunable instead of hard-coded.
4. **Simulated annealing / tabu search** over the same move set, for when the instance grows past a
   single department. The `Load` bookkeeping already supports cheap incremental add/remove, which is
   the expensive part of such a search.
5. **Cross-department capacity.** Load a lecturer's assignments across *all* departments before
   generating, so their annual ceiling is counted once rather than once per department.
6. **Timetable feasibility.** Nothing here knows about days or rooms; a lecturer can be given two
   workloads that will later prove unschedulable together. Coupling generation with
   `FacultyTimetableList` would close that gap — and is the natural place for the memetic algorithm
   the domain model was drawn from.
