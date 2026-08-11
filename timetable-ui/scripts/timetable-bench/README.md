# Timetable benchmark harness

Everything needed to reproduce the measurements behind `SOLVER-OPTIMISATION.md`, and to run new
experiments on the solver in `src/app/timetable-solver.ts`.

Plain Node — no dependencies, no build step, nothing to install. The solver is loaded from its
TypeScript source unchanged, via `node:module`'s `stripTypeScriptTypes`, so what is measured is
literally the file the application ships (Node 22.13+ or 24+).

```
node experiment.mjs --repeats 25         # the full study
```

---

## Why the instances are built backwards

The obvious way to generate a test instance is to invent plausible requirements — courses, groups,
lecturers, rooms, availability windows — and hand them to the solver. It is also the way that makes
the results uninterpretable: when the search stalls at 400 unresolved conflicts you cannot tell an
over-constrained instance from a weak algorithm, and every negative result is suspect.

`build.mjs` inverts the order. **It constructs a valid schedule first and derives the instance from
it.** It walks the week slot by slot and places classes into resources that are free at that moment:
a conflict is impossible by construction, the pass is O(n), and it cannot fail. Courses, cohorts,
lecturer eligibility, room suitability and every availability constraint are then read back off the
finished schedule, so each one is satisfied by it.

Two things follow, and they are what make the numbers mean something:

* **A perfect schedule provably exists** for every instance — zero hard violations, and a known soft
  cost. Anything the solver cannot reach is a property of the search, never of the data.
* **Every result has a yardstick.** The hidden schedule is scored by the same validator, and its
  soft cost is reported alongside the solver's as `referenceSoft` / `softVsReference`. "1,085 soft
  violations" says nothing on its own; "1,085 against a constructed schedule's 6,205" says the
  solver found something six times better than a realistic hand-built timetable.

The hidden schedule is *not* optimal — it is a feasible, realistic one. The solver beating it is
expected and is the interesting measurement.

### What the generated data contains

Structured to look like a Ukrainian HEI rather than an abstract graph:

* 6-day week, 40-minute academic hour, паровий bell grid (08:30, 10:10, 11:50, 13:30, 15:05, 16:45),
  and a separate earlier grid for фізичне виховання
* several корпуси with **directed, asymmetric** travel times; some pairs are far enough apart that
  back-to-back classes across them are infeasible within the 20-minute break
* a cohort is taught in its home корпус, and a lecturer stays in one корпус for a whole day
* abstract rooms (спорткомплекс) shared by several groups at once, with capacity
* online classes, kept to a cohort's designated online day so no day mixes online with in-room —
  except a deliberate minority, which are spaced by the commute allowance
* biweekly (чисельник/знаменник) classes, fixed pre-placed entries, external lecturers,
  and per-lecturer / per-group / per-room availability constraints

Sizes scale every resource with the class count: `groups ≈ n/15`, `lecturers ≈ n/9`,
`rooms ≈ n/22 × 1.15`. The room slack of 1.15 is deliberate — a comfortable instance would not test
anything, and a tight one is what a real faculty has.

---

## The files

| file | what it does |
| --- | --- |
| `build.mjs` | constructs the hidden schedule and derives the raw instance from it |
| `emit.mjs` | turns that into a `SolverProblem` plus the derived constraints and the reference schedule |
| `validate.mjs` | **independent** scorer — re-reads a schedule from scratch and counts all nine Π terms |
| `run.mjs` | runs one solver variant on one instance and scores it |
| `experiment.mjs` | the full sweep: sizes × instances × repetitions, with every metric |
| `materialise.mjs` | writes the instances to `instances/` as gzipped JSON |
| `bestknown.mjs` | tracks the best schedule ever found per instance, so results can be quoted as a gap |
| `report.mjs` | prints a median table from a tuning log |
| `fleet-sim.mjs` | checks the UI search portfolio's completion arithmetic over every done/fail interleaving |
| `instances/` | 50 archived instances — 10 sizes × 5 seeds, 4.1 MB |
| `results/measurements.jsonl` | the 375 measurements taken during the optimisation study |
| `results/best-known.json` | the best soft cost recorded per instance (see below) |
| `results/solver-before-optimisation.ts` | the solver as it was before the study, for A/B comparison |

### Quoting a result: reference, or gap?

Two denominators, and they answer different questions.

The **constructed reference** is the hidden schedule the instance was built around. It is a real,
feasible, human-plausible timetable, which makes "the solver is 28× better than it" a meaningful
statement about practical value — and a weak one about optimality, because a worse reference would
have made the number look better.

The **best-known gap** is what the timetabling literature uses. ITC-2007 and its successors report
against the best known solution rather than an optimum, because optima at these sizes are unknown.
`bestknown.mjs` maintains that table: the lowest soft cost any feasible run has ever recorded for
each instance, monotone, quoted as the percentage a result sits above it.

```bash
node bestknown.mjs                          # rebuild from every results file
node bestknown.mjs --add results/run-A.jsonl   # fold a finished sweep in
```

`experiment.mjs` reads the table and records `bestKnownSoft` and `gapToBestKnownPct` on every run.
A negative gap means that run *is* the new best — fold it in and it becomes 0.

What the harness deliberately does **not** offer is a lower bound. The generator guarantees a
hard-feasible schedule exists, because it builds one; it makes no claim about the reachable soft
minimum, and a real bound on Π₇/Π₈ is itself a hard combinatorial problem. Quoting "within x% of
optimal" from this harness would mean inventing the denominator.

One caveat the code enforces: only runs measured under the **corrected window definition** enter the
table. The earlier definition produced figures roughly an order of magnitude larger, and folding
them in would silently poison exactly the instances where no corrected-metric run exists yet.

---

### `fleet-sim.mjs` — the one thing here that is not about the solver

The client runs the search as a portfolio of concurrent workers (`TIMETABLE-GENERATION.md` §8a), and
its completion rule — the run ends when every worker has returned or failed, best answer wins — is
the kind of arithmetic that is easy to get subtly wrong and hard to see wrong. This exercises it over
**every** interleaving of done/fail messages for fleets of 1 to 4 (700 sequences) and asserts that
the run always terminates, reports exactly one of result-or-error, and picks the lexicographic
`(hard, objective)` best.

```bash
node fleet-sim.mjs
```

It tests a transcription of the component's handlers rather than the component itself — this project
has no unit-test setup, and a genuine runtime test needs the app against a backend. Two real defects
were found by it and by the review around it: a completion test that read an array `terminate()`
empties, and a failure path that recorded one result twice.

---

`validate.mjs` being independent is not a detail. The solver reports the violations it knows how to
count, so a change that accidentally stops counting one looks like an improvement. Every number in
every results file comes from the validator re-deriving the schedule, never from the solver's own
bookkeeping. Two bugs during the study were caught only because the two disagreed.

---

## Running the experiment

```bash
cd timetable-ui/scripts/timetable-bench

node experiment.mjs --repeats 25                    # 25 repetitions, all 10 sizes, instance seed 1
node experiment.mjs --repeats 25 --instances 1,2,3  # three different instances per size
node experiment.mjs --sizes 400,3200 --repeats 10   # a subset
node experiment.mjs --budget fixed:30000            # equal budget everywhere
node experiment.mjs --solver results/solver-before-optimisation.ts --out results/before
```

Options:

| flag | default | meaning |
| --- | --- | --- |
| `--sizes` | `25,50,100,200,400,800,1600,3200,6400,12800` | class counts |
| `--instances` | `1` | which instance seeds (1–5 are archived) |
| `--repeats` | `25` | repetitions per instance; each uses a different search seed |
| `--budget` | `scaled` | or `fixed:MS` — see below |
| `--solver` | `../../src/app/timetable-solver.ts` | the file under test |
| `--out` | `results/experiment` | output prefix |

**The default budget scales with size** (10 s ≤ 100, 30 s ≤ 800, 60 s ≤ 3200, 120 s ≤ 6400, 300 s
above), because a quality-versus-size curve only means something when every size gets a budget where
it actually converges. `--budget fixed:30000` gives the other useful figure — what each size reaches
under an equal budget. Both belong in a paper; they answer different questions.

The default run is **25 repetitions × 10 sizes ≈ 4.7 hours**. It is resumable: each finished run is
appended immediately and its key is skipped on restart, so a closed laptop costs nothing, and adding
`--repeats 50` later reuses the first 25.

### What it records

Three files: `<out>.jsonl` (one line per run), `<out>-summary.json`, `<out>-summary.csv`.

Per run — instance metadata; wall time, moves, moves/s and peak RSS; all nine Π counters and the
hard/soft split from the validator; the objective; the hidden reference and `softVsReference`; the
convergence history; 1-second progress samples; and `timeToFeasibleMs` / `iterationsToFeasible`,
captured live because the moment a run first reached zero hard violations cannot be recovered from
the final schedule afterwards.

Per size — feasible rate, and median / mean / sd / min / max for soft cost, time-to-feasibility,
throughput and memory. The CSV is one row per size, ready to paste into a table or a plot.

---

## Regenerating the instances

The archived instances are a convenience and an archive, not the source of truth: the generator is
deterministic, so `(n, seed)` always reproduces the same instance byte for byte. They are committed
so that a published result stays reproducible even if the generator is later edited — the one thing
regeneration cannot promise. `experiment.mjs` prefers the archived file when it exists and records
which was used in `instanceSource`.

```bash
node materialise.mjs                            # the whole ladder, seeds 1-5
node materialise.mjs --sizes 400,3200 --seeds 1
```

Larger instances than the ladder work too — the study went as far as 31,000 classes — they are just
too big to commit.

## Ad-hoc single runs

```bash
node run.mjs --variant ../../src/app/timetable-solver.ts --n 3200 --seed 1 --time 30000
node report.mjs --file results/measurements.jsonl
```
