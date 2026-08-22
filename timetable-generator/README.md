# timetable-generator — the C++ solver and its desktop application

A third project in this repository, next to [`timetable/`](../timetable/README.md) (the service) and
[`timetable-ui/`](../timetable-ui/README.md) (the web client): a **Qt 6 desktop application** that
signs in to the service, reads the whole timetabling problem in one request, searches for a schedule
in C++ for as long as it is given, and writes the answer back.

It exists for one reason, and the reason is a measurement. The browser solver converges:
[`TIMETABLE-GENERATION.md`](../timetable-ui/TIMETABLE-GENERATION.md) §8 records n = 12 800 reaching
soft 913 at two minutes, 438 at five, and **438 again at nine**, with 22.8 million moves in between
buying nothing at all. A deanery that is willing to leave a machine running overnight has nowhere to
spend that time. This is where it spends it.

| | |
|---|---|
| **`src/core/`** | the solver — portable C++20, no Qt, no third-party dependency |
| **`src/cli/`** | `timetable-solve`, the headless runner every measurement is taken with |
| **`src/gui/`** | the Qt 6 application: sign in, choose, watch, save |
| **`bench/`** | the study: instance generation, runs, and independent scoring |

---

## What it does that the tab does not

The tab schedules **one faculty around the others**. This schedules the **whole university at
once** — every class in the half-year movable together — which is a different problem and a better
one, because a room contested by two faculties can be resolved rather than merely avoided by
whichever of them ran second.

Four options, which are two independent questions:

| | **перепланувати все заново** | **зберегти вже заплановані** |
|---|---|---|
| **усі факультети** | every class in the half-year is placed from nothing | every placed class is frozen; only the unplaced are scheduled |
| **один факультет** | that faculty's classes are replaced, everybody else's are obstacles | that faculty's unplaced classes are scheduled around everything, including its own placed ones |

"Keep" is not a hint. A class that already has a placement becomes **immovable** — indistinguishable,
to the search, from another faculty's class — which is what «зберегти» has to mean if it is to be
worth anything to somebody who has spent a week arranging a кафедра by hand.

---

## Results

Every figure below is produced by `bench/score.mjs`, which hands the schedule to
[`timetable-bench/validate.mjs`](../timetable-ui/scripts/timetable-bench/validate.mjs) — the
**independent** validator that re-reads a schedule from scratch and is the same one the TypeScript
solver is measured with. The solver's own counters are recorded but never quoted. The `n` is class
sessions; `soft` is Π₇ + Π₈ + Π₉ (lecturer windows, group windows, mixed online days), which is what
remains once a schedule is feasible.

**Thirty seconds, median of three seeds, two cores, two workers each.** Both solvers on the same
host at the same moment, both scored by the same validator — the earlier version of this table
quoted the JavaScript figures from `TIMETABLE-GENERATION.md` §8, which were honest but measured on
another day, and a claim of the form "n× better" is only worth making when one clock timed both.
`STUDY.md` §5 is the experiment.

| n | JS solver | this solver | reference schedule |
|---|---|---|---|
| 400 | 2 | **0** | 377 |
| 800 | 16 | **0** | 754 |
| 1 600 | 34 | **0** | 1 580 |
| 3 200 | 207 | **1** | 3 164 |
| 6 400 | 959 | **7** | 6 168 |
| 12 800 | 10 764 | **16** | 12 439 |

At n ≤ 1 600 it reaches **f(σ) = 0** — no hard violations, no windows, no mixed days — and exits
early, in about a second. That exit had never fired at faculty scale before, and since f ≥ 0 it is
not "better", it is the optimum.

The last column is worth reading twice. The instances are built **backwards**, around a hidden
feasible schedule (`timetable-bench/README.md` explains why), so a perfect answer provably exists and
the hidden schedule's own soft cost is a yardstick: a realistic, human-plausible timetable. Being
780× better than it at n = 12 800 is not the interesting claim; reaching zero at 1 600 is.

**Where the budget goes.** The measurement this project was built for, one run per rung, two cores:

| instance | 60 s | 300 s | 900 s | 3 600 s |
|---|---|---|---|---|
| n = 12 800 | 26 | 14 | 11 | **8** |
| n = 6 400, tight | 15 | 21 | 18 | **10** |

An hour returns a third of the windows the first minute did. That sentence was **false** until the
work recorded in `STUDY.md` §6a: before it, this same run returned 37 at sixty seconds and 37 at
three hundred — the same schedule, after sixteen million further candidates. The tight instance's
non-monotone middle is not noise to be smoothed away either; each rung is one run, and the
run-to-run spread at a fixed budget is comparable to the difference between neighbouring rungs
(§6a again). Re-run it with `bench/budget-ladder.sh`; the numbers on your hardware will be better
than these, which come from two cores.

**Throughput.** About 86 000 candidates per second per thread at n = 3 200 and 65 000 at n = 12 800,
against the TypeScript fleet's 16 000 per worker at the same size. The factor is roughly four, not
the hundred a naive port would suggest — the JavaScript solver is already carefully written — and it
is not where the difference comes from: the quality gap at that size is a factor of six hundred.
Most of it comes from §*How it works* below, and the ablation in `STUDY.md` §4 makes the point
numerically — `--simple`, which is this solver reduced to the browser solver's two neighbourhoods,
makes **ten times** the candidates and is **fifteen times** worse.

---

## How it works

This section is the design in prose. Two companions carry the parts a paper needs:
[`ALGORITHM.md`](ALGORITHM.md) states the model, the objective and every neighbourhood formally, with
pseudocode and complexity; [`WRITING.md`](WRITING.md) says which claim rests on which experiment, what
may not be claimed, and how to regenerate every number.

### The objective is the same objective

Nine Π terms, weights `β = (150, 100, 50, 90, 120, 50, 5, 20, 30)`, exponent 2, exactly as
[`TIMETABLE-GENERATION.md`](../timetable-ui/TIMETABLE-GENERATION.md) §1.2 states them. That is not a
convenience: it is what makes the comparison above mean anything. `src/core/state.cpp` was written
from the validator's semantics rather than from the TypeScript solver, and the two agree to the digit
on every archived instance — check it yourself with `timetable-solve --mode score-hidden`.

Hard rules — room eligibility, bell-set membership, `NOT_BEFORE` / `NOT_AFTER` / `UNAVAILABLE` /
`MAX_CLASSES_PER_DAY` — are filters on the domain, never terms in the objective. A schedule this
produces cannot violate one.

### Time is a bitmask

Every time in the problem — a bell start, the end of a class — is one of a few dozen distinct minute
values, so the day is compressed onto an axis of **ticks**: the sorted distinct endpoints. A class
occupies a contiguous run of them, and the two questions the search asks a billion times become bit
operations:

```
do these two classes overlap?         (a & b) != 0
how many пари did this entity skip?   popcount(span(u) & ~u & bellStarts)
```

The second is the whole soft objective. `span(u) & ~u` is the holes between the first and last class
of an entity's day; intersecting with the bell starts counts the пари nobody used, which is exactly
the definition §1.2 argues for and exactly what the validator computes with a sort and a walk.

### The cost of a move does not depend on the size of the university

Every counter is the sum of a per-bucket statistic, where a bucket is one **(entity, day)** — one
lecturer's Monday, one group's Thursday. A candidate dirties the handful of buckets it touches, their
cached statistics are subtracted, the placement changes, and only those are recomputed. Nothing scans
the timetable.

Each bucket also caches the **union of its occupancy masks** per calendar week, which is what makes
the window term cheap to *probe*: "what would this class cost that entity's day?" is
`popcount(span(occ | m) & ~(occ | m) & bells)` against a stored count — a handful of instructions,
with no scan of the bucket at all. That probe is what the construction and every large neighbourhood
steer by.

### Seven neighbourhoods, chosen by reward per unit of work

| | |
|---|---|
| **move** | one class to a random admissible placement |
| **swap** | targeted: the partner is whoever is actually in the way |
| **chain** | an ejection chain — whoever is displaced goes where *it* would choose, to depth 3 |
| **kempe** | a local Kempe chain between two timeslots over one class's own entities |
| **ruin** | ruin-and-recreate, over a set chosen by one of five selectors |
| **kopt** | an exact-relaxation **permutation** of up to `koptK` classes at once |
| **repack** | one (entity, day) lifted out and re-packed, then refined pairwise |

Selection is a bandit over these seven, in segments of 4 000 candidates, with the reward divided by
the **work** the operator cost — measured in recomputed buckets, which the state counts for free. A
large neighbourhood therefore has to earn its price rather than merely be occasionally spectacular.

Measured at n = 12 800 over five minutes, the bandit settles on `repack` and `ruin` carrying most of
the improvement, `chain` third, and `kempe` down to about a tenth of the calls it starts with.

#### The permutation operator

This is the answer to "the search has stopped finding anything". Take `k` classes; lift all of them
out of the schedule; the cost of putting class *r* at placement *q* is then readable on its own, so
the best assignment is a **linear assignment problem**, solved exactly by the Hungarian method in
O(k³). The relaxation ignores the residual coupling *between* the k, so what follows it is an exact
pairwise refinement under the true objective, which routinely finds the two or three exchanges the
relaxation got wrong.

Two details decide whether it is worth anything:

- **The members must share something.** The objective is separable over (entity, day), so exchanging
  two classes with no entity and no day in common cannot change a single Π term. Members are drawn
  from a few *gappy* (entity, day) buckets — where the permutation has something to close — and only
  otherwise from a cluster.
- **The identity permutation is detected and dropped.** Before that check, 99.96 % of this operator's
  candidates were accepted (they cost exactly nothing) and 0.8 % improved anything. Detecting it
  turns that whole share of the budget back into search.

#### Clusters

`buildClusters` partitions the movable classes into communities of the class ↔ entity graph by label
propagation: classes that share a lecturer or a group, grouped so that a large neighbourhood can be
aimed at a part of the timetable that actually interacts. A class is of course reachable from several
groups; what is wanted is a partition to *aim* at, not a decomposition to solve independently.

The clusters are one of the five ruin selectors, and they are what the deep phase escalates on.

### Escalation, not just a kick

When the incumbent stops moving, the search does not immediately perturb. It runs a **deep phase**:
twenty-four large-neighbourhood attempts on the worst cluster and the gappiest buckets, under strict
descent, with the permutation width **widened by four** each time it is entered. Only when that comes
back empty does it perturb — or, if another worker is meaningfully ahead, adopt that worker's
schedule and continue from there.

### What the hour is actually for

The paragraph above was the design's answer to "what does a long budget buy", and measuring it said
**nothing**: at n = 12 800 the incumbent stopped at 37 s and sixteen million further moves over the
next four minutes changed it by zero. §6a of [`STUDY.md`](STUDY.md) is the whole investigation; the
two things that came out of it are in the code:

- **Every kick starts from the incumbent.** The perturbation used to displace a tenth to a fifth of
  the timetable starting from the *working* state, which after a failed cycle is worse than the best
  one found — so each escape began further from the answer than the last. Restoring the incumbent
  first, and breaking a small *related* set instead of a large random one, is worth 22 % of the soft
  cost and 34 % of `f` over six seeds (`--no-restart` to compare).
- **A worker that has stopped improving builds a new timetable instead of polishing this one.** The
  same binary on the same instance with six different seeds returns soft 11 to 29 — a factor of 2.6
  from luck alone. Which basin the construction lands in matters more than anything the local search
  does afterwards, so after `restartAfter` moves without a new incumbent a worker hands its schedule
  to the shared pool, forgets it, and reconstructs with a freshly shuffled order. It fires only when
  the budget is long enough for it to (`--no-restart-fresh` to compare).

Three further mechanisms were built for the same purpose and **measured to be worse**, and are off by
default with their numbers in the comments: a dedicated iterated-local-search loop (`--ils`),
cluster-wise recombination between pool members (`--recombine`), and a longer late-acceptance history
(`--lahc 5000`, which does not converge at all). The study says why in each case.

### Acceptance

Late acceptance hill climbing by default (`lahcLength: 100` — the dominant parameter, and its optimum
is small and does not grow with the instance, which §5.5 of the TypeScript document measured and this
implementation confirms). Simulated annealing with reheating and diversified late acceptance are both
implemented and selectable with `--engine`; `--engine mixed` gives half the workers SA and half LAHC,
which fails differently on different instances and costs nothing when the cores would otherwise idle.
Every measurement in [`STUDY.md`](STUDY.md) is on the default.

One hard violation is priced at `max(1e6, surrogate · 0.02)` — finite on purpose, so the search can
walk through a worse state to repair a stuck one, and scale-free on purpose, because `f` grows with
the square of the instance. The **incumbent** is chosen lexicographically by
`(unplaced, hard, f)`: a class left out of the timetable beats every other consideration, then hard
violations, then comfort. The first key matters more than it looks — see the next section.

The one thing late acceptance cannot do is recover once its history has collapsed onto the incumbent,
and lengthening the history does not help (`--lahc 5000` measures at soft 3 381 against 32, because a
bar filled at construction scale and five thousand slots deep never converges). What recovers the
search is not tolerance but attempts, which is what the restart mechanisms above are.

### A tenth term the objective does not have

Nothing in `f(σ)` counts a class that is not scheduled at all — a hole
[`TIMETABLE-GENERATION.md`](../timetable-ui/TIMETABLE-GENERATION.md) §13 names. It never bit the
TypeScript solver because its moves always place. A ruin-and-recreate that could not put a class back
would look like an improvement, so the acceptance cost here carries `unplaced × hardWeight × 8`, and
the recreate restores a class to where it was rather than leaving it out.

The acceptance test was not enough. Everything *above* it — the worker's incumbent, the shared best,
the pool, and the schedule the run finally returns — was comparing `(hard, f)` only, and an unplaced
class lowers both. A construction that could not place everything, or a repair that gave up, would
therefore win the incumbent outright and be returned as the answer. Every one of those comparisons
now leads with the unplaced count.

---

## Building

### The core and the headless runner — anywhere with a C++20 compiler

```bash
cmake -S . -B build -DTG_BUILD_GUI=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

### The desktop application — macOS, with Qt 6 from Homebrew

```bash
brew install qt cmake ninja
cmake -S . -B build -G Ninja -DCMAKE_PREFIX_PATH="$(brew --prefix qt)" -DCMAKE_BUILD_TYPE=Release
cmake --build build
open build/timetable-generator.app
```

If `cmake` reports `Qt6 not found`, the core and `timetable-solve` still build; only the application
is skipped. `CMAKE_PREFIX_PATH` is the one thing Homebrew's Qt needs stating, because it is
keg-only.

Linux is the same without the `CMAKE_PREFIX_PATH` (`apt install qt6-base-dev`), and Windows needs the
Qt online installer's prefix instead.

---

## Running it

The application asks for the service's address, an e-mail and a password, and signs in with the
ordinary `login` mutation — the same account, the same permissions. What it may move is decided by
the service: a class this account cannot edit arrives **locked**, stays in the problem as an
obstacle, and is never written back.

Then: choose a scope, choose a policy, choose a budget in minutes, and press **Згенерувати розклад**.
The nine Π terms fall in a table while it runs. **Зупинити й показати результат** ends the search at
its next check and keeps the best schedule found — it is a stop, not a cancel. **Зберегти в базу**
writes it.

Every run leaves `<stamp>-<scope>-<policy>.csv`, `.jsonl` and `-summary.json` in the journal
directory: the whole trajectory, every Π term at every sample, the operator statistics per worker,
and the parameters. That is not a debugging aid — it is the point. An hour-long search whose numbers
were only ever on screen is a measurement nobody can quote.

### Headless

```bash
build/timetable-solve --instance bench/instances/n12800-s1.json.gz --time 3600000 \
    --threads 8 --out schedule.json --log run.csv
```

`--problem FILE` takes a bare `SolverProblem` — including one saved straight out of the service's
`timetableGenerationInput` — so anything the application can do is reproducible without a desktop.
`--mode score-hidden` scores an archive's hidden reference schedule with this evaluator, which is how
the agreement with `validate.mjs` is checked.

---

## The service side

One new hand-written area in the service, `org.lnu.timetable.generation`:

- **`Query.timetableGenerationInput(facultyId, semesterParity)`** — the whole problem in one request:
  the class sessions to place, the timetable around them, the bells, the places, the directed walks
  between корпуси, and every scheduling rule that applies. Omit `facultyId` for the whole university.
- **`Mutation.saveGeneratedTimetable(input)`** — writes it back, checking each placement against the
  workload's own grid of bells and this caller's `EDIT` access, and reporting per class what it
  refused rather than failing the batch.

It is a `HandWrittenApi` bean and nothing else — no edit to the framework. See its own class notes for
why none of this is generable: a *class session* has no table, and the payload is a view across
eleven tables with three different faculty paths through them, which the client currently assembles
from nine round trips plus a browser-side merge.

Two things it enforces that nothing in the service ever has: that a placement's bell belongs to its
workload's `class_start_time_set_id`, and that a placement is one this caller may make.
`schema.sql` states both in comments and leaves them to "the scheduler"; this is the scheduler.

---

## The study

```bash
bench/run.sh --instances bench/instances --out bench/results/run.jsonl \
             --time 30000 --threads 2 --sizes "400 800 1600 3200 6400 12800" --seeds "1 2 3 4 5"
```

Every run is scored by the shipped harness's own validator, imported rather than copied: a scorer
that drifted from the one the TypeScript solver is measured with would make every comparison here
meaningless.

`bench/generate.mjs` makes more instances with the same backwards generator, at sizes the archive
does not carry and at densities it does not exercise:

```bash
node bench/generate.mjs --out bench/instances-xl --sizes "25600 51200" --seeds "1 2 3"
node bench/generate.mjs --out bench/instances-tight --sizes "3200 6400" --seeds "1 2 3" \
     --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'
```

The tight set matters more than the large one. The archived instances are generated at
`roomSlack: 1.15`, a comfortable faculty, and this solver reaches zero on most of them inside thirty
seconds — a benchmark every entrant passes measures nothing. At `roomSlack: 1.0` the room dimension
actually binds.

`bench/budget-ladder.sh` runs one instance at 60 s, 300 s, 900 s and 3 600 s with the trajectory
logged, which is the experiment this project exists to run.

Ablation is `--no-chain`, `--no-lns`, `--no-kopt`, `--no-repack`, `--no-cluster`, one at a time,
against the same instances and seeds — `bench/ablate.sh`.

Two further scripts exist because of what §6a of `STUDY.md` found. `bench/variance.sh` runs one
configuration on one instance under six PRNG seeds, which is how the factor-of-2.6 spread was
measured and is the reason no comparison here is drawn from a single run. `bench/arms.sh` runs the
escape mechanisms against one another, paired on the seed.

Four documents, and they do not overlap:

| | |
|---|---|
| [`README.md`](README.md) | this file — the design, in prose |
| [`ALGORITHM.md`](ALGORITHM.md) | the model, the objective and every neighbourhood stated formally, with pseudocode, complexity, and a parameter table saying how each default was chosen |
| [`STUDY.md`](STUDY.md) | what was measured, how, and what came out — including the six mechanisms that were built and rejected |
| [`WRITING.md`](WRITING.md) | for turning the above into an article: which claim rests on which experiment, what may not be claimed, and how to regenerate every number and figure |

---

## Known limitations

- **The permutation is exact only over its relaxation.** The Hungarian assignment ignores the
  coupling between the k classes it is permuting; the pairwise refinement that follows recovers most
  of it but not all. A true exact k-opt is a DP over subsets and is affordable at k ≤ 16; it is not
  implemented.
- **Rooms are a first-class search dimension.** The literature (Lach & Lübbecke; Cambazard et al.)
  says they need not be — given fixed times, room assignment is a bipartite matching and can be
  solved exactly — and that treating them as a search dimension triples the neighbourhood. Doing it
  properly would mean a matching layer under every time move.
- **The whole-university mode is untested against real data at scale.** It is correct by
  construction — the service simply reports every faculty's classes as movable — but the largest real
  instance available here is one faculty's.
- **Nothing validates that a saved schedule is the one that was searched.** The application sends the
  placements the run produced; a person who edited the timetable in the browser meanwhile will have
  their edit overwritten. A revision check on `timetable_entries` would close that.
- **The travel term is skipped entirely when no journey of any kind is known**, exactly as the
  TypeScript solver does. That is correct — inventing a walk out of missing data would reject
  schedules the data does not object to — but it means a database with no `building_travel_times` is
  scored against a strictly easier objective, and its numbers are not comparable with one that has
  them.
- **The desktop application has no tests.** Neither does `timetable-ui`.

---

## Code map

| file | what is in it |
|---|---|
| `src/core/mask.hpp` | the 128-bit time mask and the three operations the objective is built from |
| `src/core/model.hpp` | the interned problem: genes, domains, rules, the compressed time axis |
| `src/core/instance_io.cpp` | reading a `SolverProblem` (from the archive or from the service), writing placements |
| `src/core/json.cpp` | a dependency-free JSON reader and writer; gunzips a `.gz` archive through `popen` |
| `src/core/state.cpp` | the occupancy index, the nine Π terms, and the dirty-bucket delta evaluation |
| `src/core/search.cpp` | construction, acceptance, the seven neighbourhoods, the escape, the portfolio |
| `src/core/hungarian.hpp` | the linear assignment behind the permutation operator |
| `src/core/rng.hpp` | xoshiro256++, one per worker, seeded by stride |
| `src/cli/main.cpp` | `timetable-solve` |
| `src/gui/main.cpp` | the sign-in dialog, then the window |
| `src/gui/login_dialog.cpp` | endpoint, e-mail, password |
| `src/gui/graphql_client.cpp` | four GraphQL calls, every value a variable |
| `src/gui/run_controller.cpp` | the worker thread, the progress signal, the run journal |
| `src/gui/main_window.cpp` | the window |
| `bench/` | the study |
