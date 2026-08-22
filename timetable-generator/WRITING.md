# Writing the paper

Everything needed to turn this repository into a manuscript: what may be claimed and what may not,
which experiment backs each claim, what the reviewers will ask, and the exact commands that
regenerate every number and figure.

Companion to [`ALGORITHM.md`](ALGORITHM.md) (the method, formally) and [`STUDY.md`](STUDY.md) (the
experiments and their results). This file is the only one of the three that gives advice rather than
facts.

---

## 1. What the contribution is

Be honest about the shape of it. This is **not** a new metaheuristic. It is a portfolio of known
neighbourhoods under a known acceptance criterion, and its novelty is in three places:

1. **A model with three features the standard benchmarks lack** — biweekly parity averaged over two
   calendar weeks, *directed* inter-building travel, and abstract rooms with interval-overlap
   capacity — together with an evaluation scheme (compressed tick axis, 128-bit occupancy masks,
   (entity, day) bucket decomposition) that makes the cost of a candidate **independent of the size
   of the university**. That last property is measurable, was measured, and is the most defensible
   engineering claim in the work.

2. **A negative result with a mechanism**: a portfolio metaheuristic on this problem *converges hard*
   and then wastes an arbitrary amount of remaining budget — sixteen million candidates in five
   minutes changing nothing — and the three causes are separable and were separated. Most importantly,
   the obvious repairs (a longer acceptance history, a dedicated ILS loop, a targeted window operator)
   make it **worse**, and there is a single explanation for why.

3. **The variance result**: the same algorithm, the same instance, the same configuration, six seeds
   — soft 11 to 29. Which basin the construction lands in dominates everything the local search does
   afterwards, and this both explains why restarts pay and invalidates the single-run A/B comparisons
   that are still common in the timetabling literature.

If the paper has one sentence, make it (2) plus (3): **on this problem, a long budget is bought with
attempts, not with tolerance** — and the mechanisms that spend it on attempts (restart the kick from
the incumbent; abandon the basin entirely when that stops paying) are worth 34 % and 41 % of $f$
respectively, while every mechanism that spends it on tolerance or on better-targeted small moves
loses.

### What must not be claimed

- **Not "n× better than the state of the art".** The comparison is against the JavaScript solver
  that ships in the same product. It is a fair, same-clock, same-validator comparison and it is worth
  reporting, but it is a comparison of *this* system with *its own* predecessor, not with the
  literature. Say so in the same paragraph as the table.
- **Not "within x % of optimal".** No lower bound is computed. Where $f = 0$ is reached the question
  is settled — that *is* the optimum, since $f \ge 0$ — and that happens up to $n = 1\,600$ within
  30 s. Everywhere else the honest statement is a gap against the best schedule anything has found.
- **Not "statistically significant"** for the two headline mechanism comparisons as they stand. See
  §4. Either run more seeds before submitting, or report effect sizes and directions and say plainly
  that six paired seeds cannot reach $p < 0.05$ under a sign test.
- **Not "scales to 31 000 classes"** unless you re-run it. The per-candidate cost is flat in $n$ and
  the largest *measured* instance here is 12 800. The 31 000 figure is the production faculty count
  the design targets, not a measurement.

---

## 2. Proposed structure

A 10–14 page article, in the shape the *Mathematical Modeling and Computing* paper used.

| § | content | source |
|---|---|---|
| 1 | Introduction: the problem at a Ukrainian HEI, why вікна matter, what a generated timetable has to satisfy | — |
| 2 | Related work: UCTP, ITC-2007/2019, LAHC, LNS, ejection & Kempe chains, adaptive operator selection, memetic algorithms | §7 below |
| 3 | Problem statement: sets, variables, hard filters, the nine terms, the objective | `ALGORITHM.md` §1 |
| 4 | Representation and incremental evaluation: tick axis, masks, buckets, Lemma 1, complexity | `ALGORITHM.md` §2 |
| 5 | The algorithm: construction, acceptance, the seven neighbourhoods, bandit, clusters, escape | `ALGORITHM.md` §3 |
| 6 | Experimental setup: instances, the independent validator, hardware, what "soft" means | `STUDY.md` §1 |
| 7 | Results: head-to-head, ablation, budget response, the variance study, the escape mechanisms | `STUDY.md` §§3–6a |
| 8 | Discussion: the convergence failure and why the obvious repairs lose | `STUDY.md` §6a |
| 9 | Threats to validity | `STUDY.md` §7 |
| 10 | Conclusions and future work | §8 below |

Sections 4 and 8 are where this paper differs from a routine "we applied a metaheuristic" article.
Give them room; cut §5 if space is short, because a neighbourhood catalogue is the most compressible
part.

---

## 3. Claims and their evidence

Every claim the paper can make, with the experiment that backs it and the file the numbers live in.
**Do not make a claim that is not in this table without adding a row to it.**

| # | claim | evidence | data |
|---|---|---|---|
| C1 | The evaluator is correct: it agrees with an independently written validator to the digit | `--mode score-hidden` on all 50 archived instances, two architectures | reproduce on demand |
| C2 | Hard filters are never violated, including the set-valued one | Experiment 0, caps tightened to the minimum that still admits a perfect answer | `capped.jsonl` |
| C3 | The per-candidate cost does not grow with $n$ | candidate rate 4.8 M / 5.0 M / 3.8 M at $n$ = 3 200 / 6 400 / 12 800 in 30 s | `ab-dayfix.jsonl` |
| C4 | The solver reaches the optimum ($f = 0$) up to $n = 1\,600$ in 30 s | head-to-head | `headtohead.jsonl` |
| C5 | It beats its shipped predecessor by 2–3 orders of magnitude in soft cost | head-to-head, same host, same clock, same validator | `headtohead.jsonl` |
| C6 | The advantage is not raw speed | 4× the candidate rate, 500× the quality, at $n = 12\,800$ | `headtohead.jsonl` |
| C7 | Large neighbourhoods carry the result; move+swap alone is 15× worse | ablation, `simple` 251 vs `full` 17 | `ablation.jsonl` |
| C8 | Clusters, repack, ejection chains and LNS each contribute | ablation, one variant at a time | `ablation.jsonl` |
| C9 | The exact $k$-class permutation is **neutral** | `full` 17 = `no-kopt` 17 at every size | `ablation.jsonl` |
| C10 | Run-to-run spread on one instance is a factor of 2.6 | six seeds, one configuration, 180 s | `variance.log` |
| C11 | Restarting the kick from the incumbent improves the mean by 22 % (soft) / 34 % ($f$) | three arms, six paired seeds, 180 s | `arms.jsonl` |
| C12 | Rebuilding from scratch when that stops paying improves it by a further 32 % / 41 % | two arms, six paired seeds, 600 s | `long600.jsonl` |
| C13 | An hour returns a third of the windows the first minute does | budget ladder, 60/300/900/3600 s, two instances | `budget.jsonl` |
| C14 | Widening the acceptance history does not fix convergence; it prevents it | $\ell$ = 100 / 5 000 / 50 000 | `ab-lahc.log` |
| C15 | Four well-targeted mechanisms each make it worse | `--dayfix`, `--winfix`, `--cost-aware`, `--kopt-extra` | `ab-dayfix.jsonl`, `koptx.jsonl` |
| C16 | Cluster-wise recombination does not pay at two workers | `pop` vs `kick`, six paired seeds | `arms.jsonl` |

C9, C15 and C16 are negative results about mechanisms this project deliberately built. **Report
them.** They are more interesting than C5, they cost nothing to include, and a paper that reports
only what worked is one a careful reader will not trust.

---

## 4. Statistics — read this before writing §7

The measured spread is large enough that it dominates the design of the experiments, and the
temptation to over-claim is correspondingly large.

**What the data supports.** For the two headline comparisons, paired on seed, $n = 6$:

| comparison | paired differences (soft) | better on | sign test | Wilcoxon (exact, two-sided) | mean ratio |
|---|---|---|---|---|---|
| `kick` vs `base`, 180 s | −6, −7, −1, −2, −20, +2 | 5 / 6 | $p = 0.219$ | $p = 0.125$ | soft 0.78, $f$ 0.66 |
| `fresh` vs `kick`, 600 s | +2, −10, −4, −3, −3, −3 | 5 / 6 | $p = 0.219$ | $p = 0.0625$ | soft 0.68, $f$ 0.59 |

Neither reaches $p < 0.05$. With six paired samples a sign test *cannot* go below 0.031 even at 6/6,
so the design, not the effect, is the binding constraint.

**What to do about it.** One of:

- **(preferred) Run 20 paired seeds per arm before submitting.** A bootstrap over the observed
  differences puts the sign test's power at 0.34 for $n = 6$, 0.77 for $n = 15$ and **0.90 for
  $n = 20$**. At 180 s × 2 arms × 20 seeds that is 2 hours of wall clock on two cores; at 600 s it is
  6.7 hours. This is the single highest-value thing left to do to the study.
- Or report the effect sizes and directions, state the $p$ values honestly, and describe the result
  as *consistent* rather than *significant*.

**Rules for the whole results section.**

1. **Report medians for the ablations** (5 or 3 seeds each) and **means with the paired differences
   for the arm studies** (6 seeds). Say which, every time.
2. **Never compare single runs.** Every single-run A/B in the early part of this project turned out
   to be measuring luck; §6a of `STUDY.md` says so in as many words, and the paper should repeat the
   methodological point because it applies to much of the published literature on this problem.
3. **Pair on the seed.** Unpaired comparisons at this spread need several times the samples.
4. **Quote $f$ and soft.** They can disagree in direction — a run with more windows spread over more
   entities can have a smaller $f$ — and quoting only one invites the question.
5. **State the hardware and the thread count in the caption of every table**, because the budget
   response depends on both.
6. **The budget ladder is one run per rung.** It is a sighting shot, not a measurement of the budget
   response; the endpoints (26 → 8 and 15 → 10) are what it supports, not the shape. The tight
   instance's non-monotone middle is worth showing precisely because it makes this visible.

---

## 5. Figures and tables

`bench/figures.mjs` emits standalone SVGs (`\includegraphics`-ready) and one HTML page:

```bash
node bench/figures.mjs --out bench/figures
```

| figure | what it shows | caption should say |
|---|---|---|
| `headtohead.svg` | soft cost vs $n$, both solvers, log–log | the axis is $\log_{10}(\text{value} + 1)$ so that zero is representable, and that zero *is* the optimum |
| `budget.svg` | soft cost vs budget, both instances | one run per rung; see §4 rule 6 |
| `ablation.svg` | soft cost per ablated variant | median of three seeds at 60 s |
| `trajectory.svg` | best-so-far $f$ against seconds over the hour | it is the run's best across all workers, not one worker's incumbent — a worker that has just restarted is carrying a fresh construction, and plotted literally that is a sawtooth |

Two figures the paper wants that do **not** exist yet, both cheap:

- **A per-term breakdown of the residual over time** — $\Pi_7$, $\Pi_8$, $\Pi_9$ separately. The
  trajectory CSV already carries every term at every sample; it is a plotting exercise, not a run.
- **A box plot of the six-seed spread per arm.** This is the visual form of C10 and it makes §4's
  argument to a reader who does not read tables.

Every trajectory CSV carries `runBestHard`, `runBestObjective`, `runBestSoft` — the run's best-so-far
across all workers, which is the monotone series a "quality against time" figure needs. The raw
per-worker columns are not monotone and should not be plotted directly.

---

## 6. Reproducing every number

```bash
cd timetable-generator
cmake -S . -B build -DTG_BUILD_GUI=OFF -DCMAKE_BUILD_TYPE=Release -G Ninja && cmake --build build

# instances (the archive lives in the sibling project; the generated sets are made here)
node bench/generate.mjs --out bench/instances --sizes "400 800 1600 3200 6400 12800" --seeds "1 2 3"
node bench/generate.mjs --out bench/instances-tight --sizes "3200 6400" --seeds "1 2 3" \
     --opts '{"roomSlack":1.0,"lecturerConstraintShare":0.6,"groupConstraintShare":0.45}'
node bench/tighten.mjs bench/instances/n03200-s1.json.gz bench/instances-cap/n03200-s1.json.gz

# C1 — the evaluator agrees with the independent validator
build/timetable-solve --instance <archive> --mode score-hidden

# C5, C6 — head to head, one host, one clock
bench/final.sh                     # ~3 hours, includes the budget ladders

# C7, C8, C9, C15 — ablations
bench/ablate.sh

# C10 — the variance that sizes every other experiment
bench/variance.sh bench/instances/n12800-s1.json.gz 180000

# C11, C16 — the escape mechanisms, paired
bench/arms.sh bench/instances/n12800-s1.json.gz 180000

# tables from any of the above
node bench/report.mjs bench/results/*.jsonl
node bench/figures.mjs --out bench/figures
```

`bench/master.sh` runs the lot, about six hours on two cores. Raw records for every run already
reported are in `bench/study-data/`.

**Provenance rule.** Every number in the manuscript should be traceable to a line in a `.jsonl` file
in `bench/study-data/` or to a re-run of one of the commands above. When a number changes because the
code changed, change it in `STUDY.md` *and* in the source comment that quotes it — the comments in
`search.hpp` carry the measurements that justify each default, and three of them were found to have
their arrows reversed exactly because nobody re-derived them from the raw data.

---

## 7. Related work to position against

The paper needs about 25 references. These are the anchors; each line says what to cite it *for*,
which is the part that is easy to get wrong.

**The problem.**
- Post-enrolment vs curriculum-based course timetabling: the ITC-2007 tracks (McCollum et al.) — cite
  for the formulation this model departs from, and name the three departures (§1 above).
- ITC-2019 (Müller, Rudová, Müllerová) — cite for the student-sectioning-and-distribution formulation
  that is closest to a real university's data model, which is what this project also has.
- Surveys: Lewis (2008) for the metaheuristic taxonomy, Bettinelli et al. (2015) for the CB-CTT
  overview, Ceschia, Di Gaspero & Schaerf (2023) for the modern one.

**The acceptance criterion.**
- Burke & Bykov, *The late acceptance hill-climbing heuristic* (EJOR 2017) — cite for LAHC, and note
  that the canonical write-back rule and the monotone variant behave identically here at convergence.
- Diversified late acceptance (Namazi et al.) — cite when describing the implemented alternative.
- The convergence-of-LAHC observation in §8 of the paper is, as far as I can tell, **not** in the
  literature in this form. Check before claiming novelty; frame as "we observed" if unsure.

**The neighbourhoods.**
- Ruin-and-recreate / LNS: Schrimpf et al. (2000), Shaw (1998) for the relatedness selector, Pisinger
  & Ropke (2007) for adaptive LNS — the last one is the direct ancestor of §3.5's bandit.
- Ejection chains: Glover (1996).
- Kempe chains in timetabling: Thompson & Dowsland (1998).
- The Hungarian method: Kuhn (1955); the $O(n^3)$ form, Jonker & Volgenant (1987).

**Operator selection.**
- Adaptive operator selection / credit assignment: Fialho et al. (2010), Ropke & Pisinger's roulette.
- Hyper-heuristics: Burke et al. (2013) survey — position §3.5 as a selection hyper-heuristic with a
  work-normalised credit, and say why the normalisation matters here (a large neighbourhood costs 40×
  a move).

**Memetic and population methods.**
- Your own prior article, *Adaptive Memetic Algorithm with Multi-Neighbourhood Local Search for
  University Course Timetabling* — cite for the neighbourhood catalogue and the adaptive selection,
  and use §3.8's negative result to say something new: the population layer that pays there does
  **not** pay at two workers here, and the reason is pool diversity, which is measurable.
- Path relinking / scatter search for timetabling — cite when motivating the recombination that was
  tried and rejected.

**Restarts and search-space structure.**
- The variance result (C10) is the paper's justification for restarts. Position it against the
  literature on **restart strategies** (Luby et al. 1993) and on **basin-of-attraction structure**
  (fitness-distance analyses; Ochoa's local optima networks). This is the most interesting place to
  put the work in context, and the one most likely to earn a citation from someone else.

---

## 8. Future work worth promising

Ordered by how likely each is to be true. Only the first three are safe to promise.

1. **More seeds.** §4. Turns "consistent" into "significant".
2. **More cores.** Everything here is two cores. The portfolio is a real part of the algorithm, so a
   16-core run is not merely faster — it searches differently, and recombination (C16) may start to
   pay once the pool is genuinely diverse. This is a measurement, not a hope.
3. **A real instance.** The one available (the transcribed ФПМІ 2025/2026 timetable) is a single
   faculty and cannot support a scaling claim; a second real faculty would let the paper say
   something about generated-vs-observed instance structure.
4. **A lower bound**, even a weak one. Per-entity: a lecturer with $k$ classes on a day forced into
   $j$ distinct пари has at least $j - k$ windows if the day's admissible slots are not contiguous.
   Summed over entities that gives a bound on $\Pi_7 + \Pi_8$ that is probably loose but is *a*
   denominator, and "within x % of a bound" is worth a great deal more than "the best we found".
5. **Restart timing as a decision.** `restartAfter` is a constant; the theory of restart schedules
   (Luby) says it should be a distribution, and the variance data is exactly what is needed to fit
   one.
6. **Learning the operator weights across runs** rather than within one. The bandit restarts from
   scratch every run and spends its first few segments finding out what it already knew last time.

---

## 9. A note on the Ukrainian version

The dissertation chapter needs the same material in Ukrainian, and three terms should **not** be
translated back from the English:

| English here | Ukrainian | note |
|---|---|---|
| window | вікно | not «проміжок»; вікно is the term a deanery uses |
| double period | пара | the atomic slot; "lesson" and "class" are both wrong |
| numerator / denominator week | чисельник / знаменник | the biweekly alternation |
| combined group | об'єднана група | a stream taught as one class |
| building | корпус | not «будівля» in this context |

Write the Ukrainian version from `ALGORITHM.md` rather than translating the paper: the equations are
language-independent and the prose around them is shorter in Ukrainian, so a translation of a
translation drifts.
