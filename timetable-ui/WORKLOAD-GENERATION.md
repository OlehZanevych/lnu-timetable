# Automatic generation of lecturer workloads

Reference for `src/app/workload-generator.ts` — the algorithm that decides **which lecturer teaches
what** for one department. It runs entirely in the browser, reads only plain objects, and returns a
plan; writing that plan is the caller's job.

- [1. What the problem actually is](#1-what-the-problem-actually-is)
- [2. Inputs and outputs](#2-inputs-and-outputs)
- [3. Constraints](#3-constraints)
- [4. The algorithm](#4-the-algorithm)
- [5. Individual work: distributing students](#5-individual-work-distributing-students)
- [6. Termination and complexity](#6-termination-and-complexity)
- [7. Implementation map](#7-implementation-map)
- [8. What is and isn't guaranteed](#8-what-is-and-isnt-guaranteed)
- [9. Worked example](#9-worked-example)
- [10. How it is verified](#10-how-it-is-verified)
- [11. Where to take it next](#11-where-to-take-it-next)

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

### Stated formally

Let **K** be the set of slots (one per lecturer-place on a workload), **L** the lecturers, and
`C(k) ⊆ L` the candidate pool of slot *k*, with desirability `d(k, ℓ)` for ℓ ∈ C(k). Write `w(k)` for
the academic hours of slot *k*, `crs(k)` for its course and `τ(k)` for its hour type. The decision
variable is

  `x(k, ℓ) = 1` if slot *k* is given to lecturer ℓ, else 0.

  **maximise** Σ over k, ℓ of `d(k, ℓ) · x(k, ℓ)`

subject to

| | |
|---|---|
| **(1) one lecturer per slot** | `Σ over ℓ of x(k, ℓ) ≤ 1` for every *k* — `≤` and not `=` because an unfillable slot is reported, not forced |
| **(2) candidate pools** | `x(k, ℓ) = 0` whenever ℓ ∉ C(k) |
| **(3) no lecturer twice on one workload** | `Σ over k ∈ slots(W) of x(k, ℓ) ≤ 1` for every workload *W* |
| **(4) annual hours** | `Σ over k of w(k) · x(k, ℓ) ≤ H(ℓ)` for every ℓ |
| **(5) distinct courses** | `\|{ crs(k) : x(k, ℓ) = 1, τ(k) ∈ T }\| ≤ N(ℓ, T, θ)` for each family *T* of hour types and each scope θ ∈ {all, mandatory, elective} |
| **(6) floors** | the same expressions with `≥ n(ℓ, …)`, **relaxed** — violations are penalised and reported, not forbidden |

Constraint (5) is what takes this out of textbook territory. Counting *distinct* courses makes the
left-hand side a cardinality-of-image rather than a linear sum, so it is not an ILP constraint in
the usual sense without introducing an auxiliary binary `y(ℓ, c) ≥ x(k, ℓ)` for every course *c* and
every slot *k* teaching it — which is the standard linearisation, and which multiplies the model
size by the number of courses.

Drop (5) and (6) and what remains — (1)–(4) — is a **transportation problem**: slots consuming a
divisible resource (hours) from capacitated suppliers, solvable optimally by min-cost flow. That is
the relaxation §11 proposes as a stronger starting point than greedy, and it is also the honest way
to compute a tight upper bound on what any method could achieve.

### Why a heuristic

The implementation does not pretend to solve this exactly. It is a **constructive heuristic
followed by local search**, chosen because a department is small (tens to a few thousand slots), the
result is previewed and edited by a human before it is written, and a plan that is explainable beats
a plan that is optimal-but-opaque — a head of department who cannot see *why* Petrenko got the
lecture will not sign it.

The shape is standard for the generalised assignment problem: a greedy construction, then shift and
swap neighbourhoods, which Yagiura, Ibaraki and Glover treat as ejection chains of length one and
two. The slot-ordering rule is borrowed from constraint programming rather than from operations
research — **minimum remaining values**, take the most constrained variable first — because the
binding difficulty here is feasibility (who *can* teach this) more often than cost.

---

## 2. Inputs and outputs

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

### Outputs

`GenResult` is a **plan, not a write**. Nothing reaches the database until the user presses
«Застосувати», and the caller is responsible for turning the plan into mutations.

```ts
interface GenResult {
  assignments: GenAssignment[];   // one per workload, whether or not it changed
  issues: GenIssue[];             // everything the run could not do, or did reluctantly
  totalDesirability: number;      // summed over the slots *this run* filled
  filledSlots: number;
  requestedSlots: number;
  load: { lecturerId, name, hours, courses }[];   // per-lecturer result, for the preview table
  telemetry: GenTelemetry;        // §7 — timings and operation counts; the UI ignores this
}
```

**`GenAssignment`** carries `lecturerIds` (the full result for that workload) *and*
`addedLecturerIds` (only what this run added), because `gaps` mode needs both: the first to display,
the second to write. `changed` says whether the set differs from what was there before, which is what
keeps the preview to the rows that actually move.

**`GenIssue`** is the honest half of the output, and worth enumerating because a caller that renders
only the first two kinds will hide real problems:

| `kind` | Means | Severity |
|---|---|---|
| `no-candidates` | a workload needing slots has an empty candidate pool — nobody has been marked as able to teach it | blocking: nothing can fill it |
| `unfilled` | every candidate would break a ceiling. Reported **once per slot** that will go unfilled | blocking |
| `over-ceiling` | individual supervision was distributed past someone's annual ceiling because no candidate had room left (§5). The only place any ceiling gives | breach, must be resolved |
| `unmet-minimum` | a lecturer finished below a floor, with the exact shortfall (`годин на рік: 120 з 300`) | advisory: floors are objectives |
| `no-students` | an `INDIVIDUALLY` position whose groups contain no students — nothing to distribute | advisory, usually a data gap |

The first three are errors in the UI, the last two warnings. Note that several unfilled slots of one
workload produce several issues with **identical text** — a list rendering them must not key on the
message.

### Hours accounting

When several lecturers deliver one item, **each accrues the full hours** — the model is parallel
subgroups, not a shared stream. A 32-hour lab with `lecturer_count = 2` costs each of them 32 hours.
For individual work the cost is `hours × students supervised`.

This is the single most consequential modelling choice in the file. If a faculty treats
`lecturer_count` as *sharing* one stream, change `Load.add` and the individual-hours line at the end
of `distributeStudents`; nothing else depends on it.

---

## 3. Constraints

### Hard — ceilings, never violated by the slot search

Checked by `Load.canTake(workload)` before any assignment. If no candidate passes, the slot is left
**unfilled and reported** rather than forced.

The qualifier is exact: individual supervision (§5) can exceed `MAX_HOURS_PER_YEAR` as a last resort,
because a student cannot be left without a supervisor. That is the only place any ceiling gives, it
happens after two other tiers have been exhausted, and it is reported when it does.

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

### Phase 0 — seed, then individual work

`INDIVIDUALLY` workloads are split off and **placed before the slot search** (§5) — a change from
earlier versions, and the reason is in §5. For the rest:

- **`gaps` mode** — existing assignments are replayed into each lecturer's `Load` so they consume
  capacity, and are recorded in a `locked` set. A locked pair is untouchable: phases 2 and 3 may not
  move it however much desirability a swap would buy. "Only fill what's missing" is the mode's whole
  promise, and an unlocked improvement pass silently broke it — a real defect, and one that produced
  perfectly plausible output (§10).

  **Supervision a lecturer already holds is charged here too**, and for a long time it was not. The
  seed loop walks the *slot* positions only, so a pre-existing student pairing arrived carrying no
  hours: every later decision saw an emptier lecturer than the independent validator did, and a plan
  could pass the generator's own ceiling test while the validator — which counts every supervised
  student — found the lecturer over the statutory limit. Each pairing on the position's current
  roster now adds `hours` to its supervisor's `Load` before anything else runs.
- **`all` mode** — every load starts empty and nothing is locked.

A lecturer already assigned but *not* in this department (possible on a combined item) is kept in
the output but not tracked for capacity: we have no constraint data for them and no right to move
them.

Slots are then materialised: `max(0, lecturerCount − alreadyChosen)` per workload.

### Phase 1 — most-constrained-first greedy

Two things make this cheap enough to be linear rather than quadratic, and they are worth stating
before the pseudocode because the pseudocode reads as if it re-derives everything each round.

**Feasibility is maintained, not recomputed.** Every workload keeps the set of lecturers who could
take it *right now*. Assigning a lecturer can only change the workloads that lecturer is a candidate
for, so one assignment costs one ceiling check per such workload — not a scan of every slot left to
place. And during this phase feasibility is **monotone**: loads only grow, so a ceiling once crossed
stays crossed and a lecturer who has dropped out of a workload's set can never re-enter it. Testing
them again is provably wasted work, so it is skipped.

**The next slot comes from a lazy heap** keyed on that maintained count. A workload whose count
changes gets a fresh entry pushed and a version counter bumped; entries that surface with a stale
version are discarded. Selecting the most constrained slot is therefore `O(log S)` rather than a
re-sort of everything remaining.

Ties in the heap break on **hours, smallest first**, then on input order. Smallest-first is not
arbitrary: when the department is near capacity, placing the cheap positions first fits more of them
in, and measurably so — on the deliberately over-subscribed instances it is worth ten points of fill
rate against largest-first and four against no size rule at all.

```
feasible[w] ← { candidates of w that can take it }        for every workload w
heap        ← one entry per workload, keyed on |feasible[w]|

while heap not empty:
    pop the workload with
        1. fewest feasible candidates                   ← most constrained first
        2. then fewest hours                            ← fits more slots under a ceiling
        3. then input order                             ← determinism
    if its entry is stale, or it needs no more slots:  discard and continue
    if feasible[w] is empty:
        report 'unfilled' once per slot still needed, close the workload, continue
    assign the candidate with
        1. highest desirability
        2. then lowest fill ratio (hours ÷ ceiling)     ← spreads the work
        3. then lowest lecturer id                      ← determinism
    revalidate(that lecturer):                          ← only they can have changed
        for each workload they are a candidate for and that still needs slots:
            if they were feasible and no longer are: drop them, bump version, re-push
    if the workload still needs slots: bump version, re-push
```

Two details in that loop repay a second look. Feasibility is **never recomputed for a workload that
was not affected** — only the lecturer just assigned can have changed anything, and only for the
workloads they are a candidate for. And when a workload's pool empties, every slot it still needs is
reported at once and the workload is closed for good, which is sound because feasibility only shrinks
while this phase runs (§7).

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

Greedy maximises desirability and is blind to floors. Repair looks for a move that reduces the
**total** deficit: take a slot from a lecturer who holds it, give it to another of that workload's
candidates, keep it only if `Σ deficit` strictly decreased and the receiver could legally take it.

The search is driven **from the lecturers who are short**, not from the workloads. A floor can only
be closed by giving work to someone who lacks it, so the only moves worth evaluating are those whose
receiver is currently below a floor — a worklist of such lecturers, re-entered whenever a move leaves
them still short. Sweeping every workload against every candidate, which is what this used to do,
spent nearly all its probes on positions that could not have helped anyone.

Receivers are walked **best-first by desirability**, which makes the accepted move the cheapest one
that helps: meeting a floor costs desirability by construction, and `cost = donor − receiver` only
grows along that list, so the first receiver that works is already the least expensive. (Evaluating
every receiver to pick a "best" move provably cannot beat this. It was implemented, measured, and
reverted.)

The donor is deliberately *not* filtered on having slack of their own. Taking from someone who is
also below a floor usually just moves the problem, but occasionally it is the only move that helps
overall, and the total-deficit test is the honest arbiter. Filtering such donors out lost a third of
all repairs.

The total deficit is a **running number**, updated for the two lecturers a move touches rather than
recomputed by walking the department. Each accepted move strictly decreases a non-negative integer,
so the phase terminates; a move cap of `4 × workloads` guards a pathological input regardless.

### Phase 3 — improvement

Hill-climbing on total desirability over two neighbourhoods, keeping every ceiling satisfied and
never deepening the floor deficit:

- **shift** — replace one holder of a slot with a more desirable candidate. Every strictly better
  candidate is tried, best first, not merely the best one: the best may be out of headroom while the
  second-best is not, and settling for the incumbent in that case leaves desirability on the table.
- **swap** — exchange the holders of two slots that each prefer the other's lecturer. A shift alone
  cannot reach an arrangement where A should hold B's slot and B should hold A's, because either
  single move on its own is infeasible or non-improving.

Swap is only attempted where a shift failed: if a strictly better candidate could simply be taken,
the shift already took them. The GAP literature treats both as ejection chains — of length one and
two — and is consistent that shift ∪ swap is the standard neighbourhood and the cheapest real gain
over shift alone.

Like repair, this is driven by a **worklist** rather than repeated sweeps. A workload is worth
re-examining only when a lecturer it could use has changed state, so an accepted move re-enqueues
exactly the workloads the two affected lecturers are candidates for. Capped at `4 × workloads` moves.

---

## 5. Individual work: distributing students

`INDIVIDUALLY` workloads (coursework consultations and the like) never go through the slot machinery
at all. The unit of assignment is a **student**, and the rule is the one the candidate limits were
designed to express.

**They are placed first, before any slot.** This is the same most-constrained-first instinct the
greedy applies to slots, one level up. Individual supervision is the least flexible work in the
problem — every student must have a supervisor, the eligible pool is one course's candidates, and the
cost is `hours × students`, which on a group of sixty is a third of somebody's year. Booking it last,
as this used to, meant the slot search had already spent the headroom of exactly the people who then
had to absorb it, and the annual ceiling was blown as a matter of routine: across the 48 benchmark
instances the implementation this one replaced leaves **230 842 academic hours** above ст. 56's
ceiling on **2 219** lecturers, every one of them attributed to individual supervision
(`ceilingViolationsByIndividual` in `results/metrics.base.csv`) and none of it reported. The current
implementation leaves **120 hours** on **4** lecturers, and the attribution has moved entirely:
`ceilingViolationsBySearch` and `ceilingViolationsByIndividual` are both **0**, and all four sit in
`ceilingViolationsPreExisting` — inherited from three `gaps`-mode seed states that were already
unlawful before the run began, on instances where no decision the generator is entitled to make can
remove them.

Going first must not mean taking everything, though, or the collision simply reverses — a lecturer
filled to their ceiling with supervision has nothing left for the classes only they can teach. So
each lecturer carries an **individual-work budget**: their annual ceiling split between the two kinds
of work in proportion to the demand they actually face for each, where demand is what they would
receive if every position they are a candidate for were shared evenly among its candidates.

The budget is a preference, not a wall, and the ceiling itself is a strong preference rather than a
veto — a student without a supervisor is not an option. Candidates are taken in three tiers: within
budget; failing that, merely under the ceiling; failing that, the ceiling gives, the overrun goes
where there is most room left so it lands as thinly as it can, and an issue names the position.

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
competes for the same annual ceiling as everything else — and, now that it is placed first, the slot
search sees that competition instead of discovering it too late.

### The repair pass, and what it may not touch

`distributeStudents` places each position greedily and in isolation: it sees the positions already
booked, never the ones still to come. That is enough for most plans but not all — an early position
can spend headroom a later one then needs, and a lawful roster still exists that the greedy pass did
not find. `repairSupervisionCeilings` then moves students, one at a time, off any supervisor who
finished over the ceiling and onto a candidate of the *same* position who is still under it
afterwards. The total overrun therefore falls strictly and no new violation is ever created; where
no such move exists the overrun is inherent to the instance and the pass leaves it. Donors already at
their desired student count give a student up first, so repairing a ceiling does not deepen a floor
shortfall while a cheaper move remains, and every choice is totally ordered, so the result is
deterministic. `supervisionRepairMoves` counts what it did, and a run that moved anybody reports it
as an `over-ceiling` issue rather than adjusting the roster silently.

**In `gaps` mode the pass may only move supervisions this run created.** A student already paired
with a supervisor is settled work, and re-pairing a diploma student with somebody else part-way
through a year is not a scheduling detail. Without that restriction the pass drove the reported
overrun to zero by quietly rewriting the seed — a lawful-*looking* plan the department never asked
for. The locked pairings are collected before the pass runs and it skips them, which gives up the
zero and returns the inherited hours instead: a worse headline and a correct one.

**This trade is worth naming.** Respecting the ceiling means some class positions can no longer be
filled by anyone: on the benchmark, 96.2 % of slots filled becomes 92.6 %. Those positions are not
lost, they are *reported* — the department is being told that the work it has planned cannot be
covered by the staff it has within the hours the law allows. The previous behaviour filled them by
quietly putting people over 600 hours. An unfilled position is a visible, actionable gap; an
over-assigned supervisor is an invisible legal breach.

---

## 6. Termination and complexity

Let **S** = slots to fill, **W** = workloads, **L** = lecturers, **E** = candidate edges (the sum of
every workload's candidate-list length), and **d = E/L** the average number of workloads one lecturer
is a candidate for.

| Phase | Bound | Why |
|---|---|---|
| 1 — greedy | `O(S · d · log S)` | S placements; each re-tests the lecturer just used against the `d` workloads they are a candidate for, and pushes at most that many heap entries |
| 2 — repair | `O(M · d · k)` | M accepted moves, capped at `4W`; each visit walks one short lecturer's `d` workloads and their `k ≈ 1` holders |
| 3 — improve | `O(M · (C + h·C))` | same worklist shape; `h` is how many slots a lecturer holds, which bounds the swap partner search |
| 5 — students | `O(N log N + N · C)` | N students, one placement each |

Termination is unconditional: phase 1 removes one slot per iteration; phase 2 strictly decreases a
non-negative integer; phase 3 strictly increases desirability. All three carry move caps besides, so
no input can spin.

The `log S` and the `d` are what matter. Nothing in any phase is proportional to *the size of the
problem that is left* — only to the neighbourhood of the lecturer just touched — and that is the
difference between this and the version it replaced, which re-sorted every remaining slot on every
iteration and recomputed each slot's feasibility from scratch inside the comparator.

### Measured

48 instances from `scripts/workload-bench` — eight scenarios × six department sizes (10 to 320
lecturers, 53 to 8 316 slots), each an independently checked plan. Before and after, on identical
inputs:

| | before | after |
|---|---:|---:|
| empirical growth, time ∝ Sᵅ | α ≈ **2.0** | α ≈ **1.0** |
| ceiling overrun (hours above ст. 56's 600) | 230 842 | **120** |
| lecturers finishing over the ceiling | 2 219 | **4** |
| …of those, caused by this run | 2 219 | **0** |
| unmet floor shortfall | 13 382 | **5 061** |
| hours Gini (0 = every lecturer equal) | 0.177 | **0.117** |
| desirability per filled slot | 84.04 | 83.54 |
| slots filled | 96.2 % | 92.6 % |
| ceiling breaches by the slot search | 0 | 0 |
| structural errors | 0 | 0 |

**The wall-clock columns of those two files must not be divided into each other.** `metrics.csv` and
`metrics.base.csv` were measured on different machines — a two-core x86-64 container and a four-core
arm64 one — so their time ratio confounds the two implementations with the two hosts, and the
"550× overall" this section used to quote was a cross-hardware number rather than a speed-up.
Nothing recorded in those files repairs that, which is why every performance claim here is an
operation count or a fitted exponent. `same-machine.mjs` supplies the missing wall clock by running
both implementations in one process and recording the host beside its results; on that host the
median ratio is 118× and it rises with department size, which is the exponent showing up in seconds.

Growth against both lecturer count and slot count fits a power law with α ≈ 1.0 per phase. Quote the
exponent **per phase** rather than for the total: once the slot search stops dominating the run, the
total is a mixture of two differently-scaling costs and no longer a power law at all, which is
visible as the total's fit quality falling to 0.947 while the per-phase fits stay clean.

Two rows deserve reading together. Desirability *per filled slot* moved by −0.9 %, so the search is
not choosing worse lecturers. The 3.6 points of fill it gave up are entirely the positions it now
refuses to assign because doing so would put someone over the statutory ceiling — every instance
where fill dropped by more than a point paid for that drop with hundreds to tens of thousands of
hours of overload in the old behaviour. On `oversubscribed-10`: 16.4 points of fill, against 1 772
hours of illegal load. Those positions are reported, not lost — and `iplex.py` shows the trade is not
forced, since a lawful arrangement covers some of them that this search does not find.

The Gini row is the quietest and possibly the most useful in practice: the same work, spread
substantially more evenly across the department.

The operation counts in `results/metrics.csv` are machine-independent — identical on any CPU for the
same input — which is what makes them quotable in a way milliseconds are not. `scripts/workload-bench/README.md`
documents the instances, the metrics and how to reproduce all of it.

---

## 7. Implementation map

§4 says what the search decides; this says where it lives and what holds it together. The file is
one module, no imports, ~1 275 lines, and every structure below exists because a measurement said it
had to — `scripts/workload-bench/README.md` has the numbers.

### The state

| Structure | Type | Holds |
|---|---|---|
| `loads` | `Map<lecturerId, Load>` | one running load per lecturer; the only mutable model of capacity |
| `chosen[i]` / `chosenSet[i]` | `string[]` / `Set<string>` | who is on workload `i`, in order and for O(1) membership |
| `candidateOf[i]` | `Map<lecturerId, GenCandidate>` | that workload's candidates by id — replaces a linear `.find` in three hot loops |
| `ranked[i]` | `GenCandidate[]` | the same candidates, desirability-descending, sorted once at setup |
| `feasible[i]` | `Set<string>` | who could take workload `i` **right now** — maintained, never recomputed |
| `candidateWorkloads` | `Map<lecturerId, number[]>` | the inverse index: which workloads one lecturer affects. The invalidation set |
| `needed[i]` / `version[i]` | `Int32Array` | slots still to fill, and a counter that invalidates stale heap entries |
| `held` | `Map<lecturerId, GenWorkload[]>` | what each lecturer currently holds |
| `deficitOf` + `totalDeficit` | `Map` + `number` | per-lecturer floor shortfall and its running sum |
| `shortOfFloor` | `Set<string>` | lecturers below a floor — the repair worklist's seed |
| `lockedSupervision` | `Set<"workloadId\0studentId">` | `gaps` mode: pairings that existed before the run, which the supervision repair may not move |

One constant is worth knowing about because a deployment could reasonably want to change it.
`COURSE_DEFICIT_WEIGHT` (ω) is the exchange rate inside `Load.deficit()` between the two floor
shortfalls: one unit per hour short, ω per *course* short, ω = 10. Hours and courses are different
units and any single objective over both has to price one in the other, so this is a policy choice
rather than a derived constant. It is overridable through `WL_COURSE_DEFICIT_WEIGHT` for
`scripts/workload-bench/omega-sweep.mjs`, which measures what the whole instance family does as it
varies; the deployed configuration never sets it, and the browser build has no `process.env` to read.

### `class Load` — one lecturer's capacity

The innermost object in the search: `canTake` is called on the order of `S · E/L` times per run, so
everything it touches is arranged for it.

- **Constraint limits are resolved once**, in the constructor, into scalar fields and three-element
  arrays indexed by hour type. The original looked each limit up by building a template-literal key
  (`` `MAX_${t}_COURSES` ``) inside `canTake` — a string allocation and a hash lookup per check.
- **Course membership is reference-counted**, not a `Set`. "Distinct courses" is a set question, and
  a lecturer may hold three labs of one course; removing one must not remove the course. The old
  code answered that by scanning everything else the lecturer held (`others.some(...)`), which the
  repair and improvement passes paid for on every probe. A count per `(hourType, courseId)` plus a
  maintained *size* answers it in O(1) — and the size is all any constraint actually reads.
- **`hasAnyFloor`** short-circuits `deficit()` for the common case of a lecturer with no minimums.

### `class SlotHeap` — most-constrained-first, lazily

A binary min-heap of `{workload, key, bulk, order, version}`, ordered by feasible-candidate count,
then hours ascending, then input order. It is **lazy**: nothing is ever removed or re-keyed. When a
workload's count changes, its version is bumped and a fresh entry pushed; entries that surface with
a stale version are discarded on pop. That trades a small amount of memory for never having to find
an element inside the heap, which is the operation a decrease-key implementation needs an index for.

### The invariant that makes it fast

> While the greedy runs, a lecturer who is not in `feasible[i]` can never re-enter it.

Loads only grow during phase 1, so a crossed ceiling stays crossed, and a lecturer already chosen for
a workload stays chosen. `revalidate()` therefore skips every pairing that is already false and tests
only the ones that might have just become false. On a dense instance that is most of the work the
loop would otherwise do, and it is why the phase is linear rather than quadratic in the slot count.

The invariant does **not** hold in phases 2 and 3, where `drop` releases capacity — which is exactly
why those phases do not use `feasible` at all and call `canTake` directly.

### Control flow, top to bottom

```
generateWorkloads(input)
  ├── build Load per lecturer, candidateOf / candidateWorkloads / ranked   ── setup
  ├── seed locked assignments, incl. supervision already held (gaps mode)
  ├── distributeStudents × individual workloads                            ── §5, goes first
  ├── repairSupervisionCeilings, skipping locked pairings                  ── §5
  ├── initial feasible sets + heap seed
  ├── while heap: pop → skip if stale → pick best → take → revalidate      ── phase 1
  ├── repair(ctx)    worklist over lecturers short of a floor              ── phase 2
  ├── improve(ctx)   worklist over workloads; shift, then swap             ── phase 3
  └── assemble assignments, issues, load table, telemetry
```

`take` and `drop` are the only mutators, and both keep `loads`, `held`, `chosen` and `chosenSet` in
step. Phase 1 additionally calls `revalidate`; phases 2 and 3 additionally call `refreshDeficit` for
the two lecturers a move touches. Every other structure is derived.

### Telemetry

`GenResult.telemetry` carries per-phase wall-clock and twenty operation counters (`canTake`,
heap pushes and stale pops, probes and accepted moves per pass, `supervisionRepairMoves`, and so
on). They are integer
increments that influence no decision, so a run with telemetry produces a byte-identical plan to one
without; the UI ignores the field. The counters are the machine-independent half of any measurement —
identical on any CPU for the same input — which is what makes them quotable in a way milliseconds
are not.

---

## 8. What is and isn't guaranteed

**Guaranteed**

- **No ceiling is ever violated by the slot search** — including the fallback annual maximum. Across
  the 48 benchmark instances, checked independently: zero, before and after the optimisation.
- No lecturer is assigned to the same workload twice.
- In `gaps` mode, an assignment that existed before the run still exists after it, unchanged —
  **student–supervisor pairings included**. That last clause is not decoration: the supervision
  repair pass once moved pre-existing pairings too, which produced a lawful-looking plan by
  re-pairing diploma students mid-year (§5).
- Deterministic: identical input yields byte-identical output (every tie-break bottoms out in an id
  comparison).
- Terminates on every input.
- Nothing is written. The result is a plan; the user previews it and presses «Застосувати».

**Not guaranteed**

- **Not optimal.** Total desirability is a good local optimum under single moves, not a global one.
- **The annual ceiling can be exceeded by individual supervision, and only by it.** A student cannot
  be left without a supervisor, so when every candidate for an `INDIVIDUALLY` position has run out of
  room the ceiling gives rather than the student. This is the one place the hard constraint is soft,
  it is a last resort after two other tiers and after the repair pass has tried to undo it (§5), and
  it is reported. On the benchmark that last resort is currently never reached:
  `ceilingViolationsByIndividual` is **0** across the 48 instances, down from 2 219 before the
  individual pass was moved ahead of the slot search. The 120 over-ceiling hours that remain are
  `ceilingViolationsPreExisting` — inherited from `gaps`-mode seed states that were unlawful before
  the run, which the mode forbids the generator to alter.
- **Not maximal coverage.** Filling the most slots and maximising desirability can conflict; the
  MRV ordering favours coverage but does not guarantee it. An unfilled slot is always reported.
  Coverage is also traded against the ceiling on purpose: the search will leave a position unfilled
  rather than put someone over 600 hours, which costs about 3.6 points of fill on the benchmark and
  is the right way round — an unfilled position is a visible, actionable gap, an overloaded lecturer
  is an invisible legal breach. How much of that coverage a *lawful* plan could still recover is
  measured rather than guessed: `iplex.py` solves the same objective exactly and reports the gap.
- **Floors may go unmet** — they are objectives, not constraints. Reported per lecturer with the
  exact shortfall (`годин на рік: 120 з 300`).
- **No fairness criterion.** The fill-ratio tie-break spreads work among equally desirable
  candidates, but nothing bounds the spread between lecturers of differing desirability. It is
  *measured* rather than bounded: the benchmark reports the Gini coefficient of the hour
  distribution, currently 0.117 across the 48 instances (0 would be every lecturer carrying exactly
  the same load). Read the **utilisation** Gini in preference to that one — `balance.mjs` reports
  both, and it is currently 0.075. Raw hours are the wrong axis wherever posts differ in size, for
  the same reason headroom is defined as a share: 600 hours on a full post and 300 on a half post
  are perfectly balanced in utilisation and maximally unequal in hours. If fairness ever needs to be
  a constraint rather than an observation, that is where a target would be set.
- **No cross-department view.** Input is one department. A lecturer teaching for two departments has
  their annual hours counted separately in each, so both can independently believe they are within
  the ceiling.

---

## 9. Worked example

Two examples, both traced against the real implementation rather than reasoned about — the first
version of this section described a sequence of moves the code does not actually make.

### A — the three phases, and why each exists

One department. `default_max_hours_per_year = 600`.

| Workload | Course | Hours | Type | Slots | Candidates (desirability) |
|---|---|---|---|---|---|
| W1 | Algorithms | 32 | LECTURE | 1 | Petrenko 90, Kovalchuk 60 |
| W2 | Algorithms | 32 | LAB | 2 | Petrenko 80, Kovalchuk 70, Shevchuk 40 |
| W3 | Databases | 30 | LECTURE | 1 | Petrenko 85 |

Constraints: Petrenko `MAX_LECTURE_COURSES = 1`; Shevchuk `MIN_HOURS_PER_YEAR = 30`.

**Phase 1 — greedy.** Feasible counts: W3 has 1 candidate, W1 has 2, W2 has 3, so **W3 goes first**
and Petrenko takes Databases/lecture (85). That closes their `MAX_LECTURE_COURSES`.

W1 next: Petrenko is now infeasible — a second distinct lecture course — so **Kovalchuk** takes it
(60). Had W1 been processed first, Petrenko would have taken it at 90 and W3, with only Petrenko as a
candidate, would have gone unfilled. *This is the MRV heuristic paying for itself.*

W2's two slots go to Petrenko (80 — labs, in a course they already hold, so no lecture constraint
applies) and Kovalchuk (70).

Total **295**. Shevchuk holds nothing, and is 30 hours below their floor.

**Phase 2 — repair.** Shevchuk is short, so the repair worklist starts from them and looks for a
slot they could be given. W2 is the only workload they are a candidate for. Its holders are examined
in the order the greedy took them, so **Petrenko's** slot is the first tried: dropping it and giving
it to Shevchuk closes the deficit entirely, and the move is accepted.

That costs 80 − 40 = 40 points, when taking Kovalchuk's slot would have cost only 30. Repair takes
the first donor that works rather than the cheapest, and here it overspends.

Total **255**, deficit 0.

**Phase 3 — improvement.** W2 now holds Kovalchuk (70) and Shevchuk (40), and Petrenko — who was
just displaced — is free again. Shifting W2's Kovalchuk slot to **Petrenko** (80) gains 10 without
touching Shevchuk's floor. Accepted.

Total **265**.

**Result** — 4 of 4 slots filled, 265 desirability, no unmet minimums, no ceiling breached, and
Petrenko 62 h / 2 courses, Kovalchuk 32 h / 1, Shevchuk 32 h / 1.

The last two phases are worth reading together. Repair overspent by 10 and improvement won exactly
that back, which is not a coincidence: the slot repair gives away is usually the one improvement can
most obviously reclaim. It is also why **ordering repair's donors by ascending desirability — the
apparently obvious fix — is not worth doing.** Implemented and measured across 24 instances: +12
desirability in total, or 0.002 %. Improvement already compensates.

### B — why the swap neighbourhood exists

Shift alone cannot reach every improvement. The smallest case that shows it:

| Workload | Hours | Candidates (desirability) |
|---|---|---|
| W1 | 60 | Ivanenko **90**, Bondar 88 |
| W2 | 60 | Ivanenko **95**, Bondar 10 |

Both lecturers have `MAX_HOURS_PER_YEAR = 60`, so each can hold exactly one of the two.

**Greedy** takes W1 first (the two are equally constrained, so input order decides) and gives it to
Ivanenko, its best candidate at 90. Ivanenko is now full, so W2 falls to Bondar at 10. Total **100** —
and it is badly wrong, because Ivanenko was worth 95 on W2 and only 90 on W1, while Bondar was worth
88 on W1 and 10 on W2.

**Shift cannot fix it.** On W1, the incumbent Ivanenko (90) is already the best candidate — no
strictly better one exists, so nothing is tried. On W2 the incumbent Bondar (10) *is* beatable by
Ivanenko (95), but Ivanenko has no hours left; the move is infeasible on its own.

**Swap can.** Exchanging the two holders is evaluated as one move: Ivanenko releases W1 as they take
W2, and Bondar the reverse, so both stay inside their ceilings. The gain is
`(95 − 10) + (88 − 90) = +83`, and the result is **183** — the optimum.

Each half of that exchange is infeasible alone; only together are they feasible. That is exactly the
local optimum ejection chains were introduced to escape, and it is why the improvement pass tries a
swap whenever a shift has failed — never before, since a candidate who could simply be taken has
already been taken.

Traced against the implementation: one swap probe, one swap accepted, no shifts.

---

## 10. How it is verified

**There is no unit-test suite, and this section used to claim there was one.** No `*.spec.ts` file
exists anywhere in `timetable-ui`, there is no runner in `devDependencies`, and `npm test` fails.
The claim is corrected here rather than quietly deleted, because a reader who took it at face value
would have drawn the wrong conclusion about how much this code has been checked.

What does exist is stronger in some ways and weaker in others.

### The benchmark harness (`scripts/workload-bench/`)

48 instances — eight scenarios × six department sizes, 10 to 320 lecturers, 53 to 8 316 slots —
covering all 21 lecturer constraint types, both candidate constraints, all three teaching formats,
every course type, and both generation modes. Coverage of that list is asserted by the generator
script, which exits non-zero if any of it is ever lost.

Every run checks three things that a test suite would otherwise have to assert case by case:

- **Feasibility, re-derived independently.** `lib/metrics.mjs` replays the returned plan against the
  input and re-checks every constraint from `schema.sql`'s semantics, sharing no code with the
  generator. A feasibility claim resting on the searcher's own bookkeeping is worth nothing. It also
  *attributes* each breach — to the slot search, to individual supervision, or to locked assignments
  inherited in `gaps` mode — because only the first is a defect.
- **Determinism.** Every instance is run several times and the plans fingerprinted; a differing
  fingerprint fails the run.
- **Structural integrity.** A lecturer assigned who is not a candidate, a student assigned twice,
  more lecturers than slots, `MAX_STUDENTS` exceeded.

Current state: **zero** ceiling breaches by the slot search, **zero** structural errors, **zero**
determinism failures, across all 48 instances, before and after the optimisation.

`compare.mjs` runs two versions of the generator over the same instances and exits non-zero on a
quality regression — fill rate, desirability or feasibility — which is what makes it usable as a gate
rather than a report. Every change described in this document was accepted or rejected on its output.

### What this does not replace

The benchmark exercises the algorithm through its front door on generated instances. It would not
catch a defect that only shows on a shape the generator never produces, and it says nothing about
the mapping in `lecturer-workload-list.ts` between the GraphQL tree and `GenInput` — which is real,
untested code. Unit tests for the constraint families would still be worth having, and the module is
framework-free precisely so they are cheap to write.

### Defects found, and how

Five, all of which produced *plausible* output:

1. In `gaps` mode the improvement pass moved pre-existing assignments — the mode's core promise,
   violated silently. Found by reading, fixed by the `locked` set.
2. Round 2 of the student distribution spread the surplus evenly instead of by desirability,
   contradicting the specification. Found by reading, fixed by leading the sort with desirability.
3. **Individual supervision ignored the annual ceiling entirely**, so a generated plan could put a
   lecturer hundreds of hours over ст. 56's limit with nothing reported. Found by the benchmark's
   independent validator — 2 219 lecturers over the ceiling across the 48 instances — and fixed by
   moving the pass ahead of the slot search and giving it a budget (§5).
4. **Supervision a lecturer already held was never charged against their ceiling** in `gaps` mode,
   because the seed loop walks slot positions only. The generator's own ceiling test therefore passed
   on plans the independent validator failed — the two disagreed about the same lecturer's load, and
   the generator was the one that was wrong. Found by the validator, fixed by charging those hours
   during the seed (§4).
5. **The supervision repair pass took students off *any* supervisor, not only those this run
   placed.** It drove the reported overrun to zero, which is what made it look right; what it
   actually did was re-pair diploma students part-way through a year in the one mode that exists to
   leave settled work alone. Found by asking why the number had improved, fixed by the
   `lockedSupervision` set — which gives the zero back and reports the inherited hours instead (§5).

A sixth came from reading the schema rather than testing: `durationHours` is non-null in
`LecturerWorkloadInputPayload`, so applying a plan had to echo it or every mutation would have been
rejected before reaching the resolver.

Defects 4 and 5 are the same shape as each other and worth remembering as a pair: neither was a
wrong answer to the question asked, both were the right answer to a question asked against the wrong
state. A number that improves when you fix something is not evidence the fix was correct.

---

## 11. Where to take it next

Roughly in order of value per unit of effort:

1. **Longer ejection chains in phase 3.** Shift and swap are chains of length one and two; length
   three and beyond is where Yagiura, Ibaraki and Glover report their gains on GAP. The bookkeeping
   that makes a chain cheap to evaluate — incremental loads, a running deficit — is already here.
2. **Min-cost flow for the unconstrained core.** With course-count constraints ignored, the problem
   is exactly min-cost bipartite matching and solvable optimally in `O(V²E)`. Solving that first and
   repairing only the course-count violations would give a much stronger starting point than greedy.
   The hour ceiling makes it a transportation problem rather than a matching, which is still
   polynomial.
3. **Lagrangian relaxation of the floors.** Rather than the ad-hoc `× 10` weight, price each floor
   with a multiplier and adjust it between rounds — makes the desirability-versus-floors trade
   explicit and tunable instead of hard-coded. The GAP literature reaches within 1 % of the
   Lagrangian bound this way.
4. **A tighter upper bound.** The benchmark's optimality gap is measured against a deliberately loose
   relaxation — every slot given its best candidate, ignoring both ceilings and the fact that one
   lecturer cannot hold two slots at once. A gap of 2 % against that bound is a genuine ceiling on
   what is available, but a tighter bound (LP relaxation, or min-cost flow on the ceiling-free
   problem) would say how much of it is really reachable. This is the single most useful thing to add
   before making a quality claim in print.
5. **Multi-start is not the answer, and this has been measured.** Permuting the input and keeping the
   best of twelve runs gains **0.25 %** of desirability for 12× the time. The local optimum the search
   reaches is robust, so effort belongs in a better neighbourhood, not in more restarts.
5. **Cross-department capacity.** Load a lecturer's assignments across *all* departments before
   generating, so their annual ceiling is counted once rather than once per department.
6. **Timetable feasibility.** Nothing here knows about days or rooms; a lecturer can be given two
   workloads that will later prove unschedulable together. Coupling generation with
   `FacultyTimetableList` would close that gap — and is the natural place for the memetic algorithm
   the domain model was drawn from.
