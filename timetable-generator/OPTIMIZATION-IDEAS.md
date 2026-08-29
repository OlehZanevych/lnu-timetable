# Optimization ideas

A catalogue of candidate improvements to the C++ solver, written to be **executed by an automated
campaign**: each idea is stated as a hypothesis with a precise specification, the place in the code
it hooks into, the flags it should hide behind, and the measurement that decides it. The campaign
itself — the staged testing ladder, the statistics, the journal an agent keeps — is in
[`EXPERIMENT-PROTOCOL.md`](EXPERIMENT-PROTOCOL.md). The deepest of the ideas here — what to do when
the search is stuck on a timetable it cannot improve — has a file of its own,
[`STAGNATION-ESCAPE.md`](STAGNATION-ESCAPE.md), and this catalogue only points at it.

**Start with [`FINDINGS.md`](FINDINGS.md)** if the question is *what is already known*: it states the
campaign's results as claims with their evidence and threats to validity, separated from the
narrative, and it is where a paper should be written from. This file is the forward-looking half —
what to try next and how.

The three files assume the reader has [`README.md`](README.md) (the design in prose),
[`ALGORITHM.md`](ALGORITHM.md) (the formal statement — §-references of the form "A §3.4" point into
it) and [`STUDY.md`](STUDY.md) (what was measured — "S §6a"). Nothing here contradicts them; where
an idea revisits something they rejected, the entry says so and says what has to be different this
time.

---

## Contents

1. [Where the ceiling is now](#1-where-the-ceiling-is-now)
2. [Rules every idea must respect](#2-rules-every-idea-must-respect)
3. [What not to re-litigate](#3-what-not-to-re-litigate)
4. [Tier 1 — the ideas most likely to pay](#4-tier-1) (E1–E6 written before any measurement; **E7–E9 written from one, and measured**)
5. [Tier 2 — worth testing after Tier 1](#5-tier-2)
6. [Tier 3 — engineering and scaling](#6-tier-3)
7. [Data-side ideas](#7-data-side-ideas)
8. [Interactions between ideas](#8-interactions)
9. [The campaign queue](#9-the-campaign-queue)

---

## 1. Where the ceiling is now

The measured state of the solver, condensed from `STUDY.md`, because every idea below is an attack
on one of these facts:

- **The quality comes from the large neighbourhoods and the escape, not from throughput.**
  `--simple` makes ten times the candidates and is fifteen times worse (S §4). Ideas that only make
  the search faster are Tier 3 by definition.
- **`repack` and `ruin` produce ~79 % of the gain** with 43 % of the draws (S §4, hour-long run).
  Both funnel through one routine: `Worker::recreate` — random order, greedy `scanBest` insertion.
  Any improvement to *repair quality* multiplies through everything: `opRuin`, `opRepack`, the deep
  phase, the kick, and `restartFresh`'s constructions.
- **The basin lottery is the largest lever.** Same binary, same instance, six seeds: soft 11–29, a
  factor of 2.6 (S §6a); twelve seeds at 180 s span 3.2 (S §9). The restart machinery samples that
  distribution; nothing yet *steers* it — every construction is independent of everything every
  previous basin learned.
- **The endgame is defect-local and the search is not.** After an hour at n = 12 800 the residual
  is ~8 windows: five lecturers and three groups with one idle пара each (S §6). The operators that
  remain are stochastic draws over guilty buckets; nothing ever *proves* a defect movable or
  immovable, so the tail spends minutes re-sampling the same few buckets.
- **Rooms are a search dimension the literature says should be a matching** (README, *Known
  limitations*). Given fixed times, room assignment is polynomial; treating it as part of the draw
  multiplies the neighbourhood for nothing.
- **The escape ladder runs on fixed move counts** (`deepEvery` 20 000, `stagnationMoves` 60 000,
  `restartAfter` 1.2 M) tuned at n = 12 800 on two cores. Nothing adapts them to the instance, the
  budget, or the observed payoff of past escapes.
- **The exact permutation is priced out by the bandit but never made stronger.** `kopt` has the
  best hit rate of any operator (13.65 % improving) and one draw in a thousand (S §4); its known
  weakness — exact only over a relaxation — has a known fix (A §7 names it) that was never built.

## 2. Rules every idea must respect

These are the invariants of A §6 plus the campaign-specific ones. An implementation that violates
any of them is wrong even if it measures better.

1. **The evaluator's semantics are frozen.** `State`'s nine Π terms and hard filters must keep
   agreeing with `timetable-bench/validate.mjs` to the digit. Any change that touches `state.cpp`
   arithmetic must re-run `--mode score-hidden` on **all 50 archived instances** before any quality
   measurement. (Adding *read-only* probes to `State` is fine.)
2. **Every multi-class operator re-verifies `Worker::allLegal` on the full set once every member is
   down** — `MAX_CLASSES_PER_DAY` is set-valued (A §1.3) — and undoes on failure via the journal.
   The Experiment-0 capped regression (`bench/instances-cap`, S §2) must stay at zero breaches.
3. **The unplaced defence stays threefold** (A §1.6): the `8λ·unp` term in the acceptance cost, the
   `recreate` restore-on-failure, and the `(unp, hard, f)` lexicographic order in *every* better-than
   test. A new operator that can lift a class must never leave it lifted outside its own journal.
4. **New mechanisms ship behind flags, default off**, with the measured numbers in a comment beside
   the option — exactly the house pattern of `SearchOptions`. Promotion to default is the
   protocol's decision, never the implementer's.
5. **Do not add cheap operators to the bandit portfolio.** The single most transferable finding in
   the study (S §3, §4): a portfolio that already contains large neighbourhoods has no spare draws,
   and `dayfix`, `winfix` and `recombine` all lost by displacing the draws that were paying. New
   *cheap* mechanisms belong in the **escalation phases** (deep phase, kick, the hard repair of
   `STAGNATION-ESCAPE.md`), where they compete with stagnation rather than with `repack`.
6. **Preserve the anytime property** (A §3.9): no mechanism may consume the *remaining* budget —
   trigger on move counters and observed payoffs, poll the deadline, and degrade to "not applied"
   when truncated.
7. **Determinism per seed.** Everything stochastic draws from the worker's own `Rng`. No wall-clock
   in decisions (the `logEveryMs` publish is the one existing exception); no extra hidden state that
   makes `--seed` unreproducible.

## 3. What not to re-litigate

Measured negatives (S §4, §7; A §7). A cheaper model must not rediscover these by accident. Each
row names the one condition under which a retry is legitimate — otherwise the answer is already no.

| mechanism | flag | verdict | retry only if |
|---|---|---|---|
| exhaustive (entity, day) re-pack | `--dayfix` | 20 → 27 at 12 800 | moved out of the bandit into an escalation phase (see rule 5) |
| window-directed move | `--winfix` | 20 → 26 at 12 800 | same — and as the multi-class compaction of idea T2.2, not the single move |
| budget-proportional selection | `--cost-aware` | 20 → 31, double the candidates | never as-is; a different bandit (T2.6) is a new idea, not this one |
| widened permutation pool | `--kopt-extra 8` | 5 → 11 at 6 400 | only inside an exact subsolver that prices member–member coupling (E6 / DFER) |
| cluster recombination | `--recombine` | mean 20.2 → 23.3 | ≥ 8 workers, where the pool is genuinely diverse; or as path relinking (T2.4), which is a different operator |
| dedicated ILS loop | `--ils` | 37 → 70 when early | never as the *whole* tail; the kick already is ILS with plateau drift |
| longer LAHC history | `--lahc 5000` | soft 3 381; does not reach feasibility at 60 s (S §9) | never; the tail is short of attempts, not tolerance |
| **anything whose mechanism is "more candidates per second"** | E7–E9 | −8.00 (p = 0.008) where room domains run to hundreds; **unresolved, −2.06 to +1.44** where they are ~134 (CAMPAIGN-LOG.md §6p, §6q) | only after checking how much throughput it buys on *your* instances — see below |

### The throughput question, and why it is in this table

The room-scan branch (§6l–§6q) removed three O(bucket) costs the scan was paying per candidate room
and raised the candidate rate by 21–103 %. Where that converts into quality, and where it does not,
is settled — and the first answer the campaign proposed was wrong, which is why this entry states
the surviving one narrowly.

| | mean room domain | throughput gained | Δ soft | resolved? |
|---|---|---|---|---|
| `instances-unres` ur060/ur10 | 377–582 | +45–103 % | −8.00 to −9.00 | **yes**, p ≈ 0.006–0.008, at 180 s / 1 worker and 900 s / 2 |
| tight-XL / uni1 (the sets that decide defaults) | 134–159 | +25–33 % | −2.06 to +1.44 | **no** — signs flip between sets, budgets and arms at up to 18 pairs |

**The predictor is the room domain, not the residual and not the budget.** A rule in terms of the
residual — "below ~20 windows the search is at the §3.2 equilibrium and extra candidates re-sample a
plateau" — fitted all the data that existed when it was written, and was then falsified by an
experiment that moved the budget alone on one instance family (CAMPAIGN-LOG.md §6q, E13): at a
residual of 30, where the rule predicted a win, the effect was −0.50 at p = 1.000.

**So, before implementing anything whose mechanism is "more candidates per second":** ask how much
throughput it actually buys *on the instances you care about*, and check whether that quantity varies
with an instance property. On this solver it does — the room domain — and a change measured only
where the domain is large will not transfer to where it is not.

This does not contradict §1's `--simple` result (ten times the candidates, fifteen times worse).
`--simple` removes the operators that create the gradient, so its throughput has nothing to descend.
That belongs to §3.2 and always did; it is not a threshold rule about residuals.


---

## 4. Tier 1

Eight ideas, ordered by expected value per implementation effort. E1–E6 were written before
the campaign ran; **E7 and E8 were written from its largest result and should be tried first**. Effort: S ≈ a day of work for an
agent, M ≈ a few days, L ≈ a week-scale change.

### E1 — Regret-based repair (effort S, leverage on 79 % of the gain)

**Hypothesis.** `recreate` places victims in random order, greedily. Greedy insertion commits the
first class before seeing the last one's options; **regret insertion** (Ropke & Pisinger's regret-k,
the standard upgrade in the LNS literature) places first the class that would *lose the most* by not
being placed now. Since `ruin`, `repack`, the kick and the deep phase all repair through this one
routine, a few percent better repair moves most of the gain pipeline.

**Specification.** In `recreate(victims)`:

```
while victims remain unplaced:
    for each unplaced v (or only those invalidated since last round):
        (best₁, best₂) ← two best scores from scanBest-top2(v)
    v* ← argmax over v of regret(v) = best₂(v) − best₁(v)      # +∞ when only one placement exists
    place v* at its best₁;  invalidate every unplaced v sharing an entity or a day with v*
```

`scanBest` needs a top-2 variant (track the runner-up while scanning — a few lines). Cost is
O(k²·scan) worst case against O(k·scan); with the invalidation set it is nearer O(k·scan) in
practice, and k ≤ 40. Two arms to test, because the random order is currently the
*diversification* (A §3.4.5) and making repair deterministic may cost diversity:

- **arm `regret-all`**: regret insertion everywhere, with Ropke noise — multiply each score by
  U[0.9, 1.1] drawn from the worker's Rng — to keep repeated repairs of the same set different;
- **arm `regret-anchored`**: regret insertion only where the repair is anchored to the incumbent
  (kick, deep phase, DFER) and random-greedy kept in the bandit's own `opRuin`/`opRepack`.

**Hooks.** `search.cpp`: `Worker::recreate`, `Worker::scanBest`. Options: `regretDepth` (0 = off,
2 = regret-2), `regretNoise` (default 0.1). Flags: `--regret N`, `--regret-noise X`.

**Measure.** Full ladder of the protocol. Expect single-digit-percent soft improvement at 180 s if
it pays; kill if Stage A shows ≥ 10 % candidate-rate loss with no quality gain.

### E2 — The hard repair when stuck (effort L; the centrepiece)

When the incumbent has not moved for a long stretch and kicks at maximum strength keep coming back
empty, the search needs a **qualitatively harder procedure**: freeze everything except the
neighbourhood of one residual defect, solve that subproblem *exactly* (or to a proven budget),
and either remove the defect or certify it locally irreducible — and when every remaining defect is
certified irreducible, abandon the basin **immediately and deliberately**, steering the next
construction away from the trap instead of merely rolling the dice again.

The full design — triggers, defect extraction, three exact subsolvers, the irreducibility ledger,
and the biased-restart coupling — is [`STAGNATION-ESCAPE.md`](STAGNATION-ESCAPE.md). It is listed
here only so the queue in §9 can order it.

### E3 — Rooms as a matching, not a dimension (effort M)

**Hypothesis.** Given fixed times, assigning rooms is polynomial (Lach & Lübbecke; Cambazard et
al.), and the solver's own *Known limitations* names this. Two deliverables, in increasing
ambition:

**E3a — exact room re-shuffle among time-identical classes (safe, exact, cheap).** Classes on the
same day with the *same occupancy mask* and overlapping parities are mutually interchangeable in
the room dimension: exchanging their rooms cannot create a time clash. Group placed classes by
(day, mask, parity-week pattern); within a group of size g with candidate rooms, build the g × g
(or rectangular, with currently-free eligible rooms added) cost matrix — Λ·roomClash for an
ineligible/occupied room, plus the travel delta of each (class, room) pair via
`travelCostOfAdding` — and solve with the existing `hungarian`. Everything outside the group is
untouched by construction. Run it as a **deep-phase rotation member and a post-pass before
`publish`**, never in the bandit (rule 5).

**E3b — the matching layer under time moves (ambitious).** For the tight instances where Π₃ (room
conflicts) binds: after any large operator, re-derive the room of every touched class by min-cost
assignment per (day, building) slice instead of carrying rooms through the move. This shrinks the
effective search space from |slots|·|rooms| to |slots|. It is a restructuring; attempt only after
E3a has measured, and keep the old path behind the flag.

**Hooks.** New `opRematch` in `search.cpp` (E3a); `State` already exposes everything needed.
Options: `useRematch`, `rematchGroupCap` (max group size, default 24). Flag: `--rematch`.

**Measure.** Primarily on `bench/instances-tight` and `instances-cap`, where rooms bind; the
archived ladder at `roomSlack 1.15` will likely show nothing, and that is expected, not failure.

### E4 — Backbone-guided and anti-backbone restarts (effort M)

**Hypothesis.** `restartFresh` samples basins independently — 75 fresh constructions per worker per
hour (S §6a) and none of them knows anything the previous 74 learned. Two complementary biases:

- **Intensify (backbone).** Placements on which the elite pool *agrees* are probably right. At
  construction, for each movable class whose placement is identical across ≥ `backboneQuorum`
  (default 0.75) of pool members, try that placement **first** in `scanBest`'s slot order (not
  fixed — merely first, so the construction can still refuse it). The rest constructs as now.
- **Diversify (anti-backbone).** When the previous basin ended with certified-irreducible defects
  (E2), penalise re-creating the trap: during the next construction only, add
  `antiBackbonePenalty` to `scanBest`'s score for (class, placement) pairs equal to the abandoned
  incumbent's placements of the classes that were *involved in those defects*. Decay the ledger
  after one construction.

**Specification.** Keep, in `Shared` under the mutex, a compact `spots`-indexed vote table updated
on every `offer()`; a worker snapshots it before constructing. Anti-backbone data comes from E2's
ledger (or, before E2 exists, from the worst-window buckets of the abandoned incumbent — a valid
cheaper prototype). Both biases feed one new argument into `construct()`/`scanBest`.

**Hooks.** `search.cpp`: `Shared`, `Worker::construct`, `Worker::scanBest`, `Worker::restartFresh`.
Options: `restartPolicy` = `fresh | backbone | anti | mix` (mix = ε-greedy among the three by each
policy's mean post-restart basin quality, ε = 0.2). Flags: `--restart-policy P`.

**Measure.** Only meaningful at budgets where restarts fire (≥ 180 s; S §9 point 1). Success looks
like the 600 s `fresh` row of S §6a moving again; the per-restart basin-quality series in the
journal is the diagnostic.

### E5 — Adaptive restart timing (effort S)

**Hypothesis.** `restartAfter = 1.2 M` moves is one number for all instances, budgets and phases.
The right moment to abandon a basin is an optimal-stopping question, and the run already collects
the data to answer it: how long past basins took to reach their final quality, and what they
achieved.

**Specification.** Per worker, record for each completed basin: moves from construction to the last
incumbent improvement (`ripen_b`), and final `(unp, hard, f)`. Maintain `R` = median of `ripen_b`
over past basins (seed with `restartAfter`). Fire `restartFresh` when
`moves − lastIncumbentMove_ ≥ max(restartMinMoves, ripenFactor · R)` with `ripenFactor` default
1.5. Additionally: fire immediately when E2 certifies the basin exhausted, whatever the counter
says.

**Hooks.** `Worker::run` stagnation branch; a small per-worker basin log. Options:
`restartAdaptive` (bool), `ripenFactor`. Flags: `--restart-adaptive`, `--ripen-factor X`.

**Measure.** 600 s and 3 600 s arms against fixed `restartAfter`, paired seeds; also verify the
30 s ladder is untouched (adaptive must not fire earlier than the fixed rule at short budgets —
clamp with `restartMinMoves = restartAfter / 2`).

### E6 — Exact permutation with branch-and-bound (effort M)

**Hypothesis.** `kopt`'s relaxation ignores member–member coupling; the pairwise refinement
recovers "most but not all" (README, *Known limitations*). A true exact solve over the occupied
placements is affordable at the deep phase's widths, and the deep phase is exactly where exactness
is wanted — it runs 24 attempts under strict descent when everything else has failed.

**Specification.** Replace (behind a flag) the Hungarian + refine pair *inside the deep phase only*
with branch-and-bound over assignments of the k members to the k occupied placements:

```
order members by fewest admissible placements first
bestDelta ← 0                       # only a strict improvement is worth applying
dfs(depth, usedPlacements, partialTrueDelta):
    if node budget exhausted: abort to Hungarian fallback
    if depth == k: bestDelta ← min(bestDelta, partialTrueDelta); record assignment; return
    LB ← partialTrueDelta + Σ over remaining rows of that row's minimum in the relaxed matrix
    if LB ≥ bestDelta: prune
    for each unused placement q admissible for member r_depth, cheapest-first by relaxed cost:
        placeRaw(r_depth, q); flush()          # true incremental delta, coupling included
        dfs(depth+1, …); undo via journal
```

The relaxed matrix is the one `permute` already builds, so the lower bound is free. Node budget
`koptExactNodes` (default 50 000) keeps it anytime; on abort, fall back to the existing path.
Assigning inside the occupied set preserves the multiset-of-placements safety argument, so the
`kopt-extra` failure mode cannot recur. `allLegal` on the final set as always.

**Hooks.** `Worker::permute` (a sibling `permuteExact`), called from `deepPhase` and E2's DFER.
Options: `koptExact` (bool), `koptExactNodes`. Flags: `--kopt-exact`, `--kopt-exact-nodes N`.

**Measure.** Deep-phase yield (improvements per deep phase, already countable from
`rep_.deepPhases` plus incumbent moves) and end quality at 600 s / 3 600 s. Kill if the deep phase's
wall-time share doubles without quality movement.

---

### E7 — The room-occupancy mask, and the sampling it makes unnecessary (effort S, the campaign's largest measured effect)

> **Verdict, after measurement.** Implemented, verified exact over 1.61 G live queries, and worth
> −9.00 (p = 0.006) at Stage A and −8.00 (p = 0.008) at **Stage C, 900 s on two workers** — the only
> mechanism in this campaign to survive that filter. Still **not promoted**: on the sets that decide
> defaults, where room domains are ~134 rather than 377–582, the same change is unresolved at up to
> 18 paired seeds (−2.06 to +1.44, signs flipping between sets and budgets) despite 25–43 % more
> candidates. Kept behind flags, to be enabled where classes name few or no rooms. Full account:
> CAMPAIGN-LOG.md §6k–§6q — including a rule about the residual that was proposed here and then
> falsified by E13, which is worth reading before proposing another one.

**Added after the fact.** E1–E6 were written before any measurement. E7 comes from one
(CAMPAIGN-LOG.md §6k), and it is the only entry in this document whose motivation is a number rather
than an argument. Cheaper models should treat it as the first thing to try.

**The observation.** Vary nothing but the share of classes that name **no** room — so their room
domain is every room the faculty owns — and the residual moves further than anything else in this
campaign has moved it: median soft 9 → 46 as that share goes 12.6 % → 100 %, Spearman ρ = 0.800 over
45 runs. The planted schedule is identical at every level and emptying `roomIds` *removes* a
constraint, so the solver is being handed a strictly larger feasible set and returning a much worse
answer. That is a solver defect, not a difficulty gradient.

**The cause.** `State::roomClashesAt` walks the room's day:

```cpp
for (int32_t j : buckets_[roomBucketId(room, day)]) { ... if (mask.intersects(o.mask)) ++n; }
```

so pricing one room is O(the room's day), and pricing a 582-room domain is 582 walks. `roomSample`
(96) exists to bound that, which is why a class naming no room is both expensive to place and placed
from a sixth of its options. The follow-up ladder (K1) confirmed the trade is throughput, not
coverage: `--room-sample 24` **beat** the shipped 96, 256 was worse, and the full scan was three
times worse than either. Sampling less is better because scanning is what costs.

**Specification.** Make the scan cheap instead of short.

1. Room buckets already have unused `occNum` / `occDen` fields in `BucketStat` (the people families
   use them for Π₇/Π₈; `recompute` returns early for rooms). Fill them for rooms too — the same
   loop, minus the window arithmetic. `addStat` ignores them, so nothing in the objective changes,
   and nothing is allocated that was not already allocated.
2. `State::roomFreeAt(self, day, mask, parity, room)` answers `roomClashesAt(...) == 0` with one
   `Mask::intersects`. It is **exact**, not approximate, with one caveat: a union of masks cannot
   have `self` subtracted from it, so the room this class already occupies falls back to the walk —
   one room out of the domain, at most.
3. Route every room query in `Worker` through two helpers, `roomFree` (boolean sites) and `roomCost`
   (penalty sites), so the shipped path stays byte-identical when the flag is off.

**Levels, and why there are three.** `roomFreeMask` = 0 off, 1 fast path, 2 mask only.
Level 1 is behaviour-identical — every decision the search makes is the same one, so any difference
in the result is purely how many candidates the same search got through, which isolates throughput
from every other effect. Level 2 charges one clash for any busy room instead of counting them, never
walks at all, and is therefore not identical: it asks whether the exact count was ever worth its
price. **Level 3 is the verification harness**: it answers from the walk, checks the mask against it
on every query, and reports `roomMaskChecks` / `roomMaskMismatch` per worker. A run reporting zero
mismatches over hundreds of millions of queries is what licenses levels 1 and 2; run it before
trusting any measurement here.

**The arm this is all for.** `--room-free-mask 2 --room-scan-full-below 1024`: mask-priced *and*
unsampled. If scan cost is the whole story, this should scan every room in the domain for less than
the shipped code spends on 96 of them, and §6k's curve should flatten. If it does not, the room
domain is hurting the search through some path other than the price of looking, and that path is the
next thing to find.

**Hooks.** `State::recompute` (the `isRoom` early return), `State::roomFreeAt` (new),
`Worker::roomCost` / `Worker::roomFree` / `Worker::verifyRoom` (new), the nine `roomClashesAt` call
sites in `search.cpp`. Options: `roomFreeMask`. Flags: `--room-free-mask N`.

**Measure.** Move rate first — it is the mechanism, and if it does not rise the change did not do
what it claims. Then soft at 180 s and 900 s across the `instances-unres` ladder, because the whole
point is a *slope* against unrestricted share, not a single mean. Kill level 2 if it wins on move
rate and loses on quality: that would say the exact clash count is load-bearing and only level 1
should ship.

**Why it matters beyond the benchmark.** The share of classes naming no room is not a benchmark
parameter; it is the fraction of curriculum items nobody filled in under «Призначення аудиторій».
If E7 flattens the curve, a real faculty's incomplete room assignment stops being a performance
cliff. If it does not, the finding becomes operational advice instead — and note that §6j already
showed widening `roomIds` beyond a couple of rooms buys nothing, so the advice is specifically
*name a few rooms*, not *name many*.

---

### E8 — The day-cap hoist: one room-independent test asked once per room (effort XS)

> **Verdict, after measurement.** 15/10 alone (p = 0.42) and load-bearing only as one of the three
> scan fixes; see E7's banner for the joint result. Kept behind `--hoist-day-caps` / `--cap-cache`.

**The largest of the room-scan costs, and the one that reads as a typo once seen.**

`State::placementAllowed(i, day, timeIdx, parity, room)` takes a room, so `scanBest` calls it inside
the room loop. Of the three things it tests, only two mention the room — the room's own availability
window and the room's own MAX_CLASSES_PER_DAY. The third walks the day buckets of **this class's
lecturers and groups**, and is a function of `(i, day, parity)` alone. It returns the same answer for
all 96 sampled rooms, and when it says no, the whole slot is impossible whatever room is tried.

`scanBest` already hoists the people-clash count and the window cost out of that loop for exactly
this reason. This test escaped the same treatment because its signature has a room in it.

**Specification.** Split the predicate, do not change it:

```cpp
bool peopleCapsAllow(int i, int day, int parity) const;                     // room-independent
bool roomAllows(int i, int day, int timeIdx, int parity, int room) const;   // room-dependent
bool placementAllowed(...) const { return roomAllows(...) && peopleCapsAllow(...); }
```

Call `peopleCapsAllow` once per slot, next to the existing `peopleClashesAt` / `windowCostOfAdding`
hoists, and `continue` to the next slot when it fails. Call `roomAllows` inside the room loop.
`placementAllowed` stays as the conjunction for the many callers with no loop to hoist out of.

**Why it is safe without an experiment to prove it.** The conjunction is unchanged and the
room-independent conjunct is constant across the loop, so the set of placements the scan may return
is identical, element for element. The flag exists to attribute the throughput, not to hedge the
correctness — a distinction worth keeping straight on changes of this kind. "Provably
semantics-preserving" still has to be measured, because *faster* is a claim about the machine and
only the machine can answer it; it does not have to be gated, because *same answer* is a claim about
the code and the code already settles it.

**Hooks.** `State::placementAllowed` (split), `Worker::scanBest` (the hoist). Options:
`hoistDayCaps`. Flags: `--hoist-day-caps`.

**Measure.** Move rate, then quality across the `instances-unres` ladder, and composed with E7 —
the two are orthogonal: this removes the room-independent cost per room, E7 removes the
room-dependent one. Composed, the full 582-room scan should cost less than the shipped 96-room
sample; that composed arm is the one worth watching.

**Look for more of these.** The general lesson is worth more than the fix: a predicate whose
signature names a loop variable it only partly depends on will be called once per iteration by
someone who trusts the signature. `travelCostOfAdding` is the next candidate — it is O(bucket) per
room, budgeted to six per slot, and the campaign's `--room-building-first` is an attempt to make
most of its answers derivable instead of computed.

---

## 5. Tier 2

Briefer specifications; same rules, same flag discipline. Each is independent unless §8 says
otherwise.

### T2.1 — Guided local search on the residual (GLS / breakout)

> **Verdict, after measurement: null, and the diagnosis matters more than the result.** λ = 2.5 / 5 /
> 10 gave W/L 5/11, 7/8, 8/10 over 18 paired runs each (tight-XL, two workers, 180 s), all with mean
> Δ of the wrong sign, `hard = 0` throughout and the penalty arming 16–17 times per run. The λ ladder
> trends *towards* neutral rather than through it, so "tune λ" does not survive.
>
> **Why:** GLS reprices the *endpoints* of a rearrangement, and the barrier is in the *path*. The
> intermediate states of a multi-class exchange carry a clash at λ_hard ≈ 10⁶, and a comfort-term
> penalty of size 2.5–10 is irrelevant against that. This is why `forceCloseRepair` — which applies
> the whole rearrangement as one atomic candidate against a snapshot, so intermediate states are
> never scored — is the only mechanism that has ever cleared a defect. See CAMPAIGN-LOG.md §6r and
> FINDINGS.md §3.4. **Do not retry with a different λ; build the atomic operator instead.**


At stagnation, instead of (or before) kicking: add a penalty term to the acceptance cost,
`+ glsLambda · Σ_{b ∈ P} win(b)`, where `P` is the set of (entity, day) buckets that hold the
incumbent's residual windows and `win(b)` reads off `BucketStat` (`stats_` is accessible; `P` ≤ 64
entries, so `cost()` gains a small loop over `P` only). The penalised surface makes the plateau
around the incumbent tilt away from the exact defect configuration the search keeps re-creating,
which is the classic cure for exactly this failure mode (Voudouris & Tsang's GLS; the breakout
method). Reset `P` on every new incumbent. Options: `glsLambda` (0 = off; try 0.5–2 × β₇). Flag:
`--gls X`. **Caution:** this changes the surface the walk descends, not the reported objective —
`noteIncumbent` and every comparison must keep using the unpenalised values. Measure at 180 s+;
kill if feasibility time regresses on tight instances.

### T2.2 — Compaction sweep (the multi-class window closer)

`winfix` failed as a bandit member and moved one class at a time. The defect actually calls for a
*joint* move: take one (entity, day, week) with a window, keep the classes in time order, and
re-place the whole tail after the hole leftwards — each class to the earliest admissible bell not
before the previous class's end — as **one candidate** (journal, `allLegal`, single accept test).
This crosses the worse-before-better valley that single moves cannot. Deep-phase rotation and DFER
only (rule 5). Options: `useCompaction`. Flag: `--compaction`.

### T2.3 — Parity moves for biweekly residue

Π₇/Π₈ are averaged over two weeks; a half-window often survives because a biweekly class sits in
the wrong week. Two micro-operators for the escalation phases: flip one biweekly class N↔D (if its
slot domain carries the twin slot), and exchange the parities of two biweekly classes in one
bucket. Both are two-line candidates over existing machinery. Options: `useParityMoves`. Flag:
`--parity-moves`. Only worth testing on instances with a real biweekly share (the tight set has
20 %).

### T2.4 — Path relinking (recombination's gentler cousin)

`--recombine` grafts half the clusters blind and pays a repair bill (S §6a). Path relinking walks
from the incumbent *toward* a distant pool member one differing placement at a time, evaluates
every intermediate state under the true cost, and keeps the best point of the whole path (restore
otherwise). No repair bill — illegal steps are skipped, `allLegal` guards each applied step — and
the best-of-path acceptance means it cannot lose quality. Trigger where `recombine()` now sits in
the escape ladder. Order the differing classes by probe-estimated gain, cheapest first. Options:
`usePathRelink`. Flag: `--path-relink`. Retry condition of the recombination row in §3 applies:
most interesting at ≥ 8 workers, but unlike recombination it is safe to test at 2.

### T2.5 — Construction tournament

`restartFresh` descends the first construction it builds. Build `constructTournament` (default 3)
constructions — different shuffles — score each by `(unp, hard, f̃)` after `rebuild()`, keep the
best, discard the rest. Direct attack on the basin lottery at the cost of ~2 extra construction
times per restart (~1–3 s at n = 12 800). Options: `constructTournament`. Flag:
`--construct-tournament N`. Measure at 600 s+: more selective sampling against fewer total basins.

### T2.6 — Escape-level bandit

The escalation ladder (deep → kick → adopt → restart) is fixed. Track, per escape type, the
surrogate improvement realised within the following `escapeWindow` = 100 k moves, per second it
cost, and choose the next escape ε-greedily by that statistic instead of by the fixed order.
Subsumes E5 if both measure well; test separately first. Options: `escapeBandit`. Flag:
`--escape-bandit`.

### T2.7 — Diverse adoption

`adoptElite` converges workers onto the shared best. When a worker is deeply stuck (kicks at
`kickMax` failing), adopting the pool member **most distant** from its own incumbent — even if
worse, within a factor — is exploration the fresh restart pays full price for. Options:
`adoptDiverse` (accept up to 10 % worse if distance ≥ 4 × poolMinDist). Flag: `--adopt-diverse`.

### T2.8 — DLAS (or mixed engines) as the long-budget default

DLAS is already implemented and scale-invariant, and "degenerates to hill climbing far less often"
(`acceptTest`). Nobody has measured `--engine dlas` or `--engine mixed` at 600 s / 3 600 s with the
current escape machinery. Pure measurement, zero code. Also worth one arm: per-worker heterogeneous
`lahcLength` (50 / 100 / 200) as a poor man's portfolio.

### T2.9 — Kick selector weighting by residual composition

`kick()` draws its selector uniformly from four. Weight the draw by what the incumbent's residual
actually is (read `bestCounters_`): worst-window buckets when Π₇+Π₈ dominate; hot/conflict sets
when hard > 0 (tight instances); cluster otherwise. Three lines and a table. Options: none — fold
into `restartFromBest` path; flag `--kick-weighted`.

### T2.10 — Ruin-size adaptation

`lnsMax = 40` and `kickMax = 300` are absolute counts, independent of n. At n = 51 200 a 40-class
ruin is 0.08 % of the instance. Scale candidates: `lnsMax = max(40, n/320)`,
`kickMax = max(300, n/40)`, behind `--scale-ruin`. Test only at XL sizes; expect neutral-to-positive
there and neutral at 12 800.

---

## 6. Tier 3

Engineering. The study says throughput is not the lever (S §4, §5), so these are last, and each
must prove it does not disturb quality (same seeds ⇒ same trajectory where the change is purely
mechanical).

- **T3.1 Bucket storage.** `buckets_` is `vector<vector<int32_t>>`; typical size ≤ 6. An inline
  small-buffer vector (or a fixed `int32_t[8]` with spill) removes an indirection from every probe.
  Also: `recompute`'s O(|B|²) pair loop is branchy; sorting members by start within the bucket
  would let travel pairs early-exit.
- **T3.2 `scanBest` candidate lists.** Per class, cache the slot order sorted by static desirability
  (domain-time preference alone) once at load; the scan then visits likely-good slots first and the
  `best`-pruning bites sooner. Verify with the existing prune counters, not by eye.
- **T3.3 Thread scaling study.** Every number in `STUDY.md` is two cores. Measure 2 / 4 / 8 / 16
  workers at 12 800 and XL, 180 s and 3 600 s, and re-run the §3 retry conditions that were parked
  on "many cores" (`--recombine`, T2.4, T2.7). This is measurement, not code, and it reprices
  several other rows.
- **T3.4 Instance load & construction profiling at XL.** At n = 51 200, construction cost and
  `rebuild()` cost grow; confirm restarts stay affordable (they are amortised over 10⁶ candidates —
  A §4 table) before trusting XL results.
- **T3.5 PGO/LTO build.** `-O3` only today. A profile-guided build is usually worth 5–15 % moves/s;
  quality-neutral by construction. Do it once, keep the recipe in the build script.

## 7. Data-side ideas

The benchmark shapes what can be learned. Two gaps in the instance families matter more than any
solver change they would measure:

- **D1 — Whole-university instances.** The solver's stated purpose is every faculty at once, and
  the whole-university mode is "untested against real data at scale" (README, *Known
  limitations*). `emit()` generates one faculty. Add a generator mode that emits F faculties
  (5–15), each with its own rooms plus a small shared pool (the contended resource that makes the
  whole-university problem different), lecturers with cross-faculty service teaching (5–15 %), and
  one shared bell grid. Then re-run the ladder at n_total ∈ {12 800, 25 600, 51 200}. Every
  Tier 1 idea should eventually be confirmed on D1 instances, because cluster structure — which
  the deep phase and E2 aim at — is qualitatively different when faculties are near-decomposable.
- **D2 — A harder yardstick at the top of the ladder.** At `roomSlack 1.15` the archive is passed
  in 30 s up to 1 600 (S §5). The tight set exists; extend it upward:
  `node bench/generate.mjs --out bench/instances-tight-xl --sizes "12800 25600" --seeds "1 2 3"
  --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'` — the
  regime where an hour-long budget has real work at real scale. This is one command and should be
  done before the campaign starts (the protocol's Stage 0 does it).

## 8. Interactions

- **E2 consumes E6 and T2.2** (as subsolvers) and **feeds E4** (the irreducibility ledger is the

- E7 — the room-occupancy mask, and the sampling it makes unnecessary
  anti-backbone source). Implement E6 and T2.2 as free-standing flags first; E2 then composes them.
- **E5 and T2.6 overlap** (both adapt the escape schedule): test E5 first — it is smaller — and
  fold it into T2.6 only if both pay separately.
- **E1 changes the repair everything else uses.** Land it (or reject it) before E2/E3 measurements,
  or the campaign pays a re-measurement of each. If E1's `regret-anchored` arm wins, E2's repair
  steps use regret by inheritance.
- **E4, T2.5 and T2.7 all spend the restart budget**; test against a common baseline arm and do not
  stack them until each has paid alone.
- **T3.3 (cores) reprices** `--recombine`, T2.4 and T2.7; schedule it before spending long budgets
  on those three.

## 9. The campaign queue

The order an automated campaign should take, balancing effort, leverage, and the interaction rules
above. One line per experiment; the protocol file defines what "run the ladder" means and how
verdicts are recorded.

| # | idea | effort | prerequisite |
|---|---|---|---|
| 1 | D2 tight-XL instances + Stage 0 harness verification | S | — |
| 2 | T2.8 engine arms (dlas / mixed / hetero-LAHC) — measurement only | S | 1 |
| 3 | E1 regret repair, both arms | S | 1 |
| 4 | E5 adaptive restart timing | S | 1 |
| 5 | T2.9 weighted kick selectors | S | 1 |
| 6 | E3a exact room re-shuffle | M | 1 |
| 7 | T2.2 compaction sweep (escalation-phase only) | S | 1 |
| 8 | T2.3 parity moves | S | 1 |
| 9 | E6 exact permutation B&B | M | 3 |
| 10 | E2 hard repair + irreducibility ledger (STAGNATION-ESCAPE.md) | L | 7, 9 |
| 11 | E4 backbone / anti-backbone restarts | M | 10 (ledger) — prototype possible after 4 |
| 12 | T2.1 GLS penalties | M | 3 |
| 13 | T2.5 construction tournament | S | 4 |
| 14 | T3.3 thread-scaling study | S | — (any time; before 15) |
| 15 | T2.4 path relinking, T2.7 diverse adoption | M | 14 |
| 16 | T2.10 ruin-size scaling + D1 whole-university generator | M | 1 |
| 17 | E3b matching layer | L | 6 |
| 18 | T3.1–T3.2, T3.5 engineering | M | after quality queue is exhausted |

Each experiment ends in one of three verdicts recorded in the journal: **promoted** (flag becomes
default; documented in `ALGORITHM.md` §5 and `STUDY.md`), **kept-off** (flag stays, numbers go into
the option's comment — the house pattern), or **removed** (the code was wrong, not the idea;
reverted entirely). The protocol file is the authority on how a verdict is reached.
