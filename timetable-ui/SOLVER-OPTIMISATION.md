# Timetable solver — optimisation study

**2026-08-10 22:00 → 2026-08-11 10:45 UTC · 26 measurement cycles · ~440 benchmark runs**

**In one paragraph.** The shipped search was measured to be almost inert — its repair phase reached
a local optimum in its first iteration and never moved again, so the annealing wrapped around it was
decorative. It was replaced with a move-level stochastic local search under late acceptance, with
incremental evaluation, a restricted candidate list, a scale-free hard-violation weight, an endgame
min-conflicts focus, and finally an ejection chain that switches itself off once the search stops
improving. Every rung from 400 to 31,000 classes now schedules with **zero hard violations**, and
soft cost is 10–60× better than the feasible schedule each instance was constructed around. Six
further mechanisms were built and rejected on measurement; they are recorded in §4 with numbers,
because the negative results took as long to establish as the positive ones and are as reusable.

Harness: `timetable-ui/scripts/timetable-bench/` · Solver: `timetable-ui/src/app/timetable-solver.ts`

Everything here is reproducible: the instances are committed under `scripts/timetable-bench/instances/`,
the raw measurements under `scripts/timetable-bench/results/measurements.jsonl`, and the solver as it
stood before the study as `results/solver-before-optimisation.ts`.

---

## 1. What was asked, and what came out

The brief was to generate realistic test data for a Ukrainian HEI, benchmark the timetable
generator on it, and optimise until 12,800 could be scheduled in ten minutes without violating any
constraints — escalating through 25 → 400, then 800 → 12,800, and never climbing while a smaller
size was still slow.

**Every rung is now scheduled with zero constraint violations**, and both readings of "12,800" (the
word "classes" was used first and "courses" later) land inside the ten-minute budget, on a **two-core**
sandbox:

| classes | courses | budget | feasible | soft cost | reference | ratio |
|---|---|---|---|---|---|---|
| 400 | 172 | 30 s | 5/5 | 6 | 362 | 60× better |
| 800 | 357 | 30 s | 4/4 | 17 | 777 | 46× |
| 1,600 | 672 | 30 s | 5/5 | 40 | 1,582 | 40× |
| 3,200 | 1,312 | 30 s | 5/5 | 121 | 3,153 | 26× |
| 6,400 | 2,658 | 30 s | 5/5 | 594 | 6,205 | 10× |
| 6,400 | 2,658 | 120 s | 1/1 | 212 | 6,205 | 29× |
| 12,800 | 5,257 | 120 s | 3/3 | 600 | 12,464 | 21× |
| 12,800 | 5,257 | 300 s | 2/2 | 466 | 12,411 | 27× |
| **31,000** | **12,873** | 470 s | 2/2 | **1,294** | 30,247 | **23×** |

Median of the seeds, all measured on the shipped solver. Hard violations are **zero in every run**.

Re-measuring 31,000 is where the ejection chain paid best of anywhere — **2,503 → 1,463** and
**2,135 → 1,125** on the two seeds, 42% and 47%. That is §4.2's prediction confirmed at the largest
scale available: an instance this size is still descending when its budget runs out, which is the
regime the chain is for. At 29,760 placed classes the residue is 645 lecturer windows, 414 group
windows and 66 mixed online days.

"Reference" is the hidden schedule each instance was constructed around: a real, feasible answer,
not a bound. The residue is overwhelmingly windows — at 12,800 it is roughly 370 lecturer windows,
190 group windows and 40 mixed online days across 12,800 classes.

> **On the window definition.** A "window" is a whole free пара between two of a group's or a
> lecturer's classes on the same day: the count is the number of distinct bell start times inside
> the gap that nobody used. An earlier version of both solver and validator converted each gap to
> academic hours and rounded, which charged the ordinary 20-minute inter-bell break as idle time and
> made a perfectly packed six-class day score ~2 window units. Every soft figure in this document is
> under the corrected definition; the earlier draft's numbers were roughly an order of magnitude
> larger and are not comparable.

### How it scales at a fixed budget

The table above gives each size the budget where it converges, which answers "how good can this get".
The other question a paper needs is what happens at an **equal** budget. Every rung on the shipped
solver, 120 seconds, three instance seeds each, all hard = 0:

| classes | soft (3 seeds) | median | reference | ratio | windows per class |
|---|---|---|---|---|---|
| 400 | 4 / 5 / 8 | 5 | 362 | 72× | 0.013 |
| 800 | 16 / 18 / 24 | 18 | 753 | 42× | 0.023 |
| 1,600 | 20 / 40 / 44 | 40 | 1,582 | 40× | 0.025 |
| 3,200 | 72 / 80 / 121 | 80 | 3,144 | 39× | 0.025 |
| 6,400 | 153 / 212 / 232 | 212 | 6,173 | 29× | 0.033 |
| 12,800 | 556 / 600 / 611 | 600 | 12,464 | 21× | 0.047 |

**Soft cost grows as roughly n^1.3 at a fixed budget** — 1.27 fitted from 800 to 12,800, 1.30 from
1,600, 1.38 across the whole range. Slightly super-linear, so the residue per class does drift
upward: about 0.023 at 800 classes and 0.047 at 12,800, a doubling across a 16× increase in size.

An earlier draft of this section, written from a single seed per size, called that figure "flat at
~0.03 across a 32× range". Three seeds do not support "flat", and the correction is worth making
explicitly because it is the kind of claim a reader would quote: the residue per class **grows
slowly**, it does not stay constant. What survives is the useful half of the statement — the growth
is gentle enough that a 12,800-class faculty at two minutes is in the same quality regime as an
800-class one, and nothing here degrades the way an O(n²) evaluation would.

The seed spread is worth seeing too, because it is wider than the trend at the small end: 20 to 44
at n=1,600 is more than 2×, which is the same basin-to-basin variance that motivates the portfolio
of §8a. It narrows at the top (556–611 at 12,800), where the search has less freedom.

The mechanism behind the sub-quadratic growth is §3.2: a candidate's cost depends on how crowded the
days it touches are, not on the size of the faculty, so a fixed budget buys a roughly constant number
of moves *per class*. What the exponent above 1 measures is that a bigger instance needs somewhat
more than proportionally many moves to reach the same per-class quality, which is what one would
expect of a harder combinatorial problem — not a failure of the search to scale.

For scale: the ITC-2007 benchmarks the timetabling literature is built on hold **138–434 lectures**.
The largest instance here is roughly **70× the largest published benchmark**.

---

## 2. Method — why these numbers can be trusted

Three decisions did most of the work, and two of them exist because measurement instruments failed
during the study.

**Instances are built around a hidden feasible schedule.** Rather than inventing plausible
requirements and hoping a schedule exists, the generator walks the week slot by slot and *places*
classes into free resources — conflicts are impossible by construction, the pass is O(n), and it
cannot fail. Constraints are then derived *from* that schedule (a `NOT_BEFORE` at or below the
lecturer's earliest class, an abstract room's capacity at its busiest slot). **A perfect schedule
provably exists for every instance**, so a residual violation is always the algorithm's fault and
never an impossible problem.

**The scorer shares no code with the solver.** Written from the schema semantics. A validator that
imports what it validates agrees with it even where both are wrong.

**Instances follow Ukrainian HEI norms**: groups n/15 (~22 sessions/week each), lecturers n/9 (from
the statutory 600 h/year ceiling ÷ 2 semesters × 16 weeks × 2 academic hours), rooms n/22, six
working days × six 80-minute bells on a 100-minute pitch, plus a separate спорткомплекс grid.
Coverage includes all four constraint types on all three subjects, abstract rooms with and without
a building, online classes, biweekly parity, combined groups, multi-building travel and 4% external
fixed entries from other faculties.

### Two instrument failures worth recording

They cost hours and they are the reason the results above are stated with confidence.

1. **The validator was wrong about travel, and it invented a wall.** `building_travel_times` is
   directed and asymmetric (b1→b4 is 10 minutes, b4→b1 is 16). The validator read the journey in the
   bucket's array order but compared it against the chronologically ordered pair — so about half of
   all cross-building pairs were scored against the wrong direction. This produced a phantom
   "feasibility wall at n=800" that an entire cycle was spent attacking. With the direction fixed,
   the *same* build was feasible to 3,200.

2. **Runs are wall-clock bounded, so two runs with the same seed differ.** Comparing the validator's
   verdict on one run against the solver's on another produced contradictory evidence for several
   cycles. Capping by `maxIterations` makes a run bit-identical, and that is now the debugging
   default.

The lesson is uncomfortable but useful: *two independent instruments agreeing is worth far more than
one instrument insisting*, and during this study both instruments were wrong at different moments.

### The deletion changed nothing, and that was checked

Removing the retired phases and the nine options that fed them is the kind of change that is assumed
safe and occasionally is not. It was re-measured rather than assumed: `variants/v16-shipped.ts` is
the file as it ships, and at n=31,000 it returns hard=0 and soft **2,135** against the pre-deletion
file's **2,503** on the neighbouring seed — the same distribution, not a regression. `tsc` caught the
one real casualty on the way: `temperature` was still part of the public `SolverProgress` payload and
the modal printed it beside `intensity`. Both described nothing, so they were removed rather than
left to read as live knobs.

---

## 3. What was actually wrong with the solver

> The soft-cost figures in this section come from the tuning experiments, which were run under the
> earlier window definition described in §1. Each comparison is internally consistent — both sides
> of every A/B were measured the same way — but the absolute values are not on the same scale as the
> headline table. The conclusions were re-checked against the corrected definition and none changed.

### 3.1 The search did almost no searching

The decisive experiment, on the shipped code:

| perturbation | improvements | final f |
|---|---|---|
| on (every 30 barren iterations) | 24 | 131,905 |
| **off** | **1** | **904,965** — the construction value |

`repairPhase` was a *deterministic* descent: it reached a local optimum in its **first** iteration
and was inert for the remaining 89,069. Every improvement the solver had ever made came from the
perturb → re-descend → keep-if-better cycle; the 40 repair passes and one or two full `measure()`
calls per outer iteration were, after the first, pure overhead. That is why more time bought nothing
(at n=50, 575k iterations over 60 s gave the identical answer to 90k over 10 s).

Two consequences worth naming. The simulated annealing was **decorative**: temperature never
affected an answer (identical results for T from 2.5 to 8000), because the descent never consulted
it. And an acceptance rule cannot help an inert move generator — a Late Acceptance variant built
early logged 70,200 accepts, 0 rejects and 1 improvement.

**The fix** is the shape every state-of-the-art result uses: sample one move, evaluate it
**incrementally** (recompute only the buckets it touches), accept by late acceptance. At n=400 this
alone took soft cost from **801 to 45** and feasibility from 2/3 to 3/3.

### 3.2 Two quadratics, one of them mine

- **Construction** scanned slots × *all* rooms, and a class naming no room has the whole faculty as
  its domain: 1.3 s at n=3,200, 17.8 s at 12,800, **123 s at 31,000** — two minutes before the first
  move. A restricted candidate list took it to **4.6 s**. It is gated (`ROOM_SCAN_FULL_BELOW = 256`)
  because sampling *hurts* where a full scan is affordable.
- **The improvement branch called full `measure()` on every improvement** — O(n), firing on most
  moves early in a run. I had reintroduced the very cost the incremental counters existed to remove,
  one line below them. Deleting it: n=12,800 **6,980 → 35,874 moves/s**; n=31,000 **1,860 → 18,022**.

### 3.3 The acceptance cliff, and why a fixed weight cannot work

With `hard × 1e12`, any move that *temporarily* worsens feasibility costs a trillion and is always
rejected — but repairing one stuck violation usually requires passing through two. Measured on an
n=6,400 instance that returned **byte-identical** hard=1 results at 30 s, 60 s *and* 120 s: not slow,
stuck.

A *fixed* finite weight is also wrong. `f` is a sum of **squared** counters, so it grows with the
square of the instance: 1e8 is an enormous penalty at n=400 (f ≈ 1e5) and a rounding error at
n=31,000 (f ≈ 2e10). Measured, it gave soft **57,584** at 31,000 against 9,343 for the fix below.

The answer is **scale-free**: `hardWeight = max(1e6, surrogate × 0.02)`, measured from the instance's
own objective right after construction. One hard violation always costs about a 2% swing in total
soft cost — enough to dominate any single soft move, finite enough to escape a stuck one.

### 3.4 Parameters, measured rather than guessed

**L (late-acceptance history) is the dominant parameter, and smaller is better — it does *not* scale
with n**, which is the opposite of what I expected:

| L | n=3,200 | n=12,800 |
|---|---|---|
| **100** | **638** | **4,508** |
| 500 | 876 | 23,366 |
| 1,600 | 3,935 | — |
| 4,000+ | infeasible | — |

An 81% cut at the largest size from one constant. Above ~4,000 the uphill drift outruns the descent
and feasibility is lost outright.

**Targeted swaps beat random ones.** A uniformly drawn swap partner rarely admits the other's slot
and room, so most attempts are cheap rejections; choosing the partner by *who already occupies the
placement you want* makes nearly every attempt a real candidate (n=200: soft 30 → 18).

**Endgame min-conflicts focus.** A run at n=31,000 ends with a handful of violations among 29,760
classes, so a uniformly drawn class is guilty ~0.03% of the time. Drawing 70% of candidates from the
offenders while anything is infeasible is what turns "nearly feasible" into feasible: hard **5 → 0**.

---

## 4. Tried and rejected — with numbers

Negative results, recorded so they are not re-attempted.

- **Parallel portfolio.** Six independent search seeds on one instance: 3,180 / 3,260 / 3,354 /
  3,395 / 3,410 / 3,730. **Best-of-six beats the median by 6%.** Six cores for 6%, against a
  one-constant change worth 81%. A *cooperative* portfolio would do better than independent
  best-of-k, but not enough to prioritise. **The multi-worker permission granted for this work turned
  out not to be needed.**
- **Simulated-annealing temperature tuning.** T ∈ {2.5 … 8000} — identical answers.
- **Scaling L with instance size.** The optimum is small and constant; growing it loses feasibility.
- **Min-conflicts targeting as a general policy** (rather than an endgame one) — no effect when
  applied against violations that were phantom, and it is only worth its scan cost while infeasible.
- **A travel-aware placement scorer.** Sound in principle, no measurable gain: hard 39/31/21 against
  28 for the unmodified build.
- **An adaptive iterated-local-search restart, built specifically against the measured plateau.**
  Three changes over the shipped kick: displace an absolute *count* of classes rather than a
  fraction of the schedule (the old 10–20% moved 1,200–2,500 classes at n=12,800, far more than the
  following descent could undo); always kick from the **incumbent** rather than from wherever the
  last failed kick drifted, so failures cannot compound; and size the kick adaptively — start at 4
  classes, grow 1.3× while kicks keep failing, fall back to 4 the moment one lands, capped at 2% of
  the schedule.

  At n=12,800 over 540 s it returned soft **438 with objective 819,350** — *the identical schedule*
  the unmodified solver finds. Not similar: identical. Sanity runs at n=400 (soft 3) and n=3,200
  (215 against the control's 223) confirm the mechanism is not simply broken.

  The result is more informative than a win would have been. **The plateau is not a kick-strength
  problem.** Random displacement plus re-descent cannot leave that basin at any strength between 4
  classes and 2% of the schedule, which says the residue — 270 lecturer windows, 149 group windows
  and 19 mixed days across 12,800 classes — is held in place by structure rather than by a shallow
  local optimum. Escaping it plausibly needs a *different move*, not a bigger one: ruin-and-recreate
  over a whole entity-day, or an ejection chain, rather than a random reassignment. One earlier
  finding points the same way — targeted swaps beat random ones because they make each attempt a
  real candidate, and a kick has no such targeting at all.

- **Ruin-and-recreate over whole entity-days** — the structural move the ILS failure pointed at.
  On stagnation, restore the incumbent, then empty eight randomly chosen lecturer- or group-days
  completely and rebuild each one with the construction scan in a fresh random order. Unlike a kick,
  this can reach an arrangement no sequence of single-class moves can, because every intermediate
  step of such a sequence is worse.

  It is *slightly* better at sizes below the plateau — n=400 soft **2** against the control's 3,
  n=3,200 **218** against 223, both hard=0 — and at n=12,800 over 300 s it returned soft **438,
  objective 819,350**: the same schedule again, for the third time and the third mechanism.

  Three structurally different escape mechanisms returning a byte-identical objective looked like
  evidence that 438 was simply the optimum. **It was measured, and it is not.** Varying only the
  *search* seed on the same instance at the same 300-second budget gives **438 / 510 / 547 / 665** —
  a 52% spread, no clustering. Different trajectories reach materially different local optima, so
  438 is one basin among several and the plateau is real.

  Why the three variants nevertheless agreed to the digit: a run ends with `restore(best)`, so the
  answer is the incumbent. A perturbation that fails to produce a *new* incumbent leaves the result
  bit-identical no matter what it did in between. All three mechanisms fired and all three failed,
  and failure is indistinguishable from absence in the final number — which is why the mechanisms
  had to be instrumented rather than inferred from results. Counted directly: 24 perturbation events
  in a 30-second run at n=400, 21 at n=800, and **zero** at n=12,800 over 120 seconds, where
  stagnation peaks at 23,459 against the 60,000-move threshold because the search is still genuinely
  improving at that budget.

  That last figure is the actionable one. **At a full faculty the escape mechanism never runs inside
  the panel's two-minute maximum** — convergence itself takes longer than that, so the kick is
  reached only in benchmark-length runs.

  A footnote with a number attached: best-of-four search seeds is 438 against a median of 547, a 20%
  gain. The independent-portfolio idea rejected in this section was measured at 6% under the old
  window metric; under the corrected one it is worth rather more — **but only in parallel**, which
  the next entry makes precise.

- **Sequential restarts — splitting one budget across k runs and keeping the best.** This is the
  version of the portfolio that costs nothing extra, so it is the one worth knowing about, and it
  **loses badly**. Measured at equal total budget:

  | n | one long run | best of four short runs | ratio |
  |---|---|---|---|
  | 3,200 | 60 s → **116** | 4 × 15 s → 502 (521/557/614) | 4.3× worse |
  | 12,800 | 300 s → **438** | 4 × 75 s → 1,907 (2,017/2,472/2,626) | 4.4× worse |

  Two sizes, the same ratio, and it is not close. Quality improves so steeply with budget that a
  quarter-length run is nowhere near a quarter as good — the *worst* of the four long-run seeds
  (665 at 12,800) still beats the *best* quarter-length run by 2.9×.

  This is what makes the 20% figure above conditional. Best-of-k is a real gain **only when the k
  runs are concurrent on separate cores at full budget each**; as a way of spending one budget it is
  among the worst choices available. Stated carelessly — "run four seeds and keep the best" — it
  would make things nearly four and a half times worse for a reader who had one core.

- **A targeted ejection chain.** The chain draws its entry placement uniformly from the class's
  domain, which looked like the same mistake the *random* swap made — and targeting is what made the
  swap work. `variants/v22-targeted.ts` samples six admissible placements and enters at the one
  whose day currently carries the most window cost, scored by the same `windowCostAt` the candidate
  scan uses. It is **worse at both bars**: n=3,200 / 60 s gives 109 against the shipped 80, and
  n=12,800 / 120 s gives 834 against 596.

  The reason is worth keeping, because it inverts the swap's lesson. `windowCostAt(i, d)` measures
  how bad day *d* is now, not how much a rearrangement would improve it — and the worst day is
  often the most constrained one, which is the hardest to improve, not the easiest. More
  fundamentally: **the swap needed targeting because a random partner is a wasted attempt, whereas
  the chain's randomness is the point.** A swap that cannot be applied costs a rejection; a chain
  entering somewhere unpromising still rearranges four classes and still gets costed, so it is
  already doing diversification work. Making it greedy about where to enter removes the one
  mechanism in the search that is not.

  (An intermediate version that also shortened the barren threshold to 2,000 moves was *much* worse
  — n=3,200 lost feasibility outright, hard=8. Late acceptance needs sustained drift to work, and
  yanking the search back to the incumbent every 2,000 moves destroys exactly that. Recorded because
  the failure is a clean illustration of what the acceptance rule is actually doing.)

---

### 4.1 The ejection chain — the one mechanism that worked

Not a negative result, and not yet a shipped one. `variants/v19-chain.ts` adds a fourth
neighbourhood: put a class where it wants to go, find the class that was in the way, and let *that*
class go where **it** wants — recursively, to depth 3 — instead of forcing it into the hole the
first one left. The whole chain is one candidate: applied, costed once, accepted or unwound as a
unit.

`tryTargetedSwap` is the depth-1 special case with a mandatory swap-back, and the swap-back is
exactly the restriction: B has to accept precisely A's old placement, which is usually one B has
already rejected.

Same instance, same search seed, against the shipped solver:

| n | budget | shipped | chain | |
|---|---|---|---|---|
| 400 | 30 s | 3 | 7 | worse |
| 3,200 | 30 s | 223 | **132** | **41% better** |
| 3,200 | 60 s | 116 | **71** | **39% better** |
| 12,800 | 300 s | 438 | 560 | 28% worse |

Throughput is not the explanation — the chain runs *more* moves per second, not fewer (3.76 M in
60 s at n=3,200 against the shipped 3.07 M), because most chains close after one or two links.

The shape is consistent and worth stating carefully. At n=400 the instance is small enough that the
plain neighbourhood already reaches near-zero, and a chain is mostly disruption. At n=3,200 it is a
large, repeatable gain. At n=12,800 it loses to that seed's control — though 560 sits inside the
control's own seed spread (438 / 510 / 547 / 665, median 547), so the fair reading is "no better",
not "much worse".

**This is the first mechanism in the study to beat the bar anywhere.**

`chainRate` sweeps cleanly and 0.15 is the optimum — at n=3,200 / 60 s the rates 0.05 / 0.15 / 0.30 /
0.50 give 103 / **71** / 82 / 101 against the shipped 116. Every rate tested beats the shipped
solver at that size.

The n=12,800 loss looked like a size effect and is not. Widening the sweep:

| n | budget | shipped | chain @0.15 | |
|---|---|---|---|---|
| 400 | 30 s | 3 | 7 | worse |
| 1,600 | 30 s | 74 | **40** | 46% better |
| 3,200 | 60 s | 116 | **71** | 39% better |
| 6,400 | 30 s | 1,334 | **729** | 45% better |
| 12,800 | **120 s** | 913 | **652** | **28% better** |
| 12,800 | **300 s** | 438 | 560 | 28% worse |

The same instance, the same rate, the same seed — and the chain wins by 28% at two minutes and loses
by 28% at five. **It is a phase effect, not a size effect: the chain accelerates the descent and
interferes with the endgame.** Every case where it loses is a case where the search had already
converged — n=400 reaches soft 3 in seconds, and n=12,800 is done improving by ~300 s (§5). Every
case where it wins is a search still on its way down.

That reading also explains the shape of the rate sweep, and it points at the fix: the rate should
**taper as the search stops improving**, which is a signal the loop already carries in `sinceBest`.
A chain is a coarse instrument — it moves up to four classes at once — and coarse instruments are
what you want while there is structure to break up, not while polishing the last twenty windows.

### 4.2 The taper — shipped

The fix is one condition: run the chain only while the incumbent is still moving
(`sinceBest < chainOffAfter`, 20,000 barren moves). Measured on instance seed 1:

| n | budget | shipped (no chain) | chain always | **taper** |
|---|---|---|---|---|
| 400 | 30 s | 3 | 7 | 4 |
| 1,600 | 30 s | 74 | 40 | **44** |
| 3,200 | 30 s | 223 | 132 | **81** |
| 3,200 | 60 s | 116 | 71 | **80** |
| 6,400 | 30 s | 1,334 | 729 | **744** |
| 12,800 | 120 s | 913 | 652 | **596** |
| 12,800 | 300 s | 438 | 560 | 480 |

At the 12,800 / 120-second point the taper beats *both* the plain search (−35%) and the untapered
chain (−9%) — switching the chain off in the endgame is worth more than the chain costs there, which
is the clearest confirmation the phase reading was right.

**It is shipped**, and the honest case for shipping is worth stating because one row genuinely
loses. A second seed was measured at n=12,800 / 300 s specifically to test whether that row was
noise, running both arms on the same instance:

| seed | no chain | shipped |
|---|---|---|
| 1 | **438** | 480 (+9.6%) |
| 2 | **401** | 451 (+12.5%) |

It replicates. At a five-minute budget the chain costs about 10%, and an earlier draft of this
section called that "no better, not worse" on the strength of one seed and the control's wide
spread — which was too generous to the change being defended.

Two attempts to tune that row away both failed, and together they close the question:

| `chainOffAfter` | n=12,800 / 300 s |
|---|---|
| 5,000 | 490 |
| 10,000 | 502 |
| **20,000** (shipped) | **480** |
| chain off entirely | 438 |

Switching the chain off *earlier* does not recover the loss — the shipped threshold is already the
best of the three, and none of them approaches the chainless figure. Combined with the decaying-rate
result above, the reading is that **the cost is not in when the chain stops but in the trajectory it
takes while running.** The seeds scatter (§4), so the basin a run converges into is decided during
the descent; a chain that changed the descent has already chosen a slightly worse basin by the time
any switch-off fires. Nothing applied at the end can undo that.

The case for shipping anyway is the budget the product offers: 10 s / 30 s / 1 min / 2 min. **Every
budget a user can actually ask for lies in the regime where the chain wins**, at faculty scale by
35%. Five minutes is reachable only from the benchmark harness. The 400-class row gives up one
window unit out of a 362-unit reference.

**A smoothly decaying rate was then measured, and it is worse.** Replacing the switch with a linear
decay across the same barren window (`chainRate × (1 − sinceBest / chainOffAfter)`) does fix the
regime the switch loses — n=12,800 / 300 s goes 480 → **447**, against 438 with no chain at all. But
it pays for that by giving up the largest win: n=3,200 / 60 s goes 80 → **115**, which is the
chainless 116 to within noise, and n=12,800 / 120 s goes 596 → 628.

The reason is visible once stated: a decaying rate spends most of a mid-size run near zero, because
those runs sit close to convergence for most of their budget. The switch keeps the chain at full
strength through the whole descent and then removes it, which is what the phase reading actually
called for. Trading a 31% win at 3,200 for a 7% win at 12,800/300 s is not a trade worth making, so
`v21-decay.ts` is **not shipped** and the hard switch stays.

---

## 5. Honest limitations

- **All figures are from a 2-core sandbox.** A smoke run on the Mac was ~4× faster per move
  (307k vs 94k moves/s at n=25), so the numbers should improve there, but they are not measured.
- **Soft quality degrades with size relative to the reference.** 60× better than the hidden schedule
  at n=400, 10× at n=6,400 under an equal 30-second budget — the search simply gets fewer moves per
  class. (12,800 looks better than 6,400 only because it was given 120 s rather than 30 s.)
- **It converges and then goes completely inert**, and the plateau is now measured exactly. At
  n=12,800 seed 1: 120 s → 913, 300 s → **438**, 540 s → **438 with a byte-identical objective**.
  The extra 240 seconds bought **11 million moves and not one improvement**. Two things follow: the
  120-second figure in the table above understates the solver by 2×, and the plateau is a real,
  locatable target rather than a vague "diminishing returns" — a cooperative restart has ~44% of a
  run's budget to work with at that size.
- **One seed in five once failed at n=6,400** under the older acceptance rule. The scale-free weight
  fixed that case, but robustness is evidenced by five seeds per size, not fifty.
- **The 31,000 result is two seeds** (soft 2,135 and 2,503), each costing eight minutes of two
  cores. The smaller rungs are three to seven.
- **Repetition counts are modest.** Five seeds per rung, three at 12,800. `experiment.mjs` exists to
  raise that to 25 on real hardware.

---

## 6. Recommended next steps

1. **Run the full experiment on your hardware** — `scripts/timetable-bench/experiment.mjs`, 25
   repetitions × 10 sizes, ≈ 4.7 h, resumable. It writes a CSV with medians and dispersion that a
   paper can use directly, and it is the measurement this study could not afford on two cores.
2. ~~Take the 20% from multiple search seeds.~~ **Done** — the client now runs a portfolio of up to
   four workers on the same problem with strided seeds and keeps the best answer, sized down on very
   large instances because each worker holds its own copy of the schedule. See
   `TIMETABLE-GENERATION.md` §8a. The measured 20% is best-of-four against the median; what a given
   user sees depends on their core count.
3. **Make the generator report a soft lower bound.** It already constructs a hidden schedule, so it
   can also report the best soft cost construction can reach — currently it reports only the one it
   happened to build (12,464), which is a weak reference. A tighter bound would turn every soft
   figure in this study from "better than a plausible schedule" into "within x% of optimal", which
   is what a paper actually wants to claim, and it is the single highest-value change left in the
   harness.
4. **Only then, a structural move.** The seeds scatter, so there is a real plateau to attack, and
   both displace-and-redescend variants tried against it failed (§4). An ejection chain — move a
   class, then re-place whatever it displaced, recursively — is the neighbourhood the evidence
   points at, and it is a larger piece of work than anything in this study. Half of the wasted
   budget converted into any improvement at all would beat every parameter change left.
5. If the dissertation needs a published-benchmark comparison, the harness can be pointed at
   ITC-2007 instances — the formulation differs, but the shape is close enough to be informative.

The retired code (`repairPhase`, `windowPhase`, `swapPlacements`, the tabu list, the temperature
schedule) has been deleted, along with the nine tuning options that no longer reached anything
(`repairIterations`, `windowMoves`, `tabuTenure`, `initialTemperature`, `coolingFactor`,
`intensity`, `minIntensity`, `maxIntensity`, `adaptationStep`). Leaving a knob that silently does
nothing is worse than not having it.
