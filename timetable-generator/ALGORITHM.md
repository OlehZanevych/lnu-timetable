# The algorithm

A formal description of the search, written to be liftable into a manuscript. Where
[`README.md`](README.md) explains the design in prose and [`STUDY.md`](STUDY.md) reports what was
measured, this file states the model, the objective, the data structures, every neighbourhood, and
the complexity of each, in the notation a paper would use.

Everything here is checked against the source. Each section names the file and the function that
implements it, so a reviewer can go from an equation to the code that evaluates it in one step, and
so the document can be re-verified when the code changes.

> **Terminology.** Ukrainian practice supplies three words with no clean English equivalent, and this
> document uses the English gloss with the original in parentheses at first use: a **пара** is a
> double period, the atomic teaching slot (~80 min, two academic hours of 40); a **вікно** (*window*)
> is an idle пара between two taught ones on the same day for the same person; **чисельник /
> знаменник** (*numerator / denominator*) are the two alternating calendar weeks of a biweekly
> schedule.

---

## Contents

1. [The problem](#1-the-problem)
2. [Representation](#2-representation)
3. [The search](#3-the-search)
4. [Complexity](#4-complexity)
5. [Parameters](#5-parameters)
6. [Invariants](#6-invariants)
7. [What is deliberately absent](#7-what-is-deliberately-absent)

---

## 1. The problem

### 1.1 Sets and indices

| symbol | meaning | code |
|---|---|---|
| $\mathcal{C}$ | class sessions to be scheduled or scheduled around, $n = \lvert\mathcal{C}\rvert$ | `Problem::genes` |
| $\mathcal{C}^{\mathrm m} \subseteq \mathcal{C}$ | the movable ones; the rest are fixed obstacles | `Problem::movable` |
| $\mathcal{L}, \mathcal{G}, \mathcal{R}, \mathcal{A}, \mathcal{B}$ | lecturers, academic groups, rooms, abstract rooms, buildings | `nLecturers`, … |
| $\mathcal{D} \subseteq \{1,\dots,7\}$ | working days of the week | `Problem::days` |
| $\mathcal{T}$ | bell times, each with a start minute $\mathrm{start}(t)$ and a grid (bell set) it belongs to | `Problem::times` |
| $\mathcal{P} = \{\mathsf{W}, \mathsf{N}, \mathsf{D}\}$ | parity: every week, numerator only, denominator only | `Parity` |
| $\mathcal{W} = \{1, 2\}$ | the two calendar weeks | — |

An **abstract room** ($\mathcal{A}$) is a shared place that is not a room in the room table — a sports
hall, a hospital ward, a partner institution's laboratory. It may carry a capacity and an address, or
either, or neither, and the objective treats each case differently (§1.4, $\Pi_6$; §1.5).

Each class $c$ carries:

- its participants $L(c) \subseteq \mathcal{L}$ and $G(c) \subseteq \mathcal{G}$ (a lecture to a
  combined stream has several of both);
- a duration $\delta(c)$ in minutes and a headcount $\mathrm{stud}(c)$;
- a **place kind** $\kappa(c) \in \{\textsf{room}, \textsf{abstract-here}, \textsf{abstract-nowhere},
  \textsf{online}\}$ — an ordinary room, an abstract room with an address, an abstract room without
  one, or a class held online;
- domains $S(c) \subseteq \mathcal{D} \times \mathcal{T} \times \mathcal{P}$ and
  $R(c) \subseteq \mathcal{R} \cup \{\varnothing\}$.

### 1.2 Decision variables

A **schedule** $\sigma$ assigns to every movable class a placement

$$\sigma(c) \;=\; \bigl(d_c,\; t_c,\; p_c,\; r_c\bigr) \;\in\; S(c) \times R(c) ,
\qquad c \in \mathcal{C}^{\mathrm m} . \tag{1}$$

Fixed classes carry a placement that $\sigma$ may read but not change. A movable class may also be
*unplaced*, written $\sigma(c) = \bot$; §1.6 explains why that state has to exist and why it is
priced outside $f$.

The occupied minute interval is $\bigl[\mathrm{start}(t_c),\; \mathrm{start}(t_c) + \delta(c)\bigr)$,
and class $c$ is taught in calendar week $w$ iff

$$\mathrm{in}(p_c, w) \;\equiv\; \bigl(p_c = \mathsf{W}\bigr) \;\vee\; \bigl(p_c = w\bigr). \tag{2}$$

Two classes **co-occur** when their weeks and their intervals both overlap:

$$\mathrm{clash}(a,b) \;\equiv\; \mathrm{weeksOverlap}(p_a, p_b) \;\wedge\; \bigl[s_a, e_a) \cap \bigl[s_b, e_b) \neq \emptyset . \tag{3}$$

### 1.3 Hard filters

Four rule families are enforced as **domain restrictions**, never as penalty terms. A schedule this
algorithm emits cannot violate them, so they do not appear in $f$:

1. **Room eligibility** — $r_c \in R(c)$, which the loader computes from room suitability, capacity
   and the faculty's own rooms.
2. **Bell-set membership** — $(d_c, t_c, p_c) \in S(c)$. A class belongs to one grid; a physical
   education class on the sport grid cannot take a slot from the ordinary grid.
3. **Availability** — `NOT_BEFORE`, `NOT_AFTER` and `UNAVAILABLE` windows for the lecturer, the
   group and the room, resolved per (subject, day) by a *more specific wins* rule.
4. **Load cap** — `MAX_CLASSES_PER_DAY` per (subject, day).

Rules 1–2, and the lecturer and group half of rule 3, are properties of a single placement that do
not depend on the rest of the schedule, so they are baked into $S(c)$ and $R(c)$ at load time and no
operator can propose a placement that breaks them. The *room's* half of rule 3 is a (room, day, time)
property and cannot be folded into either domain, so it is tested at placement time. Rule 4 is
different in kind again, and the difference matters throughout §3:

> **Set-valued constraint.** `MAX_CLASSES_PER_DAY` is a property of a *set* of placements. Each of
> $k$ classes can satisfy it individually, tested against a day that does not yet hold the other
> $k-1$, and the $k$ together can still breach it. Every operator that moves more than one class at
> a time must therefore establish the rule against the *final* state, and they do it in two ways:
> `ruin`, `repack`, `kopt`, `kempe` and the kick call `Worker::allLegal` on the whole set once every
> member is down; `swap` re-tests its two halves directly; `chain` places one class at a time against
> the already-updated state, which suffices because the check is monotone in bucket contents.

$\mathrm{Allowed}(c, d, t, p, r)$ (`State::placementAllowed`) is therefore exactly two checks: the
room's time rules, and `MAX_CLASSES_PER_DAY` for the lecturers, the groups and the room. Everything
else is the domains.

### 1.4 The nine penalty terms

Write $E(c)$ for the entities class $c$ touches: $L(c) \cup G(c) \cup \{r_c\} \cup \{a_c\}$. For an
entity $e$ and a day $d$, the **bucket** is the set of classes of that entity on that day,

$$B_{e,d}(\sigma) \;=\; \{\, c \in \mathcal{C} \;:\; e \in E(c),\; d_c = d \,\}, \tag{4}$$

and every term below is a sum over buckets. That is the structural property the whole implementation
rests on, stated as Lemma 1 in §2.4.

**Conflicts.** Two classes of the same lecturer, the same group, or the same room that co-occur:

$$\Pi_1 = \sum_{l \in \mathcal{L}} \sum_{d \in \mathcal{D}} \bigl\lvert \{\, \{a,b\} \subseteq B_{l,d} \;:\; \mathrm{clash}(a,b) \,\} \bigr\rvert , \tag{5}$$

and $\Pi_2$, $\Pi_3$ identically over $\mathcal{G}$ and $\mathcal{R}$. Note that the count is over
*pairs*, so three mutually clashing classes contribute 3, not 1 — the same convention the validator
uses.

**Travel.** For an ordered pair of classes of the same person on the same day that do *not* overlap,
let $\mathrm{gap}(f, l) = s_l - e_f \ge 0$ be the free time between the earlier and the later, and
$\mathrm{J}(f, l)$ the journey required. A violation is a gap too short for the journey:

$$\Pi_5 = \sum_{l \in \mathcal{L}} \sum_{d \in \mathcal{D}} \bigl\lvert \{\, (f, l) \in B_{l,d}^2 \;:\; s_f \le s_l,\; \neg\,\mathrm{clash},\; \mathrm{gap}(f,l) < \mathrm{J}(f,l) \,\} \bigr\rvert , \tag{6}$$

with $\Pi_4$ the same over groups. The journey is directed and the two directions routinely disagree,
so the pair must be ordered in time before $\mathrm{J}$ is read. $\mathrm{J}$ is defined by cases —
one per way a class can be held, and every missing address reads as "no journey":

$$\mathrm{J}(a,b) = \begin{cases}
0 & \text{both online} \\
\mathrm{commute} & \text{exactly one online} \\
0 & \text{same abstract room} \\
\mathrm{abstractTravel} & \text{either is } \textsf{abstract-nowhere} \\
0 & \text{same or unknown building} \\
\mathrm{travel}[b_a, b_b] & \text{otherwise.}
\end{cases} \tag{7}$$

**Abstract-room overflow.** For an abstract room with a capacity, the summed headcount of the classes
covering an instant must not exceed it. The sum of a set of intervals peaks at one of their starts,
so testing every distinct start instant finds every breach, and the breach is charged once per
instant rather than once per class in it:

$$\Pi_6 = \sum_{a \in \mathcal{A}} \sum_{d \in \mathcal{D}} \sum_{w \in \mathcal{W}} \Bigl\lvert \Bigl\{\, s \in \mathrm{starts}(B_{a,d}^w) \;:\; \textstyle\sum_{c \in B_{a,d}^w,\; s_c \le s < e_c} \mathrm{stud}(c) \;>\; \mathrm{cap}(a) \,\Bigr\} \Bigr\rvert . \tag{8}$$

Unlike the terms below, $\Pi_6$ is **not** averaged over the two weeks: a weekly class over capacity
is over it every week.

**Windows (вікна).** Let $U_{e,d}^w$ be the set of minute instants occupied by
$\{c \in B_{e,d} : \mathrm{in}(p_c, w)\}$, and $\mathrm{bells}$ the set of bell start instants on any
grid. The idle пари are the bell starts strictly inside the span of the day but not occupied:

$$\mathrm{win}(e,d,w) \;=\; \bigl\lvert\, \bigl(\mathrm{span}(U_{e,d}^w) \setminus U_{e,d}^w\bigr) \cap \mathrm{bells} \,\bigr\rvert , \tag{9}$$

$$\Pi_7 = \sum_{l \in \mathcal{L}} \sum_{d \in \mathcal{D}} \frac{\mathrm{win}(l,d,1) + \mathrm{win}(l,d,2)}{2}, \qquad \Pi_8 = \sum_{g \in \mathcal{G}} \sum_{d \in \mathcal{D}} \frac{\mathrm{win}(g,d,1) + \mathrm{win}(g,d,2)}{2}. \tag{10}$$

$\mathrm{span}(U)$ is the closed interval from the first to the last occupied instant, so free time
*before* the first class and *after* the last is not a window — which is the point: it is not idle
time, it is a later start or an earlier finish.

**Mixed online days.** A group that has both an online class and an on-site class on the same day
must physically be in two places:

$$\Pi_9 = \sum_{g \in \mathcal{G}} \sum_{d \in \mathcal{D}} \frac{\mathbb 1[\text{mixed in week }1] + \mathbb 1[\text{mixed in week }2]}{2} . \tag{11}$$

The term is defined for groups only; a lecturer moving between an online and an on-site class is
already charged by $\Pi_5$ through the $\mathrm{commute}$ case of (7).

### 1.5 The objective

$$f(\sigma) \;=\; \sum_{i=1}^{9} \beta_i \,\Pi_i(\sigma)^{\alpha}, \qquad \alpha = 2, \tag{12}$$

$$\beta \;=\; (150,\; 100,\; 50,\; 90,\; 120,\; 50,\; 5,\; 20,\; 30). \tag{13}$$

Two properties of (12) are worth a sentence each in a paper, because they shape the search:

- **$\alpha = 2$ makes the objective convex in each count**, so the marginal cost of one more
  violation grows. Removing one lecturer window when there are 22 of them is worth
  $5(22^2 - 21^2) = 215$; removing one when there are 3 is worth 25. The search therefore attacks
  whichever term is currently largest, which is the intended behaviour: a schedule with 40 group
  windows and none for lecturers is worse than one with 20 of each, and (12) says so.
- **The terms are not commensurable in the small.** $\beta_1 = 150$ against $\beta_7 = 5$ does not
  mean a lecturer conflict is 30 window-units; squared, one conflict costs 150 while the first
  window costs 5 and the twenty-second costs 215. Feasibility is enforced lexicographically instead
  (§1.6), and $f$ is used only to rank schedules that are already comparable in feasibility.

Two variants are computed (`State::surrogate`, `State::objective`):

$$\tilde f(\sigma) \text{ — the \emph{surrogate}, with } \Pi_7,\Pi_8,\Pi_9 \text{ left unrounded}, \qquad f(\sigma) \text{ — with each of them rounded to an integer.}$$

The search descends $\tilde f$, because rounding erases the gradient: moving one class out of a
window in one calendar week changes a half-unit, which a rounded $\Pi_7$ may not register at all.
Everything reported — every table in `STUDY.md`, every figure — is $f$, which is what the independent
validator computes.

### 1.6 Feasibility, and the tenth term the objective does not have

Write $H(\sigma) = \sum_{i=1}^{6}\Pi_i(\sigma)$ for the hard total and
$\mathrm{unp}(\sigma) = \lvert\{c \in \mathcal{C}^{\mathrm m} : \sigma(c) = \bot\}\rvert$. The
**incumbent order** is lexicographic:

$$\sigma \prec \sigma' \iff \bigl(\mathrm{unp}, H, f\bigr)(\sigma) <_{\mathrm{lex}} \bigl(\mathrm{unp}, H, f\bigr)(\sigma') . \tag{14}$$

The first key exists because **nothing in (12) counts a class that is not scheduled at all**. An
unplaced class appears in no bucket, so it contributes to no $\Pi_i$, so deleting a class from the
timetable *lowers* $f$. A ruin-and-recreate that fails to put a class back would therefore look like
an improvement, and a search rewarded for that will learn to empty the timetable. Three defences,
all necessary:

1. the acceptance cost (17) charges $\mathrm{unp}$ explicitly and steeply;
2. `recreate` restores a class to where it was rather than leaving it out (§3.4.5);
3. every "is this better" test — the worker's incumbent, the shared best, the elite pool, and the
   schedule the run finally returns — uses (14) rather than $(H, f)$.

Defence 3 was missing until an adversarial review found it; §7 of `STUDY.md` records the fix.

### 1.7 Relation to the standard formulations

The model is a curriculum-based course timetabling problem in the ITC-2007 track 3 / ITC-2019 family,
with three departures worth naming in a related-work section:

- **Biweekly parity.** Every class carries $p_c \in \{\mathsf{W}, \mathsf{N}, \mathsf{D}\}$ and the
  soft terms are averaged over the two calendar weeks. ITC instances have no analogue; the closest
  published treatment is the *pattern* constraints of some Nordic and post-Soviet formulations.
- **Directed inter-building travel.** $\mathrm{travel}[b_a, b_b] \ne \mathrm{travel}[b_b, b_a]$ in
  general (one-way streets, a funicular, a hill), so pairs must be ordered in time. ITC-2007's
  `RoomStability` and the usual "same building" soft constraint are both symmetric.
- **Abstract rooms.** A place that may lack an address and may carry a capacity, giving $\Pi_6$ its
  interval-overlap form (8) rather than the usual per-slot capacity check.

$\Pi_7$ and $\Pi_8$ are the classical *idle timeslots* / `MinWorkingDays`-adjacent family;
$\Pi_1$–$\Pi_3$ are the standard clash constraints, here penalised rather than forbidden so the
search may pass through infeasibility.

---

## 2. Representation

### 2.1 The compressed tick axis

Every time that occurs in an instance — a bell start, the end of a class — is one of a few dozen
distinct minute values. Collect them into a sorted vector $\tau_0 < \tau_1 < \dots < \tau_{m-1}$ (the
**ticks**, `Problem::ticks`), and represent a class by the set of tick indices its interval covers.
The benchmark instances need $m = 22$; a real faculty with four class durations across two bell grids
needs about 40.

Because $m \le 128$ on every instance encountered, that set is a **128-bit word**
(`Mask`, two `uint64_t`). Let $\mu(c)$ be the mask of class $c$ and $\mathrm{bells}$ the mask of
ticks that are a bell start on some grid.

### 2.2 Two questions, two instructions

$$\text{do } a \text{ and } b \text{ overlap?} \qquad \mu(a) \wedge \mu(b) \ne 0 \tag{15a}$$

$$\text{how many пари did this entity skip?} \qquad \mathrm{popcount}\bigl(\mathrm{span}(U) \wedge \neg U \wedge \mathrm{bells}\bigr) \tag{15b}$$

where $\mathrm{span}(U)$ sets every bit between the lowest and the highest set bit of $U$
(`Mask::span`, two `countr_zero`/`countl_zero` and a shift). Equation (15b) *is* definition (9),
evaluated in about six instructions; the validator computes the same number with a sort and a walk,
and the two agree to the digit on all 50 archived instances.

`Mask::span` is the only non-obvious primitive:

```
span(U) = U == 0 ? 0 : (all ones from lowest_set_bit(U) to highest_set_bit(U))
```

### 2.3 The bucket decomposition

The state (`State`) keeps, for every $(e, d)$ pair, the classes in it and a cached statistic:

```
struct BucketStat {
  conflicts, travel      // Π₁…Π₅ contributed by this bucket
  winNum, winDen         // Π₇/Π₈ per calendar week
  mixNum, mixDen         // Π₉ per calendar week
  overflow               // Π₆
  occNum, occDen         // the union of the masks in each week
};
```

with $\lvert\mathcal{E}\rvert \cdot 8$ buckets in total (the stride is 8 so a day $1..7$ indexes a row
directly). The nine counters are the sums of the corresponding fields.

`occNum` / `occDen` are the reason the *probe* in §3.2 is cheap: they are $U_{e,d}^w$ itself, kept
current, so the question "what would this class cost that entity's day?" is (15b) on
$U \vee \mu(c)$ against a stored count, with no scan of the bucket at all.

### 2.4 Delta evaluation

> **Lemma 1 (separability).** Every $\Pi_i$ is a sum over $(e,d)$ buckets of a function of that
> bucket's contents alone. Consequently, moving class $c$ from $\sigma(c)$ to $\sigma'(c)$ changes
> only the buckets in $\{(e, d_c) : e \in E(c)\} \cup \{(e, d'_c) : e \in E'(c)\}$.
>
> *Proof.* Immediate from (5)–(11): each is written $\sum_{e}\sum_{d} g(B_{e,d})$. $\square$

The evaluation follows directly (`State::placeRaw` / `State::flush`):

```
placeRaw(c, d', t', p', r'):
    for each bucket b touched by c's current placement:  mark b dirty
    remove c from its buckets;  write the new placement;  insert c into its new buckets
    for each bucket b touched by the new placement:      mark b dirty

flush():
    for each dirty bucket b:
        counters -= stats[b]            # subtract the cached statistic
        stats[b]  = recompute(b)        # O(|B|²) in the bucket, |B| ≤ 6 in practice
        counters += stats[b]
        work += 1                       # the free work metric §3.5 divides rewards by
    dirty.clear()
```

Several classes moving as one candidate call `placeRaw` repeatedly and `flush` once, so a bucket
shared by two of them is recomputed once rather than twice.

**Cost.** Let $\eta = \max_c \lvert E(c)\rvert$ (participants plus place, typically 2–6) and
$\bar\beta$ the mean bucket size (classes per entity per day, 2–5 for a real timetable). One
single-class candidate touches at most $2\eta$ buckets and costs
$O\bigl(\eta\,\bar\beta^{\,2}\bigr)$ — **independent of $n$**. That is the property that makes a
one-hour budget buy the same number of moves on a 400-class instance as on a 31 000-class one, and
it is the single most important implementation claim in the paper.

Measured throughput on two cores: 3.9 M candidates in 30 s at $n = 12\,800$ (§5 of `STUDY.md`), and
the per-move cost is flat in $n$ within measurement noise from 3 200 upwards.

---

## 3. The search

### 3.1 Structure

```
Algorithm 1  solve(problem, options) → schedule
 1  clusters ← labelPropagation(problem)                        § 3.6
 2  spawn W workers, worker k seeded with seed + 7919·k
 3  each worker independently:
 4      σ ← construct()                                          § 3.2
 5      σ* ← σ                                                   # the worker's incumbent
 6      while time remains and f(working state) > 0:      # deadline polled every 1 024 moves
 7          o ← selectOperator()                                 § 3.5
 8          σ′ ← o(σ)                                            § 3.4
 9          if accept(σ′) then σ ← σ′                            § 3.3
10          if σ ≺ σ* then σ* ← σ                                # (14)
11          if stagnated then escalate / kick / restart          § 3.7
12  return the ≺-least of every worker's σ* and the shared best  § 3.8
```

Workers are independent searches over the same problem that exchange elite schedules (§3.8). The
$7919$ stride on the seed is arbitrary but large and prime, so the streams start far apart.

### 3.2 Construction

```
Algorithm 2  construct() → σ
 1  order ← movable classes, shuffled uniformly at random
 2  stable-sort order by  (|S(c)|·|R(c)|  ascending,  |L(c)|+|G(c)|  descending)
 3  for c in order:
 4      (s, r) ← scanBest(c, wide=false)  or  scanBest(c, wide=true)
 5      if found: place c at (s, r)      else: leave c unplaced   # counted in unp, priced by (17)
```

Most-constrained-first: the class with the fewest ways to be placed goes down while the timetable is
still empty enough to take it. Ties are broken by how many people the class involves, and — this
matters for §3.7 — **the order is shuffled before the stable sort**. The difficulty key is coarse
(thousands of classes share a value), so without the shuffle every construction is the same
construction and a restart lands where the last one did.

`scanBest` scores each candidate placement with the same probe the large neighbourhoods use:

$$\mathrm{score}(c, d, t, p, r) = \underbrace{\Lambda\cdot\mathrm{clashes}}_{\Lambda = 10^{9}} \;+\; \underbrace{\Delta_{\text{window}}(c,d,p,\mu)}_{\text{(15b), exact}} \;+\; \underbrace{\Theta\cdot\mathrm{travelViolations}}_{\Theta = 10^{7}} \tag{16}$$

evaluated with three prunings that make a full scan affordable: the people-clash part is hoisted out
of the room loop (it does not depend on the room), the partial score is compared against the best so
far before the next term is computed, and the travel term — the most expensive — is evaluated for at
most six rooms per slot. Rooms are sampled (`roomSample = 96`) when a class has more than
`roomScanFullBelow = 256` of them, starting at a random offset so the sample differs per call.

### 3.3 Acceptance

The search minimises a scalarisation of (14) that prices infeasibility *finitely*, so that it can
walk through a worse state to reach a better one:

$$\mathrm{cost}(\sigma) \;=\; \lambda\,H(\sigma) \;+\; \tilde f(\sigma) \;+\; 8\lambda\,\mathrm{unp}(\sigma), \qquad \lambda \;=\; \max\bigl(10^{6},\; 0.02\,\tilde f(\sigma_0)\bigr) \tag{17}$$

with $\sigma_0$ the constructed schedule. $\lambda$ is scale-free on purpose: $f$ grows with the
square of the instance, so a fixed penalty that is prohibitive at $n = 400$ is negligible at
$n = 31\,000$.

Three acceptance criteria are implemented (`Worker::acceptTest`); **late acceptance hill climbing**
is the default.

**LAHC** keeps a circular history $v_0 \dots v_{\ell-1}$ of length $\ell = 100$, initialised to
$\mathrm{cost}(\sigma_0)$, and accepts a candidate $\sigma'$ when

$$\mathrm{cost}(\sigma') \;\le\; v_{\,\mathrm{moves} \bmod \ell} \qquad\text{or}\qquad \mathrm{cost}(\sigma') \;\le\; \mathrm{cost}(\sigma) . \tag{18}$$

The slot is then written back. Two remarks that a paper should make, because both were measured:

- The implementation lowers a slot but does not raise it unless `lahcCanonical` is set. Burke and
  Bykov's original rule writes the current cost unconditionally. The difference is immaterial in
  practice, because **either way the bar collapses**: once the search stops descending, every slot
  holds the incumbent's cost and (18) admits only equal-or-better candidates. LAHC at convergence
  *is* a hill climb that accepts plateau moves.
- $\ell$ is the dominant parameter and its optimum is **small and does not grow with $n$**.
  $\ell = 5\,000$ measures at soft 3 381 against $\ell = 100$'s 32; $\ell = 50\,000$ does not reach
  feasibility in three minutes. A history filled at construction scale ($\tilde f \approx 8\times10^7$)
  and thousands of slots deep is not a bar at all.

**Simulated annealing** with $T_0 = 0.0015\,\tilde f(\sigma_0)$, geometric cooling at $0.995$ per
4 096 candidates, floor $10^{-4}T_0$, and a reheat to $T_0/2$ after `saReheatAfter` candidates
without a new incumbent. **Diversified late acceptance** (DLAS) keeps the *maximum* of the history as
the bar and replaces it only when its last copy leaves. `engine = mixed` gives half the workers SA
and half LAHC.

> The tail behaviour of all three is the same and it is the central negative result of this work:
> **the acceptance criterion cannot rescue a converged search**, because its bar is pinned to a scale
> the objective has left behind — LAHC's history to the incumbent, SA's floor temperature to the
> *construction* surrogate, four orders of magnitude above the tail objective. §3.7 is what does
> rescue it.

### 3.4 The neighbourhoods

Nine are implemented; seven are enabled by default. Each returns *applied* or *not applied*; a
candidate that is applied is then judged by (18) and undone if refused. Undo is a journal of
(class, previous placement) pairs replayed in reverse, so no copy of the schedule is made.

Throughout, $\mathrm{pick}()$ draws a class: with probability $\mathrm{hotShare} = 0.7$ from the
**hot list** (movable classes sitting in an (entity, day) bucket that carries a hard violation) while
$H > 0$, or from the **warm list** (movable classes in a bucket that has a window or a mixed day)
once $H = 0$; otherwise uniformly. Both lists are bucket-level rather than class-level — every class
in a guilty bucket is a candidate, not only the guilty pair — which is what makes them cheap to
collect, and is also the right granularity, since the repair often moves an innocent neighbour.
Both lists are refreshed every `hotRefresh` $= 50\,000$ candidates and after every escape. This is
min-conflicts targeting, and at $n = 31\,000$ it is the difference between a uniformly drawn class
being one of the guilty parties 0.03 % of the time and 70 % of the time.

#### 3.4.1 move

One class to a random admissible placement from its own domain. $O(\eta\bar\beta^2)$.

#### 3.4.2 swap (targeted)

Draw a class $i$ and a target $(d, t, p, r)$ from its domain. If a class $j$ **occupies the target
room** at that time, exchange the two placements; otherwise just move $i$. The partner is whoever is
in the way, not a randomly drawn second class — which is what makes the operator useful at high
density, where a random pair almost never has compatible domains. A class blocking the target through
a shared lecturer or group rather than through the room is not detected here; that is `chain`'s job
(§3.4.3), and the acceptance test prices the conflict meanwhile. Both halves are re-tested for the
set-valued rule afterwards (§1.3).

#### 3.4.3 chain (ejection chain)

```
Algorithm 3  opChain()
 1  i ← pick();  move i to a random admissible placement
 2  last ← i
 3  repeat depth ∈ {1..chainDepth} times:
 4      v ← a class now double-booked with `last` (its lecturers, then its groups, then its room)
 5      if none: break
 6      move v to the placement *v itself* would choose (scanBest), not to the vacated one
 7      last ← v
```

The difference from a swap is line 6: the displaced class goes where it would choose, so the operator
reaches rearrangements *every intermediate state of which is worse than both ends*. Depth 3 by
default.

#### 3.4.4 kempe (local Kempe chain)

Pick a class $i$ and a target slot. Build the alternating set of classes that block one another
between the source and target slots, expanding from each member through *that member's* lecturers
and groups, then move the whole set across at once. The expansion stops taking new heads once the set
reaches 12, so the set is bounded by 12 plus whatever one final expansion adds. Every member must be able to take the slot it is sent to, and
the set is re-tested jointly afterwards. This is the classical Kempe-chain interchange of graph
colouring, localised so the component stays small.

#### 3.4.5 ruin (ruin-and-recreate)

```
Algorithm 4  opRuin()
 1  k ← uniform in [lnsMin, lnsMax] = [6, 40]
 2  V ← selectVictims(selector, k)         # selector uniform over the five below
 3  lift every v ∈ V out of the schedule
 4  for v in V, in random order:           # the randomisation is the diversification
 5      place v at argmin scanBest(v)      # greedy, sees the others already back
 6  if not allLegal(V): undo
```

Five victim selectors, drawn uniformly:

| selector | the set it removes |
|---|---|
| `random` | $k$ classes uniformly |
| `related` | Shaw-style: a seed and everything sharing a lecturer or a group with it |
| `entityDay` | one (entity, day) bucket |
| `cluster` | one community of the conflict graph (§3.6) |
| `worstWindow` | the buckets with the largest window cost |

Every selector is truncated to $k$ by a shuffle, so a bucket or community larger than $k$ is
*sampled* rather than removed entire — which matters at $k \le 40$, because a community can hold
several hundred classes.

Greedy reinsertion in random order is what makes the operator a *diversification* rather than a
re-derivation: the same set removed twice is put back differently.

#### 3.4.6 kopt (the permutation operator)

This is the operator that answers "rearrange more than ten classes at once, exactly", and it is the
one this project was asked for by name.

```
Algorithm 5  permute(M), |M| = k
 1  Q ← the k placements the members currently hold
 2  lift every member out of the schedule
 3  optionally add `koptExtra` currently-free placements from the members' domains to Q   # default 0
 4  build the k × |Q| cost matrix
 5      C[r][q] = Λ·clashes(r at q) + Δwindow(r at q) + Θ·travel(r at q)   if admissible
 6              = +∞                                                      otherwise
 7  square it up with zero-cost dummy rows/columns
 8  A ← hungarian(C)                                      # O(max(k,|Q|)³)
 9  if A is the identity: undo and report *not applied*
10  apply A
11  if not allLegal(M): undo
12  refinePairs(M, rounds = 3)                            # exact, under the true objective
```

Three properties decide whether it is worth anything, and each is a paragraph in a paper:

- **Exactness is over a relaxation.** With all $k$ lifted out, the cost of putting class $r$ at
  placement $q$ is readable independently, so (line 8) solves a *linear assignment problem* exactly.
  The relaxation ignores the residual coupling among the $k$ — two of them sent to placements that
  clash with each other are priced as if the other were absent — which is what the pairwise
  refinement at line 12 repairs, under the true objective, in $O(k^2)$ per round.
- **The members must share something.** By Lemma 1 the objective is separable over $(e,d)$, so
  exchanging two classes with no entity and no day in common **cannot change any $\Pi_i$**. Members
  are therefore drawn from a few gappy buckets (65 %) or from one cluster (35 %), never uniformly.
- **The identity must be detected.** The relaxation very often returns everybody to where they were,
  and putting them back is a candidate that costs exactly zero and is therefore *accepted* by (18).
  Before the check at line 9, 99.96 % of this operator's candidates were accepted and 0.8 % improved
  anything; detecting the identity turns that whole share of the budget back into search.

**Measured contribution: neutral.** `full` and `--no-kopt` are indistinguishable at every size tested
(§4 of `STUDY.md`). The honest reading — and the one a paper should give — is that
ruin-and-recreate over the same $k$ classes can already reach every permutation *and* every placement
outside the set, so exactness over a subset of what another operator does anyway buys nothing
measurable. Widening the pool at line 3 to make the question strictly stronger makes it **worse**
(soft $5 \to 11$ at $n = 6\,400$), because assigning inside the occupied set is what guaranteed no
member could come to clash with another; §7.

#### 3.4.7 repack

One (entity, day) bucket lifted out, greedily re-placed, then pairwise-refined. The cheapest of the
large neighbourhoods and, with `ruin`, the one the bandit spends most of the budget on.

#### 3.4.8 dayfix, winfix — off by default

An exhaustive re-pack of one (entity, day) over every arrangement within the day, and a
window-directed move that reads the idle bell starts straight off `occNum`/`occDen` and pulls a class
from the far side of one into it. Both are *exactly matched to the residual*, and both measure worse.
§7.

### 3.5 Adaptive operator selection

A multi-armed bandit over the enabled operators, in segments of 4 000 *applied* candidates — a draw
that produces no candidate still has its work charged, but does not advance the segment.

$$\text{select } o \text{ with probability } \frac{w_o}{\sum_{o'} w_{o'}}, \qquad w_o \in [0.05, 40] \tag{19}$$

$$\text{reward } \rho_o = \sum_{\text{segment}} \begin{cases} 4.0 & \text{new incumbent} \\ 1.5 & \text{improved, not an incumbent} \\ 0.3 & \text{accepted, not improved} \end{cases} \qquad w_o \leftarrow 0.7\,w_o + 0.3\Bigl(1 + \frac{300\,\rho_o}{\max(1, \mathrm{work}_o)}\Bigr) \tag{20}$$

where $\mathrm{work}_o$ is the number of **buckets recomputed** by that operator during the segment —
a free, monotone, machine-independent proxy for cost that the state counts anyway (§2.4). Dividing
the reward by it is what stops a large neighbourhood from being chosen because it is occasionally
spectacular.

Note what (19)–(20) do *not* do: they allocate *draws* in proportion to reward-per-work, not
*budget*. Allocating budget instead (`costAwareSelection`, i.e. dividing $w_o$ by the operator's mean
work at selection time) triples the candidate count and **loses**, because a large neighbourhood's
worth is not its immediate gain per bucket touched — it is reaching states the cheap moves cannot
reach at all, and a rate divides that away. §7.

The two cheap operators start at $w = 4$ and the rest at $w = 1$, because the bandit needs a few
thousand samples before its estimate of a large neighbourhood means anything.

### 3.6 Clusters

`buildClusters` partitions $\mathcal{C}^{\mathrm m}$ into communities of the bipartite
class $\leftrightarrow$ entity graph by **label propagation**: each class starts with its own label;
each entity then takes the plurality label of its classes, each class the plurality label of its
entities, for six rounds. The result is a partition to *aim* a large neighbourhood at — classes
that genuinely contend with one another — not a decomposition to solve independently, and a class is
of course reachable from several communities.

Clusters feed the `cluster` ruin selector and the deep phase. Turning them off (`--no-cluster`) is
the single most damaging ablation after removing the large neighbourhoods entirely.

### 3.7 Escape: what a long budget is for

This is the part of the algorithm that the study rewrote, and the part a paper should lead with,
because the naive version fails in a way that is easy to miss and that the literature does not
emphasise.

**The observation.** At $n = 12\,800$ the incumbent reached $f = 5\,920$ at 37 s and was still at
exactly $5\,920$ at 300 s, after **sixteen million further candidates**. The 60 s run and the 300 s
run returned the same schedule to the digit.

**The diagnosis** (three causes, one experiment each — §6a of `STUDY.md`):

1. the escape perturbed the *working* state, which after a failed cycle is worse than the incumbent,
   so each perturbation started further from the best schedule than the last;
2. the acceptance bar had collapsed (§3.3), so between perturbations the search was a hill climb;
3. widening the bar does not help — it prevents convergence altogether.

**The mechanism that works.** Three nested escalations, tried in order:

```
Algorithm 6  escape
 1  invoked when sinceBest ≥ deepEvery and sinceDeep ≥ deepEvery
 2  if deepPhase() improved the working state:  return                     # § 3.7.1
 3  if sinceBest < stagnationMoves:             return                     # not yet stuck enough
 4  if movesSinceIncumbent ≥ restartAfter:      restartFresh();     return # § 3.7.3
 5  if useRecombine and coin(recombineRate) and recombine():        return # § 3.8, off by default
 6  if cooperate and sinceAdopt > stagnationMoves:  adoptElite();   return # § 3.8
 7  kickFromBest()                                                         # § 3.7.2
```

Two counters, deliberately distinct. `sinceBest` is reset by a kick — it measures how long since
something was *tried*; `movesSinceIncumbent` is not — it measures how long the search has really been
stuck. Line 4 needs the second, or a kick every 60 000 candidates would keep resetting the counter
that is supposed to trigger the restart, and the restart would never fire.

#### 3.7.1 Deep phase

24 large-neighbourhood attempts under **strict descent** — cluster permutation, worst-window
ruin-and-recreate, and repack in rotation — with the permutation width widened by 4 each time the
phase is entered, up to `koptK = 12`, and narrowed by 2 whenever it pays. A deep phase that improves
the working state means the ordinary neighbourhoods have room again.

#### 3.7.2 Kick from the incumbent

```
Algorithm 7  kickFromBest()
 1  σ ← σ*                                        # restore the incumbent — the whole point
 2  size ← clamp(kickSize, kickMin, kickMax)
 3  while broken < size and rounds < 12:
 4      sel ← uniform{related, entityDay, worstWindow, cluster}
 5      V ← selectVictims(sel, min(size − broken, lnsMax))
 6      lift V, greedily recreate V; keep if legal
 7  refill the acceptance history at the new cost;  sinceBest ← 0
 8  kickSize ← kickMin if the last cycle produced an incumbent, else 1.5·kickSize + kickMin
```

Line 1 is the fix. Line 4 is the second half of it: the set broken must be *related*, because a
lecturer's whole day can be repaired into a genuinely different day, whereas the same number of
unrelated classes is repaired back to almost exactly where they were and costs the climb for nothing.
Line 8 is the adaptive strength: probe close to the best schedule while that is paying, reach further
when it is not.

**Measured: 22 % of the soft cost and 34 % of $f$**, six seeds, paired, better on five of six.

#### 3.7.3 Fresh restart

```
Algorithm 8  restartFresh()
 1  offer σ* to the shared pool and to the shared best
 2  σ* ← ⊥                                        # forget it: nothing is lost, the pool has it
 3  unplace every movable class;  σ ← construct()  # a *different* construction — § 3.2, line 1
 4  block elite adoption for restartAfter candidates
```

The justification is the variance measurement, and it is worth stating as a result in its own right:
**the same binary, the same instance, the same configuration, six PRNG seeds, 180 s, returns soft
11, 27, 17, 23, 19, 29** — a factor of 2.6 between the luckiest and the unluckiest run. Which basin
the construction lands in matters more than anything the local search does afterwards. A long budget
is therefore better spent *sampling that distribution* than polishing one draw.

Line 4 is not optional: immediately after a fresh construction every pool member is markedly better,
so without it the cooperation of §3.8 drags the worker straight back into the basin it just left.

**Measured at 600 s: a further 32 % of the soft cost and 41 % of $f$**, six seeds, paired, better on
five of six, with about 24 constructions per run. It fires after `restartAfter` $= 1.2\times10^6$
candidates without a new incumbent — roughly 20 s per worker on the reference hardware — so at a 30 s
budget it never fires and short runs are unaffected.

### 3.8 Cooperation

Workers share, under one mutex:

- **the best schedule** — a worker whose incumbent is more than 3 % worse than the shared best may
  adopt it (`adoptElite`), which is a convergence mechanism and is blocked after a fresh restart;
- **an elite pool** of up to `poolSize` $= 8$ schedules, each required to differ from every other in
  at least `poolMinDist` $= 1\,\%$ of the movable classes. Diversity is enforced on insertion: an
  entry within the distance threshold of an existing one replaces it if better and is discarded
  otherwise, so the pool cannot fill with eight copies of one basin.

The pool exists to support **cluster-wise recombination** (`--recombine`): inherit a random half of
the clusters from another pool member, keep the rest from the incumbent, and repair the collisions —
lift every grafted class that breaks a per-class rule or takes part in a conflict, and greedily
reinsert. It is the only operator here that can produce a schedule neither parent would have reached.

**It is off by default because it measures worse** (§7), which is a negative result worth reporting
rather than hiding: with two workers that adopt one another's elites, the pool holds two schedules in
one basin, and a child of two near-identical parents is a repair bill with no new material in it.

---

## 4. Complexity

| step | cost | note |
|---|---|---|
| overlap test | $O(1)$ | (15a), two `AND`s |
| window count for one bucket-week | $O(1)$ | (15b), `span`+`andnot`+`popcount` |
| recompute one bucket | $O(\bar\beta^{\,2})$ | pairwise; $\bar\beta \le 6$ in practice |
| single-class candidate | $O(\eta\,\bar\beta^{\,2})$ | **independent of $n$** |
| `scanBest` for one class | $O(\lvert S(c)\rvert \cdot \lvert R(c)\rvert)$, falling to $O(\lvert S(c)\rvert \cdot 96)$ when $\lvert R(c)\rvert > 256$ | with three prunings |
| construction | $O\bigl(n \log n + n\,\lvert S\rvert\,\lvert R\rvert\bigr)$ | the sort, then one scan per class |
| ruin-and-recreate, $k$ victims | $O(k \cdot \text{scanBest})$ | |
| permutation, $k$ members | $O(k^3 + k^2\,\eta\,\bar\beta^{\,2})$ | Hungarian, then refinement |
| Kempe chain | $O(\lvert M\rvert\,\eta\,\bar\beta^{\,2})$, $\lvert M\rvert \le 12$ | |
| label propagation | $O\bigl(6 \cdot \sum_c \lvert E(c)\rvert \log \Delta\bigr)$ | once, before the search; $\Delta$ = max degree, from the plurality sort |
| bucket rebuild (after a restart) | $O(\lvert\mathcal{E}\rvert\,\bar\beta^{\,2})$ | amortised over $10^6$ candidates |

Memory is $O\bigl(n + \lvert\mathcal{E}\rvert\bigr)$ words plus two 128-bit masks per bucket; at
$n = 31\,000$ the whole state is a few tens of megabytes and fits comfortably in a laptop's cache
hierarchy at the levels that matter.

---

## 5. Parameters

Defaults, in `SearchOptions` (`src/core/search.hpp`). "Measured" means the value was chosen by an
experiment recorded in `STUDY.md`; "inherited" means it was taken from the TypeScript solver's own
tuning (`TIMETABLE-GENERATION.md` §5) and re-checked but not re-optimised.

| symbol | option | default | how chosen |
|---|---|---|---|
| $\ell$ | `lahcLength` | 100 | measured; optimum is small and flat in $n$ |
| $\lambda$ | `hardWeight` | $\max(10^6,\,0.02\,\tilde f_0)$ | scale-free by construction |
| $T_0$ | `saT0Factor` | $0.0015\,\tilde f_0$ | inherited |
| — | `saCooling` | 0.995 per 4 096 candidates | inherited; SA is not the default engine |
| — | `hotShare` | 0.7 | inherited |
| — | `hotRefresh` | 50 000 | inherited |
| — | `chainDepth` | 3 | inherited |
| $[k_{\min}, k_{\max}]$ | `lnsMin`, `lnsMax` | 6, 40 | inherited |
| $k$ | `koptK` | 12 | the "more than ten classes" requirement |
| — | `koptExtra` | 0 | **measured**: 8 is worse (§7) |
| — | `deepEvery` | 20 000 | inherited |
| — | `stagnationMoves` | 60 000 | inherited |
| — | `kickMin`, `kickMax` | 12, 300 | measured (§3.7.2) |
| — | `restartAfter` | 1 200 000 | **measured** (§3.7.3) |
| — | `poolSize`, `poolMinDist` | 8, 1 % | not tuned; recombination is off |
| — | `roomSample` | 96 | inherited |

Everything above is a command-line flag on `timetable-solve`, which is what makes the ablations in
`STUDY.md` one-line commands.

---

## 6. Invariants

What the algorithm guarantees, and where each guarantee is enforced. These are the claims a reviewer
is entitled to check.

1. **Hard filters are never violated in a returned schedule.** Rules 1–2 and the lecturer/group half
   of rule 3 by domain construction; the room half of rule 3 and rule 4 by `State::placementAllowed`
   on every placement, plus the joint re-test described in §1.3 for every operator that moves more
   than one class. Verified by an explicit regression on instances whose
   `MAX_CLASSES_PER_DAY` is pulled down to the tightest value that still admits a perfect answer
   (Experiment 0).
2. **No class is silently dropped.** By (14), by the $8\lambda\,\mathrm{unp}$ term in (17), and by
   `recreate` restoring a class it cannot re-fit.
3. **The returned schedule is the $\prec$-least ever seen**, including schedules a worker has since
   discarded in a fresh restart — `solve` compares every worker's incumbent against the shared best.
4. **Immovable classes are never moved.** A class the signed-in account may not edit arrives locked,
   stays in the problem as an obstacle, and is excluded from $\mathcal{C}^{\mathrm m}$.
5. **The evaluator agrees with an independent validator**, written from the domain semantics rather
   than from either solver, to the digit on all 50 archived instances and on both x86-64 and aarch64
   (`--mode score-hidden`).

---

## 7. What is deliberately absent

Six mechanisms and one parameter setting were implemented, measured, and left off by default. They are kept behind flags with
their numbers in the source comments, because a negative result that cannot be reproduced is not a
result. Full detail in §4 and §6a of `STUDY.md`.

Median soft cost, mechanism **off → on**, at 30 s over five seeds unless stated:

| mechanism | flag | $n=3\,200$ | $n=6\,400$ | $n=12\,800$ | also |
|---|---|---|---|---|---|
| exhaustive (entity, day) re-pack | `--dayfix` | $3 \to 3$ | $5 \to 7$ | $20 \to 27$ | candidate rate $3.8\,\mathrm{M} \to 3.3\,\mathrm{M}$ |
| window-directed move | `--winfix` | $3 \to 3$ | $5 \to 10$ | $20 \to 26$ | |
| budget-proportional selection | `--cost-aware` | $3 \to 4$ | $5 \to 16$ | $20 \to 31$ | candidate rate $5.0\,\mathrm{M} \to 11.8\,\mathrm{M}$ |
| widened permutation pool | `--kopt-extra 8` | — | $5 \to 11$ | $20 \to 23$ | |
| cluster-wise recombination | `--recombine` | — | — | mean $20.2 \to 23.3$ | 180 s, six seeds, worse on five |
| dedicated ILS loop | `--ils` | — | — | $37 \to 70$ | when it takes over at 5 s |
| longer acceptance history | `--lahc 5000` | — | — | $32 \to 3\,381$ | $\ell = 50\,000$ never reaches feasibility |

**The unifying finding, and the most transferable claim in this work:** adding a cheap, well-targeted
operator to a portfolio that already contains large neighbourhoods makes it *worse*, because the
draws it takes come out of whatever was producing the improvement. Three of the seven rows above —
`dayfix`, `winfix`, `recombine` — are instances of it, and each was individually surprising: all
three are aimed squarely at the residual, which by the end of a run is a few dozen windows among
twelve thousand classes. It is the reason the study reports per-operator ablations rather than only
the assembled system.

The `--kopt-extra` row is a different lesson and worth its own sentence in a paper. Widening the
assignment pool beyond the placements the members already hold makes the question strictly stronger,
and the answer strictly worse, because assigning *inside* the occupied set cannot change the multiset
of occupied (day, slot, room) — so no two members can come to clash in a way the relaxed cost matrix,
built with all $k$ lifted out and therefore blind to what the $k$ do to each other, failed to price.
The exactness was buying **safety**, not coverage.
