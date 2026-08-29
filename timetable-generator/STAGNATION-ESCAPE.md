# Stagnation, and the hard repair

What to do when the search holds a timetable it cannot improve. This file designs the mechanism
that idea E2 of [`OPTIMIZATION-IDEAS.md`](OPTIMIZATION-IDEAS.md) points at: a **hard repair
procedure** that fires when the ordinary machinery — the walk, the deep phase, the kick — has
demonstrably run out, attacks the surviving violations one defect at a time with exact methods, and,
when it can prove the defects locally immovable, abandons the timetable *deliberately*: it switches
the worker to a different candidate schedule and steers the next construction away from the trap it
has just certified.

It is written to be implemented and measured by an automated campaign under
[`EXPERIMENT-PROTOCOL.md`](EXPERIMENT-PROTOCOL.md), and it assumes the reader has `ALGORITHM.md`
(A §) and `STUDY.md` (S §). Everything here obeys the rules of `OPTIMIZATION-IDEAS.md` §2 — in
particular: evaluator semantics frozen, `allLegal` on every multi-class set, the threefold unplaced
defence, flags default-off, the anytime property, and nothing new in the bandit portfolio.

---

## Contents

1. [What stagnation is here, and what already answers it](#1-what-stagnation-is)
2. [Detecting "stuck" honestly](#2-detecting-stuck)
3. [DFER — defect-focused exact repair](#3-dfer)
4. [The subsolvers](#4-the-subsolvers)
5. [The irreducibility ledger](#5-the-irreducibility-ledger)
6. [Switching to a better timetable option](#6-switching)
7. [The feasibility surge (tight instances)](#7-feasibility-surge)
8. [The revised escape ladder](#8-the-revised-ladder)
9. [New options and flags](#9-options-and-flags)
10. [Correctness obligations](#10-correctness-obligations)
11. [How to measure it](#11-how-to-measure-it)

---

## 1. What stagnation is

Three facts from the study frame the design.

**The bar collapses, and tolerance does not fix it.** Late acceptance with ℓ = 100 is a hill climb
about a hundred moves after the last improvement; the plateau is *absorbing* — only a strict
improvement leaves it (A §3.3). Widening the bar (`--lahc 5000`) does not merely lose quality, it
prevents the search from reaching feasibility at all (S §9.3). So the tail cannot be rescued by the
acceptance criterion. **The tail is short of attempts.**

**The existing attempts ladder.** Algorithm 6 (A §3.7): deep phase (24 strict-descent
large-neighbourhood attempts, widening `koptWidth_`) → kick from the incumbent (related set, size
adaptive 12…300) → adopt the shared best → fresh restart after `restartAfter` = 1.2 M moves without
an incumbent. Measured worth: the kick 22 % of soft, the fresh restart another 32 % (S §6a).

**What the ladder still lacks.** Every rung is *stochastic*: a kick breaks a related set and hopes
the greedy repair lands elsewhere; a deep phase draws clusters and worst buckets and hopes the
permutation finds the exchange. When the residual is eight windows in twelve thousand classes
(S §6), the same few defect buckets get re-sampled for minutes, nothing ever concludes "this window
cannot be closed without moving that other faculty's fixed class", and the only exit is the
restart timer. The hour-long run's last twenty minutes are flat exactly because the machinery can
neither *finish* a defect nor *prove* it finished. The missing rung is a procedure that is
**exhaustive within a bounded neighbourhood**: slower per attempt by orders of magnitude, and
allowed to be, because it runs when the cheap attempts are provably not paying — it competes with
stagnation, not with `repack`.

## 2. Detecting stuck

The trigger must be evidence, not a timer alone. Three signals, all already countable in `Worker`:

| signal | meaning | source |
|---|---|---|
| `movesSinceIncumbent = moves_ − lastIncumbentMove_` | how long the search has really been stuck | exists (A §3.7 distinguishes it from `sinceBest_` on purpose) |
| consecutive failed kicks at `kickSize_ == kickMax` | the stochastic escape is saturated | count in `kickFromBest` / the stagnation branch: reset on any new incumbent |
| consecutive empty deep phases | the strict-descent large neighbourhoods are dry | count around `deepPhase()`; reset when it returns true |

**Trigger rule.** Enter the hard repair when *all* of:

```
movesSinceIncumbent ≥ hardRepairAfter            (default: stagnationMoves × 4 = 240 000)
failedMaxKicks      ≥ hardRepairKicks            (default 3)
emptyDeepPhases     ≥ 2
bestHard_ == 0  or  hard repair is entered in surge mode (§7)
```

and re-arm it only after `hardRepairAfter` further moves or a new incumbent, whichever first. At a
30 s budget these conditions are effectively unreachable — which is intended, exactly as
`restartAfter` never fires there (S §6a): short budgets must be byte-for-byte unaffected.

The trigger deliberately sits **between the kick and the fresh restart** in escalation order: the
kick is cheap and usually enough; the restart throws away a basin that may still hold an exact
improvement the stochastic repair could not see. The hard repair is the last thing tried inside a
basin and the thing that decides the basin is finished.

## 3. DFER

Defect-Focused Exact Repair. One invocation processes up to `repairDefects` (default 6) defects,
under one wall-clock budget `repairBudgetMs` (default 2 000 ms), anytime — the deadline and the
budget are polled between subsolver nodes, and a truncated attempt reports "not improved" exactly
as a truncated deep phase does (A §3.9).

```
Algorithm D1  hardRepair()
 1  st ← restore(bestSpots_)                        # anchor: always the incumbent, never the walk
 2  defects ← enumerate residual defects of the incumbent, worst first          # §3.1
 3  improvedAny ← false
 4  for defect in first repairDefects of defects, skipping ledger entries (§5):
 5      N ← extract the defect neighbourhood       # §3.2
 6      improved ← solve the frozen subproblem on N exactly within budget       # §4
 7      if improved:  noteIncumbent();  improvedAny ← true;  ledger.clear()     # the basin moved
 8      else if the subsolver ran to completion (not truncated):
 9          ledger.mark(defect)                    # certified locally irreducible — §5
10  if improvedAny: return RESUMED                 # walk continues from the improved incumbent
11  if every enumerated defect is ledger-marked: return BASIN_EXHAUSTED         # §6 takes over
12  return UNPROVEN                                # truncations; fall through to kick/restart
```

### 3.1 Defect enumeration

A **defect** is one (entity, day) bucket carrying residual cost, ordered by what the objective
charges:

- soft phase (`bestHard_ == 0`): buckets from `worstWindowBuckets` (already weighted ×4 for
  groups), plus buckets with `mixNum/mixDen` set (Π₉ residue), plus — when biweekly classes are
  present — buckets whose `winNum ≠ winDen` (half-window residue, the T2.3 target);
- surge mode (§7): buckets with `conflicts`, `travel` or `overflow` non-zero, largest first
  (`collectHot` gives the members; the bucket ids come from the same scan).

### 3.2 Neighbourhood extraction

The subproblem must contain every class whose movement could plausibly clear the defect, and
nothing else. Two-hop extraction over the class ↔ entity graph, all read from existing state:

```
core   = movable members of the defect bucket                       (bucketMembers)
ring1  = movable classes sharing any lecturer/group with a core class on the defect day
         (walk the core classes' other entity buckets on that day)
ring2  = movable classes of the defect entity on *other* days       (receivers for an evicted class)
       ∪ movable classes currently occupying, on the defect day, a slot in some core class's domain
         within the defect bucket's span (the blockers)
N      = core ∪ ring1 ∪ ring2, capped at repairScope (default 48) by dropping ring2 first,
         then ring1, by distance from the hole
```

Everything outside `N` is **frozen**: the subsolvers may read it (it defines the clash/travel/cap
landscape) but never move it. Fixed classes and other faculties' entries are frozen by
construction, exactly as in the main search.

## 4. The subsolvers

Four, tried in the order given — cheapest decisive first. Each returns *improved*, *proven-no* (ran
to completion without finding a strictly better arrangement), or *truncated*. All work through the
ordinary journal (`beginCandidate` / `moveTo` / `undo`) so a failure leaves no trace, and all end
with `allLegal(N)`.

### 4.1 Exact permutation over the neighbourhood (E6 as a subroutine)

The branch-and-bound of idea E6, run over `min(|N|, koptK + 4)` members drawn core-first, with the
LAP lower bound from the relaxed matrix and node budget `koptExactNodes`. This is the cheapest
subsolver that is *complete* over its scope (permutations of occupied placements), and it certifies
"no permutation of what these classes hold clears the defect".

### 4.2 Day-slice re-solve

The defect is a property of one (entity, day, week), and the objective is separable over buckets
(A, Lemma 1), so re-deciding **only the defect day** of the core entities is a small complete
search: for each class in `core ∪ ring1`, candidate placements are its domain slots *on that day*
(any parity, any room chosen greedily-best per slot as `opDayRepack` does) **plus one "leave the
day" option** — its single best off-day placement by `scanBest` restricted to other days. Then
depth-first over classes, most-constrained first, true incremental cost via `placeRaw`/`flush` at
each node, pruning on `partial ≥ bestKnown` — with the same admissible bound as E6 (row minima of
each remaining class's candidate costs, computed once). Branch cap `repairBranch` (default 8
candidates per class, best-first by probe score). This generalises the rejected `dayfix` in the two
ways that matter: the scope is chosen by evidence, not drawn by the bandit, and "move a class off
the day entirely" is inside the search rather than left to other operators.

### 4.3 Room re-matching over the neighbourhood (E3a as a subroutine)

Surge mode mostly, and whenever Π₃/Π₅ contribute to the defect: the Hungarian re-shuffle of rooms
among time-identical members of `N` plus currently-free eligible rooms, as specified in E3a. Exact
and cheap; certifies "no reassignment of rooms alone clears it".

### 4.4 Bounded ejection search

The completeness backstop for defects that need a longer displacement chain than depth-3 `opChain`
reaches: an ejection-chain search (Lin–Kernighan discipline) rooted at each core class in turn —
move it to each of its `repairBranch` best placements; whoever it displaces is moved likewise;
depth ≤ `repairEjectDepth` (default 6); a class may enter the chain once (tabu within the chain);
backtrack on dead ends; stop at first strictly-better total or exhaustion. Unlike `opChain` this
explores alternatives at every link rather than committing to one, and unlike everything else it may
temporarily hold a hard violation mid-chain — the journal makes that safe, and the acceptance is on
the completed chain only.

## 5. The irreducibility ledger

When a subsolver **completes** without improvement, the defect is *certified locally irreducible*:
no rearrangement within its neighbourhood, of the kinds the subsolvers cover, improves the
incumbent. Record it:

```
struct Irreducible { size_t bucketId; uint64_t basinId; int coreClasses[…]; Spot coreSpots[…]; }
```

`basinId` increments on every construction/adoption, so certificates die with the basin (line 7 of
D1 also clears them when the basin moves — a certificate is relative to the frozen complement).
The ledger is per-worker, bounded (`repairLedgerCap` = 32), and consumed by two readers:

- **DFER itself** skips ledger-marked defects — the anti-grind rule: the tail must not re-prove
  the same "no" for twenty minutes;
- **the biased restart** (§6): the (class, spot) pairs of certified defects are the anti-backbone
  set idea E4 penalises in the next construction.

An honest limitation, to be stated wherever this is written up: the certificate is relative to the
neighbourhood cap and the subsolver family — it is "locally irreducible", not "optimal". That is
exactly enough for its two uses, and no more must be claimed.

## 6. Switching

The user-facing question this file answers: *when the timetable cannot be improved, switch the
search to a better option and move on.* The `BASIN_EXHAUSTED` return of D1 is the proof-backed
version of "cannot be improved", and it should preempt the restart timer:

```
Algorithm D2  onBasinExhausted()
 1  offer bestSpots_ to the pool and shared best        (as restartFresh already does)
 2  choose the successor, ε-greedy by past post-switch payoff:
      a. adoptDistant  — the pool member most distant from bestSpots_ that is within
                          adoptDiverseSlack (10 %) of the shared best   (T2.7's move)
      b. restartBiased — fresh construction with the anti-backbone penalty of E4 fed from the
                          ledger: scanBest adds antiBackbonePenalty to a certified (class, spot)
      c. restartFresh  — the plain existing mechanism, as control and fallback
 3  block adoption for restartAfter moves               (existing rule; A §3.7.3, line 4)
 4  reset ledger, counters, kick size, acceptance history — as restartFresh does today
```

Payoff for the ε-greedy choice: the successor basin's best `(unp, hard, f)` at the moment *it* is
abandoned, compared with the exhausted basin's — a number available exactly when the next switch
happens. Until three switches have completed, use fixed order b, a, c.

The important property: **nothing is lost.** The exhausted incumbent is in the pool and the shared
best, and `solve()` returns the ≺-least ever seen (A §6, invariant 3), so switching is free in
correctness terms; what it spends is only the remaining budget — which stagnation was already
spending on nothing.

## 7. The feasibility surge

Everything above assumes the walk reached `hard = 0` and windows are what remains — true on the
archived ladder, not on the tight set, where the honest failure mode is hard violations that the
walk cannot clear (`--lahc 5000` at 60 s leaves 236–762 of them, S §9.3; even the default engine on
`instances-tight-xl` may hold conflicts for minutes). The same machinery serves, with three
changes, as a **feasibility surge** triggered by `bestHard_ > 0` persisting for
`surgeAfter` (default `stagnationMoves × 4`) moves:

- defect enumeration switches to conflict/travel/overflow buckets (§3.1, surge branch);
- the subsolver order becomes 4.3 (rooms first — cheapest way to clear Π₃), 4.4 (ejection — the
  classic repair for placement conflicts), 4.2, 4.1;
- acceptance inside subsolvers compares `(hard, f̃)` lexicographically rather than surrogate alone,
  so a step that trades one conflict for two windows is taken.

Additionally — and separately testable — a **breakout weighting** for the surge: maintain a
per-bucket integer `breakout[b]`, incremented each time a surge attempt leaves bucket `b` still in
conflict, and add `breakoutLambda · Σ breakout[b over dirty conflict buckets]` to the walk's cost
term while `hard > 0` (Morris's breakout method; the hard-phase sibling of T2.1's GLS — same
caution: reported objective and incumbent comparisons stay unpenalised). Reset on feasibility.

## 8. The revised ladder

Algorithm 6 (A §3.7) with the new rung, replacing the body of the stagnation branch in
`Worker::run`:

```
Algorithm D3  escape  (revised; new lines marked ►)
 1  if deepPhase() improved:                       return
 2  if sinceBest < stagnationMoves:                return
►3  if surge trigger (§7):                         hardRepair(surge); handle as lines 5–7
►4  if hard-repair trigger (§2):
►5      r ← hardRepair()
►6      if r == RESUMED:                           return
►7      if r == BASIN_EXHAUSTED:                   onBasinExhausted(); return
 8  if movesSinceIncumbent ≥ restartAfter:         restartFresh(); return
 9  if useRecombine and coin(recombineRate) and recombine(): return
10  if cooperate and sinceAdopt > stagnationMoves: adoptElite(); return
11  kickFromBest()
```

Everything after a hard-repair `UNPROVEN` falls through to the existing rungs unchanged, so a
truncation costs nothing but its budget. With `--hard-repair` off, D3 is byte-for-byte Algorithm 6.

## 9. Options and flags

All default-off or default-preserving; comments carry measured numbers once the campaign has them,
per the house pattern.

| option | default | flag |
|---|---|---|
| `useHardRepair` | false | `--hard-repair` |
| `hardRepairAfter` | 240 000 | `--hard-repair-after N` |
| `hardRepairKicks` | 3 | `--hard-repair-kicks N` |
| `repairBudgetMs` | 2 000 | `--repair-budget-ms N` |
| `repairDefects` | 6 | `--repair-defects N` |
| `repairScope` | 48 | `--repair-scope N` |
| `repairBranch` | 8 | `--repair-branch N` |
| `repairEjectDepth` | 6 | `--repair-eject-depth N` |
| `repairLedgerCap` | 32 | — |
| `useSurge` | false | `--surge` |
| `breakoutLambda` | 0 (off) | `--breakout X` |
| `switchPolicy` | `biased` (b,a,c ε-greedy) | `--switch-policy P` |
| `antiBackbonePenalty` | 2 × β₈ | `--anti-backbone X` |

Every one of them must be printable into the run summary (`SearchResult::summary` already carries
per-worker counters — add `hardRepairs`, `defectsCleared`, `defectsCertified`, `basinSwitches`),
because the protocol's diagnostics read them.

## 10. Correctness obligations

The checklist a reviewer — or the verifying stage of the campaign — holds the implementation to:

1. **Journal discipline.** Every subsolver mutation goes through `moveTo`/`placeRaw` recorded for
   undo; every failure path calls `undo()`; no early `return` may leave `jr_` non-empty or a class
   lifted. (The `repairAfterGraft` comment in `search.cpp` records exactly this class of bug.)
2. **`allLegal` on the final set** of every applied subproblem solution — the set-valued cap can be
   broken by k individually-legal placements (A §1.3). The Experiment-0 regression must pass with
   `--hard-repair --surge` forced on.
3. **Unplaced defence.** Subsolver 4.4 may lift classes mid-chain; its exit paths must restore or
   place every one. Assert `st_.unplacedMovable()` unchanged across `hardRepair()` (debug builds).
4. **Anytime.** `repairBudgetMs` and `sh_.deadline` polled at every subsolver node loop; a
   truncated run must be side-effect-free apart from the ledger *not* being written.
5. **Determinism.** Subsolver tie-breaks (equal costs) resolve by index, not by iteration order of
   anything unordered; the ledger is per-worker.
6. **Evaluator untouched.** DFER reads `State` and calls existing mutators only. If a new read-only
   probe is added to `State`, `--mode score-hidden` on all 50 archives is re-run anyway (rule 1 of
   the ideas file).
7. **Reporting honesty.** `publish` continues to describe the incumbent only; hard-repair activity
   appears as counters and as `phase = "repair-hard"` trajectory rows, never as fabricated
   incumbent movement.

## 11. How to measure it

The escape is the mechanism the variance experiments were built for, so the protocol's Stage B/C
arms extend `bench/arms.sh` rather than replacing it:

| arm | flags |
|---|---|
| `kick` (baseline) | *(defaults)* |
| `dfer` | `--hard-repair` |
| `dfer+switch` | `--hard-repair --switch-policy biased` |
| `dfer+switch+surge` | `--hard-repair --switch-policy biased --surge` *(tight instances only)* |

Paired on the six seeds {11, 22, 33, 44, 55, 66}, at 180 s, 600 s and 3 600 s, on `n12800-s1`,
`instances-tight` n = 6 400 and `instances-tight-xl` n = 12 800; medians and paired differences;
sign test as in S §1. Success at 600 s looks like the `fresh` row of S §6a (mean soft 7.5) moving
toward the per-seed minima the variance table shows are reachable (soft 4–5); at 3 600 s, like the
last twenty minutes of the §6 trajectory no longer being flat. Two diagnostics decide *why* it wins
or loses, both from the new counters: `defectsCleared / hardRepairs` (is the exact machinery finding
anything the kick could not?) and time share of `phase == "repair-hard"` rows (is it paying for
itself in wall-clock?). Kill criteria: any Stage A correctness failure; a 30 s ladder regression
(the triggers must make short budgets unreachable — verify byte-identical summaries with
`--hard-repair` on and off at 30 s); or Stage B worse on ≥ 4 of 6 paired seeds.
