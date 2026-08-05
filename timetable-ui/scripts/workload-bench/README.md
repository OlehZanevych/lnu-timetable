# Workload-generation benchmark

A measurement harness for `src/app/workload-generator.ts` — the algorithm that assigns lecturers to
working curriculum items. Two scripts:

| | |
|---|---|
| `generate-datasets.mjs` | writes 48 synthetic but believable department instances into `data/` |
| `run-benchmark.mjs` | runs the shipped generator over all of them and writes `results/` |

```bash
node scripts/workload-bench/generate-datasets.mjs     # rebuild data/ (deterministic)
node scripts/workload-bench/run-benchmark.mjs         # measure, write results/
```

or via npm, from `timetable-ui/`:

```bash
npm run bench:generate
npm run bench
```

Neither script adds a dependency. `run-benchmark.mjs` loads the **shipped TypeScript file**, not a
copy of it, using Node's built-in type stripping (Node 22.13+) or the project's own `typescript`
devDependency as a fallback. That is the point: a number in `results/metrics.csv` is a number about
the code that runs in the browser, and it cannot drift from it.

---

## 1. What is being measured

`generateWorkloads(input)` solves an assignment problem. Every *slot* — one lecturer-place on one
delivery position — must be given to a lecturer from that position's own candidate list, subject to
per-lecturer ceilings (annual hours, distinct courses by hour type and by mandatory/elective) and
per-lecturer floors of the same shape, maximising the total desirability of the assignments made.
That is an integer program with side constraints, and it is NP-hard in general, so the
implementation is a heuristic in three phases:

1. **Most-constrained-first greedy** — repeatedly take the slot with the fewest feasible candidates
   and give it its most desirable one.
2. **Repair** — move assignments toward lecturers who are below their floors.
3. **Improvement** — hill-climb on desirability with single moves that break no ceiling and deepen
   no floor deficit.

Plus a separate routine, `distributeStudents`, for INDIVIDUALLY-taught positions, where the unit of
work is a student rather than a slot.

The harness answers four questions about that:

- **How fast is it, and how does that grow?** Wall-clock per phase, and a fitted exponent α in
  *T ∝ N<sup>α</sup>*.
- **How much work does it do?** Operation counts — feasibility checks, comparator calls, moves
  probed and kept. These are machine-independent: identical on any CPU for the same input, which is
  what makes them citable in a way milliseconds are not.
- **How good is the answer?** Fill rate, and total desirability against a genuine upper bound.
- **Is the answer legal?** Every plan is re-checked against `schema.sql`'s constraint semantics by
  code that shares nothing with the generator.

## 2. The instances, and why they look like this

A benchmark on invented numbers measures invented behaviour. Each modelling decision below is
either a legal figure or a shape read off the real ЛНУ data imported into
`timetable/src/main/resources/db/data.sql`. They live in `lib/model.mjs`, one constant each.

### The anchor: 600 hours

**ст. 56 Закону України «Про вищу освіту»** caps the teaching load of a full post at **600 academic
hours per academic year**. A department of *L* lecturers can therefore absorb 600·L hours, and an
instance is specified not by how many courses it has but by the **fraction of that capacity the plan
asks for** (`demandRatio`). Courses are added until the planned hours reach it.

The number of courses is thus an *output*. This is what keeps sizes comparable: at every size the
same proportion of the department's statutory capacity is being fought over, so a difference between
*L* = 40 and *L* = 320 is a difference of scale and not of difficulty.

That the achieved course-to-lecturer ratio lands at **≈ 2.2–2.7** is a check on the model rather
than an input to it. For reference, the scraped ЛНУ data has 3557 courses against 2134 lecturers
(1.67), but that import covers only what the faculty websites publish — 1.7 hour rows per course
against the four or five a real curriculum carries — so it understates delivery. Two to three
distinct disciplines per member of staff is what a кафедра actually looks like.

### Structure

| Decision | Value | Why |
|---|---|---|
| Staff mix | 10 % професор, 44 % доцент, 20 % ст. викладач, 16 % викладач, 10 % асистент | the ЛНУ establishment shape |
| Who may read a lecture | professors always, доценти usually, assistants almost never (`lectureAffinity`) | Ukrainian practice, and the single most important structural constraint: it is what makes lecture slots scarce while practical slots are plentiful |
| Groups per course | 1–6, mean ≈ 3.0 | the multiplier that turns one 32-hour practical row into three delivery positions |
| Hour rows per course | LECTURE 90 %, PRACTICAL 85 %, LAB 55 %, CONSULTATION 60 %, ASSESSMENT 50 % | not every discipline has labs; consultations and assessments are often folded into other rows |
| Hours per row | triangular, e.g. lecture 16–48 peaking at 32 | a semester of two hours a week is 32 |
| Group size | 12–30 students, peak 22 | Ukrainian academic groups |
| Course types | 60 % MANDATORY, 24 % elective of some kind, the rest course work / practice / optional / attestation | the non-mandatory, non-elective types are included **because** they carry no distinct-course constraint: a dataset made only of mandatory courses never exercises the branch that ignores them |
| Two-lecturer labs | 22 % | parallel subgroups |

Delivery format follows the row: lectures and assessments TOGETHER, practicals and labs SEPARATELY
(one position per group), consultations TOGETHER or — with probability `individualShare` —
INDIVIDUALLY with a student roster.

### Constraints

All **21** `lecturer_workload_constraint_type` values appear across the matrix, and both
`lecturer_workload_candidate_constraint_type` values (`MIN_STUDENTS`, `MAX_STUDENTS`) appear on
every INDIVIDUALLY position. `generate-datasets.mjs` asserts this and exits non-zero if coverage
is ever lost.

Constraints are **calibrated, not invented**. For each lecturer the builder first estimates what
they would receive if every position were shared evenly among its candidates, then expresses their
ceiling as a multiple of that (`tightness` 1.08 = "8 % of headroom") and their floor as a fraction.
Absolute numbers would not survive a change of scale; a ceiling of 400 hours is generous in one
instance and impossible in another. A floor that lands above its own ceiling is clamped down to it —
a contradictory instance is not a hard one, it is a broken one, and it would have the repair pass
chase something unreachable for reasons that say nothing about the search.

### The eight scenarios

Each isolates one thing that can make the search expensive, so a curve can be *attributed* and not
merely observed.

| Scenario | What it isolates |
|---|---|
| `baseline` | a department as one actually is — 80 % of capacity planned, five candidates a discipline, ceilings on most staff and floors on some |
| `unconstrained` | the same structure with no per-lecturer constraints at all. The control: what the search costs when every feasibility check passes trivially |
| `tight-ceilings` | 92 % of capacity, ceilings of every family close to the actual load, no floors. All the cost lands on the greedy's feasibility scan |
| `tight-floors` | the mirror image — generous ceilings, floors on most staff. The greedy cannot satisfy a floor, only fill slots, so this is where the repair pass does real work |
| `sparse-candidates` | two candidates per discipline. Ordering decides everything; improvement has nowhere to move to |
| `dense-candidates` | twelve. Every scan walks a long list and improvement has many alternatives to try |
| `gaps-mode` | half the positions pre-assigned and locked, `mode: 'gaps'`. The common case in practice, and the one where locked work consumes capacity the later passes may not reclaim |
| `oversubscribed` | 135 % of capacity with tight ceilings. Provably infeasible. Included because the failure path is where an algorithm is most likely to spend unbounded time, and a paper should show that it does not |

Sizes: **10, 20, 40, 80, 160, 320** lecturers. The upper end is a faculty rather than a department —
a кафедра of 320 people does not exist — and is there because that is where scaling behaviour
becomes visible and where a faculty-wide run would land if the feature were ever raised above
department scope.

### Reproducibility

Every file is a pure function of a seed, and every seed is a pure function of its (scenario, size)
cell — see `seedFor` in `lib/scenarios.mjs`. `Math.random()` appears nowhere; the PRNG is a seeded
mulberry32. So `data/` is a *cache* of something reproducible rather than an opaque artifact, and a
reviewer can verify the cache is honest:

```bash
node scripts/workload-bench/generate-datasets.mjs --check   # rebuilds in memory, diffs, writes nothing
```

`data/index.json` carries a SHA-256 prefix per file for the same reason.

The JSON is minified deliberately. These files are read by machines and diffed only as a whole;
pretty-printing costs several megabytes to nobody's benefit. Working-tree size is ~37 MB, ~2.6 MB
after the compression git applies to its objects.

## 3. Method

For each dataset, smallest first: one discarded warm-up call, then up to `--repeats` timed calls
(default 5), stopping early once a per-dataset budget is spent (`--budget-ms`, default 8000). The
**minimum** is reported as the estimate of true cost — it is the run least contaminated by GC and
scheduling — alongside the standard deviation, which is what says whether the minimum can be
trusted.

The warm-up is skipped for large instances after the first few datasets: the code is thoroughly
JIT-compiled by then, and a warm-up on a two-minute instance costs two minutes to change nothing.

Every repeat's plan is fingerprinted and compared. The generator is deterministic, so a differing
fingerprint is a defect, and the run exits non-zero.

## 4. The metrics

`results/metrics.csv` — one row per dataset. `results/metrics.json` — the same plus per-run detail
and the environment. `results/scaling.csv` — fitted exponents per scenario.

### Instance

`lecturers` `courses` `positions` `slotsRequested` `candidateEdges` `candidatesPerPosition`
`students` `demandRatio` `constraintsPerLecturer`

`slotsRequested` is the true problem size: positions × lecturerCount, less anything already assigned
in `gaps` mode.

### Performance

| Column | Meaning |
|---|---|
| `msMin` `msMax` `msSd` `msArithmeticMean` | wall-clock across repeats; `msMin` is the headline |
| `msSetup` `msGreedy` `msRepair` `msImprove` `msIndividual` `msReport` | the six phases, from the median run |
| `usPerSlot` | microseconds per slot — the size-normalised cost, and the number to watch when optimising |
| `slotsPerSecond` | its reciprocal, for readers who prefer throughput |

### Work done (machine-independent)

| Column | Meaning |
|---|---|
| `opsCanTake` | calls to `Load.canTake`, the innermost predicate of the entire search |
| `opsFeasibleScan` / `opsFeasibleCandidates` | calls to the feasible-candidate scan, and candidates walked inside them |
| `opsGreedySortComparisons` | comparator invocations in the greedy's re-sort — **each one costs two feasible scans** |
| `opsLoadAdd` / `opsLoadRemove` | mutations of a lecturer's running load |
| `opsDeficitEvaluations` / `opsDeficitLecturerScans` | `Load.deficit()` calls, and lecturers walked to aggregate them |
| `repairPasses` `repairProbes` `repairMoves` | outer passes, moves probed, moves kept |
| `improvePasses` `improveProbes` `improveMoves` | the same for the improvement pass |
| `canTakePerSlot` | feasibility checks per slot — the clearest single indicator of algorithmic waste |

These come from `GenResult.telemetry`, which `workload-generator.ts` now returns. The counters are
integer increments on a hot path and change no decision the search makes: a run with telemetry
produces a byte-identical plan to one without. The UI ignores the field.

### Quality

| Column | Meaning |
|---|---|
| `fillRate` | slots filled ÷ slots requested |
| `totalDesirability` | as the generator reports it |
| `desirabilityBound` | **upper bound**: every slot filled by its single best candidate, ignoring that one lecturer cannot hold two at once and ignoring every ceiling |
| `optimalityGap` | 1 − achieved ÷ bound |
| `meanDesirability` | per filled slot |

The bound is loose by construction — no relaxation this cheap is tight — but it is a genuine bound,
so the gap is an honest *ceiling* on what a better search could win. A gap of 3 % means at most three
per cent is available, not that three per cent is available.

### Feasibility, checked independently

`verifyPlan` in `lib/metrics.mjs` re-derives every lecturer's load from the returned assignments and
re-checks every constraint against the semantics in `schema.sql`, using none of the generator's own
bookkeeping. A feasibility claim resting on the searcher's own opinion of feasibility is worth
nothing.

Ceiling breaches are **attributed**, because three different things cause them and only one is a
defect:

| Column | Meaning |
|---|---|
| `ceilingViolationsBySearch` | the slot assignments chosen break a ceiling. **A bug.** The run exits non-zero |
| `ceilingViolationsByIndividual` | slots are within the ceiling; only the individual-supervision hours push past it. See §6 |
| `ceilingViolationsPreExisting` | in `gaps` mode, locked assignments that were already over. The run may not move them, so it cannot be blamed |
| `structuralErrors` | a lecturer assigned who is not a candidate, a student assigned twice, more lecturers than slots, `MAX_STUDENTS` exceeded |
| `floorViolations` `floorShortfall` `lecturersBelowFloor` | unmet minimums. **Not** failures — floors are soft by design and the generator reports them as issues |
| `ceilingOverrunHours` | hours above the annual ceiling, summed. Severity rather than headcount: spreading an unavoidable overrun across more people raises the *count* of breaching lecturers while lowering the harm to each, so the count alone cannot say whether a change helped |

The generator's own report is counted too, one column per `GenIssue` kind: `issuesNoCandidates`,
`issuesUnfilled`, `issuesOverCeiling`, `issuesUnmetMinimum`, `issuesNoStudents`, and `issuesTotal`.
The first three are blocking problems, the last two advisory — see WORKLOAD-GENERATION.md §2.

### Balance

`hoursMean` `hoursSd` `hoursCv` `hoursMin` `hoursMax` `hoursGini` `coursesMean` `coursesMax`
`utilisationMean` `lecturersWithNoWork`

`hoursGini` is the Gini coefficient of the hour distribution: 0 if every lecturer carries the same
load, 1 if one carries everything. It is the most compact answer to "is this plan fair", which is
the question a кафедра actually asks of a generated plan.

### Scaling

`results/scaling.csv` fits log *y* against log *x* by least squares, giving α in *y ≈ c·x<sup>α</sup>*
with the R² that says whether a power law describes the data at all. α ≈ 1 is linear, α ≈ 2
quadratic. R² is reported so the exponent is never asserted when the points do not lie on a line.

## 5. Reading the results

Start with three columns: `usPerSlot`, the hot phase, and `canTakePerSlot`. Cost per slot rising
with instance size *is* the finding — a linear algorithm has a flat `usPerSlot`.

`results/run.log` holds the console output of the committed run, including the summary tables.

### What the committed baseline says

`results/metrics.csv` is the current algorithm; `results/metrics.base.csv` is the version it replaced,
measured on the same 48 instances. Both were taken on a 2-core Xeon at 2.8 GHz in a cloud container —
deliberately modest hardware, and the reason the operation counts matter more than the milliseconds.
Re-run it on your own machine before quoting any timing; on an Apple-silicon laptop the whole sweep
finishes in about a third of the time.

**The algorithm is correct.** Across all 48 instances, before and after: **zero** ceiling breaches
attributable to the slot search and **zero** structural errors, checked by code that shares nothing
with the generator. Every repeat of every instance produced an identical plan.

#### Speed

| | before | after |
|---|---:|---:|
| total, all 48 instances | 851 s | **1.55 s** |
| slowest single instance | 182.5 s (`oversubscribed-320`) | **0.28 s** (`dense-candidates-320`) |
| growth, time ∝ Sᵅ | α ≈ **2.0**, R² ≥ 0.98 | α ≈ **1.0**, R² ≥ 0.94 |

**550× overall**, median 202× per instance, 1 133× at the largest size. Cost *per slot* was rising
with instance size — 400 µs at 151 slots, 14 450 µs at 4 922 — and is now flat.

The old cost was one statement. 87 % of all time sat in the greedy phase, and inside it the remaining
slot list was re-sorted on every iteration with **each comparison recomputing both operands from
scratch**. The measured comparison count was S²⁄2 to three significant figures: the array stays nearly
sorted, so each sort costs a linear pass, and there are S of them.

Four changes removed it, in descending order of measured value:

1. **Feasibility maintained, not recomputed** — each workload keeps the set of lecturers who could
   take it; an assignment re-tests only the workloads that lecturer is a candidate for. Plus the
   observation that feasibility is monotone during the greedy, so a lecturer who has dropped out of a
   set can never re-enter it and need not be re-tested at all.
2. **A lazy heap** for most-constrained-first selection, with per-workload version counters to discard
   stale entries — `O(log S)` instead of a full re-sort.
3. **Worklists in repair and improvement** instead of repeated sweeps. Repair is now driven from the
   lecturers who are short of a floor, which is the only place a repair can come from.
4. **Reference-counted course sets and a running deficit total** — `O(1)` add and remove, and a move
   evaluated without walking the department.

#### Quality

| | before | after |
|---|---:|---:|
| ceiling overrun (hours above ст. 56's 600) | 230 842 | **4 362** |
| lecturers finishing over the ceiling | 2 219 | **155** |
| unmet floor shortfall | 13 382 | **5 045** |
| hours Gini (0 = every lecturer equal) | 0.177 | **0.119** |
| desirability per **filled** slot | 84.04 | 83.59 |
| slots filled | 97.2 % | 94.5 % |

Read the last two rows together. Desirability per filled slot moved by −0.5 %, so the search is not
choosing worse lecturers. The 2.7 points of fill are the positions it now refuses to assign because
doing so would put someone over the statutory ceiling: **every instance whose fill dropped by more
than a point paid for that fill, in the old behaviour, with hundreds to tens of thousands of hours of
illegal load.** On `oversubscribed-320`, 10.9 points of fill against 46 054 hours of overload. Those
positions are now reported rather than silently covered.

That change came from moving individual supervision **before** the slot search — it is the least
flexible work in the problem, and booking it last meant the slots had already spent the headroom of
exactly the people who then had to absorb it. See WORKLOAD-GENERATION.md §5.

#### What did not work, and is worth not retrying

- **Multi-start.** Permuting the input and keeping the best of twelve runs gains **0.25 %** of
  desirability for 12× the time (`experiment-multistart.mjs`). The local optimum is robust.
- **Largest-first tie-breaking** in the greedy. The bin-packing instinct is wrong here: the objective
  is to maximise the *number* of positions covered under a capacity, and smallest-first beats
  largest-first by ten points of fill on the over-subscribed instances.
- **Best-improvement repair.** Evaluating every receiver to pick the cheapest move provably cannot
  beat taking the first one that helps, once receivers are walked in descending desirability — the
  cost of a move only grows along that list. Implemented, measured, reverted.
- **Alternating repair and improvement to a joint fixed point.** 40 % more time, 0.02 % less floor
  shortfall, no desirability gain. One pass of each already reaches the fixed point.
- **Filtering repair donors** to those with slack of their own. Lost a third of all repairs; the
  total-deficit test is a better arbiter than the heuristic.

## 6. Known limitations of the harness

- **`distributeStudents` ignores the annual ceiling, and the harness reports rather than hides it.**
  Individual supervision hours are added to a lecturer's load after the slot search has finished, by
  a routine that consults only the candidate's `MIN_STUDENTS`/`MAX_STUDENTS` and never
  `Load.canTake`. A lecturer can therefore finish over 600 hours without the search having done
  anything wrong. This is the algorithm as written; the `ceilingViolationsByIndividual` column exists
  to keep it visible and distinct from a real breach.
- **One seed per cell.** Enough for a scaling curve, not enough for mean ± σ per cell. `seedFor`
  takes a `repeat` argument for exactly this; generating three seeds per cell triples `data/`.
- **Synthetic instances.** They are shaped by real figures but are not real departments. A run
  against a real `working_curriculum_items` export would be a stronger claim, and the input format
  is the same `GenInput` the frontend builds, so such an export can be dropped into `data/` as-is.
- **Single-threaded, one machine.** No claim is made about wall-clock on other hardware; that is
  what the operation counts are for.
- **The desirability bound is loose.** A tighter bound (an LP relaxation, or a min-cost-flow on the
  ceiling-free problem) would make the optimality gap much more informative. That is the obvious
  next piece of work if the article needs a strong quality claim.

## 7. Files

```
scripts/workload-bench/
├── README.md                 this file
├── generate-datasets.mjs     script 1 — writes data/
├── run-benchmark.mjs         script 2 — writes results/
├── compare.mjs               two generators head to head, fails on a quality regression
├── experiment-multistart.mjs how much a multi-start would buy (answer: 0.25 %)
├── lib/
│   ├── rng.mjs               seeded mulberry32 + sampling helpers
│   ├── model.mjs             every modelling constant, one place
│   ├── scenarios.mjs         the eight scenarios, the six sizes, the seed function
│   ├── dataset.mjs           builds one GenInput + its realism statistics
│   ├── load-generator.mjs    loads the shipped .ts into Node
│   └── metrics.mjs           independent validator, bound, distributions, power-law fit
├── data/                     48 instances + index.json  (regenerable, byte-identical)
└── results/
    ├── metrics.csv           the current algorithm
    ├── metrics.base.csv      the version it replaced, same instances, same machine
    ├── scaling.csv           fitted growth exponents
    └── metrics.json          the above plus per-run detail and the environment
```

Compare two versions of the generator directly:

```bash
node scripts/workload-bench/compare.mjs --base old.ts --cand src/app/workload-generator.ts
```

`compare.mjs` reports speed and quality side by side and exits non-zero on a quality regression,
which is what makes it usable as a gate rather than a report.
