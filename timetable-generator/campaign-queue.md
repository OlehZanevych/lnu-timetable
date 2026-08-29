# Campaign queue

Status of every experiment in `OPTIMIZATION-IDEAS.md` §9, kept current by the loop in
`EXPERIMENT-PROTOCOL.md` §7. Verdict blocks are appended as they land.

| # | idea | flag | status |
|---|---|---|---|
| 1 | D2 tight / tight-XL / XL instance sets + Stage 0 | — | **done** — 50/50 archives agree, new sets agree |
| 2 | T2.8 engine arms (dlas / mixed) | `--engine` | todo |
| 3 | E1 repair order | `--repair-order` | **Stage A done** — see verdict |
| 4 | E5 adaptive restart timing | `--restart-adaptive` | implemented, unmeasured |
| 5 | T2.9 weighted kick selectors | `--kick-weighted` | in screening B1 |
| 6 | E3a exact room re-matching | `--rematch` | in screening B1 |
| 7 | T2.2 compaction sweep | `--compaction` | in screening B1 |
| 8 | T2.3 parity moves | `--parity-moves` | in screening B1 |
| 9 | E6 exact permutation B&B | — | not implemented |
| 10 | E2 hard repair + ledger + basin switch | `--hard-repair`, `--switch-policy` | implemented, Stage B pending |
| 11 | E4 anti-backbone restarts | `--switch-policy 1` | implemented as part of 10 |
| 13 | T2.5 construction tournament | `--construct-tournament` | implemented, unmeasured |

## Measurement configuration

Two cores. Screening runs use `--threads 1` with two runs concurrently: it doubles throughput and
removes the one clock-driven source of noise in the search (cooperation publishes on a wall-clock
interval, A §3.9), at the cost of not exercising the portfolio. Anything promoted must be re-checked
at `--threads 2`, which is the configuration `STUDY.md` reports and the desktop application runs.

### B1 screening — verdicts (60 s, six paired seeds, threads 1)

Δ soft against the shipped default, tight-XL n12800-s1 / tight n06400-s1:

| arm | tight-XL 12800 | tight 6400 | verdict |
|---|---|---|---|
| `--parity-moves` | −12 % (5/0/1, p=0.063) | −4 % | promote to Stage B |
| `--compaction` | −10 % (4/1/1) | −1 % | promote to Stage B |
| `--kick-weighted` | −9 % (4/0/2, p=0.125) | +5 % | promote to Stage B |
| `--rematch` | −6 % (5/1/0) | +17 % | promote to Stage B (its target is rooms, and neither set makes them bind) |
| `--repair-order 1` | −3 % (4/2/0) | +14 % | **kept-off** — wins at n=3200 (−21 %, 5/0/1) and nowhere above it |
| `--repair-order 2` (regret-2) | — | — | **kept-off** — Stage S: 2.5× the move rate for no quality |

### The defect-targeting bug

Diagnosing why the hard repair's exact subsolvers were winning 0 of 42 found a fault in the
**shipped** search, not in the new code. `State::worstWindowBuckets` ranks (entity, day) buckets by
window count, and the list is read by the `worstWindow` ruin selector, by the permutation's member
draw, by the kick and by `opCloseWindow`. Buckets whose вікна are held open by *immovable* classes —
the fixed entries of the faculties this run schedules around — rise to the top of that list
precisely because nothing has been able to tidy them, and no operator aimed at one can close
anything. Six of six enumerated defects had ≤ 1 movable member. `--actionable-windows` requires two.

### The residual is an equilibrium, not a search failure

With actionable targeting, the exact day-slice solver explores up to 46 656 complete arrangements of
six classes — including pulling a class in from another day — and returns `best == before` exactly,
defect after defect. The incumbent is a genuine strict local optimum. The cause is the quadratic
objective: closing one lecturer window among 26 is worth β₇(26²−25²) = 255, and the rearrangement
that closes it opens a group window costing β₈(12²−11²) = 460. Every single-defect repair is a trade
that loses, so no procedure requiring each step to improve can leave the plateau. That is what
`forceCloseRepair` is for, and it is the only subsolver that has cleared a defect.

### B2 Stage B — verdict: no promotion (300 s, six paired seeds, single worker)

Δ soft against the shipped default:

| arm | archived n12800-s1 | tight-XL n12800-s1 |
|---|---|---|
| `act` (actionable windows) | +23 % (3/3) | −3 % (2/3) |
| `combo` (act + parity + compaction + rematch + weighted kick) | +14 % (3/3) | −1 % (2/3) |
| `hr` (combo + hard repair + region rebuild) | +32 % (1/5) | −5 % (3/2) |
| `tourn` (three constructions, keep the best) | +22 % (1/5) | +4 % (2/3) |

Nothing is promoted. Two readings worth keeping:

**The "no spare draws" finding applies to the deep phase too.** The four new operators live in the
deep-phase rotation precisely so they would not take draws from the bandit — and at 300 s they lose
anyway, because the rotation's 24 attempts are now split five or six ways instead of three, and the
three they were split from (`kopt`, worst-window `ruin`, `repack`) are the ones that were paying.
The right place for an operator that is matched to the residual is *after* the proven ones have come
back empty, not beside them. That is what the hard-repair ladder does, and it is where these
operators should be moved before they are measured again.

**Better basins lose to more basins.** `tourn` builds three constructions and descends the best of
them; it is worse on five of six archived seeds. Sampling the basin distribution more often beats
sampling it more selectively, which sharpens rather than contradicts §6a's restart result.

**The spread, again.** `off` on the archived instance returns soft 16 19 7 23 9 14 — a factor of
3.3 across six seeds at a fixed budget. Six paired seeds resolve a ~20 % effect with power 0.34
(STUDY.md §1). Every row above is inside that band except by sign count.

### C1 Stage C — the hour: dead heat
Three paired seeds, tight-XL n12800, trajectories. Median soft at 3600 s: `off` 17, `hr` 18;
paired Δ −3, −2, +5, mean 0.00. Both arms still descending at the half-hour (`off` 51→17 over the
hour). The stuck-state machinery is neutral at the hour and costs ~2 % of the move rate.

### D1 Stage B/escalated — the flattened escape phase: null
Six seeds suggested −8 %; **twenty** paired seeds give mean −0.95 (−3.2 %), W/L/T 10/9/1, identical
medians, Wilcoxon W⁺ 81 vs W⁻ 109. Kept behind `--flat-phase`, numbers in the option comment.

### Campaign close
Nothing promoted. The shipped configuration stands. The products are the diagnosis in
CAMPAIGN-LOG.md §3, the `--actionable-windows` fix, the compound-move repair, the harness, and a set
of measured negatives. Next actions in CAMPAIGN-LOG.md §5, in order.

### E1/E2/E3 — the objective's shape
`--soft-alpha 1 --soft-equal` measured −10.4 % (tight-XL, 20 seeds) and −19.1 % (archived, 19 seeds)
in total windows at 300 s single-worker — then **+2.1 %, W/L 2/4** at two workers and 900 s, the
shipped configuration. The composition is stable across all three: Π₇ down ~2–4.6, Π₈ up ~2–2.3,
f(σ) worse. Verdict: a redistribution, not an improvement. Kept behind the two flags; the trade
belongs in `global_properties` if a deanery wants to make it.

### F1 — the exact joint two-defect repair: does not pay
Two workers, 900 s, tight-XL n12800, eight paired seeds: soft median 17 → 18, mean +14 %, W/L/T
2/4/2. It does clear defects the single-defect ladder cannot (~1 in 30, like `forceCloseRepair`),
but the clearing is worth less than the candidates it costs. Kept behind `--hard-repair`;
`--no-joint-repair` isolates it.

### G1/G2 — the whole university
`bench/compose-university.mjs` composes F single-faculty instances into one planted-feasible
problem. Cross-faculty contention proved impossible to add after the fact at these densities (no
room pair and no lecturer pair across faculties has disjoint planted usage), so the instances test
scale and decomposition only. Result at 12 288 classes, 900 s, two workers: decomposed +
comfortable slack → **0, 0, 0** (proven optimal); decomposed + tight slack → 21, 24, 25; uniform +
comfortable → median 7.5; uniform + tight → median 17. Room slack dominates; structure decides only
when slack is comfortable.

### H1/H2 — the one-pass university generator, and the two factors
`bench/build-uni.mjs` + `emit-uni.mjs` + `generate-uni.mjs`: the shipped builder with faculties,
service teaching and a shared room block as parameters. Reproduces `timetable-bench/emit.mjs`
byte-for-byte at F=1, service=1, sharedRooms=0. Every planted schedule scores hard=0.

Difficulty (soft, n=12 288, F=4, 900 s, two workers, three seeds):

| service | roomSlack 1.15 (6 seeds) | roomSlack 1.00 (3 seeds) |
|---|---|---|
| 0 % | mean 4.67, median 3 | 13.3 |
| 5 % | mean 8.50, median 9 | 11.7 |
| 20 % | mean 10.33, median 9 | 15.0 |
| 100 % | mean 8.17, median 7.5 | 13.3 |

Room slack dominates; coupling is secondary and only expresses itself when rooms are comfortable —
the two interact. Extending 3 → 6 seeds cut the apparent coupling effect roughly in half
(0 % went 2.0 → 4.67), and no Mann-Whitney comparison reaches p < 0.05 (best 0.066 at 20 %). The
ordering is supported; the ratio is not. Next: several *instance* seeds per level, not just PRNG
seeds.

### H3 — the coupling ladder across instance seeds: not resolved
Three instance seeds × three PRNG seeds per level, 300 s, two workers. Means 11.33 / 16.11 / 14.56 /
13.33 for service 0 / 5 / 20 / 100 %; Mann-Whitney against 0 % gives p ≈ 0.064, 0.354, 0.354. The
per-instance means *within* the 20 % level run 7.7, 15.7, 20.3 — wider than the gap between levels.
Coupling is at most a small effect and nine runs per level cannot see it.

### The room dimension — resolved
Pooled over all four coupling levels at 900 s: `roomSlack 1.15` n=24 mean 7.92 median 8, against
`roomSlack 1.00` n=12 mean 13.33 median 13, **Mann-Whitney p ≈ 0.002**, same direction in all four
matched levels. The only instance-property effect the campaign resolved.

### I1 — the room-slack curve: the one lever that works
n = 12 288, F=4, service 20 %, three instance seeds × three PRNG seeds per rung, 300 s, two workers.

| roomSlack | rooms | median | mean | p vs 1.00 |
|---|---|---|---|---|
| 1.00 | 582 | 20.0 | 22.56 | — |
| 1.05 | 611 | 17.0 | 17.67 | 0.031 |
| 1.10 | 640 | 16.0 | 18.33 | 0.200 |
| 1.15 | 669 | 16.0 | 15.00 | 0.058 |
| 1.30 | 756 | 7.0 | 9.89 | **0.009** |

Pooled tight vs comfortable: 20.11 vs 12.44, p ≈ 0.012. Thirty per cent more rooms halves the
residual. The first significant quality improvement the campaign has produced, and it is an input
change rather than a search change.

### J1 — room eligibility at a fixed room count: null
`--eligibility K` varies how many rooms each class names, holding the room count (582), the planted
schedule and everything else identical. n = 12 288, three instance seeds × three PRNG seeds, 300 s.

| K | mean roomIds/class | mean soft | p vs K=1 |
|---|---|---|---|
| 1 | 1.97 | 28.22 | — |
| 2 | 2.46 | 24.78 | 0.185 |
| 4 | 3.44 | 24.33 | 0.270 |
| 8 | 5.39 | 26.50 | 0.564 |
| 16 | 9.30 | 22.89 | 0.102 |

Pooled narrow vs wide p ≈ 0.448, non-monotone. Against §6i's room-count ladder (−56 %, p = 0.009)
the contrast is the finding: **capacity is the constraint, assignment flexibility is not**. There is
no free version of the room lever.

### J2 — the unrestricted-room share: running (25/45 at the time of writing)

`--unrestricted-share u` varies the share of classes naming **no** room, which may therefore use any
of the faculty's 582 rooms across every kind and корпус. Same planted schedule at every level (all
three instance seeds give byte-identical `hidden` and reference soft 14 832 / 14 808 / 14 908), so
the levels differ in the *domain sizes handed to the solver*, not in what a perfect answer scores.

| level | classes naming no room | mean room domain | mean soft (partial) | mean moves |
|---|---|---|---|---|
| ur0 | 12.6 % | 74.0 | 9.17 | 31.3 M |
| ur015 | 26.0 % | 150.3 | 23.50 | 26.1 M |
| ur035 | 43.2 % | 252.2 | 28.17 | 20.4 M |
| ur060 | 64.9 % | 377.2 | 37.50 | 16.2 M |
| ur10 | 100 % | 582.0 | 50.67 | 13.0 M |

Monotone in every column, and **the instance is being relaxed as it gets worse**. Aggregate
availability-constraint size is flat across levels (48.8–52.1 kB, non-monotone), so tightness is not
the explanation. This is a solver deficiency in room-domain size, not instance difficulty — the
first search-side lead the campaign has produced with an effect this large.

### K — what the J2 curve says to try

Two candidate mechanisms, separable by experiment:

| # | mechanism | flag | test |
|---|---|---|---|
| K1 | the **sample** is too small — 96 of 582 rooms is 16 % coverage | `--room-sample`, `--room-scan-full-below` | ladder 24 / 96 / 256 / full on ur060 + ur10 |
| K2 | the **travel budget** is too small — only 6 rooms per slot are priced for the journey, so 90 of 96 sampled rooms are scored as though travel were free, and cross-корпус domains propose journeys the acceptance test then rejects | `--room-building-first`, `--room-travel-budget` | `bf` against `off` on ur0 / ur035 / ur10 |

**A no-op caught by an identity check.** The first `--room-building-first` screen returned soft
26, 32, 21, 16 for `bf` and soft 26, 32, 21, 16 for `off` — identical to the digit on four paired
runs. Two arms that share an RNG stream and differ only in a *reordering* should not agree exactly,
so the filter had never fired. `State::buildingsOn` was abandoning its mask (returning 0) on any
occupant not in a real building, and these instances have both online classes and abstract rooms, so
almost every (entity, day) bucket contained one. The fix separates the two claims the mask was
conflating: **ordering** by "the one building already in use" is sound whatever else shares the day,
while **skipping the travel evaluation** needs the stronger "nothing online or abstract shares the
day", now reported through an `allInBuilding` out-parameter. Recorded because the failure mode is
invisible — a flag that does nothing measures as a clean null, and only the exact tie gave it away.
The archived void run is `bench/results/K2-A-nofire.jsonl`.

The screening budget also moved 60 s → 180 s. At 60 s a single worker on n = 12 288 ur10 finishes at
soft ≈ 400 against the 48 it reaches at 300 s: that is bulk descent, not the regime §6k measured.

K1 is diagnostic; K2 is a candidate fix. `--room-building-first` computes, once per slot, the set of
buildings the class's own people already occupy that day (`State::buildingsOn`); when that set is a
single building, every room in it is journey-free by construction, so the scan spends its whole
sample there and skips travel pricing entirely. Deliberately narrow — with two or more buildings in
use the premise fails and the filter is not applied. Status: implemented, syntax-checked, **not yet
compiled or measured** (J2 owns both cores).

### K/E7–E12 — the room scan: found, fixed, measured, and not promoted

| # | idea | flag | status |
|---|---|---|---|
| K1 | room sample size | `--room-sample` | **measured** — 24 beats the shipped 96 by 8/9 at both large-domain levels (§6l) |
| K2 | building-first room order | `--room-building-first` | implemented, unmeasured — superseded by E7 before it ran |
| E7 | room occupancy mask | `--room-free-mask N` | **measured** — level 3 verified over 1.61 G queries, 0 mismatches |
| E8 | day-cap hoist | `--hoist-day-caps` | **measured** — 15/10 alone; carries only as one of three |
| E9 | cached bucket counts | `--cap-cache` | **measured** — as above |
| E10 | sample ladder on the cheap scan | — | **measured** — the two levers are substitutes (§6o) |
| E11 | promotion test | — | **null** — 9/8, 9/8, 9/7 on the shipped sets (§6p) |
| E12 | 900 s, two workers, on `instances-unres` | — | **survives** — 15/3, −8.00, p = 0.0075 (§6q) |

**Verdict: no default changes — but this is the campaign's first mechanism to survive Stage C.**

| E13 | budget ladder on tight-XL, testing the residual rule | — | **falsifies it** — no rung wins (§6q) |
| G1 | T2.1 guided local search, λ ladder | `--gls X` | **null** — 5/11, 7/8, 8/10 at λ = 2.5/5/10, 18 pairs each (§6r) |


| measurement | residual at the budget | candidates | Δ soft | p |
|---|---|---|---|---|
| unres, 180 s, 1 worker | 50–80 | +45–55 % | −9.00 | 0.006 |
| unres, **900 s, 2 workers** | 20–38 | +84–103 % | **−8.00** | **0.0075** |
| shipped sets, 300 s, 2 workers | 8–22 | +21–43 % | −0.28 | 0.80 |

A rule was proposed from those three rows — that the variable is how far the residual still is from
the §3.2 equilibrium — and **E13 falsified it**: on tight-XL at 60 s, residual 30, where the rule
predicted a win, the effect is −0.50 at p = 1.000, and no rung of the budget ladder wins.

What survives is narrower. The predictor is the **room domain**: −8 to −9 (p ≈ 0.006–0.008) where it
runs to hundreds, and **unresolved** (−2.06 to +1.44, signs flipping) where it is ~134, at up to 18
paired seeds. Defaults do not move. Enable
`--room-free-mask 2 --hoist-day-caps --cap-cache --room-sample 24` where classes name few or no
rooms; do not enable it elsewhere on this evidence.

Still open, and cheap for a later model to run: `--room-building-first` and `--room-travel-budget`
were implemented and never measured (`campaign/kblock2.sh` runs both). They target the last
O(bucket) cost in the room loop — `travelCostOfAdding`, budgeted to six rooms per slot, which means
ninety of ninety-six sampled rooms are scored as though travel were free. Expect the same shape as
E7–E9: real on `instances-unres`, null where it counts. Worth running only to confirm that shape.


---

## Campaign close — final state

**Search paused here at the user's request** (further sessions on this project are for writing
papers). Everything below is the state a later agent should resume from.

### Verdict: no default changes, from any block

The shipped configuration stands. Fourteen mechanisms were implemented and measured; one survived
Stage C, and it survived only in a regime the shipped sets are not in (§6q–§6r of
`CAMPAIGN-LOG.md`). Every flag added by this campaign defaults to the shipped behaviour, with its
measured numbers in the option comment beside it.

### The flags this campaign added

| flag | what it does | verdict |
|---|---|---|
| `--actionable-windows` | require ≥ 2 movable classes in a window-ranked bucket | **a fix to the shipped search**; every window-targeting mechanism was aiming at immovable buckets |
| `--room-free-mask N` | 0 walk, 1 mask fast path, 2 mask only, **3 verify** | −8 to −9 where room domains run to hundreds; unresolved where they are ~134 |
| `--hoist-day-caps` | test MAX_CLASSES_PER_DAY once per slot, not per room | as above; carries only as one of three |
| `--cap-cache` | answer the room's own cap from cached bucket counts | as above |
| `--room-sample N` | rooms examined per slot (default 96) | 24 beats 96 by 8/9 where domains are large; null on the shipped sets |
| `--room-travel-budget N`, `--room-building-first` | travel pricing in the room scan | **implemented, never measured** |
| `--gls X`, `--gls-after`, `--gls-buckets`, `--gls-all-windows` | guided local search on the residual | null at λ = 2.5/5/10 |
| `--hard-repair`, `--switch-policy`, `--surge`, `--restart-adaptive` | the stuck-state ladder | neutral at the hour, ~2 % of the move rate |
| `--soft-alpha`, `--soft-equal`, `--flat-phase` | objective shape | a redistribution, not an improvement |
| `--repair-order`, `--repair-anchored`, `--regret-noise` | repair order | wins at n = 3 200 and nowhere above it |
| `--parity-moves`, `--compaction`, `--rematch`, `--kick-weighted`, `--construct-tournament` | deep-phase operators | no promotion at Stage B |

`--room-free-mask 3` deserves separate mention: it is not an optimisation but a **verification
instrument**, checking the mask against the walk on every live query. 1.61 × 10⁹ queries, zero
mismatches. Any future change to bucket bookkeeping can be checked the same way.

### Where to resume

`FINDINGS.md` §10 has the full list. In priority order:

1. **An atomic multi-class exchange operator** (§10.3) — the one direction the equilibrium result
   points at, with a computable selection criterion and all the machinery already present.
2. **Steering the basin lottery** (§10.4) — the largest unexploited lever in the study, a factor of
   3.2 across seeds, and nothing yet steers it.
3. **E6 exact permutation with branch-and-bound** — `kopt` has the best hit rate of any operator and
   a known, unfixed weakness.
4. Cheap and unmeasured: `--room-building-first` / `--room-travel-budget` (`campaign/kblock2.sh`
   runs both), `--restart-adaptive`, `--engine dlas`.

### Reproducing anything

Every result file is `bench/results/*.jsonl`, one JSON object per run, carrying the arm, flags,
instance, seed, budget, thread count, the full validator output and per-worker operator statistics.
The block scripts in `campaign/*.sh` reproduce each experiment; `campaign/exp.mjs` is resumable and
keyed on (exp, stage, arm, instance, seed, budget), so a killed batch continues where it stopped.
