# The experiment protocol

How to test the ideas in [`OPTIMIZATION-IDEAS.md`](OPTIMIZATION-IDEAS.md) and
[`STAGNATION-ESCAPE.md`](STAGNATION-ESCAPE.md) — written as **operating instructions for an
automated campaign**: an agent (possibly a much cheaper model than the one that wrote these files)
that implements one idea at a time, runs the ladder below, records a verdict, and moves on. Every
decision rule is stated so that following it mechanically produces defensible results; judgement is
needed only where the text says "escalate to a human".

The measurement culture it encodes is the one `STUDY.md` §1 and §9 arrived at the hard way: the
run-to-run spread of this solver on one instance is a factor of 2.6–3.2, **single runs are never
compared**, seeds are paired, medians are reported, the independent validator is the only scorer
quoted, and a mechanism must be measured at a budget that actually exercises it.

---

## Contents

1. [Ground rules](#1-ground-rules)
2. [Stage 0 — the harness](#2-stage-0)
3. [Instance sets, including larger-than-12 800](#3-instance-sets)
4. [Metrics, and where each comes from](#4-metrics)
5. [The gating ladder](#5-the-gating-ladder)
6. [Hour-long testing](#6-hour-long-testing)
7. [The campaign loop](#7-the-campaign-loop)
8. [Implementing an operator: the checklist](#8-operator-checklist)
9. [Failure triage](#9-failure-triage)
10. [Record formats](#10-record-formats)
11. [Promotion to default](#11-promotion)

---

## 1. Ground rules

1. **The validator is the scorer.** Every quoted number comes from `bench/score.mjs` (which imports
   `timetable-bench/validate.mjs`) or from `--mode score-hidden` agreement checks. The solver's own
   counters go into the journal but are never a result.
2. **Paired seeds, always.** An A/B uses the same seed list for both arms — the canonical list is
   `11 22 33 44 55 66` (extend with `77 88 … 20 seeds` when §5's escalation rule fires). Report
   per-seed values, the median, the paired mean difference, and wins/losses.
3. **One change per experiment.** One flag (or one flag combination named as an arm) against the
   unmodified baseline binary of the same commit. Never stack unmeasured changes.
4. **Budget must exercise the mechanism.** Restart/escape mechanisms do nothing at 30 s
   (`restartAfter` never fires; S §9.1). Match the ladder stage to the mechanism: operators and
   repair quality → 60–180 s; escape/restart machinery → 180–3 600 s. A result measured at the
   wrong budget is not a result.
5. **Correctness gates precede quality gates**, and a correctness failure ends the experiment
   regardless of quality numbers.
6. **Do not re-litigate the rejected table** (`OPTIMIZATION-IDEAS.md` §3) outside its stated retry
   conditions.
7. **Everything lands in the journal** (§10) — including losses. A negative result with its numbers
   is the house currency (see the option comments in `search.hpp`); an unrecorded run never
   happened.
8. **The docs move with the code.** A promoted change edits `ALGORITHM.md` §5 (parameter table),
   `STUDY.md` (a dated subsection with the arm table), and the option's comment. A kept-off change
   edits only the comment. This file and the ideas file get a status mark in the queue table.

## 2. Stage 0

Run once per machine, and again after any change to `state.cpp`, the loader, or the build flags.

```bash
cmake -S . -B build -DTG_BUILD_GUI=OFF -DCMAKE_BUILD_TYPE=Release && cmake --build build

# 1. evaluator agreement — must match validate.mjs to the digit on all 50 archives
for f in ../timetable-ui/scripts/timetable-bench/instances/*.json.gz; do
  build/timetable-solve --instance "$f" --mode score-hidden
done   # compare against the archives' stored hidden scores via bench/score.mjs tooling

# 2. the set-valued-cap regression (Experiment 0, S §2) — zero breaches or stop
node bench/tighten.mjs bench/instances/n03200-s1.json.gz bench/instances-cap/n03200-s1.json.gz
bench/run.sh --instances bench/instances-cap --out bench/results/capped.jsonl \
             --time 30000 --threads 2 --sizes "3200" --seeds "1 2 3"

# 3. a 60 s reference point on n12800-s1, seeds 11/22/33 — the baseline the machine's numbers
#    are read against (hardware differs; never compare across machines)
```

Record the machine's baseline block (§10) before any experiment. **All comparisons are same-machine,
same-commit-baseline, same-thread-count.** Two threads is the study's reference; if the campaign
machine has more cores, pick one thread count and keep it for the whole campaign (and run T3.3 to
learn what the extra cores change).

## 3. Instance sets

| set | where | what it is for |
|---|---|---|
| archived ladder | `timetable-ui/scripts/timetable-bench/instances/` | n = 25 … 12 800 × 5 seeds, `roomSlack 1.15`; the head-to-head and the smoke tests |
| tight | `bench/instances-tight/` | `roomSlack 1.0`, dense constraints; where rooms and feasibility bind |
| capped | `bench/instances-cap/` | `MAX_CLASSES_PER_DAY` at the hidden schedule's peak; correctness regression only |
| tight-XL | `bench/instances-tight-xl/` (generate below) | the hard regime at real scale — the campaign's primary quality set |
| XL | `bench/instances-xl/` | n = 25 600, 51 200; scaling sanity, T2.10, T3.4 |
| whole-university | idea D1 (does not exist yet) | multi-faculty structure; required before promoting anything that touches clusters |

Generating what the archive does not carry — the user-facing point that **input larger than
n = 12 800 can be produced at will**, with the same hidden-feasible-schedule guarantee (a perfect
answer provably exists at any size or density):

```bash
node bench/generate.mjs --out bench/instances-xl --sizes "25600 51200" --seeds "1 2 3"
node bench/generate.mjs --out bench/instances-tight-xl --sizes "12800 25600" --seeds "1 2 3" \
     --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'
```

Note for XL runs: generation is fast, but check disk (each archive is a few MB gzipped) and run
`--mode score-hidden` once per new instance to extend the agreement check to the new sizes.

## 4. Metrics

From `bench/score.mjs` output (authoritative): `check.hard`, `check.soft` (Π₇+Π₈+Π₉),
`check.objective` (f), and the per-term breakdown. From the solver summary JSON (diagnostic):
`moves`, `placed`/`unplaced` (must equal movable/0), per-worker `restarts`, `perturbations`,
`deepPhases`, `adoptions`, per-operator `uses/accepted/improved/gain`, and — once
`STAGNATION-ESCAPE.md` lands — `hardRepairs`, `defectsCleared`, `defectsCertified`,
`basinSwitches`. From the trajectory log (`--log run.csv`): the monotone `runBestSoft` /
`runBestObjective` columns (never the raw per-worker columns — a restarted worker reports its fresh
construction; the file header comment in `writeTrajectory` explains this).

Two derived metrics the campaign should always extract from trajectories, because endpoint tables
hide them:

- **time-to-target**: first `seconds` at which `runBestSoft ≤ T` for T ∈ {50, 25, 15, 10} — the
  anytime view; a mechanism that reaches soft 15 twice as fast is a win even at an equal endpoint;
- **last-improvement time**: the last `seconds` at which `runBestObjective` fell — "was the run
  still descending when the clock stopped" (S §6 reads its hour-long run exactly this way).

## 5. The gating ladder

Each experiment climbs; a stage failed is the experiment ended (verdict recorded, code kept behind
its flag or reverted per §9). "Baseline" always means the same commit with the flag off.

**Stage S — smoke (minutes).** Correctness only.
Archived n ∈ {400, 1 600}, 10 s, seeds 1–3, flag on:
`hard = 0`, `unplaced = 0`, exits early at f = 0 where the baseline does, no crash, and the
candidate rate within 30 % of baseline. Then the capped regression (§2 step 2) with the flag on.
For mechanisms with triggers designed to be unreachable at short budgets (hard repair, restart
policies): additionally verify the **30 s summary is identical** to baseline on `n12800-s1` seed 11
— the triggers must not fire there at all.

**Stage A — cheap signal (an hour or two).** Small volume first, exactly as the campaign brief
requires: archived n = 6 400 **and** tight n = 6 400, 60 s, six paired seeds.
Decision: proceed if the arm wins the paired median on either set and loses badly on neither
(paired mean soft worse by > 25 % on 5+/6 seeds = stop). Remember S §4's caveat — at
`roomSlack 1.15` the small-n columns are noise; the tight set is the informative half of this
stage. Mechanisms that only act at long budgets (escape family) skip to Stage B after passing
Stage S.

**Stage B — the main measurement (an evening).** `n12800-s1` (archived) and tight-XL n = 12 800,
**180 s and 600 s**, six paired seeds each.
Decision rule: the minimal detectable effect at six paired seeds is roughly a 20 % mean shift
(S §1's power note: sign test power 0.34 at n = 6). So:
- wins ≥ 5/6 paired seeds at either budget with mean soft improvement ≥ 10 % → **pass**;
- wins ≤ 2/6 or mean worse → **fail**;
- anything between → **extend to 20 paired seeds** at the more favourable budget
  (≈ 2 h at 180 s, per S §1's costing) and decide by Wilcoxon p < 0.05 on the paired differences,
  falling back to "kept-off, promising" if still unresolved — recorded as such, not silently
  dropped.

**Stage C — the hour (a night).** Only for Stage-B passers.
`n12800-s1` and tight-XL n = 12 800 at 3 600 s × 3 paired seeds (11/22/33), plus one XL
(n = 25 600) pair at 3 600 s as a scaling canary, trajectories logged.
Pass = endpoint no worse on the paired seeds **and** either endpoint or time-to-target improved;
plus the §6 sanity checks. A Stage-C pass makes the idea a promotion candidate (§11).

Cost of the whole ladder per idea, two threads: Stage S ≈ 15 min, A ≈ 2 h, B ≈ 3–8 h, C ≈ 15 h —
one idea fits in a night-and-a-day unattended, which is the cadence the campaign loop assumes.

## 6. Hour-long testing

What §5-C's runs must additionally record and check, because the hour is the budget this project
exists for:

- **Trajectory shape**, not just endpoint: five-minute-bucket best-so-far series (S §6 format), the
  last-improvement time, and the restart/kick/adoption counts per worker (the hour currently spends
  ~370 kicks and ~75 constructions per worker — S §6a's closing table; an arm that changes those
  numbers by an order of magnitude is doing something the endpoint may not show).
- **The non-monotone caveat**: each budget rung is one run; the rung-to-rung spread at fixed budget
  is comparable to neighbouring rungs (S §6, tight table). Never read a budget ladder's shape from
  single runs; the honest claims are paired endpoints. `bench/budget-ladder.sh` exists for the
  sighting shot; the arms comparison at fixed budget is the measurement.
- **Anytime check**: `runBestSoft` at 600 s inside the 3 600 s trajectory should statistically
  match the standalone 600 s runs (A §3.9 states the caveats — cooperation is clock-driven — so
  match means "within the seed spread", not equality).
- **Residual composition**: the Π₇/Π₈/Π₉ split of the endpoint (S §6 reports 5/3/0 at the hour).
  A mechanism aimed at windows that only ever moves Π₉ is telling you where it actually acts.

## 7. The campaign loop

The standing procedure for the executing agent. State lives in two files under
`bench/campaign/` (create it): `queue.md` — the §9 table of `OPTIMIZATION-IDEAS.md`, copied and
kept current with a status column — and `journal.jsonl` — one line per completed stage per
experiment (§10 schema).

```
loop:
 1  pick the topmost queue entry whose prerequisites are met and status is "todo"
 2  branch: create a git branch exp/<id>; implement per the idea's specification,
    strictly behind its flag; obey §8 if it adds an operator
 3  build; run Stage 0's steps 1–2 if state.cpp or the loader was touched
 4  climb the ladder (§5), writing a journal line after every stage
 5  verdict:
      promoted   → §11 procedure, merge, update docs (ground rule 8)
      kept-off   → merge the flagged code with measured numbers in the option comment;
                    update docs' status marks
      failed     → revert unless the flag+comment is itself worth keeping (it usually is,
                    per the house pattern); record why in the journal
 6  update queue.md; commit with the experiment id in the message; goto loop
```

Rules for the loop itself: never run two experiments' measurements concurrently on one machine
(they share cores and the numbers become noise); never edit the baseline while an experiment is
climbing; if an implementation stalls (compile errors persisting, correctness gate failing twice
after a fix attempt), mark `blocked` with a description and move to the next entry — **escalate to
a human** after two blocked entries in a row, and likewise before any change that would touch
`state.cpp` arithmetic, the loader's domain construction, or the incumbent order: those are outside
the campaign's authority (ideas-file rules 1 and 3).

A nightly cadence that fits the ladder: implement + Stage S in the working day; Stage A in the
evening; Stage B overnight; Stage C the following night if B passed. Time-boxed, unattended,
resumable from the journal.

## 8. Operator checklist

Adding a neighbourhood/operator or an escalation-phase mechanism touches a known list of places —
missing one is the classic silent bug. In `search.cpp`/`search.hpp`:

1. `SearchOptions` field with the documented default and the measured-numbers comment slot;
2. CLI flag in `src/cli/main.cpp` (`--x` / `--no-x` pair where the default may flip later);
3. if a bandit operator (rare — rule 5 of the ideas file): `Op` enum entry, `kOpNames`, weight
   initialisation in the `Worker` constructor, a case in **both** switch statements
   (`applyOperator` *and* the inlined switch in `Worker::run`), and work accounting via the
   existing `segWork_`/`segUses_` pattern;
4. if an escalation mechanism: wire into `deepPhase` rotation or the D3 ladder only;
5. candidate discipline: `beginCandidate()` first, all mutations via `moveTo` (or
   `placeRaw` + manual journal awareness as `recreate` does), `settle()` before any cost read,
   `undo()` on every failure path, `jr_.clear()` on accept;
6. `allLegal(set)` after the last member is down, for anything multi-class;
7. never leave a movable class lifted on exit (assert `unplacedMovable()` restored);
8. counters: a `WorkerReport`/`OperatorReport` field if the protocol will need to see it, and
   `SearchResult::summary()` emission;
9. deadline/stop-flag polling in any loop that can run > 1 ms;
10. RNG: only `rng_`; no `std::rand`, no unordered-container iteration order in decisions.

## 9. Failure triage

| symptom | first suspicion | action |
|---|---|---|
| `hard > 0` on archived ladder at 30 s | new operator emits illegal sets | check §8.6; run capped regression; revert if not found in one fix |
| `unplaced > 0` anywhere | a lift without restore on some path | §8.7; the `repairAfterGraft` comment describes the historic instance of this bug |
| score-hidden disagreement | evaluator semantics touched | full stop; revert; this is outside campaign authority |
| candidate rate collapsed > 30 % | new mechanism hogs the budget | check work accounting and trigger frequency; a Stage-S fail, not a judgement call |
| 30 s summary differs though triggers "unreachable" | trigger arithmetic wrong | fix before any quality run; this gate exists to protect short budgets |
| quality regressed only at one stage | budget-dependence (ground rule 4) | record both numbers; decide at the stage the mechanism is *for* |
| results wildly unstable across seeds | pairing broken (different seeds per arm?) or machine contention | re-run the stage; verify seed lists byte-equal; one experiment at a time |

## 10. Record formats

One JSON line per (experiment, stage, instance, budget, seed, arm) in
`bench/campaign/journal.jsonl` — append-only, exactly the shape `bench/score.mjs` rows already
have, extended:

```json
{"exp":"E1-regret","stage":"B","commit":"<sha>","arm":"regret-anchored","baselineArm":"off",
 "instance":"tight-xl/n12800-s1","timeMs":180000,"threads":2,"seed":22,
 "check":{"hard":0,"soft":14,"objective":905},"moves":21400000,
 "restarts":4,"hardRepairs":0,"timeToSoft":{"50":21.5,"25":74.0,"15":161.2,"10":null},
 "lastImprovementS":171.9,"notes":""}
```

And per experiment, one summary block appended to `bench/campaign/queue.md` when the verdict lands:

```markdown
### E1-regret — verdict: kept-off (2026-xx-xx, commit <sha>)
Stage B, 180 s, tight-xl n12800, paired seeds 11–66, soft off→on:
14/27/17/23/19/29 → 15/24/18/25/17/30; median 21→21.5; wins 2/6. Regret repair does not
pay at 2 threads; candidate rate −6 %. Numbers copied into the `regretDepth` comment.
```

The block is the artefact a future reader (or the dissertation) quotes; write it in the house
voice — what was measured, on what, and what may be concluded, nothing more.

## 11. Promotion

A flag becomes a default only when all of:

1. Stage C passed (endpoint and/or time-to-target, paired);
2. the 30 s and 60 s short-budget numbers are not worse (the desktop application's two-minute
   users must lose nothing);
3. Experiment-0 capped regression and the 50-archive score-hidden agreement pass with the flag on;
4. the XL canary showed no scaling pathology;
5. the docs moved (ground rule 8): `ALGORITHM.md` §5 row, `STUDY.md` dated subsection with the arm
   tables, option comment updated from "off by default, and measured" to the new state, and —
   since the browser solver and the C++ solver share the objective, not the mechanisms — a check
   whether any claim in `README.md`'s results section is now stale.

Promotion of anything from `STAGNATION-ESCAPE.md` additionally requires the escape-specific kill
criteria of its §11 to have stayed silent through Stage C, and the claim discipline of
[`WRITING.md`](WRITING.md) applies to anything destined for the manuscript: a mechanism promoted
here still may not be *claimed* beyond what its paired-seed tables support.
