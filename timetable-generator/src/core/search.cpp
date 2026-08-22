// The search.
//
// Shape of it, in one paragraph. A greedy most-constrained-first construction produces a starting
// schedule; after that the run is one stochastic local search per worker, under a late-acceptance
// (or annealing) rule, drawing each candidate from a portfolio of seven neighbourhoods whose
// selection probabilities are adapted at runtime by reward per unit of work. Three of the seven are
// large: a ruin-and-recreate over a set chosen by one of five selectors (random, related,
// entity-day, cluster, worst-window), an exact-relaxation permutation search over up to `koptK`
// classes at once, and an ejection chain. When the incumbent stops moving the search *escalates*
// rather than merely kicking: it runs a deep phase on the cluster contributing most to the
// objective, with a growing permutation width, and perturbs only when that too comes back empty.
//
// Why this and not the shipped TypeScript loop. That one converges: TIMETABLE-GENERATION.md §8
// records n = 12 800 reaching soft 438 at 300 s and the identical 438 at 540 s, with 22.8 million
// moves in between buying nothing at all. An hour-long budget is worth having only if the search
// still has somewhere to go at minute fifty, and single-class moves under late acceptance do not.
// The large neighbourhoods and the escalation are what that hour is for.
#include "search.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <array>
#include <cmath>
#include <cstdio>
#include <functional>
#include <fstream>
#include <memory>
#include <mutex>
#include <numeric>
#include <thread>

#include "hungarian.hpp"
#include "rng.hpp"

namespace tg {
namespace {

using Clock = std::chrono::steady_clock;

// A clash is priced far above any comfort term inside the *scan* heuristics, so a placement that
// double-books somebody is never preferred to one that merely leaves a gap. This is a scan-ordering
// constant, not the acceptance test's `hardWeight`, which is finite on purpose (§5.5).
constexpr double kClashBig = 1e9;
constexpr double kTravelBig = 1e7;
constexpr double kImpossible = 1e15;

enum Op : int { kOpMove = 0, kOpSwap, kOpChain, kOpKempe, kOpRuin, kOpKopt, kOpRepack, kOpDayRepack,
                kOpCloseWindow, kOpCount };
const char* const kOpNames[kOpCount] = {"move", "swap", "chain", "kempe", "ruin", "kopt", "repack",
                                       "dayfix", "winfix"};

enum RuinSelector : int { kRuinRandom = 0, kRuinRelated, kRuinEntityDay, kRuinCluster, kRuinWorstWindow, kRuinCount };

/// Read-only work shared by every worker, plus the elite the workers cooperate through.
struct Shared {
  const Problem* p = nullptr;
  SearchOptions o;
  Clock::time_point started;
  Clock::time_point deadline;

  // Communities of the class conflict graph: classes that share a lecturer or a group, grouped so
  // that a large neighbourhood can be aimed at a part of the timetable that actually interacts.
  std::vector<int> clusterOf;
  std::vector<std::vector<int>> clusters;

  std::mutex mu;
  bool haveBest = false;
  int64_t bestUnplaced = 0;
  int64_t bestHard = 0;
  double bestObjective = 0;
  std::vector<Spot> bestSpots;
  int bestWorker = 0;
  std::vector<TrajectoryPoint> trajectory;

  /// The population. One shared best is enough to make workers converge on each other; it is not
  /// enough to recombine, and recombination is the one mechanism that can produce a timetable
  /// neither parent was ever going to reach by local search. Kept small, sorted, and deliberately
  /// *diverse*: an entry that is nearly a copy of one already held is refused, because a pool of
  /// eight near-identical timetables is a pool of one.
  struct Elite {
    std::vector<Spot> spots;
    int64_t unplaced = 0;
    int64_t hard = 0;
    double objective = 0;
  };

  /// The order every "is this better" test in the search uses: fewest classes left unplaced, then
  /// fewest hard violations, then the objective.
  static bool better(int64_t un, int64_t hard, double obj,
                     int64_t un2, int64_t hard2, double obj2) {
    if (un != un2) return un < un2;
    if (hard != hard2) return hard < hard2;
    return obj < obj2;
  }
  std::vector<Elite> pool;

  /// How many classes two timetables place differently.
  static int64_t distance(const std::vector<Spot>& a, const std::vector<Spot>& b) {
    int64_t d = 0;
    const size_t n = std::min(a.size(), b.size());
    for (size_t i = 0; i < n; ++i) {
      if (a[i].day != b[i].day || a[i].timeIdx != b[i].timeIdx || a[i].room != b[i].room ||
          a[i].parity != b[i].parity) {
        ++d;
      }
    }
    return d;
  }

  /// Offer a timetable to the pool. Caller must hold `mu`.
  void offer(int64_t unplaced, int64_t hard, double objective, const std::vector<Spot>& spots,
             int cap, int64_t minDist) {
    for (auto& e : pool) {
      if (distance(e.spots, spots) < minDist) {
        // Same basin. Keep whichever is better and leave the pool's diversity alone.
        if (better(unplaced, hard, objective, e.unplaced, e.hard, e.objective)) {
          e = Elite{spots, unplaced, hard, objective};
        }
        return;
      }
    }
    if (static_cast<int>(pool.size()) < cap) {
      pool.push_back(Elite{spots, unplaced, hard, objective});
      return;
    }
    size_t worst = 0;
    for (size_t i = 1; i < pool.size(); ++i) {
      if (better(pool[worst].unplaced, pool[worst].hard, pool[worst].objective,
                 pool[i].unplaced, pool[i].hard, pool[i].objective)) {
        worst = i;
      }
    }
    if (better(unplaced, hard, objective, pool[worst].unplaced, pool[worst].hard,
               pool[worst].objective)) {
      pool[worst] = Elite{spots, unplaced, hard, objective};
    }
  }
};

/// Label propagation on the bipartite class ↔ entity graph. Cheap, and it produces what the deep
/// phase needs: groups of classes that genuinely contend with one another, rather than an arbitrary
/// partition of the index space. A class may of course be reachable from several groups; what is
/// wanted is a partition to *aim* at, not a decomposition to solve independently.
void buildClusters(const Problem& p, Shared& sh) {
  const int V = static_cast<int>(p.genes.size());
  sh.clusterOf.assign(static_cast<size_t>(V), -1);
  if (p.movable.empty()) return;

  const int nEnt = p.nLecturers + p.nGroups;
  std::vector<int> labelC(static_cast<size_t>(V), -1);
  std::vector<int> labelE(static_cast<size_t>(std::max(1, nEnt)), -1);
  std::vector<std::vector<int>> entClasses(static_cast<size_t>(std::max(1, nEnt)));
  for (int i : p.movable) {
    const Gene& g = p.genes[static_cast<size_t>(i)];
    for (int k = 0; k < g.lecCount; ++k) {
      entClasses[static_cast<size_t>(p.lecPool[static_cast<size_t>(g.lecFrom + k)])].push_back(i);
    }
    for (int k = 0; k < g.grpCount; ++k) {
      entClasses[static_cast<size_t>(p.nLecturers + p.grpPool[static_cast<size_t>(g.grpFrom + k)])].push_back(i);
    }
  }
  for (size_t k = 0; k < p.movable.size(); ++k) labelC[static_cast<size_t>(p.movable[k])] = static_cast<int>(k);

  std::vector<int> tally;
  const auto plurality = [&tally]() {
    std::sort(tally.begin(), tally.end());
    int best = tally.empty() ? -1 : tally[0];
    int bestN = 0, cur = best, n = 0;
    for (int v : tally) {
      if (v == cur) { ++n; } else { if (n > bestN) { bestN = n; best = cur; } cur = v; n = 1; }
    }
    if (n > bestN) best = cur;
    return best;
  };

  for (int round = 0; round < 6; ++round) {
    for (int e = 0; e < nEnt; ++e) {
      const auto& cs = entClasses[static_cast<size_t>(e)];
      if (cs.empty()) continue;
      tally.clear();
      for (int c : cs) tally.push_back(labelC[static_cast<size_t>(c)]);
      labelE[static_cast<size_t>(e)] = plurality();
    }
    for (int i : p.movable) {
      const Gene& g = p.genes[static_cast<size_t>(i)];
      tally.clear();
      for (int k = 0; k < g.lecCount; ++k) tally.push_back(labelE[static_cast<size_t>(p.lecPool[static_cast<size_t>(g.lecFrom + k)])]);
      for (int k = 0; k < g.grpCount; ++k) tally.push_back(labelE[static_cast<size_t>(p.nLecturers + p.grpPool[static_cast<size_t>(g.grpFrom + k)])]);
      if (tally.empty()) continue;
      labelC[static_cast<size_t>(i)] = plurality();
    }
  }

  std::vector<int> remap(static_cast<size_t>(std::max(1, V)), -1);
  for (int i : p.movable) {
    const int lab = labelC[static_cast<size_t>(i)];
    if (lab < 0 || lab >= V) continue;
    if (remap[static_cast<size_t>(lab)] < 0) {
      remap[static_cast<size_t>(lab)] = static_cast<int>(sh.clusters.size());
      sh.clusters.emplace_back();
    }
    const int cid = remap[static_cast<size_t>(lab)];
    sh.clusterOf[static_cast<size_t>(i)] = cid;
    sh.clusters[static_cast<size_t>(cid)].push_back(i);
  }
}

class Worker {
 public:
  Worker(Shared& sh, int id)
      : sh_(sh), p_(*sh.p), o_(sh.o), id_(id), st_(*sh.p),
        rng_(sh.o.seed + static_cast<uint64_t>(id) * 7919ULL) {
    ops_.resize(kOpCount);
    for (int k = 0; k < kOpCount; ++k) {
      ops_[static_cast<size_t>(k)].name = kOpNames[k];
      weight_[k] = 1.0;
      // Seeded rather than zero, so the first segment does not divide by an unmeasured cost. The
      // true figures arrive within one segment.
      avgWork_[k] = 16.0;
    }
    if (!o_.useKempe) weight_[kOpKempe] = 0;
    if (!o_.useLns) weight_[kOpRuin] = 0;
    if (!o_.useKopt) weight_[kOpKopt] = 0;
    if (!o_.useRepack) weight_[kOpRepack] = 0;
    if (!o_.useDayRepack) weight_[kOpDayRepack] = 0;
    if (!o_.useCloseWindow) weight_[kOpCloseWindow] = 0;
    if (o_.chainRate <= 0) weight_[kOpChain] = 0;
    // The two cheap operators start heavier: they are what most of a run is made of, and the
    // bandit needs a few thousand samples before its estimate of a large neighbourhood is worth
    // anything.
    weight_[kOpMove] = 4;
    weight_[kOpSwap] = 4 * (o_.swapRate > 0 ? 1.0 : 0.0);
    useSa_ = o_.engine == "sa" || (o_.engine == "mixed" && (id % 2) == 1);
    useDlas_ = o_.engine == "dlas";
  }

  void run();
  const WorkerReport& report() const { return rep_; }
  const std::vector<Spot>& best() const { return bestSpots_; }
  int64_t bestUnplaced() const { return bestUnplaced_; }
  int64_t bestHard() const { return bestHard_; }
  double bestObjective() const { return bestObjective_; }

 private:
  // ── construction ─────────────────────────────────────────────────────────
  void construct();
  bool scanBest(int i, bool wide, int& outSlot, int& outRoom, double& outScore);

  // ── candidate application ────────────────────────────────────────────────
  void beginCandidate() { jr_.clear(); workAtStart_ = st_.work(); }
  void moveTo(int i, int day, int ti, int par, int room) {
    jr_.emplace_back(i, st_.spotOf(i));
    st_.placeRaw(i, day, ti, par, room);
  }
  void settle() { st_.flush(); }
  void undo() {
    for (auto it = jr_.rbegin(); it != jr_.rend(); ++it) st_.placeRaw(it->first, it->second);
    st_.flush();
    jr_.clear();
  }

  double cost() const {
    return static_cast<double>(st_.hard()) * hardWeight_ + st_.surrogate() +
           static_cast<double>(st_.unplacedMovable()) * hardWeight_ * 8.0;
  }
  bool acceptTest(double c);
  bool noteIncumbent();

  // ── operators ────────────────────────────────────────────────────────────
  bool opMove();
  bool opSwap();
  bool opChain();
  bool opKempe();
  bool opRuin();
  bool opKopt();
  bool opRepack();
  bool opDayRepack();
  bool opCloseWindow();

  // ── escalation and bookkeeping ───────────────────────────────────────────
  bool deepPhase();
  void perturb();
  /// Break `size` classes out of the current timetable in related sets and greedily repair them.
  /// Returns how many were actually broken.
  int kick(int size);
  void kickFromBest();
  bool recombine();
  void restartFresh();
  bool repairAfterGraft(const std::vector<int>& grafted);
  bool ilsCycle();
  void ilsLoop();
  int pickOperator();
  bool applyOperator(int op);
  void refreshLists();
  void publish(const char* phase);
  void adoptElite();

  int pickGene();
  bool randomSpot(int i, int& day, int& ti, int& par, int& room);
  /// Whether every one of these genes is *currently* sitting somewhere the hard rules allow.
  ///
  /// `MAX_CLASSES_PER_DAY` is the one hard rule that is a property of a set rather than of a
  /// placement: each of k classes can pass the check on its own, against a day that does not yet
  /// hold the other k−1, and the k together can still break the cap. Every operator that moves more
  /// than one class at a time therefore has to ask again once they are all down.
  bool allLegal(const std::vector<int>& members) const;
  bool hasSlot(const Gene& g, int slot) const;
  bool hasRoom(const Gene& g, int room) const;
  void selectVictims(int selector, int size, std::vector<int>& out);
  bool recreate(const std::vector<int>& victims);
  bool permute(const std::vector<int>& members);
  bool refinePairs(const std::vector<int>& members, int rounds);

  Shared& sh_;
  const Problem& p_;
  const SearchOptions& o_;
  int id_;
  State st_;
  Rng rng_;

  bool useSa_ = false;
  bool useDlas_ = false;
  double hardWeight_ = 1e6;
  double acceptedCost_ = 0;
  std::vector<double> history_;
  double dlasMax_ = 0;
  double temperature_ = 1;
  double t0_ = 1;

  std::vector<Spot> bestSpots_;
  std::vector<Spot> anchorSpots_;
  std::vector<int> focus_;
  std::vector<Spot> parentSpots_;
  std::vector<int> grafted_;
  Counters bestCounters_;
  double bestSurrogate_ = 0;
  int64_t bestHard_ = 0;
  int64_t bestUnplaced_ = 0;
  double bestObjective_ = 0;
  bool haveBest_ = false;

  int64_t moves_ = 0;
  int64_t sinceBest_ = 0;
  /// Current kick strength, in classes, and whether the cycle since the last kick found anything.
  int kickSize_ = 0;
  bool gainSinceKick_ = false;
  /// The move at which the incumbent last improved. Unlike `sinceBest_` this is *not* reset by a
  /// kick, so it measures how long the search has really been stuck rather than how long since the
  /// last time something was tried about it.
  int64_t lastIncumbentMove_ = 0;
  int64_t adoptBlockUntil_ = 0;
  int64_t listAge_ = 0;
  std::vector<int> hot_;
  std::vector<int> warm_;

  std::vector<std::pair<int, Spot>> jr_;
  uint64_t workAtStart_ = 0;

  // The bandit allocates **budget**, not draws. `weight_` is an estimate of reward per unit of work;
  // `avgWork_` is what one candidate of that operator costs, in recomputed buckets. Selection is
  // proportional to weight/avgWork, so two operators with the same reward *rate* get the same share
  // of the search's time even when one of them costs a hundred times more per attempt.
  //
  // Selecting proportionally to `weight_` alone was measured and is wrong for exactly that reason: an
  // exhaustive day re-pack costs about 1 300 placements against a single move's 14, so a weight
  // pushed all the way down to the 0.05 floor still spent a third of the budget on it. What looks
  // like a floor on how often an operator is *tried* is really a floor on how much of the run it
  // *owns*.
  double weight_[kOpCount]{};
  double avgWork_[kOpCount]{};
  double segScore_[kOpCount]{};
  double segWork_[kOpCount]{};
  int64_t segUses_[kOpCount]{};
  int64_t segMoves_ = 0;

  WorkerReport rep_;
  std::vector<OperatorReport> ops_;

  std::vector<int> victims_, scratch_, members_;
  std::vector<size_t> worstBuckets_;
  std::vector<Spot> spotPool_;
  std::vector<double> costMatrix_;
  std::vector<int> assign_;
  Clock::time_point lastPublish_;
  int koptWidth_ = 8;
};

// ── construction ────────────────────────────────────────────────────────────

bool Worker::scanBest(int i, bool wide, int& outSlot, int& outRoom, double& outScore) {
  const Gene& g = st_.gene(i);
  if (g.slotCount == 0 || g.roomCount == 0) return false;
  const int* slots = p_.slotsOf(g);
  const int* rooms = p_.roomsOf(g);

  double best = kImpossible;
  int bestSlot = -1, bestRoom = -1;

  const int slotStart = rng_.belowI(g.slotCount);
  const int roomLimit = (wide || g.roomCount <= o_.roomScanFullBelow)
                            ? g.roomCount
                            : std::min(g.roomCount, o_.roomSample);
  for (int k = 0; k < g.slotCount; ++k) {
    const int s = slots[(slotStart + k) % g.slotCount];
    const int day = slotDay(s), ti = slotTime(s), par = slotParity(s);
    const Mask mask = p_.maskAt(ti, g.durSlot);
    const double peopleClash = static_cast<double>(st_.peopleClashesAt(i, day, mask, par)) * kClashBig;
    if (peopleClash >= best) continue;
    const double wcost = st_.windowCostOfAdding(i, day, par, mask);
    if (peopleClash + wcost >= best) continue;

    const int roomStart = rng_.belowI(g.roomCount);
    int travelBudget = 6;
    for (int m = 0; m < roomLimit; ++m) {
      const int r = rooms[(roomStart + m) % g.roomCount];
      if (!st_.placementAllowed(i, day, ti, par, r)) continue;
      double sc = peopleClash + static_cast<double>(st_.roomClashesAt(i, day, mask, par, r)) * kClashBig + wcost;
      if (sc >= best) continue;
      if (p_.travelKnown && travelBudget > 0) {
        --travelBudget;
        sc += static_cast<double>(st_.travelCostOfAdding(i, day, mask, par, r)) * kTravelBig;
        if (sc >= best) continue;
      }
      best = sc;
      bestSlot = s;
      bestRoom = r;
      if (best <= 0) { outSlot = bestSlot; outRoom = bestRoom; outScore = best; return true; }
    }
  }
  if (bestSlot < 0) return false;
  outSlot = bestSlot;
  outRoom = bestRoom;
  outScore = best;
  return true;
}

void Worker::construct() {
  std::vector<int> order = p_.movable;
  if (!o_.keepExisting) {
    for (int i : order) st_.placeRaw(i, -1, -1, st_.gene(i).parity, -1);
    st_.flush();
  }
  // Break ties at random rather than by index. The difficulty key is coarse — thousands of classes
  // share the same (slots × rooms) — so a fixed order makes every construction the same
  // construction, and a restart that lands where the last one did is not a restart. Shuffling first
  // and sorting *stably* keeps "most constrained first" while making the result genuinely different
  // each time.
  for (size_t i = order.size(); i > 1; --i) {
    std::swap(order[i - 1], order[static_cast<size_t>(rng_.belowI(static_cast<int>(i)))]);
  }
  // Most constrained first: the class with the fewest ways to be placed goes down while the
  // timetable is still empty enough to take it.
  std::stable_sort(order.begin(), order.end(), [this](int a, int b) {
    const Gene& ga = st_.gene(a);
    const Gene& gb = st_.gene(b);
    const int64_t da = static_cast<int64_t>(ga.slotCount) * ga.roomCount;
    const int64_t db = static_cast<int64_t>(gb.slotCount) * gb.roomCount;
    if (da != db) return da < db;
    return (ga.lecCount + ga.grpCount) > (gb.lecCount + gb.grpCount);
  });
  for (int i : order) {
    if (st_.gene(i).day >= 0) continue;  // already placed, and this run is keeping it
    int slot = -1, room = -1;
    double score = 0;
    if (!scanBest(i, /*wide=*/false, slot, room, score)) {
      if (!scanBest(i, /*wide=*/true, slot, room, score)) continue;
    }
    st_.place(i, slotDay(slot), slotTime(slot), slotParity(slot), room);
  }
}

// ── acceptance ──────────────────────────────────────────────────────────────

bool Worker::acceptTest(double c) {
  if (useSa_) {
    bool ok = c <= acceptedCost_;
    if (!ok) {
      const double d = c - acceptedCost_;
      ok = d < temperature_ * 40 && rng_.unit() < std::exp(-d / temperature_);
    }
    if (ok) acceptedCost_ = c;
    return ok;
  }
  if (useDlas_) {
    // Diversified late acceptance: the bar is the *maximum* of the history, replaced only when the
    // last copy of it leaves. Scale-invariant, and it degenerates to hill climbing far less often
    // than plain LAHC on a long run.
    const size_t idx = static_cast<size_t>(moves_) % history_.size();
    const double prev = acceptedCost_;
    const bool ok = c < prev || c <= dlasMax_;
    if (ok) acceptedCost_ = c;
    if (acceptedCost_ != history_[idx]) {
      const bool wasMax = history_[idx] >= dlasMax_ - 1e-12;
      if (acceptedCost_ > history_[idx]) {
        history_[idx] = acceptedCost_;
        if (acceptedCost_ > dlasMax_) dlasMax_ = acceptedCost_;
      } else {
        history_[idx] = acceptedCost_;
        if (wasMax) {
          dlasMax_ = *std::max_element(history_.begin(), history_.end());
        }
      }
    }
    return ok;
  }
  // Late acceptance hill climbing.
  const size_t idx = static_cast<size_t>(moves_) % history_.size();
  const bool ok = c <= history_[idx] || c <= acceptedCost_;
  if (ok) acceptedCost_ = c;
  // Burke and Bykov's rule writes the *current* cost into the slot, which can raise it again; the
  // variant that only ever lowers it makes the bar monotone, and a monotone bar is hill climbing
  // with extra steps — once every slot has collapsed to the incumbent's cost nothing worsening is
  // ever accepted again, and no amount of remaining time can help.
  if (o_.lahcCanonical || history_[idx] > acceptedCost_) history_[idx] = acceptedCost_;
  return ok;
}

bool Worker::noteIncumbent() {
  const int64_t h = st_.hard();
  const double obj = st_.objective();
  // A class that is not placed at all appears in none of the nine Π terms, so a timetable with a
  // class missing scores *better* than the same timetable with it placed. `cost()` knows this and
  // charges for it; the incumbent test has to as well, or a construction that could not place
  // everything — or a repair that gave up — becomes the answer the run returns.
  const int64_t un = st_.unplacedMovable();
  // Lexicographic, per TIMETABLE-GENERATION.md §1.3: fewer hard violations always wins the
  // incumbent, whatever it costs in comfort. Only the acceptance test prices them finitely.
  if (haveBest_ && !(un < bestUnplaced_ ||
                     (un == bestUnplaced_ &&
                      (h < bestHard_ || (h == bestHard_ && obj < bestObjective_))))) {
    return false;
  }
  haveBest_ = true;
  bestUnplaced_ = un;
  bestHard_ = h;
  bestObjective_ = obj;
  bestCounters_ = st_.counters();
  bestSurrogate_ = st_.surrogate();
  st_.snapshotInto(bestSpots_);
  lastIncumbentMove_ = moves_;
  gainSinceKick_ = true;
  return true;
}

// ── small helpers ───────────────────────────────────────────────────────────

bool Worker::hasSlot(const Gene& g, int slot) const {
  const int* a = p_.slotsOf(g);
  return std::binary_search(a, a + g.slotCount, slot);
}

bool Worker::hasRoom(const Gene& g, int room) const {
  if (g.roomCount == 1 && p_.roomsOf(g)[0] == room) return true;
  if (g.anyRoom) return room >= 0 && room < p_.nRooms && p_.isFacultyRoom[static_cast<size_t>(room)];
  const int* a = p_.roomsOf(g);
  return std::binary_search(a, a + g.roomCount, room);
}

int Worker::pickGene() {
  // "Keep everything already placed" on a fully-scheduled faculty leaves nothing movable at all.
  // That is a legitimate request with a legitimate answer — the timetable it already has — and not
  // an occasion to index an empty vector.
  if (p_.movable.empty()) return -1;
  // During an ILS descent the only part of the timetable that has changed is what the kick broke,
  // and everything else is still at a local optimum. Drawing uniformly there wastes the descent on
  // re-proposing moves that were already refused; drawing from the broken set is the repair.
  if (!focus_.empty() && rng_.chance(o_.ilsFocus)) {
    return focus_[static_cast<size_t>(rng_.belowI(static_cast<int>(focus_.size())))];
  }
  if (st_.hard() > 0 && !hot_.empty() && rng_.chance(o_.hotShare)) {
    return hot_[static_cast<size_t>(rng_.belowI(static_cast<int>(hot_.size())))];
  }
  if (st_.hard() == 0 && !warm_.empty() && rng_.chance(o_.hotShare)) {
    return warm_[static_cast<size_t>(rng_.belowI(static_cast<int>(warm_.size())))];
  }
  return p_.movable[static_cast<size_t>(rng_.belowI(static_cast<int>(p_.movable.size())))];
}

bool Worker::randomSpot(int i, int& day, int& ti, int& par, int& room) {
  const Gene& g = st_.gene(i);
  if (g.slotCount == 0 || g.roomCount == 0) return false;
  for (int attempt = 0; attempt < 4; ++attempt) {
    const int s = p_.slotsOf(g)[rng_.belowI(g.slotCount)];
    const int r = p_.roomsOf(g)[rng_.belowI(g.roomCount)];
    if (!st_.placementAllowed(i, slotDay(s), slotTime(s), slotParity(s), r)) continue;
    day = slotDay(s);
    ti = slotTime(s);
    par = slotParity(s);
    room = r;
    return true;
  }
  return false;
}

void Worker::refreshLists() {
  if (st_.hard() > 0) st_.collectHot(hot_);
  else hot_.clear();
  st_.collectWarm(warm_);
  // A full pass over every (entity, day) — 30 000 buckets at n = 12 800 — so it is amortised over
  // the refresh interval exactly as the hot list is, and never paid per candidate.
  st_.worstWindowBuckets(worstBuckets_, 256);
  listAge_ = 0;
}

// ── operators ───────────────────────────────────────────────────────────────

bool Worker::opMove() {
  const int i = pickGene();
  if (i < 0) return false;
  int day, ti, par, room;
  if (!randomSpot(i, day, ti, par, room)) return false;
  const Gene& g = st_.gene(i);
  if (g.day == day && g.timeIdx == ti && g.parity == par && g.room == room) return false;
  beginCandidate();
  moveTo(i, day, ti, par, room);
  settle();
  return true;
}

bool Worker::opSwap() {
  const int i = pickGene();
  if (i < 0) return false;
  const Gene& gi = st_.gene(i);
  if (gi.slotCount == 0 || gi.roomCount == 0) return false;
  const int s = p_.slotsOf(gi)[rng_.belowI(gi.slotCount)];
  const int r = p_.roomsOf(gi)[rng_.belowI(gi.roomCount)];
  // A class in no room has nobody to trade a room with; those move by reassignment alone, and are
  // also the classes least in need of a swap since neither contests a room.
  if (r < 0) return false;
  const int day = slotDay(s), ti = slotTime(s), par = slotParity(s);
  const Mask mask = p_.maskAt(ti, gi.durSlot);
  const int j = st_.occupantOf(i, day, mask, par, r);
  if (j < 0) {
    if (!st_.placementAllowed(i, day, ti, par, r)) return false;
    if (gi.day == day && gi.timeIdx == ti && gi.parity == par && gi.room == r) return false;
    beginCandidate();
    moveTo(i, day, ti, par, r);
    settle();
    return true;
  }
  const Gene& gj = st_.gene(j);
  if (gi.day < 0 || gj.day < 0) return false;
  const int iSlot = packSlot(gi.day, gi.timeIdx, gi.parity);
  if (!hasSlot(gj, iSlot) || !hasRoom(gj, gi.room)) return false;
  const Spot iOld = st_.spotOf(i);
  beginCandidate();
  moveTo(i, day, ti, par, r);
  moveTo(j, iOld.day, iOld.timeIdx, iOld.parity, iOld.room);
  settle();
  // MAX_CLASSES_PER_DAY is the one hard rule the domains do not carry, and a swap can break it
  // even though neither placement is new — so both halves are re-checked afterwards.
  if (!st_.placementAllowed(i, day, ti, par, r) ||
      !st_.placementAllowed(j, iOld.day, iOld.timeIdx, iOld.parity, iOld.room)) {
    undo();
    return false;
  }
  return true;
}

bool Worker::opChain() {
  const int i = pickGene();
  if (i < 0) return false;
  int day, ti, par, room;
  if (!randomSpot(i, day, ti, par, room)) return false;
  beginCandidate();
  moveTo(i, day, ti, par, room);
  settle();
  int last = i;
  const int depth = 1 + rng_.belowI(std::max(1, o_.chainDepth));
  for (int d = 0; d < depth; ++d) {
    const Gene& gl = st_.gene(last);
    if (gl.day < 0) break;
    // Whoever is now double-booked with the last link gets re-placed where *it* would choose to go,
    // rather than being forced into the slot the mover vacated. That is the whole difference from a
    // swap, and it reaches rearrangements every intermediate state of which is worse than both ends.
    int victim = -1;
    const Mask m = gl.mask;
    for (int k = 0; k < gl.lecCount && victim < 0; ++k) {
      const int l = p_.lecPool[static_cast<size_t>(gl.lecFrom + k)];
      for (int32_t q : st_.lecBucket(l, gl.day)) {
        if (q == last) continue;
        const Gene& gq = st_.gene(q);
        if (gq.movable && weeksOverlap(gl.parity, gq.parity) && m.intersects(gq.mask)) { victim = q; break; }
      }
    }
    for (int k = 0; k < gl.grpCount && victim < 0; ++k) {
      const int gr = p_.grpPool[static_cast<size_t>(gl.grpFrom + k)];
      for (int32_t q : st_.grpBucket(gr, gl.day)) {
        if (q == last) continue;
        const Gene& gq = st_.gene(q);
        if (gq.movable && weeksOverlap(gl.parity, gq.parity) && m.intersects(gq.mask)) { victim = q; break; }
      }
    }
    if (victim < 0 && gl.room >= 0) {
      victim = st_.occupantOf(last, gl.day, m, gl.parity, gl.room);
    }
    if (victim < 0) break;
    int vs = -1, vr = -1;
    double sc = 0;
    if (!scanBest(victim, /*wide=*/false, vs, vr, sc)) break;
    moveTo(victim, slotDay(vs), slotTime(vs), slotParity(vs), vr);
    settle();
    last = victim;
  }
  return !jr_.empty();
}

bool Worker::opKempe() {
  // A local Kempe chain: pick a class and a target timeslot, then move the whole alternating set of
  // classes that block one another between the two slots. Restricted to the moved class's own
  // entities, which is where the interference is and keeps the component small.
  const int i = pickGene();
  if (i < 0) return false;
  const Gene& gi = st_.gene(i);
  if (gi.day < 0 || gi.slotCount == 0) return false;
  const int target = p_.slotsOf(gi)[rng_.belowI(gi.slotCount)];
  const int fromSlot = packSlot(gi.day, gi.timeIdx, gi.parity);
  if (target == fromSlot) return false;
  const int tDay = slotDay(target), tTi = slotTime(target), tPar = slotParity(target);

  members_.clear();
  scratch_.clear();
  members_.push_back(i);
  scratch_.push_back(0);  // side: 0 = goes to target, 1 = comes back
  const Mask tMask = p_.maskAt(tTi, gi.durSlot);

  for (size_t head = 0; head < members_.size() && members_.size() < 12; ++head) {
    const int x = members_[head];
    const int side = scratch_[head];
    const int dDay = side == 0 ? tDay : slotDay(fromSlot);
    const int dTi = side == 0 ? tTi : slotTime(fromSlot);
    const int dPar = side == 0 ? tPar : slotParity(fromSlot);
    const Gene& gx = st_.gene(x);
    const Mask dMask = p_.maskAt(dTi, gx.durSlot);
    (void)tMask;
    const auto consider = [&](int q) {
      if (q == x) return;
      if (std::find(members_.begin(), members_.end(), q) != members_.end()) return;
      const Gene& gq = st_.gene(q);
      if (!gq.movable) return;
      if (!weeksOverlap(static_cast<uint8_t>(dPar), gq.parity)) return;
      if (!dMask.intersects(gq.mask)) return;
      members_.push_back(q);
      scratch_.push_back(side == 0 ? 1 : 0);
    };
    for (int k = 0; k < gx.lecCount; ++k) {
      for (int32_t q : st_.lecBucket(p_.lecPool[static_cast<size_t>(gx.lecFrom + k)], dDay)) consider(q);
    }
    for (int k = 0; k < gx.grpCount; ++k) {
      for (int32_t q : st_.grpBucket(p_.grpPool[static_cast<size_t>(gx.grpFrom + k)], dDay)) consider(q);
    }
  }
  if (members_.size() < 2) return false;

  // Every member has to be able to take the slot it is being sent to.
  for (size_t k = 0; k < members_.size(); ++k) {
    const Gene& gm = st_.gene(members_[k]);
    const int want = scratch_[k] == 0 ? target : fromSlot;
    if (!hasSlot(gm, want)) return false;
  }
  beginCandidate();
  for (size_t k = 0; k < members_.size(); ++k) {
    const int m = members_[k];
    const int want = scratch_[k] == 0 ? target : fromSlot;
    moveTo(m, slotDay(want), slotTime(want), slotParity(want), st_.gene(m).room);
  }
  settle();
  for (size_t k = 0; k < members_.size(); ++k) {
    const Gene& gm = st_.gene(members_[k]);
    if (!st_.placementAllowed(members_[k], gm.day, gm.timeIdx, gm.parity, gm.room)) {
      undo();
      return false;
    }
  }
  return true;
}

void Worker::selectVictims(int selector, int size, std::vector<int>& out) {
  out.clear();
  if (p_.movable.empty()) return;
  switch (selector) {
    case kRuinRandom: {
      for (int k = 0; k < size; ++k) {
        out.push_back(p_.movable[static_cast<size_t>(rng_.belowI(static_cast<int>(p_.movable.size())))]);
      }
      break;
    }
    case kRuinRelated: {
      // Shaw-style: a seed, then everything sharing a lecturer or a group with it. Removing a
      // related set is what lets the recreate find a different arrangement rather than putting
      // each class back where it was.
      const int seed = pickGene();
      if (seed < 0) break;
      out.push_back(seed);
      const Gene& gs = st_.gene(seed);
      for (int k = 0; k < gs.lecCount && static_cast<int>(out.size()) < size; ++k) {
        const int l = p_.lecPool[static_cast<size_t>(gs.lecFrom + k)];
        for (int d : p_.days) {
          for (int32_t q : st_.lecBucket(l, d)) {
            if (st_.gene(q).movable && static_cast<int>(out.size()) < size) out.push_back(q);
          }
        }
      }
      for (int k = 0; k < gs.grpCount && static_cast<int>(out.size()) < size; ++k) {
        const int gr = p_.grpPool[static_cast<size_t>(gs.grpFrom + k)];
        for (int d : p_.days) {
          for (int32_t q : st_.grpBucket(gr, d)) {
            if (st_.gene(q).movable && static_cast<int>(out.size()) < size) out.push_back(q);
          }
        }
      }
      break;
    }
    case kRuinEntityDay: {
      const int seed = pickGene();
      if (seed < 0) break;
      const Gene& gs = st_.gene(seed);
      if (gs.day < 0) { out.push_back(seed); break; }
      const bool useGroup = gs.grpCount > 0 && (gs.lecCount == 0 || rng_.chance(0.5));
      if (useGroup) {
        const int gr = p_.grpPool[static_cast<size_t>(gs.grpFrom + rng_.belowI(gs.grpCount))];
        for (int32_t q : st_.grpBucket(gr, gs.day)) if (st_.gene(q).movable) out.push_back(q);
      } else if (gs.lecCount > 0) {
        const int l = p_.lecPool[static_cast<size_t>(gs.lecFrom + rng_.belowI(gs.lecCount))];
        for (int32_t q : st_.lecBucket(l, gs.day)) if (st_.gene(q).movable) out.push_back(q);
      }
      break;
    }
    case kRuinCluster: {
      if (sh_.clusters.empty() || p_.movable.empty()) break;
      const int seed = pickGene();
      int cid = sh_.clusterOf[static_cast<size_t>(seed)];
      if (cid < 0) cid = rng_.belowI(static_cast<int>(sh_.clusters.size()));
      const auto& c = sh_.clusters[static_cast<size_t>(cid)];
      if (c.empty()) break;
      if (static_cast<int>(c.size()) <= size) {
        out = c;
      } else {
        const int start = rng_.belowI(static_cast<int>(c.size()));
        for (int k = 0; k < size; ++k) out.push_back(c[static_cast<size_t>((start + k) % static_cast<int>(c.size()))]);
      }
      break;
    }
    case kRuinWorstWindow:
    default: {
      if (worstBuckets_.empty()) { const int g = pickGene(); if (g >= 0) out.push_back(g); break; }
      const size_t bid = worstBuckets_[static_cast<size_t>(rng_.belowI(static_cast<int>(worstBuckets_.size())))];
      st_.bucketMembers(bid, out);
      break;
    }
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  if (static_cast<int>(out.size()) > size) {
    for (int k = static_cast<int>(out.size()) - 1; k > 0; --k) std::swap(out[static_cast<size_t>(k)], out[static_cast<size_t>(rng_.belowI(k + 1))]);
    out.resize(static_cast<size_t>(size));
  }
}

bool Worker::allLegal(const std::vector<int>& members) const {
  for (int i : members) {
    const Gene& g = st_.gene(i);
    if (g.day < 0 || g.timeIdx < 0) return false;
    if (!st_.placementAllowed(i, g.day, g.timeIdx, g.parity, g.room)) return false;
  }
  return true;
}

bool Worker::recreate(const std::vector<int>& victims) {
  scratch_ = victims;
  for (int k = static_cast<int>(scratch_.size()) - 1; k > 0; --k) {
    std::swap(scratch_[static_cast<size_t>(k)], scratch_[static_cast<size_t>(rng_.belowI(k + 1))]);
  }
  bool all = true;
  for (int v : scratch_) {
    int s = -1, r = -1;
    double sc = 0;
    if (!scanBest(v, /*wide=*/false, s, r, sc) && !scanBest(v, /*wide=*/true, s, r, sc)) {
      // Nothing admissible is left for it now that the others are back. Put it where it was: a
      // class the recreate could not fit must not be silently dropped, because f(σ) does not
      // charge for a missing class and the search would learn to empty the timetable.
      all = false;
      for (auto it = jr_.rbegin(); it != jr_.rend(); ++it) {
        if (it->first == v) { st_.placeRaw(v, it->second); break; }
      }
      st_.flush();
      continue;
    }
    st_.placeRaw(v, slotDay(s), slotTime(s), slotParity(s), r);
    st_.flush();
  }
  return all;
}

bool Worker::opRuin() {
  const int selector = rng_.belowI(kRuinCount);
  const int size = o_.lnsMin + rng_.belowI(std::max(1, o_.lnsMax - o_.lnsMin + 1));
  selectVictims(selector, size, victims_);
  if (victims_.size() < 2) return false;
  beginCandidate();
  for (int v : victims_) moveTo(v, -1, -1, st_.gene(v).parity, -1);
  settle();
  recreate(victims_);
  settle();
  if (!allLegal(victims_)) { undo(); return false; }
  return true;
}

bool Worker::opRepack() {
  selectVictims(kRuinEntityDay, 16, victims_);
  if (victims_.size() < 2) return false;
  beginCandidate();
  for (int v : victims_) moveTo(v, -1, -1, st_.gene(v).parity, -1);
  settle();
  recreate(victims_);
  settle();
  if (!allLegal(victims_)) { undo(); return false; }
  refinePairs(victims_, 2);
  return true;
}

/// The move that closes a gap, proposed on purpose.
///
/// Every other neighbourhood here draws a placement and asks the objective what it thinks. This one
/// works backwards from the defect: take an (entity, day) that has a вікно, read the idle bell starts
/// straight off the occupancy mask, and try to pull a class from the far side of one of them into it.
/// That is the only kind of move that can close a gap — a gap is closed by moving the block on one
/// side of it across, and nothing else — so proposing it directly is worth roughly the ratio of the
/// day's slots to its holes over drawing at random.
///
/// It is the min-conflicts idea applied to the soft terms. TIMETABLE-GENERATION.md §5.7 argues it for
/// the hard ones: at n = 31 000 a uniformly drawn class is one of the guilty parties about 0.03 % of
/// the time, so the entire remaining budget goes on polishing what is already correct. The residual
/// here is twenty windows among twelve thousand classes, which is the same arithmetic.
bool Worker::opCloseWindow() {
  if (worstBuckets_.empty()) return false;
  const size_t bid = worstBuckets_[static_cast<size_t>(rng_.belowI(static_cast<int>(worstBuckets_.size())))];
  const int day = State::bucketDay(bid);
  const int week = rng_.chance(0.5) ? 1 : 2;
  Mask holes = st_.holesOf(bid, week);
  if (holes.empty()) {
    holes = st_.holesOf(bid, week == 1 ? 2 : 1);
    if (holes.empty()) return false;
  }
  // One hole, chosen among them.
  const int nHoles = holes.popcount();
  int wanted = rng_.belowI(nHoles);
  int holeTick = -1;
  for (int b = holes.lowest(); b <= holes.highest(); ++b) {
    if (!holes.testBit(b)) continue;
    if (wanted-- == 0) { holeTick = b; break; }
  }
  if (holeTick < 0) return false;
  const int holeMinute = p_.ticks[static_cast<size_t>(holeTick)];

  st_.bucketMembers(bid, members_);
  if (members_.empty()) return false;
  // Prefer a class on the far side of the hole: pulling it in is what shortens the span. Ties and
  // the wrong side are allowed through — the acceptance test is the judge, and a class moved from
  // before the hole can still help by closing up behind it.
  scratch_.clear();
  for (int m : members_) {
    const Gene& g = st_.gene(m);
    if (g.start > holeMinute) scratch_.push_back(m);
  }
  if (scratch_.empty()) scratch_ = members_;
  const int i = scratch_[static_cast<size_t>(rng_.belowI(static_cast<int>(scratch_.size())))];
  const Gene& g = st_.gene(i);
  if (g.day < 0 || g.slotCount == 0) return false;

  // The slot whose start is exactly that idle bell, on that day, in that class's own domain.
  const int* slots = p_.slotsOf(g);
  int chosen = -1;
  const int start = rng_.belowI(g.slotCount);
  for (int q = 0; q < g.slotCount; ++q) {
    const int sl = slots[(start + q) % g.slotCount];
    if (slotDay(sl) != day) continue;
    if (p_.times[static_cast<size_t>(slotTime(sl))].startMinutes != holeMinute) continue;
    chosen = sl;
    break;
  }
  if (chosen < 0) return false;
  const int ti = slotTime(chosen), par = slotParity(chosen);
  const Mask mask = p_.maskAt(ti, g.durSlot);

  // A room for it: the first admissible one that is free, else give up rather than trade a window
  // for a room clash.
  const int* rooms = p_.roomsOf(g);
  const int limit = std::min(g.roomCount, o_.roomSample);
  const int rstart = rng_.belowI(std::max(1, g.roomCount));
  int room = -2;
  for (int r = 0; r < limit; ++r) {
    const int cand = rooms[(rstart + r) % g.roomCount];
    if (!st_.placementAllowed(i, day, ti, par, cand)) continue;
    if (st_.roomClashesAt(i, day, mask, par, cand) == 0) { room = cand; break; }
    if (room == -2) room = cand;
  }
  if (room == -2) return false;
  if (g.timeIdx == ti && g.parity == par && g.room == room) return false;

  beginCandidate();
  moveTo(i, day, ti, par, room);
  settle();
  return true;
}

/// Exhaustive re-pack of one (entity, day).
///
/// The soft objective is separable over (entity, day, week): a day with a вікно in it is a day whose
/// classes could have been packed into an interval and were not, and the only reason they were not
/// is contention from the *other* entities each class touches. So the right repair is to lift that
/// day's classes out and try every arrangement of them within the day — which is small enough to
/// enumerate exactly, unlike almost everything else in this problem.
///
/// A few classes and a few bells: at k = 3 with six candidate placements each that is 216 leaves,
/// every one evaluated under the *true* objective rather than a surrogate, which is what makes this
/// different from the ruin-and-recreate that also visits this set. Greedy re-insertion has to commit
/// to the first class's placement before it has seen the second's options; this does not.
bool Worker::opDayRepack() {
  if (worstBuckets_.empty()) return false;
  const size_t bid = worstBuckets_[static_cast<size_t>(rng_.belowI(static_cast<int>(worstBuckets_.size())))];
  const int day = State::bucketDay(bid);
  st_.bucketMembers(bid, members_);
  if (members_.size() < 2) return false;
  for (int k = static_cast<int>(members_.size()) - 1; k > 0; --k) {
    std::swap(members_[static_cast<size_t>(k)], members_[static_cast<size_t>(rng_.belowI(k + 1))]);
  }
  const int k = std::min<int>(3, static_cast<int>(members_.size()));
  members_.resize(static_cast<size_t>(k));

  // Candidate placements for each member, on this day only, ranked by the cheap probe and cut to
  // the best few. Moving a class off the day entirely is what the other neighbourhoods are for.
  constexpr int kBranch = 6;
  std::array<std::array<std::pair<int, int>, kBranch>, 3> cands{};
  std::array<int, 3> nCand{};
  for (int m = 0; m < k; ++m) {
    const int i = members_[static_cast<size_t>(m)];
    const Gene& g = st_.gene(i);
    const int* slots = p_.slotsOf(g);
    std::vector<std::pair<double, std::pair<int, int>>> scored;
    for (int q = 0; q < g.slotCount; ++q) {
      const int s = slots[q];
      if (slotDay(s) != day) continue;
      const int ti = slotTime(s), par = slotParity(s);
      const Mask mask = p_.maskAt(ti, g.durSlot);
      const double people = static_cast<double>(st_.peopleClashesAt(i, day, mask, par)) * kClashBig;
      const double win = st_.windowCostOfAdding(i, day, par, mask);
      // One room per slot: the first admissible one that is free, else the first admissible one.
      int room = -1;
      double roomPenalty = kImpossible;
      const int* rooms = p_.roomsOf(g);
      const int limit = std::min(g.roomCount, o_.roomSample);
      const int start = rng_.belowI(std::max(1, g.roomCount));
      for (int r = 0; r < limit; ++r) {
        const int cand = rooms[(start + r) % g.roomCount];
        if (!st_.placementAllowed(i, day, ti, par, cand)) continue;
        const double rc = static_cast<double>(st_.roomClashesAt(i, day, mask, par, cand)) * kClashBig;
        if (rc < roomPenalty) { roomPenalty = rc; room = cand; }
        if (rc <= 0) break;
      }
      if (room == -1) continue;
      scored.emplace_back(people + roomPenalty + win, std::make_pair(s, room));
    }
    if (scored.empty()) return false;
    std::sort(scored.begin(), scored.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
    nCand[static_cast<size_t>(m)] = std::min<int>(kBranch, static_cast<int>(scored.size()));
    for (int q = 0; q < nCand[static_cast<size_t>(m)]; ++q) {
      cands[static_cast<size_t>(m)][static_cast<size_t>(q)] = scored[static_cast<size_t>(q)].second;
    }
  }

  std::array<Spot, 3> original{};
  for (int m = 0; m < k; ++m) original[static_cast<size_t>(m)] = st_.spotOf(members_[static_cast<size_t>(m)]);
  const double before = cost();
  double best = before;
  std::array<std::pair<int, int>, 3> bestPick{};
  bool found = false;
  std::array<int, 3> pick{};

  const auto restore = [&] {
    for (int m = 0; m < k; ++m) st_.placeRaw(members_[static_cast<size_t>(m)], original[static_cast<size_t>(m)]);
    st_.flush();
  };

  // Depth-first over the members, evaluating a complete arrangement at the leaf. No pruning on a
  // partial cost: a class parked on a bad slot on the way to a good arrangement is exactly the
  // valley the single-move neighbourhoods cannot cross, and pruning it would forbid the same moves
  // again.
  const std::function<void(int)> dfs = [&](int depth) {
    if (depth == k) {
      for (int m = 0; m < k; ++m) {
        const auto& c = cands[static_cast<size_t>(m)][static_cast<size_t>(pick[static_cast<size_t>(m)])];
        st_.placeRaw(members_[static_cast<size_t>(m)], slotDay(c.first), slotTime(c.first),
                     slotParity(c.first), c.second);
      }
      st_.flush();
      bool legal = true;
      for (int m = 0; m < k && legal; ++m) {
        const int i = members_[static_cast<size_t>(m)];
        const Gene& g = st_.gene(i);
        legal = st_.placementAllowed(i, g.day, g.timeIdx, g.parity, g.room);
      }
      if (legal) {
        const double c = cost();
        if (c < best) {
          best = c;
          for (int m = 0; m < k; ++m) {
            bestPick[static_cast<size_t>(m)] = cands[static_cast<size_t>(m)][static_cast<size_t>(pick[static_cast<size_t>(m)])];
          }
          found = true;
        }
      }
      restore();
      return;
    }
    for (int q = 0; q < nCand[static_cast<size_t>(depth)]; ++q) {
      pick[static_cast<size_t>(depth)] = q;
      dfs(depth + 1);
    }
  };
  dfs(0);
  if (!found) return false;

  beginCandidate();
  for (int m = 0; m < k; ++m) {
    const auto& c = bestPick[static_cast<size_t>(m)];
    moveTo(members_[static_cast<size_t>(m)], slotDay(c.first), slotTime(c.first), slotParity(c.first), c.second);
  }
  settle();
  return true;
}

bool Worker::permute(const std::vector<int>& members) {
  const int k = static_cast<int>(members.size());
  if (k < 2) return false;

  // ── the pool of placements to assign these k classes to ────────────────────
  //
  // The first k are the ones they already hold between them: assigning inside that set leaves the
  // multiset of occupied (day, slot, room) untouched, so nothing outside the k can be disturbed by
  // the exchange itself. That is the permutation neighbourhood, and on its own it measures as
  // neutral here — because ruin-and-recreate over the same k classes can already reach every
  // permutation *and* every placement outside the set, so exactness over a subset of what another
  // operator does anyway buys nothing.
  //
  // So the pool is widened: `extra` further placements, drawn from the members' own domains and kept
  // only when they are currently free. The assignment then answers a strictly stronger question —
  // *which k of these k + extra placements should these k classes take, and in which order* — which
  // is something no greedy recreate can answer, because a greedy recreate has to commit the first
  // class before it has seen the last one's options. Rectangular assignment, squared up with
  // zero-cost dummy rows so the Hungarian method can be used unchanged.
  spotPool_.clear();
  for (int m : members) {
    const Spot s = st_.spotOf(m);
    if (s.day < 0) return false;
    spotPool_.push_back(s);
  }

  beginCandidate();
  for (int m : members) moveTo(m, -1, -1, st_.gene(m).parity, -1);
  settle();

  const int extra = std::min(o_.koptExtra, k * 2);
  for (int e = 0; e < extra; ++e) {
    const int owner = members[static_cast<size_t>(rng_.belowI(k))];
    const Gene& go = st_.gene(owner);
    if (go.slotCount == 0 || go.roomCount == 0) continue;
    const int sl = p_.slotsOf(go)[rng_.belowI(go.slotCount)];
    const int day = slotDay(sl), ti = slotTime(sl), par = slotParity(sl);
    const Mask mask = p_.maskAt(ti, go.durSlot);
    // Only a free placement is worth adding: one that clashes is a placement the assignment would
    // have to price at kClashBig anyway, and it would crowd out a candidate that does not.
    int room = -1;
    bool ok = false;
    const int rstart = rng_.belowI(std::max(1, go.roomCount));
    const int limit = std::min(go.roomCount, o_.roomSample);
    for (int rr = 0; rr < limit; ++rr) {
      const int cand = p_.roomsOf(go)[(rstart + rr) % go.roomCount];
      if (!st_.placementAllowed(owner, day, ti, par, cand)) continue;
      if (st_.roomClashesAt(owner, day, mask, par, cand) != 0) continue;
      if (st_.peopleClashesAt(owner, day, mask, par) != 0) break;
      room = cand;
      ok = true;
      break;
    }
    if (!ok) continue;
    Spot s;
    s.day = day;
    s.timeIdx = ti;
    s.room = room;
    s.parity = static_cast<uint8_t>(par);
    bool duplicate = false;
    for (const Spot& q : spotPool_) {
      if (q.day == s.day && q.timeIdx == s.timeIdx && q.room == s.room) { duplicate = true; break; }
    }
    if (!duplicate) spotPool_.push_back(s);
  }

  const int cols = static_cast<int>(spotPool_.size());
  const int n = std::max(k, cols);

  // With every member lifted out, the cost of putting class r at placement q is readable on its
  // own. The residual coupling between the k is what the true-delta refinement below cleans up.
  costMatrix_.assign(static_cast<size_t>(n) * static_cast<size_t>(n), 0.0);
  for (int r = 0; r < n; ++r) {
    for (int q = 0; q < n; ++q) {
      // A dummy row (a placement nobody has to take) or a dummy column costs nothing; a real pair
      // starts impossible and is priced below if it is admissible.
      costMatrix_[static_cast<size_t>(r) * static_cast<size_t>(n) + static_cast<size_t>(q)] =
          (r < k && q < cols) ? kImpossible : 0.0;
    }
  }
  for (int r = 0; r < k; ++r) {
    const int i = members[static_cast<size_t>(r)];
    const Gene& g = st_.gene(i);
    for (int q = 0; q < cols; ++q) {
      const Spot& s = spotPool_[static_cast<size_t>(q)];
      // Parity travels with the class, not with the placement: a weekly class cannot take a
      // biweekly slot and the other way round.
      const int wantSlot = packSlot(s.day, s.timeIdx, g.parity);
      if (!hasSlot(g, wantSlot)) continue;
      const int room = g.placeKind == kPlaceRoom ? s.room : -1;
      if (g.placeKind == kPlaceRoom && (room < 0 || !hasRoom(g, room))) continue;
      if (!st_.placementAllowed(i, s.day, s.timeIdx, g.parity, room)) continue;
      const Mask mask = p_.maskAt(s.timeIdx, g.durSlot);
      double c = static_cast<double>(st_.clashCountAt(i, s.day, mask, g.parity, room)) * kClashBig;
      c += st_.windowCostOfAdding(i, s.day, g.parity, mask);
      if (p_.travelKnown) c += static_cast<double>(st_.travelCostOfAdding(i, s.day, mask, g.parity, room)) * kTravelBig;
      costMatrix_[static_cast<size_t>(r) * static_cast<size_t>(n) + static_cast<size_t>(q)] = c;
    }
  }
  hungarian(costMatrix_, n, assign_);
  bool identity = true;
  for (int r = 0; r < k; ++r) {
    const int q = assign_[static_cast<size_t>(r)];
    if (q < 0 || q >= cols ||
        costMatrix_[static_cast<size_t>(r) * static_cast<size_t>(n) + static_cast<size_t>(q)] >= kImpossible) {
      undo();
      return false;
    }
    if (q != r) identity = false;
  }
  // The relaxation very often returns everybody to where they were, and putting them back is a
  // candidate the acceptance test then waves through for costing exactly nothing. Measured at
  // n = 12 800: 99.96% of this operator's candidates were accepted and 0.8% improved anything.
  // Detecting the identity here turns that whole share of the budget back into search.
  if (identity) {
    undo();
    return false;
  }
  for (int r = 0; r < k; ++r) {
    const int i = members[static_cast<size_t>(r)];
    const Spot& s = spotPool_[static_cast<size_t>(assign_[static_cast<size_t>(r)])];
    const Gene& g = st_.gene(i);
    st_.placeRaw(i, s.day, s.timeIdx, g.parity, g.placeKind == kPlaceRoom ? s.room : -1);
  }
  settle();
  // The cost matrix was built with all k lifted out, so each feasibility probe saw a day missing
  // the other k−1. Ask again now that they are all down.
  if (!allLegal(members)) { undo(); return false; }
  refinePairs(members, 3);
  return true;
}

bool Worker::refinePairs(const std::vector<int>& members, int rounds) {
  // Exact pairwise exchange under the *true* objective, which is what the relaxed assignment above
  // cannot see. Small sets, so this is a handful of microseconds and it routinely finds the two or
  // three exchanges the relaxation got wrong.
  const int k = static_cast<int>(members.size());
  if (k < 2) return false;
  bool any = false;
  for (int round = 0; round < rounds; ++round) {
    bool improved = false;
    for (int a = 0; a < k; ++a) {
      for (int b = a + 1; b < k; ++b) {
        const int x = members[static_cast<size_t>(a)];
        const int y = members[static_cast<size_t>(b)];
        const Spot sx = st_.spotOf(x);
        const Spot sy = st_.spotOf(y);
        if (sx.day < 0 || sy.day < 0) continue;
        const Gene& gx = st_.gene(x);
        const Gene& gy = st_.gene(y);
        if (!hasSlot(gx, packSlot(sy.day, sy.timeIdx, gx.parity))) continue;
        if (!hasSlot(gy, packSlot(sx.day, sx.timeIdx, gy.parity))) continue;
        const int rx = gx.placeKind == kPlaceRoom ? sy.room : -1;
        const int ry = gy.placeKind == kPlaceRoom ? sx.room : -1;
        if (gx.placeKind == kPlaceRoom && (rx < 0 || !hasRoom(gx, rx))) continue;
        if (gy.placeKind == kPlaceRoom && (ry < 0 || !hasRoom(gy, ry))) continue;
        const double before = cost();
        st_.placeRaw(x, sy.day, sy.timeIdx, gx.parity, rx);
        st_.placeRaw(y, sx.day, sx.timeIdx, gy.parity, ry);
        st_.flush();
        const bool legal = st_.placementAllowed(x, sy.day, sy.timeIdx, st_.gene(x).parity, rx) &&
                           st_.placementAllowed(y, sx.day, sx.timeIdx, st_.gene(y).parity, ry);
        if (!legal || cost() >= before) {
          st_.placeRaw(x, sx);
          st_.placeRaw(y, sy);
          st_.flush();
        } else {
          jr_.emplace_back(x, sx);
          jr_.emplace_back(y, sy);
          improved = true;
          any = true;
        }
      }
    }
    if (!improved) break;
  }
  return any;
}

bool Worker::opKopt() {
  const int width = std::min(o_.koptK, std::max(3, koptWidth_));
  // Permuting classes that share nothing rearranges nothing: the objective is separable over
  // (entity, day), so an exchange between two classes with no entity and no day in common cannot
  // change a single Π term. The members are therefore drawn from a few *gappy* (entity, day)
  // buckets — where the permutation has something to close — and only otherwise from a cluster.
  if (rng_.chance(0.65)) {
    if (worstBuckets_.empty()) return false;
    members_.clear();
    const int take = 1 + rng_.belowI(3);
    for (int b = 0; b < take && static_cast<int>(members_.size()) < width; ++b) {
      const size_t bid = worstBuckets_[static_cast<size_t>(rng_.belowI(static_cast<int>(worstBuckets_.size())))];
      st_.bucketMembers(bid, scratch_);
      for (int m : scratch_) {
        if (static_cast<int>(members_.size()) >= width) break;
        if (std::find(members_.begin(), members_.end(), m) == members_.end()) members_.push_back(m);
      }
    }
  } else {
    selectVictims(kRuinCluster, width, members_);
  }
  if (members_.size() < 3) return false;
  return permute(members_);
}

// ── escalation ──────────────────────────────────────────────────────────────

bool Worker::deepPhase() {
  ++rep_.deepPhases;
  refreshLists();
  bool improved = false;
  const double startCost = cost();

  // Escalate the permutation width each time the ordinary neighbourhoods run dry. This is the
  // answer to "the search has stopped finding anything": widen the rearrangement rather than
  // repeating the same one.
  koptWidth_ = std::min(o_.koptK, koptWidth_ + 4);

  const int attempts = 24;
  for (int a = 0; a < attempts; ++a) {
    if (Clock::now() >= sh_.deadline) break;
    const double before = cost();
    bool applied = false;
    const int pick = a % 3;
    if (pick == 0 && o_.useKopt) {
      selectVictims(kRuinCluster, koptWidth_, members_);
      applied = members_.size() >= 3 && permute(members_);
    } else if (pick == 1 && o_.useLns) {
      selectVictims(kRuinWorstWindow, o_.lnsMax, victims_);
      if (victims_.size() >= 2) {
        beginCandidate();
        for (int v : victims_) moveTo(v, -1, -1, st_.gene(v).parity, -1);
        settle();
        recreate(victims_);
        settle();
        if (allLegal(victims_)) applied = true;
        else undo();
      }
    } else if (o_.useRepack) {
      applied = opRepack();
    }
    if (!applied) continue;
    ++moves_;
    if (cost() < before) {
      acceptedCost_ = cost();
      if (!history_.empty()) {
        const size_t idx = static_cast<size_t>(moves_) % history_.size();
        if (history_[idx] > acceptedCost_) history_[idx] = acceptedCost_;
      }
      improved = true;
      if (noteIncumbent()) sinceBest_ = 0;
      jr_.clear();
    } else {
      undo();
    }
  }
  if (improved) {
    // A deep phase that paid means the ordinary neighbourhoods have room again: reset the width so
    // the cheap operators get their turn before the expensive one widens once more.
    koptWidth_ = std::max(6, koptWidth_ - 2);
  }
  return cost() < startCost;
}

void Worker::perturb() {
  if (p_.movable.empty()) return;
  ++rep_.perturbations;
  const double strength = 0.10 + 0.10 * rng_.unit();
  const int n = static_cast<int>(static_cast<double>(p_.movable.size()) * strength);
  for (int k = 0; k < n; ++k) {
    const int i = p_.movable[static_cast<size_t>(rng_.belowI(static_cast<int>(p_.movable.size())))];
    int day, ti, par, room;
    if (randomSpot(i, day, ti, par, room)) st_.placeRaw(i, day, ti, par, room);
  }
  st_.rebuild();
  acceptedCost_ = cost();
  std::fill(history_.begin(), history_.end(), acceptedCost_);
  dlasMax_ = acceptedCost_;
  if (useSa_) temperature_ = t0_ * 0.5;
  sinceBest_ = 0;
  refreshLists();
}

/// Return to the best timetable this worker has found, break a small related part of it, repair, and
/// carry on from there.
///
/// The difference from `perturb()` is the first word. A perturbation of the working state is only a
/// diversification if the working state is the best thing you have; once it is not — and after a
/// failed stagnation cycle it never is — perturbing it walks away from the answer. Anchoring every
/// kick to the incumbent turns the long tail of a run from a random walk into a proper iterated
/// local search: each cycle asks "is there a better timetable *near the best one*", which is the
/// question that has an affirmative answer often enough to be worth an hour.
///
/// The set broken is `kRuinRelated` / `kRuinEntityDay` / `kRuinWorstWindow` / `kRuinCluster` in turn
/// rather than uniform: a kick that removes a lecturer's whole day can be repaired into a genuinely
/// different day, whereas the same number of unrelated classes is repaired back to almost exactly
/// where they were and costs the climb for nothing.
int Worker::kick(int size) {
  static const int kSelectors[4] = {kRuinRelated, kRuinEntityDay, kRuinWorstWindow, kRuinCluster};
  int taken = 0;
  // A large kick is assembled from several small related sets rather than one enormous one: one
  // cluster of three hundred classes is most of a faculty, and recreating it greedily is a
  // reconstruction, not a kick.
  for (int round = 0; taken < size && round < 12; ++round) {
    const int sel = kSelectors[rng_.belowI(4)];
    selectVictims(sel, std::min(size - taken, o_.lnsMax), victims_);
    if (victims_.size() < 2) continue;
    beginCandidate();
    for (int v : victims_) moveTo(v, -1, -1, st_.gene(v).parity, -1);
    settle();
    recreate(victims_);
    settle();
    if (!allLegal(victims_)) undo();
    else {
      taken += static_cast<int>(victims_.size());
      for (int v : victims_) focus_.push_back(v);
      jr_.clear();
    }
  }
  return taken;
}

void Worker::kickFromBest() {
  if (!haveBest_ || p_.movable.empty()) { perturb(); return; }
  ++rep_.perturbations;
  st_.restore(bestSpots_);
  // `kick` records what it broke for the ILS descent to aim at. The ordinary walk has its own
  // targeting — `hot_` and `warm_`, refreshed from the live violations — and leaving a stale set
  // behind would bias half of every draw for the rest of the run at whatever the last kick
  // happened to touch, growing by up to `kickMax` ids each time.
  focus_.clear();
  kick(std::clamp(kickSize_, o_.kickMin, o_.kickMax));
  focus_.clear();

  acceptedCost_ = cost();
  std::fill(history_.begin(), history_.end(), acceptedCost_);
  dlasMax_ = acceptedCost_;
  // A kick is a small displacement, not a restart, so the bar comes back only part of the way.
  if (useSa_) temperature_ = t0_ * 0.25;
  sinceBest_ = 0;
  gainSinceKick_ = false;
  noteIncumbent();  // the repair itself occasionally lands better than what it started from
  refreshLists();
}

int Worker::pickOperator() {
  double share[kOpCount];
  double total = 0;
  for (int k = 0; k < kOpCount; ++k) {
    share[k] = weight_[k] <= 0 ? 0.0
               : (o_.costAwareSelection ? weight_[k] / std::max(1.0, avgWork_[k]) : weight_[k]);
    total += share[k];
  }
  double pick = rng_.unit() * total;
  for (int k = 0; k < kOpCount; ++k) {
    pick -= share[k];
    if (pick <= 0) return k;
  }
  return kOpMove;
}

bool Worker::applyOperator(int op) {
  switch (op) {
    case kOpMove: return opMove();
    case kOpSwap: return opSwap();
    case kOpChain: return opChain();
    case kOpKempe: return opKempe();
    case kOpRuin: return opRuin();
    case kOpKopt: return opKopt();
    case kOpRepack: return opRepack();
    case kOpDayRepack: return opDayRepack();
    case kOpCloseWindow: return opCloseWindow();
    default: return false;
  }
}

/// One iterated-local-search cycle: anchor on the incumbent, break a small related part of it, let a
/// **strict descent** put it back together, and keep the result only if it is better than what we
/// started from.
///
/// This is the answer to the measurement that motivated the whole escape mechanism. With the
/// ordinary loop, n = 12 800 stops improving at about thirty seconds and twenty million further
/// moves change nothing: the acceptance bar has collapsed onto the incumbent (a late-acceptance bar
/// is monotone once the search stops descending, and a temperature pinned to the *construction*
/// scale is zero next to an objective four orders of magnitude smaller), so the walk is a hill climb
/// on a surface with no downhill left. Widening the bar instead — a five-thousand-long history —
/// does not converge at all: soft 32 → 3 381. The tail is not short of tolerance. It is short of
/// *attempts*, and each attempt has to start from the best timetable rather than from wherever the
/// walk has drifted.
///
/// So the cycle is made cheap and the anchor absolute: a few hundred descent moves per kick rather
/// than the four hundred thousand the stagnation counter used to spend between kicks, and a restore
/// at the end of every cycle that fails. What was twenty-five diversifications in three minutes
/// becomes thousands.
bool Worker::ilsCycle() {
  const double anchorObj = bestObjective_;
  const double anchorCost = cost();
  const int size = std::clamp(kickSize_, o_.kickMin, o_.kickMax);
  focus_.clear();
  kick(size);
  acceptedCost_ = cost();
  refreshLists();

  bool gained = false;
  for (int m = 0; m < o_.ilsDescent; ++m) {
    if ((m & 255) == 0 && Clock::now() >= sh_.deadline) break;
    const int op = pickOperator();
    const double before = cost();
    const uint64_t workBefore = st_.work();
    if (!applyOperator(op)) { ++moves_; segWork_[op] += 1.0; ++segUses_[op]; continue; }
    ++moves_;
    ++listAge_;
    ++ops_[static_cast<size_t>(op)].uses;
    const double after = cost();
    const double workUsed = static_cast<double>(st_.work() - workBefore) + 1.0;
    segWork_[op] += workUsed;
    ++segUses_[op];
    // Equal-cost moves are accepted, not merely improving ones. Most rearrangements of a timetable
    // this good change no window at all, and a descent that refuses them cannot cross the plateau
    // that separates one local optimum from the next — which is most of what there is to cross when
    // the objective is a sum of squares of small integers. The ordinary walk gets this for free: a
    // late-acceptance bar that has collapsed onto the incumbent still admits equality.
    if (after <= before + 1e-9) {
      ++ops_[static_cast<size_t>(op)].accepted;
      if (after < before - 1e-9) {
        ++ops_[static_cast<size_t>(op)].improved;
        ops_[static_cast<size_t>(op)].gain += before - after;
      }
      acceptedCost_ = after;
      jr_.clear();
      if (noteIncumbent()) { gained = true; segScore_[op] += 4.0; }
      else segScore_[op] += after < before ? 1.5 : 0.2;
    } else {
      undo();
    }
    if (++segMoves_ >= 4000) {
      for (int k = 0; k < kOpCount; ++k) {
        if (weight_[k] <= 0) continue;
        if (segUses_[k] > 0) {
          const double observed = segWork_[k] / static_cast<double>(segUses_[k]);
          avgWork_[k] = 0.6 * avgWork_[k] + 0.4 * observed;
        }
        const double rate = segScore_[k] / std::max(1.0, segWork_[k]);
        weight_[k] = std::clamp(0.7 * weight_[k] + 0.3 * (1.0 + 300.0 * rate), 0.05, 40.0);
        segScore_[k] = 0;
        segWork_[k] = 0;
        segUses_[k] = 0;
      }
      segMoves_ = 0;
    }
    if (listAge_ >= o_.hotRefresh) refreshLists();
  }

  focus_.clear();
  // What the cycle leaves behind. A cycle that ended no worse than it started becomes the new
  // anchor even when it found nothing — that is the plateau drift, at the scale of whole cycles
  // rather than single moves, and it is what stops the loop from proposing the same kick from the
  // same place forever. A cycle that ended worse is discarded outright.
  if (cost() <= anchorCost + 1e-9) st_.snapshotInto(anchorSpots_);
  else st_.restore(anchorSpots_);
  return gained || bestObjective_ < anchorObj;
}

void Worker::ilsLoop() {
  int64_t cycles = 0;
  int64_t sinceAdopt = 0;
  int64_t sinceGain = 0;
  st_.restore(bestSpots_);
  st_.snapshotInto(anchorSpots_);
  while (Clock::now() < sh_.deadline) {
    if (o_.stopFlag && o_.stopFlag->load(std::memory_order_relaxed)) break;
    if (st_.hard() == 0 && st_.counters().lecWinHalves == 0 && st_.counters().grpWinHalves == 0 &&
        st_.counters().mixedHalves == 0) {
      break;
    }
    // Adapt the kick before making it, exactly as the stagnation path did: tighten to `kickMin`
    // while the neighbourhood of the best solution is still giving, reach further when it is not.
    kickSize_ = gainSinceKick_ ? o_.kickMin
                               : std::min(o_.kickMax, kickSize_ + kickSize_ / 8 + 1);
    gainSinceKick_ = false;
    const bool gained = ilsCycle();
    ++cycles;
    if (gained) { gainSinceKick_ = true; sinceAdopt = 0; sinceGain = 0; }
    else { ++sinceAdopt; ++sinceGain; }
    // Drift is allowed, but not indefinitely: if a long stretch of sideways cycles has produced
    // nothing, go back to the best timetable and try again from there.
    if (sinceGain >= o_.ilsReanchor) {
      st_.restore(bestSpots_);
      st_.snapshotInto(anchorSpots_);
      sinceGain = 0;
    }

    // Every so often, spend one cycle on the wide exact permutation instead of the kick — this is
    // the "rearrange more than ten classes at once" escalation, now inside the loop that repeats.
    if ((cycles % 64) == 0) {
      const double before = bestObjective_;
      deepPhase();
      if (bestObjective_ < before) { gainSinceKick_ = true; sinceGain = 0; }
      st_.restore(anchorSpots_);
    }
    if (o_.cooperate && sinceAdopt >= 256) {
      adoptElite();
      st_.restore(bestSpots_);
      st_.snapshotInto(anchorSpots_);
      sinceAdopt = 0;
    }

    const auto now = Clock::now();
    if (now - lastPublish_ >= std::chrono::milliseconds(o_.logEveryMs)) {
      publish("ils");
      lastPublish_ = now;
    }
  }
  rep_.ilsCycles = cycles;
  st_.restore(bestSpots_);
}

/// Put a class back wherever the graft or the conflicts left it unplaceable.
///
/// Two things can be wrong after inheriting part of another timetable. A grafted class can break a
/// rule that is a property of a *set* rather than of a placement — `MAX_CLASSES_PER_DAY` is the only
/// one, and it is invisible to a per-class check made before the other classes arrived. And the two
/// halves can simply collide: parent A's Monday and parent B's Monday were each conflict-free, and
/// together they are not. Both are repaired the same way — lift the offenders and let the greedy
/// insertion put them somewhere the combined timetable allows.
bool Worker::repairAfterGraft(const std::vector<int>& grafted) {
  for (int round = 0; round < 4; ++round) {
    victims_.clear();
    for (int i : grafted) {
      const Gene& g = st_.gene(i);
      if (g.day < 0 || g.timeIdx < 0 || !st_.placementAllowed(i, g.day, g.timeIdx, g.parity, g.room)) {
        victims_.push_back(i);
      }
    }
    if (st_.hard() > 0) {
      st_.collectHot(scratch_);
      for (int i : scratch_) {
        if (std::find(victims_.begin(), victims_.end(), i) == victims_.end()) victims_.push_back(i);
      }
    }
    if (victims_.empty()) return true;
    // Journalled, because `recreate`'s last resort for a class it cannot place anywhere is to read
    // the class's previous spot back out of the journal. Lifting a victim with a bare `placeRaw`
    // makes that fallback a no-op and the class stays unplaced — and an unplaced class *lowers*
    // every Π term, so the truncated timetable would then win the incumbent outright.
    beginCandidate();
    for (int v : victims_) moveTo(v, -1, -1, st_.gene(v).parity, -1);
    settle();
    recreate(victims_);
    settle();
    if (!allLegal(victims_)) { undo(); return false; }
    jr_.clear();
  }
  return victims_.empty();
}

/// Cluster-wise crossover with two parents from the shared pool.
///
/// Every other escape here moves *within* one basin: a kick displaces part of the incumbent and the
/// descent puts it back, so what comes out is a variation on what went in. Recombination is the one
/// operator that can produce a timetable neither parent would have reached, and the run-to-run
/// spread on a single instance says there is something to reach — the same configuration, the same
/// instance, a different seed, and the residual moves by a factor of three.
///
/// The unit inherited is a **cluster**, not a class: classes that share a lecturer or a group have
/// to move together or the child is merely both parents' conflicts at once. Label propagation
/// already gives the clusters; a fair coin per cluster gives the child.
bool Worker::recombine() {
  if (!haveBest_ || sh_.clusters.empty()) return false;
  const int64_t minDist =
      std::max<int64_t>(4, static_cast<int64_t>(static_cast<double>(p_.movable.size()) * o_.poolMinDist));
  {
    std::lock_guard<std::mutex> lk(sh_.mu);
    if (sh_.pool.size() < 2) return false;
    // Prefer a parent that is genuinely elsewhere; recombining with a near-copy of ourselves is a
    // no-op with a repair bill attached.
    int chosen = -1;
    for (int attempt = 0; attempt < 4; ++attempt) {
      const int idx = rng_.belowI(static_cast<int>(sh_.pool.size()));
      if (Shared::distance(sh_.pool[static_cast<size_t>(idx)].spots, bestSpots_) >= minDist) {
        chosen = idx;
        break;
      }
    }
    if (chosen < 0) return false;
    parentSpots_ = sh_.pool[static_cast<size_t>(chosen)].spots;
  }
  // Decide what would be inherited *before* touching the working state. Returning from the middle
  // of a graft would leave `st_` holding one timetable while `acceptedCost_` and the acceptance
  // history describe another, and the next few thousand candidates would be judged against a bar
  // belonging to a schedule that no longer exists.
  grafted_.clear();
  for (const auto& c : sh_.clusters) {
    if (!rng_.chance(0.5)) continue;
    for (int i : c) {
      if (!st_.gene(i).movable) continue;
      const Spot& a = bestSpots_[static_cast<size_t>(i)];
      const Spot& b = parentSpots_[static_cast<size_t>(i)];
      if (a.day == b.day && a.timeIdx == b.timeIdx && a.room == b.room && a.parity == b.parity) continue;
      grafted_.push_back(i);
    }
  }
  if (grafted_.empty()) return false;
  ++rep_.recombinations;

  st_.restore(bestSpots_);
  const int64_t unplacedBefore = st_.unplacedMovable();
  for (int i : grafted_) {
    const Spot& b = parentSpots_[static_cast<size_t>(i)];
    st_.placeRaw(i, b.day, b.timeIdx, b.parity, b.room);
  }
  st_.flush();
  if (!repairAfterGraft(grafted_) || st_.unplacedMovable() > unplacedBefore) {
    // The child could not be made whole. Better the parent than a timetable with a class missing.
    st_.restore(bestSpots_);
  }

  acceptedCost_ = cost();
  std::fill(history_.begin(), history_.end(), acceptedCost_);
  dlasMax_ = acceptedCost_;
  if (useSa_) temperature_ = t0_ * 0.25;
  sinceBest_ = 0;
  gainSinceKick_ = false;
  noteIncumbent();
  refreshLists();
  return true;
}

/// Abandon this basin and build a new timetable from scratch.
///
/// The six-seed spread — soft 11 to 29 on one instance with one configuration — says that which
/// basin the construction lands in matters more than anything the local search does afterwards. A
/// worker that has stopped improving is therefore better off *sampling again* than polishing: it
/// hands its incumbent to the shared pool, forgets it, and reconstructs with a freshly shuffled
/// order. Nothing is lost — the pool and the shared best keep every timetable ever reached, and the
/// run returns the best of all of them — and an hour becomes some dozens of independent draws from
/// that distribution rather than one draw plus fifty-nine minutes of polishing.
///
/// It fires only after `restartAfter` moves without a new incumbent, which at short budgets is never.
void Worker::restartFresh() {
  if (haveBest_) {
    std::lock_guard<std::mutex> lk(sh_.mu);
    const int64_t minDist =
        std::max<int64_t>(4, static_cast<int64_t>(static_cast<double>(p_.movable.size()) * o_.poolMinDist));
    if (o_.poolSize > 0) {
      sh_.offer(bestUnplaced_, bestHard_, bestObjective_, bestSpots_, o_.poolSize, minDist);
    }
    if (!sh_.haveBest || Shared::better(bestUnplaced_, bestHard_, bestObjective_, sh_.bestUnplaced,
                                        sh_.bestHard, sh_.bestObjective)) {
      sh_.haveBest = true;
      sh_.bestUnplaced = bestUnplaced_;
      sh_.bestHard = bestHard_;
      sh_.bestObjective = bestObjective_;
      sh_.bestSpots = bestSpots_;
      sh_.bestWorker = id_;
    }
  }
  ++rep_.restarts;
  // Empty the movable part first. `construct()` skips a class that already has a placement when
  // `keepExisting` is set — which is right at the start of such a run, where the placed classes are
  // the ones being kept and are frozen anyway, and wrong here, where every movable class has a
  // placement by now and skipping them all would make the "restart" a no-op that had nonetheless
  // thrown the incumbent away.
  for (int i : p_.movable) st_.placeRaw(i, -1, -1, st_.gene(i).parity, -1);
  st_.flush();
  // Do not let the cooperation undo the restart. `adoptElite` exists to pull a worker onto a
  // markedly better timetable, and immediately after a fresh construction *every* pool member is
  // markedly better — so without this the worker would be dragged straight back into the basin it
  // just left, and the restart would be a very expensive no-op.
  adoptBlockUntil_ = moves_ + o_.restartAfter;
  haveBest_ = false;
  bestSpots_.clear();
  construct();
  st_.rebuild();
  acceptedCost_ = cost();
  std::fill(history_.begin(), history_.end(), acceptedCost_);
  dlasMax_ = acceptedCost_;
  if (useSa_) temperature_ = t0_;
  sinceBest_ = 0;
  lastIncumbentMove_ = moves_;
  kickSize_ = o_.kickMin;
  noteIncumbent();
  refreshLists();
}

void Worker::adoptElite() {
  if (!o_.cooperate) return;
  if (moves_ < adoptBlockUntil_) return;
  std::vector<Spot> take;
  {
    std::lock_guard<std::mutex> lk(sh_.mu);
    if (!sh_.haveBest) return;
    const bool worth = sh_.bestUnplaced < bestUnplaced_ ||
                       (sh_.bestUnplaced == bestUnplaced_ &&
                        (sh_.bestHard < bestHard_ ||
                         (sh_.bestHard == bestHard_ && sh_.bestObjective < bestObjective_ * 0.97)));
    if (!worth) return;
    take = sh_.bestSpots;
  }
  st_.restore(take);
  acceptedCost_ = cost();
  std::fill(history_.begin(), history_.end(), acceptedCost_);
  dlasMax_ = acceptedCost_;
  noteIncumbent();
  sinceBest_ = 0;
  ++rep_.adoptions;
  refreshLists();
}

void Worker::publish(const char* phase) {
  // Every field of one row describes the **incumbent**, not the working state. Mixing the two —
  // reporting the incumbent's f(σ) beside the current state's Π terms — produced rows whose
  // objective was not f() of the numbers next to it, and a soft cost that rose while the objective
  // fell. A row that cannot be checked against itself is not a measurement.
  const Counters& c = bestCounters_;
  TrajectoryPoint pt;
  pt.seconds = std::chrono::duration<double>(Clock::now() - sh_.started).count();
  pt.worker = id_;
  pt.moves = moves_;
  pt.hard = bestHard_;
  pt.objective = bestObjective_;
  pt.surrogate = bestSurrogate_;
  pt.lecConflicts = c.lecConflicts;
  pt.grpConflicts = c.grpConflicts;
  pt.roomConflicts = c.roomConflicts;
  pt.grpTravel = c.grpTravel;
  pt.lecTravel = c.lecTravel;
  pt.absOverflow = c.absOverflow;
  pt.lecWindows = static_cast<int64_t>(std::llround(static_cast<double>(c.lecWinHalves) / 2.0));
  pt.grpWindows = static_cast<int64_t>(std::llround(static_cast<double>(c.grpWinHalves) / 2.0));
  pt.mixedDays = static_cast<int64_t>(std::llround(static_cast<double>(c.mixedHalves) / 2.0));
  pt.soft = pt.lecWindows + pt.grpWindows + pt.mixedDays;
  pt.phase = phase;

  if (o_.onProgress) o_.onProgress(pt);
  std::lock_guard<std::mutex> lk(sh_.mu);
  sh_.trajectory.push_back(pt);
  if (haveBest_ && o_.poolSize > 0) {
    const int64_t minDist =
        std::max<int64_t>(4, static_cast<int64_t>(static_cast<double>(p_.movable.size()) * o_.poolMinDist));
    sh_.offer(bestUnplaced_, bestHard_, bestObjective_, bestSpots_, o_.poolSize, minDist);
  }
  if (haveBest_ && (!sh_.haveBest || Shared::better(bestUnplaced_, bestHard_, bestObjective_,
                                                    sh_.bestUnplaced, sh_.bestHard, sh_.bestObjective))) {
    sh_.haveBest = true;
    sh_.bestUnplaced = bestUnplaced_;
    sh_.bestHard = bestHard_;
    sh_.bestObjective = bestObjective_;
    sh_.bestSpots = bestSpots_;
    sh_.bestWorker = id_;
  }
}

// ── the loop ────────────────────────────────────────────────────────────────

void Worker::run() {
  rep_.worker = id_;
  construct();
  if (p_.movable.empty()) {
    // Nothing to place. The timetable it already has is the answer.
    st_.rebuild();
    noteIncumbent();
    publish("end");
    rep_.hard = bestHard_;
    rep_.objective = bestObjective_;
    rep_.operators = ops_;
    return;
  }
  st_.rebuild();

  const double s0 = st_.surrogate();
  hardWeight_ = o_.hardWeight > 0 ? o_.hardWeight : std::max(1e6, s0 * 0.02);
  t0_ = std::max(1.0, s0 * o_.saT0Factor);
  temperature_ = t0_;
  acceptedCost_ = cost();
  history_.assign(static_cast<size_t>(std::max(1, o_.lahcLength)), acceptedCost_);
  dlasMax_ = acceptedCost_;
  noteIncumbent();
  refreshLists();
  lastPublish_ = Clock::now();
  publish("start");

  int64_t sinceDeep = 0;
  int64_t sinceAdopt = 0;
  while (true) {
    if ((moves_ & 1023) == 0) {
      const auto now = Clock::now();
      if (now >= sh_.deadline) break;
      if (o_.stopFlag && o_.stopFlag->load(std::memory_order_relaxed)) break;
      if (now - lastPublish_ >= std::chrono::milliseconds(o_.logEveryMs)) {
        publish(st_.hard() > 0 ? "repair" : "windows");
        lastPublish_ = now;
      }
    }
    if (st_.hard() == 0 && st_.counters().lecWinHalves == 0 && st_.counters().grpWinHalves == 0 &&
        st_.counters().mixedHalves == 0) {
      break;  // f(σ) = 0 — there is nothing left to find
    }

    // Choose an operator by roulette over weight/cost — a share of the budget, not a share of the
    // draws.
    double share[kOpCount];
    double total = 0;
    for (int k = 0; k < kOpCount; ++k) {
      share[k] = weight_[k] <= 0 ? 0.0
                 : (o_.costAwareSelection ? weight_[k] / std::max(1.0, avgWork_[k]) : weight_[k]);
      total += share[k];
    }
    double pick = rng_.unit() * total;
    int op = kOpMove;
    for (int k = 0; k < kOpCount; ++k) {
      pick -= share[k];
      if (pick <= 0) { op = k; break; }
    }

    const double before = cost();
    const uint64_t workBefore = st_.work();
    bool applied = false;
    switch (op) {
      case kOpMove: applied = opMove(); break;
      case kOpSwap: applied = opSwap(); break;
      case kOpChain: applied = opChain(); break;
      case kOpKempe: applied = opKempe(); break;
      case kOpRuin: applied = opRuin(); break;
      case kOpKopt: applied = opKopt(); break;
      case kOpRepack: applied = opRepack(); break;
      case kOpDayRepack: applied = opDayRepack(); break;
      case kOpCloseWindow: applied = opCloseWindow(); break;
      default: break;
    }
    const double workUsed = static_cast<double>(st_.work() - workBefore) + 1.0;
    if (!applied) {
      segWork_[op] += workUsed;
      ++segUses_[op];
      ++moves_;
      ++sinceBest_;
      continue;
    }

    ++moves_;
    ++listAge_;
    ++sinceDeep;
    ++sinceAdopt;
    OperatorReport& orp = ops_[static_cast<size_t>(op)];
    ++orp.uses;

    const double after = cost();
    const bool ok = acceptTest(after);
    if (ok) {
      ++orp.accepted;
      if (after < before) {
        orp.gain += before - after;
        ++orp.improved;
      }
      jr_.clear();
      if (noteIncumbent()) {
        sinceBest_ = 0;
        segScore_[op] += 4.0;
      } else {
        ++sinceBest_;
        segScore_[op] += after < before ? 1.5 : 0.3;
      }
    } else {
      undo();
      ++sinceBest_;
    }
    segWork_[op] += workUsed;
    ++segUses_[op];

    // Adaptive operator weights, in segments. The reward is divided by the work the operator cost,
    // measured in recomputed buckets, so a large neighbourhood has to earn its price rather than
    // merely be occasionally spectacular.
    if (++segMoves_ >= 4000) {
      for (int k = 0; k < kOpCount; ++k) {
        if (weight_[k] <= 0) continue;
        if (segUses_[k] > 0) {
          const double observed = segWork_[k] / static_cast<double>(segUses_[k]);
          avgWork_[k] = 0.6 * avgWork_[k] + 0.4 * observed;
        }
        const double rate = segScore_[k] / std::max(1.0, segWork_[k]);
        weight_[k] = 0.7 * weight_[k] + 0.3 * (1.0 + 300.0 * rate);
        weight_[k] = std::clamp(weight_[k], 0.05, 40.0);
        segScore_[k] = 0;
        segWork_[k] = 0;
        segUses_[k] = 0;
      }
      segMoves_ = 0;
    }

    if (listAge_ >= o_.hotRefresh) refreshLists();

    if (sinceBest_ >= o_.deepEvery && sinceDeep >= o_.deepEvery) {
      sinceDeep = 0;
      // The walk's job is to reach a feasible timetable and polish it until it stops paying. From
      // that point the budget is better spent on repeated kicks of the incumbent than on more of
      // the same walk, and at an hour that is nearly the whole budget.
      if (o_.useIls && bestHard_ == 0 && haveBest_ && moves_ - lastIncumbentMove_ >= o_.ilsAfter) { ilsLoop(); break; }
      const bool paid = deepPhase();
      if (!paid && sinceBest_ >= o_.stagnationMoves) {
        if (o_.restartAfter > 0 && moves_ - lastIncumbentMove_ >= o_.restartAfter) restartFresh();
        else if (o_.useRecombine && rng_.chance(o_.recombineRate) && recombine()) { sinceAdopt = 0; }
        else if (o_.cooperate && sinceAdopt > o_.stagnationMoves) { adoptElite(); sinceAdopt = 0; }
        else if (o_.restartFromBest) {
          // Adapt the strength before kicking: a cycle that produced a new incumbent means the
          // neighbourhood of the best solution is still giving, so probe it again at the small
          // radius; a cycle that produced nothing means look further out.
          kickSize_ = gainSinceKick_ ? o_.kickMin
                                     : std::min(o_.kickMax, kickSize_ + kickSize_ / 2 + o_.kickMin);
          kickFromBest();
        } else {
          perturb();
        }
      }
    }
    if (useSa_) {
      if ((moves_ & 4095) == 0) temperature_ = std::max(t0_ * 1e-4, temperature_ * o_.saCooling);
      if (sinceBest_ >= o_.saReheatAfter) { temperature_ = t0_ * 0.5; sinceBest_ = 0; }
    }
  }

  publish("end");
  rep_.moves = moves_;
  rep_.hard = bestHard_;
  rep_.objective = bestObjective_;
  rep_.operators = ops_;
}

}  // namespace

SearchResult solve(const Problem& p, const SearchOptions& opts) {
  Shared sh;
  sh.p = &p;
  sh.o = opts;
  sh.started = Clock::now();
  sh.deadline = sh.started + std::chrono::milliseconds(opts.timeLimitMs);
  if (opts.useClusters) buildClusters(p, sh);

  int threads = opts.threads > 0 ? opts.threads : static_cast<int>(std::thread::hardware_concurrency());
  if (threads < 1) threads = 1;

  std::vector<std::unique_ptr<Worker>> workers;
  workers.reserve(static_cast<size_t>(threads));
  for (int k = 0; k < threads; ++k) workers.push_back(std::make_unique<Worker>(sh, k));

  std::vector<std::thread> pool;
  pool.reserve(static_cast<size_t>(threads));
  for (int k = 1; k < threads; ++k) pool.emplace_back([&workers, k] { workers[static_cast<size_t>(k)]->run(); });
  workers[0]->run();
  for (auto& t : pool) t.join();

  SearchResult r;
  r.totalSeconds = std::chrono::duration<double>(Clock::now() - sh.started).count();
  int bestK = -1;
  for (int k = 0; k < threads; ++k) {
    const Worker& w = *workers[static_cast<size_t>(k)];
    r.moves += w.report().moves;
    r.workers.push_back(w.report());
    if (w.best().empty()) continue;
    if (bestK < 0) { bestK = k; continue; }
    const Worker& b = *workers[static_cast<size_t>(bestK)];
    if (Shared::better(w.bestUnplaced(), w.bestHard(), w.bestObjective(), b.bestUnplaced(),
                       b.bestHard(), b.bestObjective())) {
      bestK = k;
    }
  }

  // A worker that restarted has dropped its own incumbent on purpose; the shared best is what
  // remembers it. Take whichever of the two is better rather than only the live workers'.
  const std::vector<Spot>* pick = nullptr;
  if (bestK >= 0) pick = &workers[static_cast<size_t>(bestK)]->best();
  if (sh.haveBest && !sh.bestSpots.empty() &&
      (pick == nullptr ||
       Shared::better(sh.bestUnplaced, sh.bestHard, sh.bestObjective,
                      workers[static_cast<size_t>(bestK)]->bestUnplaced(),
                      workers[static_cast<size_t>(bestK)]->bestHard(),
                      workers[static_cast<size_t>(bestK)]->bestObjective()))) {
    pick = &sh.bestSpots;
    if (bestK < 0) bestK = sh.bestWorker;
  }

  State final(p);
  if (pick != nullptr) final.restore(*pick);
  r.best = final.genes();
  r.counters = final.counters();
  r.hard = final.hard();
  r.objective = final.objective();
  r.bestWorker = bestK < 0 ? 0 : bestK;
  const Counters& c = r.counters;
  r.soft = std::llround(static_cast<double>(c.lecWinHalves) / 2.0) +
           std::llround(static_cast<double>(c.grpWinHalves) / 2.0) +
           std::llround(static_cast<double>(c.mixedHalves) / 2.0);
  for (int i = 0; i < p.movableCount; ++i) {
    const Gene& g = r.best[static_cast<size_t>(i)];
    if (g.movable && g.day >= 0 && g.timeIdx >= 0) ++r.placed;
    else if (g.movable) ++r.unplaced;
  }
  r.trajectory = std::move(sh.trajectory);
  std::stable_sort(r.trajectory.begin(), r.trajectory.end(),
                   [](const TrajectoryPoint& a, const TrajectoryPoint& b) { return a.seconds < b.seconds; });
  return r;
}

Json SearchResult::summary() const {
  Json o = Json::object();
  o.set("hard", Json{static_cast<long long>(hard)});
  o.set("soft", Json{static_cast<long long>(soft)});
  o.set("objective", Json{objective});
  o.set("moves", Json{static_cast<long long>(moves)});
  o.set("bestWorker", Json{bestWorker});
  o.set("placed", Json{placed});
  o.set("unplaced", Json{unplaced});
  o.set("seconds", Json{totalSeconds});

  Json v = Json::object();
  v.set("lecturerConflicts", Json{static_cast<long long>(counters.lecConflicts)});
  v.set("groupConflicts", Json{static_cast<long long>(counters.grpConflicts)});
  v.set("roomConflicts", Json{static_cast<long long>(counters.roomConflicts)});
  v.set("groupTravel", Json{static_cast<long long>(counters.grpTravel)});
  v.set("lecturerTravel", Json{static_cast<long long>(counters.lecTravel)});
  v.set("abstractRoomOverflow", Json{static_cast<long long>(counters.absOverflow)});
  v.set("lecturerWindows", Json{static_cast<long long>(std::llround(static_cast<double>(counters.lecWinHalves) / 2.0))});
  v.set("groupWindows", Json{static_cast<long long>(std::llround(static_cast<double>(counters.grpWinHalves) / 2.0))});
  v.set("mixedOnlineDays", Json{static_cast<long long>(std::llround(static_cast<double>(counters.mixedHalves) / 2.0))});
  o.set("violations", std::move(v));

  Json ws = Json::array({});
  for (const auto& w : workers) {
    Json j = Json::object();
    j.set("worker", Json{w.worker});
    j.set("moves", Json{static_cast<long long>(w.moves)});
    j.set("hard", Json{static_cast<long long>(w.hard)});
    j.set("objective", Json{w.objective});
    j.set("perturbations", Json{static_cast<long long>(w.perturbations)});
    j.set("deepPhases", Json{static_cast<long long>(w.deepPhases)});
    j.set("ilsCycles", Json{static_cast<long long>(w.ilsCycles)});
    j.set("recombinations", Json{static_cast<long long>(w.recombinations)});
    j.set("restarts", Json{static_cast<long long>(w.restarts)});
    j.set("adoptions", Json{static_cast<long long>(w.adoptions)});
    Json ops = Json::array({});
    for (const auto& op : w.operators) {
      Json jo = Json::object();
      jo.set("name", Json{op.name});
      jo.set("uses", Json{static_cast<long long>(op.uses)});
      jo.set("accepted", Json{static_cast<long long>(op.accepted)});
      jo.set("improved", Json{static_cast<long long>(op.improved)});
      jo.set("gain", Json{op.gain});
      ops.push(std::move(jo));
    }
    j.set("operators", std::move(ops));
    ws.push(std::move(j));
  }
  o.set("workers", std::move(ws));
  return o;
}

void writeTrajectory(const std::string& path, const SearchResult& r) {
  const bool csv = path.size() > 4 && path.compare(path.size() - 4, 4, ".csv") == 0;
  std::ofstream out(path);
  if (!out) return;

  // Every row describes **one worker's** incumbent at that moment, which is the right thing to log
  // and the wrong thing to plot: workers take turns publishing, and a worker that has just restarted
  // reports the fresh construction it is now carrying. Read literally, the file looks like a
  // sawtooth. `runBest*` is the run's best-so-far across every worker — a monotone series, and the
  // one a "quality against time" figure is asking for.
  std::vector<int64_t> runHard(r.trajectory.size(), 0);
  std::vector<double> runObj(r.trajectory.size(), 0);
  std::vector<int64_t> runSoft(r.trajectory.size(), 0);
  {
    int64_t bh = 0;
    double bo = 0;
    int64_t bs = 0;
    bool have = false;
    for (size_t i = 0; i < r.trajectory.size(); ++i) {
      const TrajectoryPoint& t = r.trajectory[i];
      if (!have || t.hard < bh || (t.hard == bh && t.objective < bo)) {
        have = true;
        bh = t.hard;
        bo = t.objective;
        bs = t.soft;
      }
      runHard[i] = bh;
      runObj[i] = bo;
      runSoft[i] = bs;
    }
  }

  if (csv) {
    out << "seconds,worker,moves,phase,hard,objective,surrogate,soft,lecturerConflicts,"
           "groupConflicts,roomConflicts,groupTravel,lecturerTravel,abstractRoomOverflow,"
           "lecturerWindows,groupWindows,mixedOnlineDays,runBestHard,runBestObjective,runBestSoft\n";
    for (size_t i = 0; i < r.trajectory.size(); ++i) {
      const TrajectoryPoint& t = r.trajectory[i];
      out << t.seconds << ',' << t.worker << ',' << t.moves << ',' << t.phase << ',' << t.hard << ','
          << t.objective << ',' << t.surrogate << ',' << t.soft << ',' << t.lecConflicts << ','
          << t.grpConflicts << ',' << t.roomConflicts << ',' << t.grpTravel << ',' << t.lecTravel
          << ',' << t.absOverflow << ',' << t.lecWindows << ',' << t.grpWindows << ',' << t.mixedDays
          << ',' << runHard[i] << ',' << runObj[i] << ',' << runSoft[i] << '\n';
    }
    return;
  }
  for (size_t i = 0; i < r.trajectory.size(); ++i) {
    const TrajectoryPoint& t = r.trajectory[i];
    Json j = Json::object();
    j.set("runBestHard", Json{static_cast<long long>(runHard[i])});
    j.set("runBestObjective", Json{runObj[i]});
    j.set("runBestSoft", Json{static_cast<long long>(runSoft[i])});
    j.set("seconds", Json{t.seconds});
    j.set("worker", Json{t.worker});
    j.set("moves", Json{static_cast<long long>(t.moves)});
    j.set("phase", Json{t.phase});
    j.set("hard", Json{static_cast<long long>(t.hard)});
    j.set("objective", Json{t.objective});
    j.set("surrogate", Json{t.surrogate});
    j.set("soft", Json{static_cast<long long>(t.soft)});
    j.set("lecturerConflicts", Json{static_cast<long long>(t.lecConflicts)});
    j.set("groupConflicts", Json{static_cast<long long>(t.grpConflicts)});
    j.set("roomConflicts", Json{static_cast<long long>(t.roomConflicts)});
    j.set("groupTravel", Json{static_cast<long long>(t.grpTravel)});
    j.set("lecturerTravel", Json{static_cast<long long>(t.lecTravel)});
    j.set("abstractRoomOverflow", Json{static_cast<long long>(t.absOverflow)});
    j.set("lecturerWindows", Json{static_cast<long long>(t.lecWindows)});
    j.set("groupWindows", Json{static_cast<long long>(t.grpWindows)});
    j.set("mixedOnlineDays", Json{static_cast<long long>(t.mixedDays)});
    out << j.dump() << '\n';
  }
}

}  // namespace tg
