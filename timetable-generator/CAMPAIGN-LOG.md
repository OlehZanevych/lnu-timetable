# The optimisation campaign

> **If you are looking for results rather than for the story, read [`FINDINGS.md`](FINDINGS.md).**
> It states what the campaign established as claims with their statistics and threats to validity.
> This file is the chronological record — every experiment in the order it ran, including the ones
> that went wrong, the bugs found in the shipped solver along the way, and the reasoning that led
> from each result to the next. It is the raw material; `FINDINGS.md` is the synthesis.

What was built, what was measured, and what came out. This is the record of one automated campaign
run against the ideas in [`OPTIMIZATION-IDEAS.md`](OPTIMIZATION-IDEAS.md) and
[`STAGNATION-ESCAPE.md`](STAGNATION-ESCAPE.md), under the design in
[`EXPERIMENT-PROTOCOL.md`](EXPERIMENT-PROTOCOL.md). It is written to be read by whoever runs the
campaign next — including a cheaper model working unattended — so it says what is settled, what is
still open, and which of the mechanisms are worth another measurement and under what conditions.

Everything below is scored by the independent validator
([`timetable-bench/validate.mjs`](../timetable-ui/scripts/timetable-bench/validate.mjs)), never by
the solver's own counters, and every comparison is paired on the PRNG seed.

---

## 1. Headline

**No mechanism was promoted.** Nine were implemented and measured; none beats the shipped
configuration at 300 s over six paired seeds, and the two that looked strongest at 60 s did not
survive to 300 s. That is a real result about a solver that has already had seven mechanisms
rejected for the same reason (`STUDY.md` §7), and the campaign's own instrumentation explains it.

**One near-result is worth reading in full, because it is the campaign's sharpest lesson about
measurement.** Flattening the objective's comfort terms (α = 1, β₇ = β₈ = β₉) cut the total number
of вікна by 10–19 % across two instances at twenty paired seeds each — and then vanished when the
comparison was repeated at the *shipped* configuration of two workers and a 900 s budget (+2 %,
W/L 2/4). What survives in every regime is the composition: lecturer windows down by two, group
windows up by two. **β and α decide whose вікна survive, not how many.** §6c and §6c.1.

**And three things came out that are worth more than a promotion.**

1. **A fault in the shipped search.** The list of "worst window" (entity, day) buckets — which the
   `worstWindow` ruin selector, the permutation's member draw, the kick and `opCloseWindow` all aim
   at — is dominated by buckets whose вікна are held open by classes this run may not move. Six of
   six enumerated defects had at most one movable member. Every draw aimed at one of them is spent
   on a gap nobody can close. `--actionable-windows` fixes it. **Fixing it does not measurably help**
   (§4), which is itself the interesting part.
2. **A proof of what the flat tail is.** With actionable targeting, an exact search over every
   arrangement of up to six classes on a defect day — including pulling a class in from another day
   — returns `best == before` **exactly**, defect after defect, exploring up to 46 656 complete
   arrangements each. The converged incumbent is a genuine strict local optimum, and the cause is
   the quadratic objective (§3). No strict-descent procedure of any width can leave it. This
   settles, with a search rather than an argument, why an hour-long run goes flat.
3. **The one procedure that does clear a certified defect** is the only one that is allowed to make
   the timetable worse first: `forceCloseRepair` (§3.3) — joined later by the exact joint two-defect
   repair (§6d), which clears at the same rate by a different route and equally fails to pay.
4. **The one instance property that is resolved, and it is not the search's fault or credit.**
   Room slack: pooled over four coupling levels, soft 7.92 at `roomSlack 1.15` against 13.33 at
   1.00, **p ≈ 0.002** (§6h). Cross-faculty coupling, measured with a whole-university generator
   built for the purpose (§6f) and then sampled across instances as well as seeds, is **not**
   resolved — p ≈ 0.06 to 0.35, with instance-to-instance spread inside a level wider than the
   distance between levels. The benchmark's own coupling sits where realistic service teaching puts
   it, which closes the "untested at scale" limitation in the project's favour.
5. **The one manipulation that measurably works, and it is not a search change.** Thirty per cent
   more rooms halves the вікна: at n = 12 288, soft 22.56 at `roomSlack 1.00` against 9.89 at 1.30,
   monotone across five rungs, p ≈ 0.009 at the endpoints and 0.012 pooled (§6i). Fourteen search
   mechanisms could not do that; one input property does. **But there is no free version of it**:
   widening how many rooms each class may use, at a fixed room count and on an otherwise identical
   instance, moves the residual −19 % non-monotonically at p ≈ 0.10 (§6j). Capacity is the
   constraint; assignment flexibility is not.
6. **The methodological finding, which is the most transferable thing here.** Every effect this
   campaign measured shrank or vanished as the sample grew — three times, in the same direction
   (§6b, §6c.1, §6h). On a problem with a factor-of-three run-to-run spread, a small sample does
   not give a small error bar; it gives a wrong centre.

---

## 2. What was built

All behind flags, all default-off, all preserving feasibility and the unplaced defences
(`--mode score-hidden` agrees with the independent validator on all 50 archives after every change).

| flag | mechanism |
|---|---|
| `--repair-order 1 \| 2` | most-constrained-first, or regret-2, reinsertion in every repair |
| `--repair-anchored` | apply the above only where the repair is anchored to the incumbent |
| `--kick-weighted` | draw the kick's victim selector by the residual's composition |
| `--parity-moves` | flip or exchange the calendar week of biweekly classes |
| `--compaction` | left-shift a day's whole tail across a вікно, as one candidate |
| `--rematch` | exact room re-assignment at one instant, by Hungarian matching |
| `--actionable-windows` | restrict the worst-window list to buckets with ≥ 2 movable classes |
| `--construct-tournament N` | build N constructions, descend the best |
| `--restart-adaptive` | restart on observed basin ripening time rather than a fixed move count |
| `--hard-repair` | the defect-focused exact repair, its ledger, and certified basin switching |
| `--switch-policy 0..4` | what to do when a basin is certified finished |
| `--surge` | the same machinery aimed at hard violations instead of windows |
| `--deep-extras` | put the new operators in the deep-phase rotation as well |

Plus the campaign harness itself, which is reusable and is the part most worth keeping:
`campaign/exp.mjs` (resumable paired arm × seed × instance driver, scoring every run with the
independent validator), `campaign/cmp.mjs` (per-seed values, medians, paired differences, exact sign
test), `campaign/agree.mjs` (the Stage 0 evaluator gate over every archive), and
`campaign/queue.md` (the running verdict log).

New instance families, generated with the shipped backwards generator so a perfect answer still
provably exists: `bench/instances-tight` (n = 3 200, 6 400 at `roomSlack 1.0`),
`bench/instances-tight-xl` (n = 12 800, same density) and `bench/instances-xl` (n = 25 600).

---

## 3. The diagnosis, which is the campaign's main product

### 3.1 The defect list was pointing at the unfixable

`State::worstWindowBuckets` ranks (entity, day) buckets by window count. Buckets whose windows are
caused by *immovable* classes rise to the top of that ranking **because** nothing has been able to
tidy them — they are the entities the search has failed at, which is exactly the failure the ranking
is looking for. But a вікно is a gap *between* two classes, so a bucket holding one movable class has
its gap held open by fixed entries, and no operator aimed at it can close anything.

The instrumentation that found this was the hard repair reporting 0 wins from 42 defects across five
subsolvers. The verbose trace showed why in one line:

```
[defect bid=5866 day=2 members=1 holes=1/1 cost=639 soft=12]
   daySolve: only 1 movable members
```

`--actionable-windows` requires two movable members. After it, the defects are real:

```
[defect bid=12091 day=3 members=3 holes=1/1 …]
[defect bid=12860 day=4 members=4 holes=1/1 …]
```

### 3.2 The residual is an equilibrium, not an unsearched region

With real defects, the exact day-slice solver is genuinely exhaustive within its scope:

```
daySolve: k=6 leaves<=46656 nodes=55987 found=0 best=6256 before=6256
daySolve: k=5 leaves<=3888  nodes=4666  found=0 best=6256 before=6256
```

`best == before` to the digit. Every complete arrangement of those six classes — every slot in each
class's own domain, on the defect day and on every other day, with a room chosen per slot, including
classes pulled in from elsewhere in the week — is either infeasible or no better.

The cause is (12)'s exponent. With Π₇ ≈ 26 lecturer windows and Π₈ ≈ 12 group windows, closing one
lecturer window is worth β₇(26² − 25²) = 255, and the rearrangement that closes it almost always
opens a group window, which costs β₈(12² − 11²) = 460. **Every single-defect repair is a trade that
loses.** The convex objective that makes the search attack the largest term (`ALGORITHM.md` §1.5) is
the same property that locks its endgame.

Two consequences, and both are transferable beyond this solver:

- A procedure that requires each step to improve cannot leave this plateau, however wide it
  searches. Widening the exact search is not the answer, and the campaign measured that rather than
  assuming it.
- The escape has to be a **compound** move: make it worse in one place, pay for it in another, and
  judge only the pair.

### 3.3 The compound move

`forceCloseRepair` closes the вікно unconditionally — the compaction sweep, applied whatever it costs
— then spends `repairDescent` candidates repairing the damage with the search's own portfolio, aimed
by `focus_` at exactly the classes the forced move disturbed, admitting equal-cost moves so plateau
drift is available. Only the pair is judged.

It is the only subsolver in the ladder that has cleared a certified defect (`forceClose 1/15` on the
run that verified it, where `rematch`, `daySolve`, `permute`, `compaction` and `eject` were all
0/15). It is also where a real bug lived: every operator opens its own candidate with
`beginCandidate()`, which *clears* the journal, so a compound move spanning several operator calls
cannot be rolled back through it. It now takes an explicit snapshot. Anyone extending the ladder
must do the same.

---

## 4. What was measured

### Stage A — screening (60 s, six paired seeds, single worker)

Δ soft against the shipped default:

| arm | tight-XL n12800-s1 | tight n06400-s1 |
|---|---|---|
| `--parity-moves` | **−12 %** (5/0/1, p = 0.063) | −4 % |
| `--compaction` | **−10 %** (4/1/1) | −1 % |
| `--kick-weighted` | −9 % (4/0/2, p = 0.125) | +5 % |
| `--rematch` | −6 % (5/1/0) | +17 % |
| `--repair-order 1` | −3 % (4/2/0) | +14 % |

`--repair-order 1` separately measured **−21 % (5/0/1, p = 0.063)** at tight n = 3 200 — a real
effect at a size where, as `STUDY.md` §4 says of that column, nothing else is measurable either.
`--repair-order 2` (regret-2) was killed at Stage S: tracking the runner-up through `scanBest`
weakens its prune and costs **2.5× the move rate**.

### Stage B — 300 s, six paired seeds, single worker

| arm | archived n12800-s1 | tight-XL n12800-s1 |
|---|---|---|
| `act` — actionable windows | +23 % (3/3) | −3 % (2/3) |
| `combo` — act + parity + compaction + rematch + weighted kick | +14 % (3/3) | −1 % (2/3) |
| `hr` — combo + hard repair + region rebuild | +32 % (1/5) | −5 % (3/2) |
| `tourn` — three constructions, descend the best | +22 % (1/5) | +4 % (2/3) |

And, on tight-XL n12800-s1:

| arm | Δ soft |
|---|---|
| `--lahc-canonical` (Burke–Bykov's rule) | +1 % (4/2) |
| `--restart-after 600000` (twice as often) | −5 % (3/2/1) |
| `--restart-after 300000` (four times as often) | +6 % (4/2) |
| `--restart-adaptive` | **identical to the default on all six seeds** — a no-op as implemented |
| `--engine dlas` | **does not reach feasibility**: 958 hard violations at 300 s |

Four readings.

**The "no spare draws" finding applies to the deep phase.** The new operators were put in the
deep-phase rotation precisely so they would not take draws from the bandit, and at 60 s they trended
better for it. At 300 s they do not, because the rotation's twenty-four attempts are now split five
or six ways instead of three, and the three they are split from — the wide permutation, the
worst-window ruin, the repack — are the ones carrying the improvement. This is `STUDY.md` §3 one
level up. The operators have since been moved out of the rotation (`--deep-extras` restores them)
and left in the hard-repair ladder, where they take a draw from nothing at all.

**More basins beat better basins.** `tourn` builds three constructions and descends the best; it is
worse on five of six archived seeds. That sharpens §6a's restart result rather than contradicting
it: what a long budget wants is more draws from the basin distribution, not more selective ones.
Restarting *more* often than the default (`--restart-after 300000`) is also worse, so the shipped
1.2 M is near a genuine optimum from both sides.

**DLAS confirms the acceptance result from the other side.** `STUDY.md` §9.3 records that a wider
LAHC bar prevents convergence; diversified late acceptance, which keeps the *maximum* of its history
as the bar, does not reach feasibility at all at this size. The three-level escape is not one design
among several — every alternative to it that has been measured fails to converge.

**The spread is still the binding constraint.** `off` on the archived instance returns soft
16 19 7 23 9 14 across six seeds at a fixed budget — a factor of 3.3. Six paired seeds resolve a
20 % effect with power 0.34 (`STUDY.md` §1). Every row above except the sign counts is inside that
band, and the honest reading of the whole table is "nothing here is large enough to see at this
sample size", not "these mechanisms are worthless".

### Stage C — the hour

See §6.

---

## 5. What a cheaper model should do next

In the order that maximises the chance of a real finding per hour of measurement.

1. **Re-measure the Stage A winners now that they are out of the deep-phase rotation.** `parity`,
   `compaction` and `rematch` are now hard-repair-only. The 60 s result that made them interesting
   was measured with them *in* the rotation, so it neither supports nor refutes the current build.
   Six paired seeds, 300 s, tight-XL and archived n = 12 800.
2. **Give one comparison twenty seeds.** Every table above is limited by the sample, not by the
   effect. Pick the single most promising arm — currently `hr` on tight-XL (3/2 at 300 s) — and run
   20 paired seeds at 300 s. That is about 3.5 hours on two cores at one worker per lane and it is
   the only way to settle a 20 % effect. `EXPERIMENT-PROTOCOL.md` §5 has the escalation rule.
3. **Measure at two workers.** Every campaign number is single-worker (two runs in parallel, one
   worker each — chosen to double throughput and remove the clock-driven cooperation noise). The
   shipped configuration is two cooperating workers, and mechanisms that change *basin diversity* —
   the region rebuild, the distant-elite adoption, the tournament — are exactly the ones whose value
   depends on the pool being diverse. Re-run the Stage B arms at `--threads 2`.
4. **Attack the equilibrium directly.** §3.2 says single-defect repair always loses the trade. The
   untested response is a **joint two-defect repair**: pick a lecturer-window defect and a
   group-window defect that share classes, and solve them *together*, so the move that opens the
   group window is priced against the lecturer window it closes in the same search. `forceClose` is
   the blunt version of this and `--flat-phase` was the cheap version, measured null at twenty seeds
   (§6b); the exact version is the one worth building.
5. **Tune what the compound move is allowed to spend.** `repairDescent` (4 000 candidates),
   `repairDefects` (6) and `repairBudgetMs` (2 000) were set by judgement, never measured. The
   mechanism only fires a few times a run, so its budget is nearly free — try 4× on each.
6. **Consider whether the objective is what should change.** This is the practical conclusion, and
   it is a modelling question rather than a search one. §3.2 shows that at the endgame the search is
   *optimal with respect to its own objective* over every neighbourhood tested: it does not close
   the last few вікна because (12) says closing them costs more than leaving them. If what a deanery
   actually wants is the smallest **total** number of windows, then α = 2 and
   β₇ : β₈ = 5 : 20 are what stand in the way, not the search — and no amount of further work on the
   search will change that. Two cheap experiments would settle it: run the shipped solver with
   α = 1, and with β₇ = β₈, and score both with the *unchanged* validator. If either returns a lower
   soft count, the objective and the goal have diverged, which is a result the dissertation should
   report and a `global_properties` row a deanery should be able to set.
7. **Do not re-litigate**: regret-2 everywhere, DLAS, `--restart-after 300000`, the construction
   tournament, and the new operators inside the deep-phase rotation. All measured, all worse, all
   kept behind flags with their numbers.

---

## 6. Stage C — what an hour buys

Three paired seeds, one worker, tight-XL n = 12 800, `off` against the full stuck-state machinery
(`hr` = actionable windows + parity + compaction + rematch + weighted kick + hard repair + region
rebuild). Every rung is read off the *same* run's trajectory, which single-worker runs make legitimate
(`ALGORITHM.md` §3.9): the incumbent at time t of an hour-long run is distributed as the final
incumbent of a t-long run at that seed. Every rung is therefore paired.

Median soft, three seeds:

| budget | `off` | `hr` |
|---|---|---|
| 60 s | 51 | 41 |
| 300 s | 29 | 31 |
| 900 s | 27 | 26 |
| 1 800 s | 19 | 22 |
| 3 600 s | **17** | **18** |

Paired Δ soft at the hour: −3, −2, +5 — mean **0.00**, two wins to one. A dead heat.

Two things are worth taking from it anyway.

**The hour still buys a great deal on a tight instance.** `off` goes 51 → 17 over the hour and `hr`
41 → 18, and both are still descending at the half-hour. The tight-XL family is a harder benchmark
than the archive at this size, exactly as `STUDY.md` §1 argues it should be, and it leaves the
budget response clearly visible rather than saturated.

**The stuck-state machinery is not paying for itself at this scale.** It is neutral at the hour and
it costs about 2 % of the move rate. The honest reading is not that the mechanism is wrong — §3
shows it does exactly what it was designed to do, and the compound move clears defects nothing else
can — but that what it clears is worth about as much as the candidates it spends. Where to look
next is §5.

## 6a. Stage D — the flattened escape phase

The mechanism §3.2 argues for directly: when the hard repair certifies a defect irreducible — or,
without it, when two consecutive kicks produce nothing — spend a bounded stretch of candidates
descending a **flattened** objective, in which the three comfort terms share one weight and
exponent one. Under (13) as it stands, exchanging a lecturer window for a group window loses in both
directions and the residual is an equilibrium; flattened, that exchange is a wash and the
equilibrium becomes a plateau the search can drift along. The incumbent is never chosen on the
flattened value, and the acceptance bar is refilled at the true scale on the way in and on the way
out.

300 s, six paired seeds, tight-XL n = 12 800:

| arm | median soft | Δ mean | W/L/T |
|---|---|---|---|
| `off` | 31 | — | — |
| `--flat-phase` (200 k-move stretches) | 31.5 | −2 % | 2/2/2 |
| `--flat-phase --flat-moves 50000` | 30 | **−8 %** | 3/3/0 |

The shorter stretch is the largest single effect the campaign measured that is still standing, and
six paired seeds cannot tell it from luck (3/3). It was therefore escalated to **twenty** paired
seeds under `EXPERIMENT-PROTOCOL.md` §5 — the only sample size that can settle an effect this size.

## 6b. Twenty seeds, and what they settle

`off` against `--flat-phase --flat-moves 50000`, 300 s, tight-XL n = 12 800, twenty paired PRNG
seeds, one worker each:

```
off      29 29 33 39 28 33 27 24 28 28 29 40 28 42 28 29 32 27 25 25   median 28.5  mean 30.15
flat50   33 24 35 27 23 34 31 27 26 36 37 27 24 30 31 25 32 24 34 24   median 28.5  mean 29.20
Δ        +4 −5 +2 −12 −5 +1 +4 +3 −2 +8 +8 −13 −4 −12 +3 −4 ±0 −3 +9 −1
```

Mean Δ soft **−0.95 (−3.2 %)**, wins/losses/ties **10/9/1**, medians **identical**, Wilcoxon
W⁺ 81.0 against W⁻ 109.0. The mechanism is **null**. The −8 % that six seeds showed was luck, and
this is the campaign's cleanest measurement precisely because it is the only one taken at a sample
size that can decide anything.

It is also the general lesson. Of everything measured here, one arm was escalated to a sample size
capable of resolving it, and the effect vanished. Every other number in this document is a
six-seed reading of a quantity whose run-to-run spread is a factor of three, and should be read as
"not resolved", never as "small but real".

---

## 6c. Stage E — the result the diagnosis actually pointed at

§3.2 established that the endgame is a strict local optimum **of the objective**, not an unsearched
region: with Π₇ ≈ 26 and Π₈ ≈ 12, closing a lecturer window is worth β₇(26²−25²) = 255 and opening
the group window that closes it costs β₈(12²−11²) = 460, so the exchange loses in both directions.
Every mechanism in §4 tried to search harder. The question none of them asked is whether the
objective is what should change.

The comfort exponent and the comfort weights are now settable (`--soft-alpha`, `--soft-equal`).
Every arm below is scored by the **unchanged** validator, so what is compared is the plain number of
вікна in the timetable, not the objective each arm was optimising.

**Twenty paired seeds, 300 s, one worker, two independent instances:**

| instance | soft, shipped → α = 1 with β₇ = β₈ = β₉ | Δ | W/L | Wilcoxon |
|---|---|---|---|---|
| tight-XL n12800-s1 | mean 27.7 → 24.8, median 28 → 24 | **−10.4 %** | 12/6/1 | W⁺ 45.5, W⁻ 125.5 (p ≈ 0.08) |
| archived n12800-s1 | mean 15.2 → 12.3, median 16 → 13 | **−19.1 %** | 14/5/0 | W⁺ 43.5, W⁻ 146.5 (p ≈ 0.04) |

It replicates, and the second instance is the stronger of the two. But the composition is the whole
finding, and it says something different from "the solver got better":

| term | shipped | α = 1, equal β | Δ |
|---|---|---|---|
| Π₇ lecturer windows | 9.68 | 5.05 | **−4.63** |
| Π₈ group windows | 5.05 | 7.11 | **+2.05** |
| Π₉ mixed online days | 0.42 | 0.11 | −0.32 |
| f(σ), the true weighted objective | 1 098 | 1 251 | **+153** |

**It is not finding better schedules. It is moving idle time off lecturers and onto groups** — which
is exactly the exchange β₈ : β₇ = 20 : 5 exists to forbid. Under the shipped preferences the result
is *worse* (f rises). Under preferences that count one idle пара as one idle пара, it is a fifth
better.

Three things follow, and they are the most useful conclusions the campaign reached.

**1. The residual window count is a policy setting, not a search limit.** The solver is already
locally optimal for what it has been asked to optimise. How many вікна survive, and whose they are,
is decided by β and α — and can be moved by about a fifth without touching the search at all. That
belongs in `global_properties` beside the other statutory figures an administrator edits, because it
is an institutional judgement: is one cohort's idle пара worth four of a lecturer's? β says yes; it
is not obvious, and nobody has been asked.

**2. The study's own reporting metric quietly disagrees with the objective.** `STUDY.md` reports
`soft = Π₇ + Π₈ + Π₉` as "what remains once a schedule is feasible, and the number a deanery reads",
while the search optimises Σβᵢ Πᵢ². Those are different preferences: `soft` already assumes all
windows are equal, which is precisely the assumption `--soft-equal` makes and the shipped β denies.
Every soft-cost table in this project is therefore scoring the solver against a yardstick it was
never asked to optimise, and the α = 1 arm wins on `soft` exactly because `soft` is its objective.
A paper should either report f, or report the three terms separately, or say plainly that `soft`
encodes an equal-weight preference the solver does not share.

**3. What is *not* claimed.** This is not evidence that flattening the objective produces better
timetables. It is evidence that the total-window metric is sensitive to the weights at about the
20 % level, and that the search delivers whatever the weights ask for. Whether a deanery prefers
fourteen fewer lecturer windows and six more group windows is a question for the deanery.

### 6c.1 The confirmation, which overturns the headline and keeps the mechanism

Neither the single-worker restriction nor the 300 s budget is what a deanery runs, so the comparison
was repeated at **two cooperating workers and 900 s** — the shipped configuration — on the archived
n = 12 800 instance, six paired seeds:

| | shipped | α = 1, equal β | Δ |
|---|---|---|---|
| total windows (`soft`) | mean 7.83, per seed 9 12 3 16 1 6 | mean 8.00, per seed 10 6 6 9 6 11 | **+2.1 %, W/L 2/4** |
| Π₇ lecturer windows | 5.83 | 3.67 | −2.17 |
| Π₈ group windows | 2.00 | 4.33 | +2.33 |
| f(σ) | 359 | 490 | +131 |

**The total-window advantage disappears; the redistribution does not.** Lecturer windows still fall
by two and group windows still rise by two, almost exactly cancelling. The 10–19 % gains measured at
300 s on one worker were an artefact of the regime: when the residual is large there is idle time to
move *and* slack to lose in the moving, and the accounting happened to come out ahead; at the
shipped configuration the residual is already about eight windows in twelve thousand classes, and
there is nothing left to gain by moving them — only somebody else to give them to.

So the corrected conclusion, which is the campaign's last and firmest:

**β and α decide _whose_ вікна survive, not _how many_.** The trade they govern is real, it is worth
about two windows each way at n = 12 800, and it is a genuine institutional choice — but it is not a
route to a better timetable, and the shipped weights are not costing a deanery anything in total
comfort. Nothing in this campaign found a configuration that beats the shipped one where it counts.

Two things from §6c stand regardless, because they do not depend on the total moving:

- The **choice** is real and is currently a source constant. If a deanery would rather its lecturers
  had gap-free weeks than its cohorts, `--soft-equal` buys that at about two group windows per two
  lecturer windows, and that trade belongs in `global_properties` where an administrator can make
  it, not in `state.hpp`.
- The **reporting inconsistency** stands and should be fixed in the write-up: `soft = Π₇+Π₈+Π₉`
  weights every window equally while the search minimises Σβᵢ Πᵢ² with β₈ : β₇ = 4 : 1. Reporting
  the three terms separately would have made this whole section unnecessary, because the
  redistribution would have been visible on the face of every table.

---

## 6d. Stage F — the exact joint two-defect repair

The last unbuilt item of §5, and the only direct attack on the equilibrium of §3.2. Every other
subsolver repairs one defect and is judged on the total, which is why they all fail: the exchange
that closes a lecturer's вікно opens the group's, and the objective correctly refuses it. The refusal
is right; the *pair* is what should have been searched.

`jointSolve` searches it. It takes the defect and its **coupled partner** — the bucket that holds
the same classes, which is the bucket that would acquire the вікно — lifts up to `jointK` classes
spanning both entities and both days (including cross-day pullers for each), and enumerates complete
joint arrangements under the true objective. Partner selection follows *coupling strength*, not
existing damage; an earlier version required the partner to already have windows and so excluded
precisely the tidy bucket the trade is with, firing on 3 defects in 10 instead of 27.

It works, in the sense that matters: it clears defects the single-defect ladder cannot, at about one
in thirty attempts — the same rate as `forceCloseRepair`, and by a different route.

It does not pay. **Two workers, 900 s, tight-XL n = 12 800, eight paired seeds**, the whole
stuck-state machinery against the shipped default:

| | soft, per seed | median | mean | W/L/T |
|---|---|---|---|---|
| shipped | 19 18 16 16 11 22 14 22 | 17 | 17.25 | — |
| + hard repair, joint repair, region rebuild | 15 18 26 16 18 27 24 14 | 18 | 19.75 | 2/4/2 (+14 %) |

Measured at the configuration that ships, which is the lesson §6c.1 paid for.

## 6e. Stage G — the whole university, and the one clear win

`README.md`'s known limitations say the whole-university mode "is untested against real data at
scale". The benchmark had the same gap from the other side: `emit.mjs` generates **one faculty**,
uniformly coupled, and a university is not that. A university is *near-decomposable* — dense
contention inside a faculty, sparse between.

`bench/compose-university.mjs` composes F single-faculty instances into one problem. Getting it
sound took four attempts and each failure is worth recording, because each is a way to build an
instance that looks right and is not:

1. **Ids are entry pairs, not parallel arrays** — `roomBuilding` is `[roomId, buildingId]`,
   `buildingTravel` is `["from>to", minutes]`.
2. **A class occupies an interval, not a bell.** Testing two entities for "different bell index"
   declares overlapping classes disjoint: 24 lecturer conflicts in the planted schedule.
3. **Π₅ is hard.** Merging a lecturer across faculties creates a cross-campus walk; a thirty-minute
   walk between classes fifteen minutes apart is a violation, and the planted schedule carried 246
   of them. Merging a *room* does the same thing by moving a class into another faculty's building.
4. **The fixed entries are part of the timetable.** An occupancy map built from the hidden schedule
   alone says a lecturer is free on a day they are already teaching.

With all four fixed the composition is sound — `--mode score-hidden` agrees with the validator on
every composed archive, and the planted schedule scores hard = 0. But it then produces **no
cross-faculty sharing at all**, and that is a quantitative finding rather than a bug: at these
densities (room utilisation ~63 %, lecturers teaching most days) there is no pair of rooms and no
pair of lecturers in different faculties whose planted usages are disjoint enough to be one
identity. **Contention cannot be added to a planted-feasible instance after the fact.** A benchmark
that wants genuine cross-faculty contention has to plant the whole university's schedule in one
pass — a change to `emit.mjs`, not a composition on top of it.

What the composed instances therefore test is scale and near-decomposable structure.
**900 s, two workers, three seeds, every instance 12 288–12 800 classes** — the same size, and (by
construction) very nearly the same number of groups, lecturers and rooms:

| instance | room slack | structure | soft |
|---|---|---|---|
| university, 4 faculties × 3 200 | 1.15 | decomposed | **0, 0, 0** — f(σ) = 0, reached in 149–410 s |
| university, 8 faculties × 1 600 | 1.15 | decomposed | **0, 1, 3** |
| archived n12800 | 1.15 | uniform | 1, 3, 6, 9, 12, 16 (median 7.5) |
| university, 4 faculties × 3 200 | 1.00 | decomposed | **21, 24, 25** |
| tight-XL n12800 | 1.00 | uniform | 11 … 22 (median 17) |

The first reading of the top three rows was that difficulty is coupling rather than size — a
twelve-thousand-class *university* solved to proven optimality where a uniformly coupled instance of
the same size is not. The fourth row was run to check that reading and refutes it: the same
composition at `roomSlack 1.0` returns 21–25, no better than the uniform instance of the same
density, and far worse than the decomposed instance of the comfortable one.

So the honest conclusion is the two-factor one:

**Room slack dominates, and structure only decides once slack is comfortable.** Tightening the room
dimension moves the uniform instance from 7.5 to 17 and the decomposed one from 0 to 23 — the larger
effect of the two by a wide margin. Decomposition is worth everything at `roomSlack 1.15` (0 against
7.5) and worth nothing at `roomSlack 1.0`. That fits the mechanism: a decomposed instance is F
independent problems, and F independent *easy* problems are trivial while F independent *hard* ones
are still hard.

Three things follow.

- **The known limitation is answered, with a condition attached.** Whole-university scheduling is
  not the hard case it was assumed to be — at realistic room slack it is markedly *easier* per class
  than one faculty of the same total size, and the search exploits the decomposition without being
  told to. Where rooms genuinely bind, that advantage disappears.
- **`roomSlack` is the benchmark parameter that matters**, and `STUDY.md` §1 already says so ("the
  tight set matters more than the size of the archive"). This measurement puts a number on it at
  n ≈ 12 800: a factor of two on the uniform instances and the difference between 0 and 23 on the
  decomposed ones. A scaling claim quoted without the density it was measured at is not a claim.
- **Where the remaining effort belongs**: not in the search, which solves the decomposable
  comfortable case to optimality, and not in more operators — but in the benchmark, which should
  plant a whole university's schedule in **one pass** so that genuine cross-faculty contention can be
  studied at all. The composition above cannot manufacture it, and that is proved rather than
  assumed.

---

## 6f. Stage H — the one-pass university, and difficulty against coupling

§6e ended by saying that contention cannot be added to a planted-feasible instance after the fact,
and that a benchmark wanting it has to plant the whole university in **one pass**. That is
`bench/build-uni.mjs` + `bench/emit-uni.mjs` + `bench/generate-uni.mjs`.

It is the shipped builder with one dimension added rather than a rewrite, and the claim is checkable
rather than rhetorical: **at `faculties: 1, serviceShare: 1, sharedRoomShare: 0` it reproduces
`timetable-bench/emit.mjs` byte for byte**, at every size and seed tried. The two extremes consume no
random draws, so the PRNG stream is identical and the new generator is provably a superset of the
old one.

The structure the shipped builder already had in embryo is what made this cheap: a cohort is taught
in its home корпус, and a lecturer stays in one корпус for a whole day. What it lacked was a *faculty*
— its lecturer pool is global, so every cohort may contend with every other for every teacher. That
is one end of a scale, and the new knobs place an instance anywhere on it:

| knob | meaning |
|---|---|
| `--faculties F` | the university is F faculties, one корпус each |
| `--service S` | the share of lecturers who teach for *any* faculty; the rest teach only their own |
| `--shared-rooms R` | the share of rooms in a central block every faculty may book |

The planted schedule is still built by walking the week and placing classes into resources free at
that moment, so **a perfect answer provably exists at every coupling level** — checked, not assumed:
the composed hidden schedule scores hard = 0 on every instance generated, and the C++ evaluator
agrees with the independent validator on all of them.

### What coupling costs

n = 12 288, four faculties, 15 % shared rooms, `roomSlack 1.15`, **900 s, two workers, three PRNG
seeds**. Only the service share varies; the size, the room count, the lecturer count and the group
count are identical across rows.

The ladder was first read at three seeds and then extended to six, and the extension is worth
showing, because the three-seed reading overstated the effect by about a factor of two — the same
lesson §6b learned about `flat50` and §6c.1 about the objective.

| cross-faculty service teaching | soft, six seeds | median | mean | *(three-seed mean)* |
|---|---|---|---|---|
| 0 % — faculties share nobody | 0, 1, 3, 3, 8, 13 | **3.0** | **4.67** | *2.0* |
| 5 % | 5, 6, 8, 10, 11, 11 | **9.0** | **8.50** | *6.3* |
| 20 % | 6, 6, 8, 10, 14, 18 | **9.0** | **10.33** | *8.0* |
| 100 % — one global pool | 4, 4, 6, 9, 13, 13 | 7.5 | 8.17 | *7.0* |

Mann-Whitney against the uncoupled level: p ≈ 0.128 at 5 %, **0.066** at 20 %, 0.109 at 100 %.

**A little coupling costs most of the difficulty — direction consistent, magnitude not resolved.**
The uncoupled level is better than all three coupled levels on both the mean and the median, the
median jumps 3 → 9 as soon as *any* teaching is shared, and going on from 5 % to 20 % to 100 % adds
little. The shape is a saturation rather than a slope: what matters is whether the faculties are
coupled at all, far more than how much.

What six seeds do **not** support is a number. No comparison reaches p < 0.05, the spread inside the
uncoupled level alone runs 0 to 13, and the three-seed means that first suggested a tripling are
already known to have been luck. The honest claim is the ordering, not the ratio.

Two consequences, and the first one corrects §6e.

**The shipped benchmark's coupling is realistic, not worst-case.** §6e speculated that the archived
n = 12 800 instance is "pathologically coupled" because a composed, uncoupled university of the same
size solved to zero. This measurement says otherwise: a university with 5–20 % service teaching —
which is what service teaching actually looks like in a Ukrainian HEI — lands at soft 6–8, and the
archived instance sits at median 7.5. The benchmark is in the right place. What was
unrepresentative was the *composition*, whose zero coupling is the artificial end of the scale.

**And the whole-university mode is answered properly.** Scheduling four faculties at once is not
harder than scheduling one faculty of the same total size; at realistic coupling it is
indistinguishable from it. The known limitation can be closed on the basis of a measurement rather
than an argument — with the caveat that these instances are still generated rather than observed,
which `STUDY.md` §7 already states for the whole benchmark.

*Caveats, stated as the protocol requires.* A row is **one instance**, so instance-to-instance
variation is confounded with the coupling it was generated at: the ladder varies the PRNG seed six
ways but the planted schedule only once per level. Before any of this is quoted as a curve rather
than as a direction, it needs several *instance* seeds per level as well — which is a day of
measurement and the obvious next experiment.

---

## 6g. The two factors, and how they interact

§6e found that decomposition was worth everything at `roomSlack 1.15` and nothing at 1.00, from two
composed instances. §6f varied coupling properly with a generator built for it. Running that ladder
at both densities gives the whole picture, and the two factors turn out not to be additive.

n = 12 288, four faculties, 15 % shared rooms, 900 s, two workers, three PRNG seeds per cell. Soft
cost, per seed and mean:

| cross-faculty service teaching | `roomSlack 1.15` (six seeds) | `roomSlack 1.00` (three seeds) |
|---|---|---|
| 0 % | 0, 1, 3, 3, 8, 13 — **4.67** | 13, 13, 14 — **13.3** |
| 5 % | 5, 6, 8, 10, 11, 11 — **8.50** | 6, 13, 16 — **11.7** |
| 20 % | 6, 6, 8, 10, 14, 18 — **10.33** | 9, 15, 21 — **15.0** |
| 100 % | 4, 4, 6, 9, 13, 13 — 8.17 | 10, 12, 18 — 13.3 |

Read down the columns and across the rows:

- **Room slack is the primary factor.** Every cell gets worse when the room dimension binds — by
  2.9× at zero coupling and about 1.4× everywhere else, and the tight column is worse than the
  comfortable one in every row.
- **Coupling is a secondary factor that only expresses itself when rooms are comfortable.** At
  `roomSlack 1.15` the residual goes 4.67 → 8.50 → 10.33 as service teaching rises. At
  `roomSlack 1.00` the column is flat — 13.3, 11.7, 15.0, 13.3 — with a spread inside each cell
  (6 to 21) far larger than the differences between them.
- **So the factors interact.** Decoupling the faculties buys a great deal when rooms are not the
  binding constraint and nothing at all when they are.

The mechanism is not mysterious. Coupling through shared teachers is a constraint on *who* can be
where; room scarcity is a constraint on *how many* classes can run at once. When rooms bind, the
second constraint is active everywhere and the first is slack almost everywhere, so relaxing it
changes nothing. This also explains §6e's composed instances without appealing to their artificial
zero coupling: at `roomSlack 1.15` they were decoupled *and* comfortable, which is the one cell in
the table where the solver reaches zero.

**The practical reading, for a deanery with вікна in its timetable**: room capacity and room
eligibility are the lever, and reorganising who teaches across faculties is not. Widening `roomIds`
on the working curriculum items — which is what «Призначення аудиторій» is for — moves the residual
further than any structural change to service teaching, and further than anything this campaign was
able to do to the search. The tight column is the one a deanery with a full building lives in, and
in that column nothing about faculty structure helps at all.

**And the reading for the campaign as a whole.** Forty hours of work on the search produced no
improvement over the shipped configuration; a day of work on *characterising the problem* produced
three results that change what the numbers mean. With a solver this well tuned, the marginal value of
another operator is close to zero and the marginal value of knowing which instance properties drive
difficulty is high. That is worth saying plainly in a thesis, because it is the opposite of the
conclusion a reader expects an optimisation chapter to reach.

---

## 6h. The coupling ladder, sampled properly — and what survives

§6f's caveat said the ladder varied the PRNG seed but planted only **one instance per level**, so
instance-to-instance variation was confounded with the coupling it was generated at, and that the
ladder needed several instance seeds before it could be quoted as anything but a direction. That
experiment has now been run: three instance seeds × three PRNG seeds per level, 300 s, two workers,
nine measurements per cell.

| service teaching | per-instance means | all nine runs | mean |
|---|---|---|---|
| 0 % | 11.0, 9.7, 13.3 | 7 8 9 12 12 12 13 13 16 | **11.33** |
| 5 % | 11.3, 22.0, 15.0 | 9 9 12 13 18 18 21 21 24 | **16.11** |
| 20 % | 15.7, 20.3, 7.7 | 6 6 11 12 15 16 20 21 24 | **14.56** |
| 100 % | 16.0, 15.3, 8.7 | 6 10 10 12 13 13 16 19 21 | **13.33** |

Mann-Whitney against the uncoupled level: p ≈ 0.064 at 5 %, **0.354** at 20 %, **0.354** at 100 %;
pooling all coupled runs against all uncoupled ones gives p ≈ 0.125.

**The coupling effect does not survive proper instance sampling.** Look at the per-instance means:
within the 20 % level they run 7.7, 15.7 and 20.3 — a spread wider than the distance between any two
levels. Which instance was planted matters more than how coupled it was. The ordering that six PRNG
seeds on one instance suggested (4.67 / 8.50 / 10.33 / 8.17) is still faintly visible in the means,
but 20 % and 100 % are now indistinguishable from 0 %, and the whole thing is inside the noise.

This is the **third** correction in the same direction, and the pattern is the campaign's most
transferable methodological finding: *every effect measured here shrank or vanished as the sample
grew.* `flat50` went from −8 % at six seeds to null at twenty; the objective-shape result went from
−19 % at one configuration to +2 % at the shipped one; and the coupling ladder has gone from
"triples the residual" at three seeds to "not resolved" at nine. On a problem whose run-to-run
spread is a factor of three, a small sample does not give a small error bar — it gives a *wrong
centre*.

### What does survive: the room dimension

The same data answer the other factor decisively. Matching level by level at 900 s:

| service teaching | `roomSlack 1.15` | `roomSlack 1.00` |
|---|---|---|
| 0 % | 4.67 | 13.33 |
| 5 % | 8.50 | 11.67 |
| 20 % | 10.33 | 15.00 |
| 100 % | 8.17 | 13.33 |

Every level is worse when the room dimension binds, and pooled — 24 runs against 12 — the means are
**7.92 against 13.33**, medians 8 against 13, **Mann-Whitney p ≈ 0.002**. That is the only
instance-property effect this campaign has resolved at a sample size capable of resolving anything,
and it is resolved comfortably.

**So the two-factor conclusion of §6g stands, but only half of it is evidence.** Room slack is a
large, significant, consistent determinant of how good a timetable the solver returns. Cross-faculty
coupling is, at most, a small one, and nine runs per level cannot see it. The practical advice
survives and gets sharper, because it rests on the half that is proved: **for a deanery with вікна in
its timetable, room capacity and room eligibility are the lever** — «Призначення аудиторій» is worth
more than anything in this campaign, more than any structural change to service teaching, and more
than any of the fourteen search mechanisms measured here. And a scaling claim quoted without the
`roomSlack` it was measured at is not a claim.

---

## 6i. The room-slack curve — the one lever that measurably works

§6h resolved *that* room slack matters (p ≈ 0.002) but not *by how much*, and "add rooms" is only
advice if it comes with a number. So: the same university at five room densities, everything else
held constant — n = 12 288, four faculties, 20 % service teaching, 15 % shared rooms — with three
instance seeds and three PRNG seeds at every level, 300 s, two workers. Nine measurements per rung.

| `roomSlack` | rooms | soft, median | soft, mean | against 1.00 | Mann-Whitney |
|---|---|---|---|---|---|
| 1.00 | 582 | 20.0 | **22.56** | — | — |
| 1.05 | 611 | 17.0 | **17.67** | −21.7 % | p ≈ **0.031** |
| 1.10 | 640 | 16.0 | 18.33 | −18.7 % | p ≈ 0.200 |
| 1.15 | 669 | 16.0 | **15.00** | −33.5 % | p ≈ 0.058 |
| 1.30 | 756 | 7.0 | **9.89** | −56.2 % | p ≈ **0.009** |

Pooling the two tight rungs against the two comfortable ones: 20.11 against 12.44, **p ≈ 0.012**.

**Thirty per cent more rooms halves the вікна.** 582 → 756 rooms takes the residual from 22.6 to 9.9,
the ordering is monotone in the median across all five rungs, and both endpoints of the comparison
are significant at a sample size that has refused to certify anything else in this campaign.

Two ways to read it for a deanery, and the second is the useful one:

- *Crudely, across the whole range*: about **fourteen extra rooms per вікно removed** at this scale.
- *Honestly, by segment*: 5.9 rooms per window over the first 29 rooms added, then 22 and 17 over the
  next two segments. The per-segment slopes are **not** resolved at nine runs each — the 1.10 rung
  even sits slightly above 1.05 — and the shape may well be convex, with the cheapest windows going
  first. What is resolved is the direction and the endpoints.

### Why this matters more than anything else in this document

This is the **first manipulation in the whole campaign to produce a significant improvement in
timetable quality**, and it is not a change to the search. Fourteen search mechanisms were
implemented and measured and none of them beat the shipped configuration; one input property, varied
over a range a real institution could plausibly move, halves the residual.

For the thesis that is a conclusion rather than a disappointment, and it should be stated as one: on
a well-tuned solver, the remaining вікна are a property of the **instance**, not of the search, and
the instance is the thing an institution can actually change. The concrete forms that takes in this
system are:

- **Room eligibility, not just room count.** `roomSlack` widens the pool the generator draws from,
  and the same effect is available to a deanery for free by widening `roomIds` on the working
  curriculum items — which is exactly what «Призначення аудиторій» exists to edit. A class that names
  four eligible rooms where six would do is a class contributing to the tight end of this curve.
- **The number worth quoting in a scaling claim.** Every soft cost in `STUDY.md` is measured at
  `roomSlack 1.15`. This curve says that one parameter moves the headline figure by a factor of two
  across a plausible range — more than the difference between the C++ solver and any variant of it
  measured here. A residual quoted without its room density is not comparable to anything.

---

## 6j. Room *eligibility* is not room *capacity* — the free lever does not work

§6i showed that thirty per cent more rooms halves the вікна, and closed by suggesting the same
benefit might be available for nothing by widening `roomIds` on the working curriculum items —
«Призначення аудиторій» rather than a building. That was a hypothesis and it is now measured, and it
is **wrong**.

The experiment is unusually clean. `--eligibility K` changes how many alternative rooms each class
names — its own room plus up to K plausible alternatives of the same kind in the same корпус — while
the room count, the planted schedule and every other property stay **identical**. All five levels
share the same hidden schedule (reference soft 14 908) and the same 582 rooms; only the mean number
of rooms a class may use changes.

`roomSlack 1.00`, n = 12 288, three instance seeds × three PRNG seeds, 300 s, two workers:

| `K` | mean rooms per class | median | mean | against K = 1 | p |
|---|---|---|---|---|---|
| 1 | 1.97 | 29.0 | 28.22 | — | — |
| 2 | 2.46 | 23.0 | 24.78 | −12.2 % | 0.185 |
| 4 (shipped) | 3.44 | 20.0 | 24.33 | −13.8 % | 0.270 |
| 8 | 5.39 | 25.5 | 26.50 | −6.1 % | 0.564 |
| 16 | 9.30 | 23.0 | 22.89 | −18.9 % | 0.102 |

Pooled narrow (K = 1, 2) against wide (K = 8, 16): 26.50 against 24.59, **p ≈ 0.448**. The trend is
weakly downward and **not monotone** — K = 8 sits above K = 4 — and nothing approaches significance.
Set beside §6i's room-count ladder, measured on the same generator at the same size with the same
design, the contrast is the finding:

| lever | change | effect | p |
|---|---|---|---|
| room **count** (§6i) | 582 → 756 rooms | 22.56 → 9.89 (**−56 %**), monotone | **0.009** |
| room **eligibility** (§6j) | 1.97 → 9.30 rooms named per class | 28.22 → 22.89 (−19 %), non-monotone | 0.102 |

**Capacity is the constraint; assignment flexibility is not.** The mechanism is visible in how the
generator draws alternatives: `roomsLike` offers rooms of the *same kind in the same корпус*, so
widening K can only redistribute demand inside a pool whose size it cannot change. When a faculty's
computer labs are all busy at 11:50, naming nine of them instead of two does not create a tenth. More
rooms creates one.

That has a direct consequence for the advice in §6i, and it is worth stating plainly because it is
the opposite of what a solver author would like to be true: **there is no free version of the room
lever.** Filling in «Призначення аудиторій» more generously is worth doing for the reasons the
project already gives — a lecture for 120 students in a 12-seat lab is a real failure the board
exists to catch — but it is not a route to a gap-free timetable, and this campaign can now say so
with a controlled measurement rather than a plausible argument.

One qualification, and it is the next experiment rather than a hedge. The eligibility knob above
widens *within a kind and a building*. The generator also has `unrestrictedShare` — the share of
classes that name **no** room at all and may therefore use any of the faculty's rooms, across kinds
and корпуси. That is a strictly larger kind of flexibility, and whether *it* buys what capacity buys
is a different question from the one answered here.

---

## 6k. The unrestricted-room share — the campaign's first large search-side finding

This is the experiment §6j closed by asking for, and it does not answer §6j's question. It answers a
different and better one.

`--unrestricted-share u` sets the share of classes that name **no** room. Such a class has
`anyRoom = true`, so its room domain is every room the faculty owns — all 582, across every kind and
every корпус. Five levels, `roomSlack 1.00`, n = 12 288, F = 4, service 20 %, shared rooms 15 %,
three instance seeds × three PRNG seeds each, 300 s, two workers. All fifteen instances pass the
Stage 0 agreement gate.

| level | classes naming no room | mean room domain | median soft | mean soft | Π₇ | Π₈ | Π₉ | median f | mean moves |
|---|---|---|---|---|---|---|---|---|---|
| ur0 | 12.6 % | 74.0 | 9 | 9.89 | 5.7 | 3.4 | 0.8 | 390 | 31.8 M |
| ur015 | 26.0 % | 150.3 | 23 | 26.11 | 15.2 | 10.0 | 0.9 | 2 845 | 25.4 M |
| ur035 | 43.2 % | 252.2 | 31 | 30.22 | 17.2 | 11.4 | 1.6 | 5 165 | 20.1 M |
| ur060 | 64.9 % | 377.2 | 37 | 38.67 | 20.2 | 15.1 | 3.3 | 8 045 | 15.8 M |
| ur10 | 100 % | 582.0 | 46 | 48.22 | 26.7 | 17.7 | 3.9 | 9 035 | 12.8 M |

Every column is monotone. Mann-Whitney against ur0: p = 0.0006, 0.0013, 0.0004, 0.0003. Spearman
across all 45 runs, against the measured unrestricted share, ρ = **0.800** (n = 45, t = 8.76). After
nine sections of effects that shrank as the sample grew, this one is five times the size of anything
else the campaign has measured and it is not close to the noise floor.

### Why it is not a difficulty result

The obvious reading — "instances with more roomless classes are harder" — is wrong, and the
generator's construction is what rules it out.

- **The planted schedule is identical at every level.** All five ur levels of a given instance seed
  have byte-identical `hidden` and identical reference soft (14 832 / 14 808 / 14 908 for s1 / s2 /
  s3). The perfect answer is the same timetable and scores the same at ur0 and at ur10.
- **The instance is being *relaxed* as the result gets worse.** Emptying a class's `roomIds` removes
  a constraint. Every schedule feasible at ur0 stays feasible at ur10; the reverse does not hold. The
  solver is handed a strictly larger feasible set and returns an answer five times worse.
- **Tightness is flat.** Total availability-constraint size across the levels is 48.8, 52.1, 48.8,
  52.1, 49.7 kB — non-monotone, and uncorrelated with the result. The PRNG draws shift between
  levels, so the constraint sets are not identical, but they are not systematically different either.
- **The only monotone instance property is the mean room domain**, 74 → 582, and the result tracks
  it.

A solver that gets much worse when its search space is enlarged is not meeting a harder problem. It
has a deficiency that scales with room-domain size. That is a **search** finding, and this campaign
has not produced one before.

### The mechanism, and the two candidates it leaves

`Worker::scanBest` is the room chooser used by construction, by the repair ladder, and — through
`roomSample` — by four other operators. Reading it against a 582-room domain gives two suspects:

```cpp
const int roomLimit = (wide || g.roomCount <= o_.roomScanFullBelow)   // 256
                          ? g.roomCount
                          : std::min(g.roomCount, o_.roomSample);     // 96
...
int travelBudget = 6;
for (int m = 0; m < roomLimit; ++m) {
  ...
  if (p_.travelKnown && travelBudget > 0) { --travelBudget; sc += travelCostOfAdding(...); }
}
```

1. **Coverage.** 96 of 582 rooms is 16 % of the domain, so the scan is choosing a room from a sixth
   of the options. The room start is randomised per slot, so the sample is unbiased — this is a
   variance argument, not a blind-spot one.
2. **Travel pricing.** `travelCostOfAdding` is O(bucket) *per room*, so only the first six rooms of a
   slot are priced for the journey. The remaining ninety are scored as though travel were free. That
   costs nothing when a domain is five rooms in one корпус — the omitted rooms are in that корпус
   too. It costs everything when the domain spans every корпус: the scan proposes cross-campus
   placements whose real cost the acceptance test then rejects, so the candidate rate and the
   candidate quality fall together, which is exactly the pair of collapses in the table.

Both predict the direction. They are separated by the K block, and (2) has a fix that costs nothing:
`State::buildingsOn` computes, once per slot at the same O(lecturers + groups) the people-clash hoist
already pays, the set of buildings this class's own people already occupy that day. When that set is
a **single** building, every room in it has `journeyMinutes == 0` against all of them — travel-free
by construction, no per-room evaluation needed, no travel violation possible. `--room-building-first`
spends the whole sample on those rooms and only falls through to the rest if they yielded nothing.
With two or more buildings in use the premise fails and the filter is not applied at all.

### What it means for the application, before any of that is measured

The share of roomless classes is not a benchmark parameter. It is the fraction of curriculum items
nobody filled in under «Призначення аудиторій», and in a real faculty it is whatever the deanery
happened to do. This table says that share is, by a wide margin, the most consequential single input
property the campaign has measured — ahead of room slack (§6i), ahead of cross-faculty coupling
(§6h), and ahead of every search-side arm that has been tried.

Note carefully how it composes with §6j. Widening `roomIds` from one room to nine changes nothing
(§6j, p ≈ 0.448). Emptying `roomIds` entirely makes things dramatically worse (this section,
p ≈ 0.0003). **Naming some rooms is what matters; how many is nearly irrelevant.** The operational
advice is therefore sharp and cheap: it is worth ensuring every curriculum item names *at least a
few* plausible rooms, and it is not worth anyone's time to name more than a few.

Whether the effect survives a fixed solver is the K block's question, and the answer changes which
of those two sentences is a recommendation and which is a bug report.

---

## 6l. The room sample — the shipped default is on the wrong side of it

§6k left two candidate mechanisms. This settles which, and the answer is neither of the two readings
a solver author would reach for first.

`--room-sample N` sets how many rooms `scanBest` examines per slot once a class's domain exceeds
`roomScanFullBelow`. 180 s, single worker, three instance seeds × three PRNG seeds per cell, on the
two levels of §6k's ladder where the effect is largest:

| rooms scanned per slot | ur060 median | ur060 mean | ur10 median | ur10 mean | mean moves |
|---|---|---|---|---|---|
| 24 | **43** | 46.6 | **59** | 61.4 | 7.06 M / 6.12 M |
| 96 (shipped) | 61 | 60.9 | 76 | 76.9 | 4.91 M / 3.86 M |
| 256 | 56 | 57.7 | 106 | 108.2 | 2.93 M / 2.24 M |
| all 582 | 79 | 97.2 | 319 | 411.0 | 1.74 M / 1.42 M |

Paired against the shipped default, `--room-sample 24` wins **8 of 9** seeds at both levels, mean Δ
−14.33 (ur060) and −15.44 (ur10) — roughly −24 % and −20 %. The full scan loses 7 of 9 and 9 of 9.

**Coverage is not the problem; paying for coverage is.** Looking at more of a class's options makes
the answer worse, monotonically, because the budget it costs was buying more moves elsewhere. This
is the same shape as the study's oldest finding — a portfolio with large neighbourhoods has no spare
draws (S §3) — arriving through a completely different door.

### What is actually expensive, and why the sample exists at all

The room loop pays two costs per candidate room, and **neither of them had to be paid per room**.

**`roomClashesAt` walks the room's day.** Answering "is this room free?" means iterating
`buckets_[roomBucketId(room, day)]`, so pricing a 582-room domain is 582 walks. `roomSample` is a
bound on that walk count and nothing else. But room buckets already carry `occNum` / `occDen` fields
— `BucketStat` has them for every family, the people families use them for Π₇/Π₈, and `recompute`
returned early for rooms without filling them. Filled, the same question is one `Mask::intersects`.
`State::roomFreeAt` is exact rather than approximate; the one case a union of masks cannot settle is
the room the class already occupies, where the overlap may be its own, and that falls back to the
walk — one room in the domain, at most.

That exactness is not an argument, it is measured. `--room-free-mask 3` answers from the walk, as
the shipped code does, and checks the mask against it on **every single query**:

| instance | queries | mismatches |
|---|---|---|
| uni-ur0-n12800-s1 | 169 285 836 | **0** |
| uni-ur060-n12800-s1 | 688 650 472 | **0** |
| uni-ur10-n12800-s1 | 753 216 822 | **0** |

The query counts are themselves a measurement: the same 60 s of the same search asks 4.5× as many
room questions at ur10 as at ur0. That ratio is §6k's mechanism in one number.

**`placementAllowed` re-answered a room-independent question 96 times per slot.** This is the larger
of the two and was hiding in plain sight. The predicate is

```cpp
bool placementAllowed(i, day, timeIdx, parity, room)   // takes a room…
```

but of its three tests, only the room's own availability window and the room's own per-day cap
depend on `room`. MAX_CLASSES_PER_DAY for the class's **lecturers and groups** walks their day
buckets and is a function of (class, day, parity) alone — the same answer for every room in the
slot, and the whole slot fails if it fails. The people-clash and window costs are hoisted out of
that loop already, for exactly this reason; this one was overlooked because it lived behind a
signature with a room argument. Split into `peopleCapsAllow` and `roomAllows`, it is asked once per
slot (`--hoist-day-caps`).

Both changes are behaviour-identical by construction, which is what makes them worth measuring
separately: any difference in the result is a difference in how many candidates the same search got
through, with nothing else varying. E7 and E8 in `OPTIMIZATION-IDEAS.md`.

---

## 6m. E7 — the mask, and a control arm that did exactly what it was supposed to do

Six paired seeds per cell, 180 s, single worker, three instance seeds per level.

| arm | ur0 median | ur060 median | ur10 median | moves (ur10) |
|---|---|---|---|---|
| `off` (shipped) | 16.5 | 57 | 76 | 3.65 M |
| `rfm1` mask fast path, exact | 16.5 | 57 | 76 | 3.85 M |
| `rfm2` mask only, no walk ever | **13.5** | 55 | **60.5** | **5.07 M** |
| `rfm2f` `rfm2` + no sampling | 13.5 | 52.5 | 102 | 2.10 M |
| `s24` (§6l's winner, for scale) | 15 | 48 | 65 | 5.84 M |

Paired against the shipped default: `rfm2` is −18.50 mean at ur10 (W/L/T 4/1/1), −6.50 at ur060,
−4.25 at ur0. It buys 25–39 % more candidates and spends them well.

### The control arm is the most informative row

`rfm1` was built to be **behaviour-identical**: `roomFreeAt` agrees with `roomClashesAt(...) == 0`
on every input, so a free room skips the walk and a busy one is still counted exactly. It ties the
shipped default on **22 of 24 paired runs** — 11/12 at ur0, 5/6 at ur060, 6/6 at ur10, with a mean Δ
of −0.50, −1.00 and 0.00.

That is what a correct behaviour-identical change looks like, and it is worth pausing on for two
reasons. It validates the claim empirically, alongside the 1.61 billion query checks of §6l. And it
says something about the search: `rfm1` runs 2–5 % more moves and converts **none** of them into
quality. The tail is not short of attempts. §6l's ladder wins by 25–39 %, not by 5 %, which locates
where the threshold is rather than merely showing that one exists.

### The full scan is still unaffordable, and that is the finding

`rfm2f` removes the sample entirely on top of the mask, and it is the worst arm at ur10 — 2.10 M
moves against the shipped 3.65 M. Making the freeness test O(1) did not make a 582-room scan
affordable, so **something else in the room loop is still O(bucket) per room**. There is exactly one
candidate left, and it is `placementAllowed` (§6l): a predicate that takes a room but whose
MAX_CLASSES_PER_DAY test for the class's own lecturers and groups does not depend on it, plus the
room's own cap, which does. E8 hoists the first and caches the second.

This is why the arm mattered even though it lost. A cheap arm that fails for a *legible* reason
locates the next cost; a cheap arm that fails ambiguously wastes the budget it cost. Design the
ladder so the losing rungs are diagnostic.

---

## 6n. E8/E9 — the last two per-room costs, and the campaign's first significant search-side win

Three changes, each removing one O(bucket) cost that a room scan was paying **per candidate room**,
and each provably semantics-preserving:

| | what it removes | where |
|---|---|---|
| E7 `--room-free-mask 2` | the clash walk | `roomClashesAt` → `roomFreeAt`, one AND |
| E8 `--hoist-day-caps` | the class's own MAX_CLASSES_PER_DAY, asked once per room for one answer | hoisted to once per slot |
| E9 `--cap-cache` | the room's own cap walk — per room by nature, so cached rather than hoisted | `BucketStat::cntNum/cntDen` |

Nine paired seeds per cell, three instance seeds per level, 180 s, single worker. Pooled over all
27 pairs, against the shipped default:

| arm | W/L/T | mean Δ soft | sign test | Wilcoxon |
|---|---|---|---|---|
| `hoist` (E8 + E9) | 15/10/2 | −7.41 | 0.424 | 0.058 |
| `allsamp` (E7 + E8 + E9) | **21/6/0** | **−9.00** | **0.0059** | **0.0198** |
| `all` (`allsamp`, sampling removed) | 14/13/0 | +4.33 | 1.000 | 0.494 |

Per level, and the throughput that explains it:

| | ur0 | ur060 | ur10 |
|---|---|---|---|
| `off` median / moves | 16 / 8.22 M | 61 / 4.36 M | 76 / 3.48 M |
| `allsamp` median / moves | 13 / 8.88 M | 62 / 6.26 M | **59** / **5.39 M** |
| candidates gained | +8 % | +44 % | +55 % |
| paired W/L | 14/4 | 7/2 | 7/2 |

**This is the first search-side change the campaign has taken to significance.** Everything before it
was either an instance property (§6h–§6k) or a mechanism that measured null. It is worth being
precise about why this one is different, because the reason is methodological rather than clever:
the three changes do not alter a single decision the search makes. They alter only how many
decisions fit in the budget. There is no new operator competing for draws, no re-weighted objective,
nothing to displace what was already paying — which is exactly the failure mode that killed
`dayfix`, `winfix`, `--cost-aware`, and the four Stage-B operators (S §3, §4; §B2 of the queue).

Note also which rows are *not* significant. `hoist` alone is 15/10 at p = 0.42 — the day-cap hoist
matters only because it is one of three, and reported on its own it would have read as another null.
The composed arm is the finding; the decomposition is there so a later reader knows which part to
keep if one has to be reverted.

### The full scan stays dead, and this is now a real result rather than a missing fix

`all` removes sampling on top of all three fixes and is a **null with a positive mean**: 14/13,
+4.33. §6m suspected the full scan was failing because the loop still held an O(bucket) cost. It no
longer holds one, and the full scan still fails.

So the conclusion inverts. **Sampling is correct.** Examining six times as many rooms is six times
the work however cheap each room becomes, and the value of examining more of them is sublinear —
the scan is looking for a room that is free and lightly penalised, and past a few dozen candidates
the marginal one is almost never better than the best already seen. §6l's ladder was not exposing a
bug in the sample; it was measuring the position of a genuine optimum, and finding the shipped
default on the wrong side of it.

What remains open is where that optimum sits **now** that looking is cheap, since the cost curve the
ladder was climbing has changed underneath it. That is E10. And whether any of it survives on the
sets that decide defaults — archived and tight-XL, two workers, classes that name a handful of rooms
— is E11, which is the only experiment here whose answer can change a shipped default.

---

## 6o. E10 — the two levers are substitutes, not complements

The sample ladder, re-run on top of the cheap scan. The prediction was that the optimum would move
**up**: with each room cheaper to examine, more of them should be affordable. Eighteen paired seeds
per cell, 180 s, the two levels where the room dimension binds.

| arm | ur060 median | ur10 median | moves (ur10) |
|---|---|---|---|
| `s24` — sample 24, shipped scan | 46.5 | 65 | 5.48 M |
| `f24` — sample 24, cheap scan | **42.5** | **58** | 6.61 M |
| `f48` — sample 48, cheap scan | 48.5 | 60 | 6.14 M |

The optimum did **not** move up. 24 and 48 are indistinguishable (medians 42.5 / 48.5 and 58 / 60),
so the curve is flat where it used to be steep — consistent with §6n's reading that the value of
examining more rooms is sublinear and small, and that the ladder in §6l was measuring the *cost*
side of the trade almost entirely.

The important number is the comparison the experiment was not designed to make:

| the cheap scan is worth… | on top of | W/L/T | mean Δ | sign test |
|---|---|---|---|---|
| §6n | the shipped sample of 96 | 21/6/0 | −9.00 | **0.0059** |
| here | a sample of 24 | 22/13/1 | −4.03 | 0.175 |

**The two levers overlap.** Making each room cheap to examine is worth a great deal when 96 of them
are examined and much less when 24 are, for the obvious reason once stated: twenty-four rooms were
never expensive to scan. What §6n measured was largely the same waste §6l measured, reached from the
other side.

That matters for what gets recommended, because the two are not equally priced:

- `--room-sample 24` is a **one-line change to a default**. No new state, no new invariant, nothing
  to get wrong later.
- The cheap scan is ~300 lines across `state.cpp`, `state.hpp` and `search.cpp`, and introduces two
  new pieces of maintained state (the room occupancy masks and the per-week bucket counts) that any
  future change to bucket bookkeeping has to keep correct.

On this evidence the second buys a further ~6 % over the first, at p = 0.175. That is a real
possibility of a real effect and not a demonstration of one. A campaign that has spent nine sections
watching effects shrink as n grew should say so plainly rather than bank it.

The honest summary is therefore two sentences with different confidences. The room scan was
oversampling, and correcting that is worth roughly a fifth of the residual where room domains are
large — established. Making the scan itself cheap is worth something further on top, and how much is
not resolved.

### One thing to check before assuming this is a special-set result

`instances-unres` was built to make the room dimension bind, so the natural objection is that none of
it applies to the sets the study actually reports. It does not survive contact with the numbers:

| set | rooms | mean room domain | classes naming **no** room |
|---|---|---|---|
| `instances-tight-xl` n12800-s1 | 582 | 134.5 | **22.7 %** |
| `instances-uni1` uni-f4s0-n12800-s1 | 669 | 159.4 | **23.4 %** |

Both shipped sets sit near §6k's `ur015` rung — a fifth to a quarter of their classes name no room at
all, and their mean room domain is well past `roomScanFullBelow`. The regime this section is about is
the regime the study has been measuring in all along; it simply had no reason to look at the room
domain as a variable until §6k made it one.

---

## 6p. E11 — the promotion test, and the answer is no

Everything in §6l–§6o was measured on `instances-unres`, at 180 s, on one worker. This is the same
comparison in the configuration that decides defaults: the archived-style sets the study reports,
**two workers, 300 s**, three instance seeds × three PRNG seeds, 18 paired runs per arm.

| | tight-XL median | tight-XL moves | uni1 median | uni1 moves |
|---|---|---|---|---|
| `off` (shipped) | 22 | 31.60 M | 10 | 34.76 M |
| `s24` | 18 | 37.76 M | 12 | 42.59 M |
| `fast` | 26 | 41.03 M | 8 | 45.55 M |
| `fast24` | 19 | 43.89 M | 10 | 49.78 M |

Pooled over both sets, 18 pairs each:

| arm | W/L/T | mean Δ soft | sign test | candidates gained |
|---|---|---|---|---|
| `s24` | 9/8/1 | −0.17 | 1.000 | +21 % |
| `fast` | 9/8/1 | +0.11 | 1.000 | +31 % |
| `fast24` | 9/7/2 | −0.28 | 0.804 | +43 % |

**Null, on all three arms, as flat as a null gets.** Nine wins and eight losses is the coin. The
candidate rates are up by a fifth to nearly a half and **not one of those extra candidates reaches
the score.**

### Verdict

**No default changes.** `--room-sample`, `--hoist-day-caps`, `--cap-cache` and `--room-free-mask`
stay as flags, defaulted to the shipped behaviour, with these numbers in their option comments.

That is the right outcome and it is worth stating why rather than treating it as a disappointment.
An effect of −9.00 at p = 0.006 (§6n) that becomes −0.28 at p = 0.80 when moved to the sets that
matter is exactly what the staged ladder in `EXPERIMENT-PROTOCOL.md` exists to catch, and it is the
fourth time this campaign has caught one: `--flat-phase` (§6b), the objective shape (§6c.1), the
coupling effect (§6f), and now this. A protocol that had promoted on Stage A would have shipped four
changes, three of which do nothing and one of which does nothing while adding three hundred lines of
maintained state to the hottest data structure in the solver.

### Why it is null here and real there

Deferred to §6q, which tried two answers and kept the second. The short version: the separating
variable is the **room domain** — hundreds of rooms per class on `instances-unres`, ~134 here — and
through it the size of the throughput gain the fixes actually buy (+45–103 % there, +21–43 % here).
A tempting alternative explanation in terms of the residual was proposed and then falsified; §6q
keeps the falsification because the shape of the mistake is instructive.

### What survives, and for whom

Three things do:

1. **§6k stands untouched.** The share of classes naming no room is still the largest single input
   property the campaign has measured (ρ = 0.800, p ≈ 0.0003), and it is a property of the data a
   deanery controls. Nothing in §6p weakens it: the solver-side fix failing to help is *why* the
   input-side advice matters.
2. **The flags are worth keeping.** A faculty whose «Призначення аудиторій» is largely empty runs in
   the regime where they win. `--room-free-mask 2 --room-sample 24 --hoist-day-caps --cap-cache` is
   worth −9 there, and the option comments say so.
3. **`--room-free-mask 3` is a reusable instrument.** Any future change to bucket bookkeeping can be
   checked against the walk on hundreds of millions of live queries, which is a stronger guarantee
   than the unit tests it would otherwise get.

---

## 6q. E12/E13 — the first mechanism to survive Stage C, and a rule that did not survive its own test

Three earlier results died at this exact step, so it is worth naming the filter before the result.
`--soft-alpha 1 --soft-equal` measured −19.1 % at 300 s on one worker and **+2.1 %** at 900 s on two
(§6c.1). `--flat-phase` measured −8 % at six seeds and null at twenty (§6b). The coupling effect
halved between three instance seeds and six (§6f). Every effect this campaign has found has shrunk
when it was measured harder.

E12 is `fast24` — the three scan fixes plus `--room-sample 24` — at **900 s on two workers**, on the
instances where §6n found the effect, 18 paired runs.

| | median soft, `off` → `fast24` | mean | moves |
|---|---|---|---|
| ur060 | 29 → **20** (−31 %) | 28.2 → 21.2 | 71.0 M → 130.5 M |
| ur10 | 34 → **29** (−15 %) | 38.4 → 29.4 | 57.5 M → 117.0 M |

Pooled: **W/L/T 15/3/0, mean Δ −8.00, sign test p = 0.0075.** At three times the budget and twice
the workers the effect is −8.00 against −9.00 at Stage A. It does not shrink.

### A rule proposed, and then falsified by the experiment built to test it

This section originally ended with a rule. The rule was wrong, and the record of how it was killed is
worth more than the rule was, so it is kept here rather than quietly replaced.

**What was proposed.** Put E12 beside §6n and §6p and three points appeared to line up:

| measurement | residual at the budget | candidates gained | Δ soft | p |
|---|---|---|---|---|
| §6n — unres, 180 s, 1 worker | 50–80 | +45–55 % | −9.00 | 0.006 |
| §6q — unres, 900 s, 2 workers | 20–38 | +84–103 % | −8.00 | 0.0075 |
| §6p — shipped sets, 300 s, 2 workers | 8–22 | +21–43 % | −0.28 | 0.80 |

The middle row shares its instance family with the first and its configuration with the third, and
behaves like the first — so, the argument went, neither the set nor the configuration is the
variable, and what decides whether throughput converts is how far the residual still is from the
§3.2 equilibrium. Below ~20 windows the search sits at the strict local optimum and extra candidates
re-sample a plateau; above it they convert.

It was a clean story, it explained all three points, and it connected the branch to the campaign's
central diagnosis. Every one of those is a reason to distrust it: three points inferred from
measurements that each varied *two* things at once.

**E13 varies one.** Same tight-XL instances that produced the null, same binary, same arms, two
workers throughout, and only the budget moves — so the residual moves and nothing else does. Under
the rule, 60 s (residual ≈ 30) should win and 300 s (residual ≈ 22) should be null.

`fast` is the three scan fixes with the sample left alone; `fast24` also cuts the sample to 24.
17–18 paired seeds per cell:

| budget | residual (`off`) | arm | W/L/T | mean Δ | sign test |
|---|---|---|---|---|---|
| 60 s | 30.5 | `fast` | 8/7/3 | −0.50 | 1.000 |
| 60 s | | `fast24` | 8/10/0 | +0.22 | 0.815 |
| 180 s | 23 | `fast` | 11/6/0 | −2.06 | 0.332 |
| 180 s | | `fast24` | 7/8/1 | −1.06 | 1.000 |
| 300 s (§6p) | 22 | `fast` | 3/5/1 | +1.44 | — |
| 300 s (§6p) | | `fast24` | 4/3/2 | −1.67 | — |

**No rung wins.** At a residual of 30 — comfortably above the proposed threshold, on the very family
the rule said should now behave like `instances-unres` — the effect is −0.50 at p = 1.000. The
ordering across budgets is not monotone in either arm. The rule is falsified.

### What is actually true, stated at the confidence the data supports

The variable that separates the two families is the one §6k identified in the first place: **the size
of a class's room domain**, and through it the size of the throughput gain the fixes actually buy.

| | mean room domain | throughput gained | Δ soft | resolved? |
|---|---|---|---|---|
| `instances-unres` ur060/ur10 | 377–582 | +45–103 % | −8.00 to −9.00 | **yes**, p ≈ 0.006–0.008, at two budgets and two worker counts |
| tight-XL / uni1 | 134–159 | +25–33 % | −2.06 to +1.44 | **no** — signs flip between sets, budgets and arms at up to 18 pairs |

So the honest statement is narrower than the one it replaces, and it is two claims, not one:

1. Where classes name no room and the domain is the whole faculty, the scan fixes are worth roughly a
   quarter to a third of the residual, and that holds at 180 s on one worker and at 900 s on two.
2. Where domains are around 130, the effect is **not resolved**. It is somewhere between small and
   zero, it may not be in the direction the mechanism predicts, and eighteen paired seeds cannot
   tell. Nothing here licenses a claim about it either way.

The retrospective explanation for `--simple` — ten times the candidates, fifteen times worse (S §4)
— survives the correction and belongs to §3.2 rather than to this branch: `--simple` removes the
operators that create the gradient, so its throughput has nothing to descend. That was always the
right reading; it just does not generalise into a threshold rule about residuals.

**A note on the method, since this document is written to be executed by cheaper models.** The rule
survived exactly as long as it took to design an experiment that could kill it, which was one turn.
The tell was structural rather than statistical: three points, each differing in two variables, fitted
by a story about one of them. When that shape appears, the next experiment is not more seeds on the
same comparison — it is the one that moves a single variable, even if it costs two hours and the
existing points look convincing.

### What this changes about the recommendation

The verdict of §6p stands — **the defaults do not move.** The flags get a condition for use, now
stated in terms of the property that actually predicts the effect:

```bash
# Worth enabling when classes name few or no rooms, so that room domains run to hundreds:
# measured at −8 to −9 soft there, at 180 s on one worker and at 900 s on two.
# Not resolved, and not recommended, where domains are ~130.
--room-free-mask 2 --hoist-day-caps --cap-cache --room-sample 24
```

And one honest caveat about generality. Every number here is from a generator whose planted schedule
is known to be perfect. Real curricula may sit anywhere on this line, and the only way to know where
a given faculty sits is to run it once and look — which is now a two-minute check with an actionable
answer rather than a research question.

---

## 6r. T2.1 — guided local search, and the last of the three ways to attack the equilibrium

§3.2 proved the residual is a strict local optimum **of the objective**. There are exactly three
things one can do about that, and this campaign has now tried all three.

| | attack | result |
|---|---|---|
| 1 | **search harder** — reach further from the incumbent | exact enumeration of 46 656 arrangements per defect returns `best == before` (§3.2); the joint two-defect solver clears ~1 in 30 and costs more than it clears (§6d) |
| 2 | **change the objective** — make the losing trade a wash | α = 1 with equal weights *redistributes* Π₇ into Π₈ and is +2.1 % at the shipped configuration (§6c.1) |
| 3 | **change the walked surface only** — leave the objective alone and tilt the terrain | **this section** |

The third is the classical answer and the one the other two were not. Guided local search (Voudouris
and Tsang) does not reach further and does not change what is being optimised: while the search is
stuck, it adds `λ · Σ_{b ∈ P} windows(b)` to the *acceptance cost* over the buckets `P` holding the
current residual, so the configuration the search keeps re-creating stops being the cheapest thing
nearby. Every reported number, every better-than test and `noteIncumbent` keep reading the
unpenalised objective.

### Implementation, and two things it had to get right

`--gls X` arms the penalty after `stagnationMoves` without a new incumbent — where the kick already
acts, because that is the evidence the surface has no downhill left — and disarms it on the next
incumbent, rebuilding `P` from *that* incumbent's residual. `P` is the top 64 window-ranked buckets,
filtered to actionable ones (§B's defect-targeting note: a bucket whose вікно is held open by
immovable classes rises to the top of a window-ranked list precisely because nothing can fix it).

Two details that would each have silently invalidated the measurement:

**The acceptance history has to be refilled on every arm and disarm.** Arming shifts the whole
surface up and disarming shifts it back down, so every cost in the late-acceptance history refers to
a surface that no longer exists. Left alone, arming would reject everything until the history
refilled and disarming would accept everything — and both would be read as the penalty's effect when
they are the bookkeeping's. `glsUpdate` refills the history at the current cost, exactly as a restart
does.

**A counter for how often the mechanism fired.** A run where the penalty never armed tests nothing,
whatever the flag said, and would report as a clean null. `glsArmings` is in every worker report.

### Result: null, on all three strengths

tight-XL n12800, two workers, 180 s, three instance seeds × six PRNG seeds, 18 paired runs per arm.
λ in units of β₇ = 5, per the specification's suggested 0.5–2× range.

| arm | median | mean | armings/run | moves | W/L/T vs `off` | mean Δ | sign test |
|---|---|---|---|---|---|---|---|
| `off` | 25 | 22.72 | 0 | 19.6 M | — | — | — |
| `--gls 2.5` | 25.5 | 24.89 | 17 | 19.9 M | 5/11/2 | +2.17 | 0.210 |
| `--gls 5` | 27 | 24.83 | 16 | 19.9 M | 7/8/3 | +2.11 | 1.000 |
| `--gls 10` | 23.5 | 23.50 | 17 | 20.0 M | 8/10/0 | +0.78 | 0.815 |

`hard = 0` on all 72 runs, so the feasibility regression the specification warned about did not
occur. The mechanism armed 16–17 times per run — it was thoroughly exercised. The candidate rate is
*higher* than the baseline's, so the penalty costs nothing to evaluate. And every arm has a mean Δ
of the **wrong sign**, with the strongest λ closest to neutral.

### Why it fails, and this is the part worth keeping

The natural reading is "the penalty was too weak" or "λ needs tuning". The monotonicity says
otherwise: 2.5 → 5 → 10 moves the mean Δ 2.17 → 2.11 → 0.78, towards zero rather than through it.
Extrapolating, a λ large enough to help would be large enough to dominate the objective, at which
point the search optimises the penalty instead of the timetable.

The better explanation is that **GLS changes the price of the destination and not the reachability of
the path**, and only the second was ever the problem.

§3.2's arithmetic — 255 gained against 460 lost — describes the *endpoints* of a rearrangement.
Tilting the surface makes that exchange look profitable. But the search still has to execute it as a
sequence of individually accepted candidates, and the intermediate states of a multi-class
rearrangement are not merely slightly worse: they carry a **clash**, priced at λ_hard ≈ 10⁶, because
moving the first class into the slot the second has not yet vacated is a hard violation. No penalty
on the comfort terms of size 2.5–10 changes anything about a barrier of that height.

That explains, retrospectively, why `forceCloseRepair` is the only subsolver that has ever cleared a
defect: it applies the whole rearrangement as **one atomic candidate against an explicit snapshot**,
so the intermediate states are never scored at all. The escape from this equilibrium is not a
question of pricing. It is a question of whether the operator can express the whole exchange in a
single move.

**So the ceiling is now characterised from three sides.** Searching further does not find a better
arrangement because there is not one within 46 656 of them. Changing the objective redistributes
rather than improves. Changing the walked surface does not help because the barrier is in the hard
terms, not the comfort ones. What remains, and what this campaign has not built, is an operator
capable of proposing multi-class exchanges atomically at scale — which is `forceCloseRepair`'s
mechanism generalised beyond the one defect at a time it currently handles.

Kept behind `--gls X`, default 0, with these numbers in the option comment.

---

## 6s. Where this leaves the solver

**Nothing is promoted. The shipped configuration stands**, and after 1 219 runs and ~148 core-hours
that is the honest summary. What the campaign produced instead is a characterisation of the ceiling,
one fix to the shipped search, a reusable apparatus, and a set of measured negatives sharp enough to
save a later effort from re-deriving them.

The ceiling is now described from three sides, which is the part worth carrying forward. The residual
is a strict local optimum of the objective (§3.2, by exhaustive enumeration). Searching further does
not find a better arrangement, changing the objective redistributes rather than improves (§6c.1), and
changing the walked surface does not help because the barrier lives in the **hard** terms crossed
mid-rearrangement rather than in the comfort terms a penalty reprices (§6r). What remains untried is
an operator that expresses a multi-class exchange **atomically** — `forceCloseRepair`'s mechanism,
which is the only thing that has ever cleared a defect, generalised beyond one defect at a time.

Two results stand on their own regardless of the search. The share of classes naming **no** room is
the largest input-side effect measured (ρ = 0.800, p ≈ 0.0003, §6k), and it composes with the
eligibility null (§6j) into advice a deanery can act on: name a few rooms per class; naming more buys
nothing. And `--actionable-windows` is a genuine fault found in the shipped search — every
window-targeting mechanism in the solver was aiming its effort at buckets held open by immovable
classes (§B of the queue).

**Read `FINDINGS.md` for the claims and their statistics; this file for how each was arrived at.**
The search was paused here at the author's request, with `FINDINGS.md` §10 listing where to resume.

---

## 7. How to reproduce any of it

```bash
cmake -S . -B build -DTG_BUILD_GUI=OFF -DCMAKE_BUILD_TYPE=Release && cmake --build build

# the Stage 0 gate: the C++ evaluator against the independent validator, every archive
node campaign/agree.mjs

# any paired experiment; resumable, scores every run with validate.mjs
node campaign/exp.mjs --exp my-idea --stage B --time 300000 --threads 1 --par 2 \
  --seeds "11 22 33 44 55 66" \
  --instances "bench/instances-tight-xl/n12800-s1.json.gz" \
  --arm "off:" --arm "mine:--my-flag" --out bench/results/mine.jsonl

# the paired table, with the exact sign test
node campaign/cmp.mjs bench/results/mine.jsonl off mine

# larger or tighter instances than the archive carries
node bench/generate.mjs --out bench/instances-tight-xl --sizes "12800 25600" --seeds "1 2 3" \
     --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'
```

One operational note, learned the hard way and worth more than it looks: **a benchmark is only
comparable with what shared the machine with it.** Do not compile, and do not run a second
experiment, while one is being measured. The driver interleaves arms by seed so that slow drift
affects both arms equally, but nothing can repair a run that lost a core to a build.
