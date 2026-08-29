# The study

What was measured, how, and what came out. This is the companion to
[`README.md`](./README.md), which says how the solver works; this says why anyone should believe the
numbers in it.

Everything here is reproducible from the repository with `bench/master.sh`, which runs the
experiments below in the order their conclusions depend on one another and writes one JSON line per
run. `bench/report.mjs` turns those lines into the tables, `bench/figures.mjs` into the figures, and
every record already reported is kept in `bench/study-data/`.

The method itself — the model, the objective, the neighbourhoods, the complexity of each — is in
[`ALGORITHM.md`](ALGORITHM.md). What may be claimed from the results below, and what may not, is in
[`WRITING.md`](WRITING.md).

---

## 1. Method

### The instances

`timetable-ui/scripts/timetable-bench` — the harness that was built for the TypeScript solver, used
unchanged. Its central property is that **the instances are built backwards**: a valid schedule is
constructed first, walking the week slot by slot and placing each class into resources that are free
at that moment, and the instance is then read back off it — courses, cohorts, lecturer eligibility,
room suitability, every availability window and every cap. Two things follow, and they are what make
a residual soft cost mean anything:

- **A perfect schedule provably exists** for every instance — zero hard violations, and a known soft
  cost. Anything the search cannot reach is a property of the search, never of the data.
- **Every result has a yardstick.** The hidden schedule is scored by the same validator, and its own
  soft cost is reported alongside. It is feasible and human-plausible but not optimal, so the search
  beating it is expected; the interesting question is by how much, and whether zero is reached.

Three sets are used:

| set | what it is |
|---|---|
| `timetable-ui/scripts/timetable-bench/instances/` | the 50 archived instances — 10 sizes × 5 seeds, n = 25 … 12 800, at `roomSlack: 1.15` |
| `bench/instances-tight/` | generated at `roomSlack: 1.0`, 60 % lecturer / 45 % group / 35 % room constraint density, 20 % biweekly, 8 % external — a faculty with no room to spare |
| `bench/instances-cap/` | the archived instances with every `MAX_CLASSES_PER_DAY` pulled down to the hidden schedule's own peak — maximally tight while a perfect answer still exists |

The tight set matters more than the size of the archive. At `roomSlack: 1.15` this solver reaches
f(σ) = 0 on most of the ladder inside thirty seconds, and a benchmark every entrant passes measures
nothing.

### The scoring

Never the solver's own counters. Every figure comes from
[`timetable-bench/validate.mjs`](../timetable-ui/scripts/timetable-bench/validate.mjs), which
re-reads a schedule from scratch, was written from the domain semantics rather than from either
solver, and counts all nine Π terms plus the five hard filters a conforming schedule must satisfy
exactly. `bench/score.mjs` **imports** it rather than copying it: a scorer that drifted from the one
the TypeScript solver is measured with would make every comparison here meaningless.

Agreement between the C++ evaluator and that validator is itself checked, on every instance and after
every change, by

```bash
build/timetable-solve --instance <archive> --mode score-hidden
```

which scores the hidden schedule with the C++ counters. The two agree to the digit on all 50 archived
instances, on both x86-64 and aarch64.

### The environment

Two-core cloud sandbox, x86-64, Linux, GCC 13, `-O3`. Every figure below is therefore **pessimistic
for an ordinary laptop**, and the thread-scaling experiment is the one to read before extrapolating.
The TypeScript solver is run on the same host at the same time, under Node 22, loaded from its
TypeScript source unchanged via `stripTypeScriptTypes` — so what is measured is literally the file
the application ships.

### What "soft" means

`soft = Π₇ + Π₈ + Π₉` — lecturer windows, group windows, mixed online days — which is what remains
once a schedule is feasible, and the number a deanery reads. `f(σ) = Σ βᵢ·Πᵢ²` is reported too, but it
is dominated by whichever term happens to be largest and is a poor summary across sizes. `hard` is
Π₁…Π₆ and is **0** on every run reported here unless stated otherwise.

Medians, not means. The search is stochastic, five seeds is a small sample, and a mean over a
distribution with one bad seed in it says more about that seed than about the algorithm.

### How comparisons are made, and what they support

Experiment 5 (§6a) measured the run-to-run spread on a single instance at a factor of **2.6**. That
number sizes every other experiment in this document, so the rules are stated once here:

- **Ablations** (Experiments 1 and 2) are reported as **medians** over 5 seeds (30 s) or 3 seeds
  (60 s). They are one-factor-at-a-time comparisons where the effects are large — `simple` is 15×
  `full` — and a median over a handful of seeds is enough to see them.
- **Mechanism comparisons** (§6a) are **paired on the PRNG seed** and reported as means with the
  paired differences shown. Pairing matters: unpaired, the spread swamps a 20 % effect.
- **Significance.** For the two headline comparisons, six paired seeds give 5/6 in the expected
  direction, an exact sign test at $p = 0.219$ and an exact Wilcoxon signed-rank at $p = 0.125$
  (`kick` vs `base`) and $p = 0.0625$ (`fresh` vs `kick`). Neither reaches $p < 0.05$, and with six
  paired samples a sign test cannot go below 0.031 even at 6/6 — **the sample size, not the effect,
  is the binding constraint.** A bootstrap over the observed differences puts the sign test's power
  at 0.34 for n = 6, 0.77 for n = 15 and 0.90 for n = 20. The correct reading of §6a's tables is
  therefore "a large and consistent effect, not yet significant at six seeds"; twenty seeds per arm
  would settle it and costs about two hours at 180 s.
- **Single runs are never compared.** Every single-run A/B taken before Experiment 5 turned out to
  be measuring luck, including three that briefly looked like findings. This is a methodological
  point about the problem, not about this implementation, and it applies to any timetabling result
  quoted from one run.

---

## 2. Experiment 0 — feasibility under a binding set-constraint

**Question.** `MAX_CLASSES_PER_DAY` is the only hard rule that is a property of a *set* rather than
of a placement: each of k classes can pass the check on its own, against a day that does not yet
hold the other k−1, and the k together can still break the cap. Do the large neighbourhoods — which
move up to forty classes at once — ever emit a schedule that breaks it?

**Method.** `bench/tighten.mjs` pulls every lecturer's and every group's cap down to the most classes
that entity has on any one day of the hidden schedule. The caps are then maximally tight and a
perfect answer still provably exists. 30 s, 3 sizes × 3 seeds, every result checked for
`filters.constraintBreaches`.

**Result.** See `bench/results/capped.jsonl`. The answer must be zero breaches on every run; anything
else is a bug, not a trade-off.

This experiment exists because an adversarial review found two independent paths that *could* breach
it — a ruin-and-recreate restoring a class it could not re-fit, and the permutation operator building
its cost matrix with all k classes lifted out — neither of which fired on the archived instances,
whose caps are generous. Both now re-verify the whole set jointly once every class is down
(`Worker::allLegal`). The regression is here so that the next operator to move several classes at
once cannot quietly reintroduce it.

---

## 3. Experiment 1 — does the eighth neighbourhood pay?

**Question.** The seven-operator portfolio was measured first. The eighth, `dayfix`, is an
exhaustive re-pack of one (entity, day): lift that day's classes out and try every arrangement of
them within the day, each evaluated under the true objective. It is the operator most directly
matched to the residual, which is almost entirely windows. Does it earn its cost?

**Method.** 30 s, n ∈ {3 200, 6 400, 12 800} × 5 seeds, with and without `--no-dayfix`. Same seeds,
same instances, same binary.

**Result.** `bench/results/ab-dayfix.jsonl`. Median soft cost over five seeds, 30 s, and the median
candidate count beside it:

| | n = 3 200 | n = 6 400 | n = 12 800 | candidates at 12 800 |
|---|---|---|---|---|
| default (seven operators) | **3** | **5** | **20** | 3.77 M |
| `--dayfix` | 3 | 7 | 27 | 3.29 M |
| `--winfix` | 3 | 10 | 26 | 4.53 M |
| `--cost-aware` | 4 | 16 | 31 | 9.63 M |

**It does not pay, and neither does the mechanism built next.** `dayfix` is exhaustive within the
day, matched exactly to the residual, and it loses 20 → 27 at the size where the budget binds while
also costing an eighth of the throughput. `winfix` — a window-directed move that reads the idle bell
starts off the cached occupancy mask and pulls a class from the far side of one into it, the only
move family that closes a gap by construction rather than by luck — loses 20 → 26. `cost-aware`,
which allocates the *budget* between operators rather than the draws, more than doubles the candidate
count and loses anyway.

The explanation is the same in all three cases and it is the most transferable finding in this study:
**a portfolio that already contains large neighbourhoods has no spare draws.** Whatever the new
operator is given comes out of `ruin` and `repack`, which is where the improvement was coming from.
A mechanism has to beat the marginal draw it displaces, not merely be useful.

---

## 4. Experiment 2 — ablation

**Question.** Which of the eight neighbourhoods carries the result?

**Method.** One variant at a time, everything else unchanged: `full`, then `--no-kopt`, `--no-lns`,
`--no-repack`, `--no-dayfix`, `--no-chain`, `--no-kempe`, `--no-cluster`, and finally `--simple`
(move and targeted swap only — the shape of the search the browser solver runs). 60 s, n ∈ {3 200,
6 400, 12 800} × 3 seeds.

`--no-cluster` is the one that is not an operator: it turns off the conflict-graph communities, so
the cluster ruin selector falls back and the deep phase has nothing to aim at.

**Result.** `bench/results/ablation.jsonl`. Median soft cost over three seeds at 60 s, ordered by the
n = 12 800 column, with the median candidate count at that size:

| variant | n = 3 200 | n = 6 400 | n = 12 800 | candidates |
|---|---|---|---|---|
| `full` | 2 | 9 | **17** | 7.4 M |
| `--no-kopt` | 2 | 9 | **17** | 7.5 M |
| `--dayfix` | 3 | 13 | 20 | 6.9 M |
| `--no-kempe` | 3 | 8 | 22 | 7.1 M |
| `--no-lns` | 2 | 12 | 24 | 14.2 M |
| `--winfix` | 2 | 8 | 24 | 9.2 M |
| `--no-chain` | 2 | 12 | 26 | 7.0 M |
| `--no-repack` | 3 | 11 | 28 | 7.7 M |
| `--no-cluster` | 1 | 9 | 29 | 9.2 M |
| `--cost-aware` | 3 | 17 | 31 | 18.5 M |
| `--simple` | 45 | 102 | **251** | 72.4 M |

Three things to read off it.

**The large neighbourhoods are the result.** `--simple` — move and targeted swap only, the shape of
the search the browser solver runs — makes **ten times the candidates** and is **fifteen times
worse**. Nothing about this solver's advantage is throughput; it is which states the operators can
reach. Removing any one of `repack`, `chain`, `lns` or the clusters costs between 40 % and 70 % of
the quality at n = 12 800, and each removal *raises* the candidate count, which is the same point
from the other side.

**The exact permutation is neutral.** `full` and `--no-kopt` are identical at every size. §6a's
operator statistics explain why, and the explanation is a point in the algorithm's favour rather than
against it — see below.

**Small instances say nothing.** The n = 3 200 column is noise: every variant is within a couple of
windows of every other, and `--no-cluster` "wins" it. At `roomSlack` 1.15 a 3 200-class instance is
not a benchmark, which is why the tight set exists.

**What the operator statistics say separately.** Every run records, per worker and per operator, the
number of candidates, how many were accepted, how many improved the objective, and the total
surrogate reduction credited to it. Measured at n = 12 800 over five minutes, the bandit settles on
`repack` and `ruin` carrying most of the improvement, `chain` third, and `kempe` down to about a
tenth of the calls it starts with. That is the bandit working: nothing is hand-tuned, and an operator
that stops paying is stopped from being tried.

The hour-long run at n = 12 800 gives the sharpest picture. Both workers together, 438 million
candidates:

| operator | candidates | share of draws | accepted | improving | share of total gain |
|---|---|---|---|---|---|
| `repack` | 88.3 M | 29.5 % | 47.9 % | 7.56 % | **47.1 %** |
| `ruin` | 41.0 M | 13.7 % | 18.6 % | 3.96 % | **31.4 %** |
| `chain` | 67.8 M | 22.6 % | 10.0 % | 1.62 % | 13.4 % |
| `move` | 54.8 M | 18.3 % | 4.2 % | 0.46 % | 3.5 % |
| `swap` | 33.2 M | 11.1 % | 6.3 % | 0.74 % | 3.5 % |
| `kopt` | 0.40 M | **0.1 %** | 97.8 % | 13.65 % | 0.7 % |
| `kempe` | 14.1 M | 4.7 % | 2.4 % | 0.27 % | 0.4 % |

Two rows are worth a paragraph each.

`repack` and `ruin` take 43 % of the draws and produce 79 % of the gain, and neither was hand-picked:
the bandit found them. `move` and `swap` start at four times the weight of everything else and end up
carrying 7 % of the improvement between them, which is the clearest statement in this study of what a
large neighbourhood is for.

`kopt` is the interesting one, and it resolves the neutrality above. Its candidates are accepted
97.8 % of the time and improve the objective 13.65 % of the time — **by an order of magnitude the
best hit rate of any operator** — and the bandit still cuts it to one draw in a thousand, because
(20) divides the reward by the work and a twelve-class Hungarian assignment costs some forty times a
move. So `--no-kopt` changes nothing not because the operator is useless but because *the selection
mechanism had already priced it correctly*. That is a result about the bandit, and it is a better
argument for adaptive operator selection than any of the ablation rows: the portfolio is robust to
including an operator that does not pay, because it stops paying for it.

One finding from those statistics is worth recording because it changed the code. Before the identity
check was added, the permutation operator's candidates were **99.96 % accepted and 0.8 % improving** —
the relaxed assignment was returning everybody to where they already were, which costs exactly
nothing and is therefore always accepted. Detecting the identity turned that whole share of the
budget back into search.

---

## 5. Experiment 3 — head to head, one host, one clock

**Question.** How much better is this than the solver that ships in the browser?

**Method.** Both solvers, on the same host, at the same moment, on the same archived instances, at
the same wall-clock budget, scored by the same validator. The TypeScript solver runs as a portfolio
of two processes on seeds strided by 7919 — the closest thing Node has to the Web Worker fleet the
client runs, and the fair counterpart to two C++ threads. `bench/run-ts.mjs` loads it from its
TypeScript source unchanged.

30 s, n ∈ {400 … 12 800} × 3 seeds.

**Why this and not §8's table.** `TIMETABLE-GENERATION.md` §8 reports the browser solver on a
two-core sandbox at some point in the past. Those figures are honest and were measured the same way,
but a claim of the form "n× better" is only worth making when both sides were timed by the same
clock. This experiment is that.

**Result.** `bench/results/headtohead.jsonl`. Mean of three instances per size; both solvers reach
hard = 0 everywhere, so the comparison is entirely about comfort.

| n | TypeScript soft | C++ soft | TypeScript f | C++ f | reference soft |
|---|---|---|---|---|---|
| 400 | 4.0 | **0.0** | 315 | **0** | 377 |
| 800 | 18.3 | **0.0** | 1 597 | **0** | 754 |
| 1 600 | 38.3 | **0.0** | 9 645 | **0** | 1 580 |
| 3 200 | 195.3 | **1.3** | 169 657 | **10** | 3 164 |
| 6 400 | 960.3 | **7.0** | 3 822 895 | **440** | 6 168 |
| 12 800 | 10 475.0 | **19.0** | 538 491 187 | **1 773** | 12 439 |

Up to n = 1 600 the C++ search closes **every** window in the timetable within thirty seconds — that
is not "better", it is the optimum, since f = 0 and f ≥ 0. From 3 200 up the ratio is between two and
three orders of magnitude on the soft count and five on f, which is the quadratic weighting doing
what it is for. The "reference soft" column is the schedule the instance generator planted, and both
solvers beat it comfortably at every size; it is a feasibility witness, not a good timetable.

The gap is not an implementation-speed story. At n = 12 800 the C++ run makes about 3.9 million moves
in thirty seconds against the TypeScript fleet's 0.9 million — a factor of four, on two cores, with
both fleets at two workers. The remaining factor of five hundred is the neighbourhood portfolio and
the delta evaluation, not the language.

---

## 6. Experiment 4 — what an hour buys

**Question.** This is the experiment the whole project exists for. The browser solver **converges**:
§8 records n = 12 800 at soft 913 after two minutes, 438 after five, and 438 again after nine, with
22.8 million moves in between buying nothing. Does this one keep going?

**Method.** One instance, one seed, four budgets — 60 s, 300 s, 900 s, 3 600 s — with the full
trajectory logged at every sample. Run on the archived n = 12 800 and on the tight n = 6 400.

**Result.** `bench/results/budget.jsonl`, and the per-run trajectories in `bench/logs/`.

n = 12 800, seed 1, two threads, scored by the independent validator:

| budget | soft | f | moves |
|---|---|---|---|
| 60 s | 26 | 3 065 | 7.5 M |
| 300 s | 14 | 905 | 37 M |
| 900 s | 11 | 565 | 111 M |
| 3 600 s | **8** | **305** | 438 M |

An hour returns a timetable with **a third of the windows** the first minute produced, and the same
run before §6a's changes returned 37 at sixty seconds and 37 at three hundred — the identical
schedule, after sixteen million wasted moves. That difference is the whole point of the section.

**What the residual is made of.** The composition of the surviving soft cost, per rung:

| budget | Π₇ lecturer windows | Π₈ group windows | Π₉ mixed days | soft | f |
|---|---|---|---|---|---|
| 60 s | 17 | 9 | 0 | 26 | 3 065 |
| 300 s | 9 | 5 | 0 | 14 | 905 |
| 900 s | 7 | 4 | 0 | 11 | 565 |
| 3 600 s | 5 | 3 | 0 | 8 | 305 |

Π₉ is zero from the first minute and stays there — mixed online days are easy, because a group's
online classes can nearly always be gathered onto their own day. The two window terms fall together
and in proportion, roughly 2:1 lecturer-to-group throughout, which is what the instance generator
plants and not something the search chooses. The practical reading for a deanery: after an hour, a
12 800-class faculty has **five lecturers and three groups with one idle пара each**, and everyone
else has a gap-free week.

Note also what an hour does to f rather than to soft: 3 065 → 305, a factor of ten against soft's
factor of three, because f is quadratic and the search is removing violations from the entities that
have the most of them first. Both numbers are worth quoting; they answer different questions.

The tight instance — `roomSlack: 1.0`, dense constraints, n = 6 400 — is the useful counter-case:

| budget | 60 s | 300 s | 900 s | 3 600 s |
|---|---|---|---|---|
| soft | 15 | 21 | 18 | **10** |
| f | 1 800 | 2 030 | 1 780 | **800** |

The hour still wins by a third, and the ladder is **not monotone in between**, which is exactly what
§6a's variance says to expect: each rung is one run, not a continuation of the previous one, and the
run-to-run spread at a fixed budget is comparable to the difference between neighbouring rungs. A
budget ladder with one seed per rung is a sighting shot, not a measurement of the budget response;
the honest claim it supports is the endpoints, 15 → 10 and 26 → 8, not the shape.

The trajectory is the more interesting output, because a budget table says where the search ended and
the trajectory says whether it was still descending when the clock ran out. Best-so-far f by
five-minute bucket on the hour-long run: 1 060, 765, 545, 545, 545, 545, 360, **305**, and then flat
for the last twenty minutes. Improvements are irregular and they keep arriving — the drop from 545 to
360 comes at half an hour, long after any reasonable person would have concluded the search was done.
That is the restart mechanism finding a better basin, and it is why the honest reading of the last
twenty flat minutes is "this run had stopped", not "the algorithm converges at forty minutes": the
run before it was flat from ten to thirty and then improved twice.

---

## 6a. Experiment 5 — the frozen tail, and what unfroze it

**Question.** Experiment 4 asks what an hour buys. The first honest answer was: *nothing*, and finding
out why is the most useful thing in this study.

**The observation.** n = 12 800, seed 1, two threads, 300 s, trajectory sampled every 250 ms. The
incumbent reaches f = 5 920 (soft 37) at 37 s and is still at exactly 5 920 when the clock runs out,
after a further **sixteen million moves**. The 60 s run and the 300 s run return the same number to
the digit. A search that cannot use five minutes will not use an hour.

**Why.** Three separate causes, and it took an experiment each to separate them.

1. *The escape walked away from the answer.* On stagnation the search shuffled — it relocated a
   tenth to a fifth of every movable class at random — starting **from the working state**, which
   after a failed cycle is already worse than the incumbent. So each perturbation started further
   from the best timetable than the last. Two hundred and seventy of them in five minutes, and not
   one produced anything.
2. *The acceptance bar had collapsed.* Late acceptance with a hundred-long history is a hill climb
   about a hundred moves after the last refill — the bar is monotone in this implementation, and even
   Burke and Bykov's rule cannot raise it once every slot holds the same value. Simulated annealing
   has the same problem from the other end: T₀ is a fraction of the *construction* surrogate, 8 × 10⁷,
   and by the tail the objective is 5 × 10³, so the floor temperature is effectively zero.
3. *There is nothing wrong with 1 and 2 that more tolerance fixes.* Lengthening the history is the
   obvious repair and it is catastrophic: 5 000 gives soft 3 381 (from 32) and 50 000 does not even
   reach feasibility (547 hard violations after three minutes). A bar filled at construction scale
   and 5 000 slots deep is not a bar at all; the search never converges. **The tail is not short of
   tolerance, it is short of attempts.**

**What was tried and rejected.** A dedicated iterated-local-search loop — kick the incumbent, run a
few hundred strict-descent moves, keep it only if better — reaching five thousand cycles a minute
where the stagnation counter managed twenty-five. It is *worse*: soft 70 against 37 at 60 s when it
takes over early, and no better than the ordinary walk when it takes over late. The ordinary walk
with a collapsed late-acceptance bar still admits **equal-cost** moves, and plateau drift is most of
what there is to do on a surface whose objective is a sum of squares of small integers; a strict
descent refuses exactly those moves. The loop is kept behind `--ils` with these numbers in its
comment, because the mechanism is worth being able to re-measure.

**The variance, which changed the design.** Same binary, same instance, same configuration, 180 s,
six PRNG seeds:

| seed | 11 | 22 | 33 | 44 | 55 | 66 |
|---|---|---|---|---|---|---|
| soft | 11 | 27 | 17 | 23 | 19 | 29 |
| f | 565 | 3 085 | 1 220 | 2 260 | 2 120 | 3 365 |

Mean soft 21, min 11, max 29 — a factor of **2.6 between the luckiest and the unluckiest run of the
same algorithm on the same input**. That spread is not noise to be averaged away in the write-up; it
is the largest single lever in the search. It says the basins reachable from different starts differ
enormously in quality, and therefore that an hour is far better spent visiting several of them than
polishing one. It also says — and this is the methodological point — that **every single-run A/B in
this study before Experiment 5 was measuring luck**. Two of the four mechanisms rejected in §4 were
rejected on three seeds, which is enough only for the differences of the size seen there; the
mechanisms compared here are all measured over six.

**What was kept.** Two changes, both aimed at attempts rather than tolerance.

- `restartFromBest` (`--no-restart` to disable): every kick begins by restoring the incumbent, and
  breaks a *related* set — a lecturer's day, a cluster, the worst-window buckets — sized adaptively
  between `kickMin` and `kickMax`, tightening back to `kickMin` after any cycle that pays.
- `useRecombine` (`--no-recombine`): the workers keep a shared **pool** of up to eight timetables,
  each required to be at least 1 % of the movable classes away from every other, and on stagnation a
  worker builds a child by inheriting a random half of the *clusters* from another pool member and
  repairing the collisions. A kick can only produce a variation on the incumbent; recombination is
  the only operator here that can produce a timetable neither parent was going to reach. The cluster,
  not the class, is the unit of inheritance — classes sharing a lecturer or a group have to move
  together or the child is just both parents' conflicts at once.

**Result.** `bench/results/arms.jsonl` — three arms, the same six seeds each, 180 s, n = 12 800
seed 1. Paired, because the spread above makes anything else unreadable.

| soft, by seed | 11 | 22 | 33 | 44 | 55 | 66 | mean | mean f |
|---|---|---|---|---|---|---|---|---|
| `base` — perturb the working state | 22 | 27 | 15 | 23 | 41 | 27 | 25.8 | 2 988 |
| `kick` — restart from the incumbent | **16** | **20** | **14** | **21** | **21** | 29 | **20.2** | **1 964** |
| `pop` — kick + recombination | 20 | 27 | 16 | 27 | 21 | 29 | 23.3 | 2 401 |

Restarting the kick from the incumbent is worth **22 % of the soft cost and 34 % of f**, and wins on
five of the six seeds. It also un-freezes the trajectory: the same seeds at 600 s reach mean soft
11.0 where 180 s reached 20.2, which the `base` arm could not do at all. Recombination **loses** — to the kick on five of six — and is therefore off by
default, with the numbers in the comment on `useRecombine`. It is the fourth mechanism in this study
to be rejected for the same reason (§4's `costAwareSelection`, `useCloseWindow`, `useDayRepack`): a
new operator added to a portfolio that already works takes its draws from whatever was working. Its
own additional reason is worth recording — with two workers that adopt one another's elites, the
pool holds two timetables in one basin, and a child of two near-identical parents is a repair bill
with no new material in it. It is kept behind `--recombine` for the many-core case, where the pool
would be genuinely diverse.

**And the second half of the answer: sample the distribution instead of polishing one draw.** If the
spread above is real, then at a long budget a worker that has stopped improving should stop polishing
and *build another timetable*. `restartFresh` does exactly that — the incumbent goes to the pool and
to the shared best, the worker forgets it, and `construct()` runs again with a freshly shuffled order
(the difficulty key is coarse enough that a fixed order gave the same construction every time, which
is why the shuffle had to be added before the restart could mean anything). Adoption is blocked for
the same number of moves afterwards, or cooperation would drag the worker straight back into the
basin it just left.

n = 12 800 seed 1, **600 s**, two threads, the same six PRNG seeds, paired:

| soft, by seed | 11 | 22 | 33 | 44 | 55 | 66 | mean | mean f |
|---|---|---|---|---|---|---|---|---|
| `kick` — restart from the incumbent only | 11 | 15 | 8 | 18 | 7 | 7 | 11.0 | 589 |
| `fresh` — and a new construction when that stops paying | 13 | **5** | **4** | **15** | **4** | **4** | **7.5** | **350** |

A further **32 % of the soft cost and 41 % of f**, better on five of the six seeds, and about
twenty-four fresh constructions per run. It fires after `restartAfter` = 1 200 000 moves without a new
incumbent — roughly twenty seconds a worker on this hardware — so at 30 s it never fires and short
budgets are unaffected. Recombination *on top of* the restarts was measured too, on three of the
seeds (soft 12, 9, 5 against 13, 5, 4): still not paying, even with the diverse pool the restarts
produce.

Together the two changes take n = 12 800 seed 1 from a mean soft of 25.8 that four extra minutes
could not improve, to 7.5 — and the second number is still falling when the clock stops.

---

### What the hour actually spends itself on

The same hour-long run, per worker: **367 and 375 kicks** from the incumbent, **75 and 76 fresh
constructions**, **79 and 80 elite adoptions**, 219 million candidates each. So a fresh basin is
started roughly every 48 seconds per worker and about 150 basins are sampled over the hour between
the two — against a single basin, polished for 59 minutes, in the version this study started with.
The trajectory (§6, five-minute buckets) shows the consequence: the improvements from 545 to 360 and
360 to 305 arrive at the half-hour mark, from restarts, long after the local search in any one basin
had finished.

---

## 7. Threats to validity

- **Two cores.** Every number is measured on a two-core sandbox. The portfolio is a real part of the
  algorithm — workers cooperate through an elite pool and adopt one another's incumbents — so a
  four- or eight-core machine is not merely faster, it searches differently. The direction is
  favourable but the magnitude is unmeasured here.
- **Synthetic instances.** They are shaped like a Ukrainian HEI — six-day week, паровий bell grid, a
  separate grid for фізичне виховання, directed asymmetric travel between корпуси, abstract rooms with
  and without an address, online classes, biweekly parity, combined groups, external fixed entries —
  but they are generated, not observed. The one real instance available (the transcribed ФПМІ
  2025/2026 timetable in `data.sql`) is a single faculty and cannot support a scaling claim.
- **No lower bound.** The generator guarantees a hard-feasible schedule exists, because it builds
  one. It makes no claim about the reachable soft minimum, and a real bound on Π₇/Π₈ is itself a hard
  combinatorial problem. "Within x % of optimal" would mean inventing the denominator. Where this
  solver reaches soft 0 the question is settled — that *is* the optimum — and at the sizes where it
  does not, the honest statement is a gap against the best schedule anything has found.
- **The comparison is of two searches over one objective, not of two objectives.** The nine Π terms,
  their weights and the hard filters are identical by construction, and checked by
  `--mode score-hidden`. If the objective is wrong, both solvers are wrong in the same way, and this
  study says nothing about that.
- **The service path is unmeasured.** `timetableGenerationInput` is a single round trip where the
  client needs nine plus a browser-side merge, and that is a structural argument, not a measurement.
  Nobody has timed it against a real database.
- **One implementation of each.** A better JavaScript solver is possible and a worse C++ one is
  certain. What is being compared is what exists.

---

## 8. Reproducing all of it

```bash
cd timetable-generator
cmake -S . -B build -DTG_BUILD_GUI=OFF -DCMAKE_BUILD_TYPE=Release && cmake --build build
bench/master.sh                              # about six hours on two cores
node bench/report.mjs bench/results/*.jsonl   # the tables
```

Individual pieces:

```bash
# agreement with the independent validator
build/timetable-solve --instance ../timetable-ui/scripts/timetable-bench/instances/n06400-s1.json.gz \
    --mode score-hidden

# one variant, one budget, one instance, with the trajectory
build/timetable-solve --instance <archive> --time 3600000 --threads 8 \
    --out schedule.json --log run.csv
#   run.csv carries every Π term at every sample for the publishing worker, and `runBestHard`,
#   `runBestObjective`, `runBestSoft` — the run's best-so-far across all workers, which is the
#   monotone series a "quality against time" figure wants. A raw per-worker column is not: a worker
#   that has just restarted is carrying a fresh construction and reports it.

# the mechanisms that were measured and rejected, for re-measuring
build/timetable-solve --instance <archive> --time 600000 --no-restart        # perturb the working state
build/timetable-solve --instance <archive> --time 600000 --no-restart-fresh  # never reconstruct
build/timetable-solve --instance <archive> --time 600000 --recombine         # cluster-wise crossover
build/timetable-solve --instance <archive> --time 600000 --ils               # the ILS loop
build/timetable-solve --instance <archive> --time 600000 --lahc 5000         # a longer acceptance bar

# the shipped TypeScript solver, same instance, same clock
node bench/run-ts.mjs --instance <archive> --time 30000 --workers 2 --out ts.jsonl

# more instances, at sizes and densities the archive does not carry
node bench/generate.mjs --out bench/instances-xl --sizes "25600 51200" --seeds "1 2 3"
node bench/generate.mjs --out bench/instances-tight --sizes "3200 6400" --seeds "1 2 3" \
     --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'

# the two experiments behind section 6a
bench/variance.sh bench/instances/n12800-s1.json.gz 180000    # how much of a result is luck
bench/arms.sh     bench/instances/n12800-s1.json.gz 180000    # base vs kick vs recombination

# maximally tight set-constraints, for the feasibility regression
node bench/tighten.mjs bench/instances/n03200-s1.json.gz bench/instances-cap/n03200-s1.json.gz
```

---

## 9. Re-measured for the dissertation, and what did not reproduce

Everything above is a **tuning log**: a record of what was tried during development, at whatever
budget and replicate count the question of the moment needed. That is the right kind of document to
have while building a solver and the wrong kind to draw conclusions from, for a reason this project
found the hard way — see §6a on variance.

The dissertation therefore re-measured the whole thing under a design fixed **in advance**: six
experiments, an independent validator on every row, randomised run order from a recorded seed, and
a sample size taken from a bootstrap power calculation over a separately measured spread. Scripts:
`scripts/cpp-*.mjs` in the thesis repository. Three of its outcomes should be read back into this
file by anyone using it.

**1. The variance is the resolution limit, and it must be measured at the budget you are comparing
at.** Twelve seeds of the shipped configuration on `n12800-s1` at 180 s span a factor of 3.2 in soft
cost. At 60 s the same configuration has barely restarted (0–2 fresh constructions per run) while at
180 s it restarts four to six times, so the two budgets do not even exercise the same machinery, and
a band read at one is not a band for the other.

**2. Several of the negative results above do not reproduce at 60 s with three seeds.** `dayfix`
(median soft 18) and `winfix` (16) both measure *better* than the shipped configuration (21) on that
design; so do `no-kopt` (14) and `kopt-extra` (15). None of these differences is outside the spread.
The honest reading is not that the earlier measurements were wrong — they were taken at 30 s over
five seeds and reported as such — but that **a 15-arm ablation at three seeds separates only the
mechanisms that break the search by an order of magnitude**, and the rest of its ordering is noise.
The mechanisms stay off because a wider measurement put them there, not because this one did.

**3. The acceptance-history result is stronger than reported above.** `--lahc 5000` and
`--lahc 50000` do not merely lose quality at 60 s on `n12800-s1`: they do not reach **feasibility**,
with median hard violations of 236 and 762 respectively. A wider acceptance bar does not fail to
rescue a converged search; it prevents the search converging at all. That is the load-bearing
observation behind the three-level escape, and it now has two independent measurements behind it,
one per realisation.

The comparison against the shipped TypeScript solver, under identical conditions (same archived
bytes, same 30 s, **one worker each**, both scored by the independent validator), gives on
`n12800`: soft 7 781 against 33, with a candidate-rate ratio of only 1.6. The quality ratio is two
orders of magnitude larger than the throughput ratio, which is the argument that the advantage comes
from the mechanisms rather than from the move rate — but no experiment here separates the compressed
tick axis from the change of runtime, and the claim should not be made as though one did.
