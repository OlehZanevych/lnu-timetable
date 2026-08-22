// The search: what runs after construction, and the knobs the study varies.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "json.hpp"
#include "model.hpp"
#include "state.hpp"

namespace tg {

struct SearchOptions {
  int64_t timeLimitMs = 30000;
  int threads = 0;             // 0 = one per hardware thread
  uint64_t seed = 20260802;
  std::string engine = "lahc"; // lahc | sa | dlas | mixed

  // Acceptance
  int lahcLength = 100;
  /// Write the current cost back into the history slot (Burke and Bykov's rule) rather than only
  /// lowering it. See `acceptTest`.
  bool lahcCanonical = false;
  double hardWeight = 0;       // 0 → max(1e6, surrogate·0.02), scale-free (§5.5)
  double saT0Factor = 0.0015;  // T₀ as a fraction of the constructed surrogate
  /// Geometric cooling factor, applied once per 4 096 candidates. The default is the value the
  /// implementation used as a literal before the option was wired up; changing it changes only the
  /// `sa` and `mixed` engines, and every measurement in STUDY.md is on the default `lahc`.
  double saCooling = 0.995;
  int saReheatAfter = 400000;  // moves without a new incumbent before a reheat

  // Move mix. These are starting weights; the bandit adapts them at runtime.
  double swapRate = 0.5;
  double chainRate = 0.15;
  int chainDepth = 3;
  double hotShare = 0.7;
  int64_t hotRefresh = 50000;

  // Large neighbourhoods
  bool useLns = true;
  bool useRepack = true;
  // Off by default, and measured: an exhaustive re-pack of one (entity, day) is the operator most
  // directly aimed at the residual, and it still loses. Median soft, off → on, 30 s, five seeds:
  // 3 → 3 at n = 3 200, 5 → 7 at 6 400, 20 → 27 at 12 800, *and* the candidate rate falls from
  // 3.8 M to 3.3 M. At 60 s, three seeds, n = 12 800: 17 → 20. Kept because the mechanism is worth
  // being able to re-measure, not because it pays.
  bool useDayRepack = false;
  /// The window-directed move: read the idle bell starts off an (entity, day)'s occupancy mask and
  /// pull a class from the far side of one into it — the only move family that closes a gap by
  /// construction rather than by luck.
  ///
  /// Off by default, and this is the third mechanism in a row to be rejected for the same reason.
  /// Median soft, off → on, 30 s, five seeds: 3 → 3 at n = 3 200, **5 → 10** at 6 400, and
  /// **20 → 26** at 12 800; at 60 s, three seeds, 9 → 8 at 6 400 but 17 → 24 at 12 800. It is cheap
  /// and it is exactly matched to the residual — which is twenty windows among twelve thousand
  /// classes — and it still loses at the size where the budget binds, because the improvement is
  /// coming from the large neighbourhoods and every draw given to something else is a draw taken
  /// from them. See the note on `costAwareSelection` for the general form of the finding.
  bool useCloseWindow = false;
  bool useKopt = true;
  bool useClusters = true;
  bool useKempe = true;
  int koptK = 12;
  /// How many *free* placements to add to the permutation pool beyond the k the classes already
  /// hold. Zero — the default — makes the operator a pure permutation.
  ///
  /// Widening it looked like the obvious improvement: a rectangular assignment over a superset
  /// answers "which k of these k + extra placements should these k classes take, and in which
  /// order", which no greedy recreate can answer because a greedy recreate commits the first class
  /// before it has seen the last one's options. Measured at 8, five seeds, 30 s: soft 5 → 11 at
  /// n = 6 400 and 20 → 23 at 12 800.
  ///
  /// The reason is the thing the permutation was quietly getting right. Assigning inside the set the
  /// classes already occupy cannot change the multiset of occupied (day, slot, room), so no pair of
  /// the k can come to clash in a way the relaxed cost matrix — built with all k lifted out, and
  /// therefore blind to what the k do to each other — failed to price. Add free placements and that
  /// guarantee is gone: the assignment cheerfully sends several of the k somewhere they conflict,
  /// and the pairwise refinement can only undo two at a time. The exactness was buying safety, not
  /// coverage.
  int koptExtra = 0;
  /// Select operators proportionally to reward per unit of work rather than to reward alone — that
  /// is, allocate the *budget* between them rather than the draws. Sounds obviously right and is
  /// measured to be worse: it more than doubles the candidate count (5.0 M → 11.8 M at n = 6 400 in
  /// thirty seconds) and loses quality anyway — median soft 5 → 16 at 6 400 and 20 → 31 at 12 800,
  /// five seeds — because a large neighbourhood's worth is not its immediate gain per bucket
  /// touched; it is reaching states the cheap moves cannot reach at all, and a rate divides that
  /// away. Kept as a switch so the finding can be reproduced.
  bool costAwareSelection = false;
  int lnsMin = 6;
  int lnsMax = 40;

  // Escape
  int64_t stagnationMoves = 60000;   // before a perturbation
  int64_t deepEvery = 20000;         // moves between deep-phase attempts once converging

  /// What to do when the deep phase also comes back empty.
  ///
  /// `false` is the original behaviour: перемішати — relocate a tenth to a fifth of every movable
  /// class at random, from wherever the working state happens to be, and climb again. It measures as
  /// a **random restart that never returns**: at n = 12 800 the incumbent stops moving at ~37 s and
  /// is still exactly where it was at 300 s, after sixteen million further moves and some two
  /// hundred and seventy perturbations. Two things are wrong with it. The kick is far too big to
  /// climb back from inside one stagnation window, and — the real fault — it kicks the *working*
  /// state, which after a failed cycle is already worse than the incumbent, so the search drifts
  /// away from the best timetable it has found and never comes back.
  ///
  /// `true` is iterated local search proper: restore the incumbent first, then break a small,
  /// *related* part of it and repair. The strength adapts — `kickMin` after a cycle that produced a
  /// new incumbent, half again as large after one that did not, capped at `kickMax` — so the search
  /// probes close to the best solution while that is paying and reaches further only when it stops.
  bool restartFromBest = true;
  int kickMin = 12;                  // classes broken by a kick that is paying
  int kickMax = 300;                 // and by one that has not paid for many cycles

  /// Once the search has a feasible timetable and the ordinary walk has stopped improving it, hand
  /// the rest of the budget to `ilsLoop` — kick the incumbent, run a few hundred descent moves, keep
  /// the result only if it is no worse — instead of continuing the walk.
  ///
  /// **Off by default, and measured.** It is the natural thing to try once the trajectory is seen to
  /// freeze (§6a of the study) and it does not work: at n = 12 800 it reaches soft 70 against the
  /// walk's 37 when it takes over at five seconds, and 37 against 37 when it takes over at forty.
  /// Thousands of kick-and-descend cycles a minute find nothing the walk had not already found. The
  /// walk's late-acceptance bar, collapsed onto the incumbent, still admits *equal-cost* moves, and
  /// plateau drift is most of what there is to do on a surface whose objective is a sum of squares
  /// of small integers; the cycle admits them too, but only within one cycle, and it is the long
  /// uninterrupted drift that matters. `--ils` turns it on.
  bool useIls = false;
  int ilsDescent = 600;              // descent moves per cycle
  /// Moves without a new incumbent before the walk hands over. Too small and the walk never gets to
  /// finish its descent, which is the better descent: handing over at five seconds instead of forty
  /// costs soft 37 → 70 at n = 12 800.
  int64_t ilsAfter = 400000;
  double ilsFocus = 0.5;             // share of the descent's draws taken from what the kick broke
  int64_t ilsReanchor = 400;         // sideways cycles before returning to the incumbent

  /// The shared population. `poolSize` timetables, each at least `poolMinDist` × |movable| classes
  /// away from every other, recombined cluster-wise when a worker's own escape has stopped paying.
  int poolSize = 8;
  double poolMinDist = 0.01;
  /// Cluster-wise crossover between pool members. **Off by default, and measured**: n = 12 800,
  /// 180 s, six seeds, mean soft 20.2 without it and 23.3 with it, worse on five of the six. It is
  /// the same finding as `costAwareSelection` and `useCloseWindow` — the draws it takes come out of
  /// the kick, which is where the improvement was coming from — with an additional reason of its
  /// own: with two workers that adopt one another's elites, the pool holds two timetables in the
  /// same basin, and a child of two near-identical parents is a repair bill with no new material in
  /// it. Worth re-measuring on many cores, or alongside `restartAfter`, where the pool is genuinely
  /// diverse. `--recombine` turns it on.
  bool useRecombine = false;
  double recombineRate = 0.35;
  /// Moves without a new incumbent before a worker abandons its basin and constructs a new
  /// timetable from scratch. 0 disables it. At 30 s it never fires; at an hour it is most of the
  /// algorithm. See `Worker::restartFresh`.
  int64_t restartAfter = 1200000;

  // Room scanning
  int roomSample = 96;
  int roomScanFullBelow = 256;

  bool keepExisting = false;         // only schedule what has no placement yet
  int logEveryMs = 250;
  bool cooperate = true;             // share elites between workers
  bool verbose = false;

  /// Called from a worker thread every `logEveryMs` with the state of the search. The desktop
  /// application draws its progress from this; the headless runner ignores it.
  std::function<void(const struct TrajectoryPoint&)> onProgress;
  /// Polled between candidates. Setting it ends every worker at its next check and the run returns
  /// the best schedule found so far — «Зупинити й показати результат», not «скасувати».
  std::atomic<bool>* stopFlag = nullptr;
};

struct TrajectoryPoint {
  double seconds = 0;
  int worker = 0;
  int64_t moves = 0;
  int64_t hard = 0;
  double objective = 0;
  double surrogate = 0;
  int64_t lecConflicts = 0, grpConflicts = 0, roomConflicts = 0;
  int64_t grpTravel = 0, lecTravel = 0, absOverflow = 0;
  int64_t lecWindows = 0, grpWindows = 0, mixedDays = 0;
  int64_t soft = 0;
  std::string phase;
};

struct OperatorReport {
  std::string name;
  int64_t uses = 0;
  int64_t accepted = 0;
  int64_t improved = 0;
  double seconds = 0;
  double gain = 0;   // total surrogate reduction credited to this operator
};

struct WorkerReport {
  int worker = 0;
  int64_t moves = 0;
  int64_t hard = 0;
  double objective = 0;
  int64_t perturbations = 0;
  int64_t deepPhases = 0;
  int64_t ilsCycles = 0;
  int64_t recombinations = 0;
  int64_t restarts = 0;
  int64_t adoptions = 0;
  std::vector<OperatorReport> operators;
};

struct SearchResult {
  std::vector<Gene> best;
  Counters counters;
  int64_t hard = 0;
  int64_t soft = 0;
  double objective = 0;
  int64_t moves = 0;
  int bestWorker = 0;
  double constructSeconds = 0;
  double totalSeconds = 0;
  int placed = 0;
  int unplaced = 0;
  std::vector<TrajectoryPoint> trajectory;
  std::vector<WorkerReport> workers;

  Json summary() const;
};

SearchResult solve(const Problem& p, const SearchOptions& opts);

/// Writes the run's trajectory: `.csv` for a spreadsheet, anything else as JSON Lines. Both carry
/// every Π term at every sample, which is what an ablation table is built from.
void writeTrajectory(const std::string& path, const SearchResult& r);

}  // namespace tg
