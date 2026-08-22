// The schedule, its occupancy index, and the incremental evaluation of the nine Π terms.
//
// Every counter the objective reads is kept as the sum of a per-bucket statistic, where a bucket is
// one (entity, day) — one lecturer's Monday, one group's Thursday, one room's Friday, one shared
// place's Tuesday. A move dirties the handful of buckets it touches, their cached statistics are
// subtracted, the placement changes, and only those buckets are recomputed. The cost of a candidate
// therefore depends on how crowded the days it touches are and not at all on the size of the
// faculty — which is the property that lets a one-hour budget buy the same number of moves on a
// 400-class instance and on a 31 000-class one.
//
// The arithmetic is the same as `scripts/timetable-bench/validate.mjs`, deliberately: the harness
// re-reads every schedule this produces from scratch and the two numbers have to agree.
#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

#include "model.hpp"

namespace tg {

/// β from TIMETABLE-GENERATION.md §1.2. α is 2 for every term.
struct Weights {
  double lecturerConflicts = 150;
  double groupConflicts = 100;
  double roomConflicts = 50;
  double groupTravel = 90;
  double lecturerTravel = 120;
  double abstractRoomOverflow = 50;
  double lecturerWindows = 5;
  double groupWindows = 20;
  double mixedOnlineDays = 30;
};

/// The nine Π counters. Windows and mixed days are held in half-units because each is averaged
/// over the two calendar weeks, and halves keep the running total exact.
struct Counters {
  int64_t lecConflicts = 0;
  int64_t grpConflicts = 0;
  int64_t roomConflicts = 0;
  int64_t grpTravel = 0;
  int64_t lecTravel = 0;
  int64_t absOverflow = 0;
  int64_t lecWinHalves = 0;
  int64_t grpWinHalves = 0;
  int64_t mixedHalves = 0;

  int64_t hard() const {
    return lecConflicts + grpConflicts + roomConflicts + grpTravel + lecTravel + absOverflow;
  }
};

/// What one (entity, day) bucket contributes. Which fields are live depends on the family.
///
/// `occNum` / `occDen` are the union of the masks of everything in the bucket in each calendar
/// week. They are what makes the window term cheap to *probe*: the cost of adding one more class to
/// this entity's day is `popcount(span(occ|m) & ~(occ|m) & bells)` against the stored count, which
/// is a handful of instructions and needs no scan of the bucket at all.
struct BucketStat {
  int32_t conflicts = 0;
  int32_t travel = 0;
  int32_t winNum = 0;
  int32_t winDen = 0;
  int32_t mixNum = 0;
  int32_t mixDen = 0;
  int32_t overflow = 0;
  Mask occNum;
  Mask occDen;
};

enum BucketFamily : uint8_t { kFamLec = 0, kFamGrp = 1, kFamRoom = 2, kFamAbs = 3 };

/// A gene's placement, for journalling and undo.
struct Spot {
  int day = -1;
  int timeIdx = -1;
  int room = -1;
  uint8_t parity = kWeekly;
};

class State {
 public:
  explicit State(const Problem& problem);

  const Problem& problem() const { return p_; }
  const std::vector<Gene>& genes() const { return genes_; }
  const Gene& gene(int i) const { return genes_[static_cast<size_t>(i)]; }
  const Counters& counters() const { return c_; }

  Spot spotOf(int i) const {
    const Gene& g = genes_[static_cast<size_t>(i)];
    return Spot{g.day, g.timeIdx, g.room, g.parity};
  }

  // ── placement ─────────────────────────────────────────────────────────────
  /// Moves one gene and brings every counter back into step. Use `placeRaw` + `flush` when several
  /// genes move as one candidate, so the shared buckets are recomputed once instead of per gene.
  void place(int i, int day, int timeIdx, int parity, int room) {
    placeRaw(i, day, timeIdx, parity, room);
    flush();
  }
  void placeRaw(int i, int day, int timeIdx, int parity, int room);
  void placeRaw(int i, const Spot& s) { placeRaw(i, s.day, s.timeIdx, s.parity, s.room); }
  void flush();

  /// Rebuilds every bucket and every counter from the genes. O(V·E) — used after construction and
  /// after a perturbation that touches too much for the dirty-bucket bookkeeping to pay.
  void rebuild();

  // ── hard rules that are not clashes ──────────────────────────────────────
  /// Room time rules and MAX_CLASSES_PER_DAY. The domains carry everything else.
  bool placementAllowed(int i, int day, int timeIdx, int parity, int room) const;

  // ── objective ─────────────────────────────────────────────────────────────
  /// The smooth surrogate the search descends: Σ βᵢ·Πᵢ², with the averaged terms unrounded.
  double surrogate() const;
  /// Πᵢ..Π₆ summed — the terms a schedule has to satisfy to be usable at all.
  int64_t hard() const { return c_.hard(); }
  /// Movable classes with no placement at all. Nothing in f(σ) counts a missing class — the
  /// objective is silent about it — so the search prices it separately and steeply, or a large
  /// neighbourhood that cannot put a class back would look like an improvement.
  int unplacedMovable() const { return unplaced_; }
  /// f(σ) as the validator computes it, with the averaged terms rounded. For reporting.
  double objective() const;

  const Weights& weights() const { return w_; }

  /// Buckets recomputed since the state was built — a free, monotone proxy for how much work a
  /// candidate cost, which is what the operator bandit divides its reward by.
  uint64_t work() const { return work_; }

  // ── conflict inspection, for the search ──────────────────────────────────
  /// Movable genes currently taking part in a hard violation.
  void collectHot(std::vector<int>& out) const;
  /// Movable genes sitting in an (entity, day) that has a window or a mixed online day — the soft
  /// phase's analogue of the hot list, and the reason a feasible run does not spend its budget
  /// polishing the 95%% of the timetable that is already gap-free.
  void collectWarm(std::vector<int>& out) const;
  /// The (entity, day) buckets with the largest window cost, as bucket ids.
  void worstWindowBuckets(std::vector<size_t>& out, size_t limit) const;
  /// The movable members of one bucket, by id.
  void bucketMembers(size_t bid, std::vector<int>& out) const;
  /// Which day a bucket id belongs to. The stride is 8 so that a day (1…7) indexes a row directly.
  static int bucketDay(size_t bid) { return static_cast<int>(bid % kDayStride); }
  /// How many clashes gene `i` would have at (day, mask, parity, room) — self excluded.
  int clashCountAt(int i, int day, const Mask& mask, int parity, int room) const;
  /// The first movable gene contesting `room` at (day, mask, parity), or -1.
  int occupantOf(int self, int day, const Mask& mask, int parity, int room) const;
  /// Clashes gene `i` would have with its lecturers and groups at (day, mask, parity) — the part
  /// of `clashCountAt` that does not depend on the room, so a room scan can hoist it out.
  int peopleClashesAt(int i, int day, const Mask& mask, int parity) const;
  /// Clashes with whatever is already in `room` at (day, mask, parity).
  int roomClashesAt(int self, int day, const Mask& mask, int parity, int room) const;
  /// What placing gene `i` at (day, parity, mask) would add to the weighted window cost — exact,
  /// computed from the cached per-bucket occupancy masks in O(lecturers + groups).
  double windowCostOfAdding(int i, int day, int parity, const Mask& mask) const;
  /// Travel violations gene `i` would create in its own lecturer and group buckets if it sat at
  /// (day, mask, parity) in `room`.
  int travelCostOfAdding(int i, int day, const Mask& mask, int parity, int room) const;

  int windowsOf(const Mask& occ) const {
    return occ.empty() ? 0 : (occ.span() & ~occ & p_.bellStartTicks).popcount();
  }

  /// The bell start ticks this bucket left idle between its first and last class, in one calendar
  /// week — the вікна themselves, as a mask. What a window-directed move aims at.
  Mask holesOf(size_t bid, int week) const {
    const BucketStat& s = stats_[bid];
    const Mask& occ = week == 1 ? s.occNum : s.occDen;
    if (occ.empty()) return Mask{};
    return occ.span() & ~occ & p_.bellStartTicks;
  }
  /// The tick index a bell start occupies, or -1. Used to turn a hole back into a placement.
  int tickOfMinute(int minute) const {
    const auto it = std::lower_bound(p_.ticks.begin(), p_.ticks.end(), minute);
    if (it == p_.ticks.end() || *it != minute) return -1;
    return static_cast<int>(it - p_.ticks.begin());
  }

  const std::vector<int32_t>& lecBucket(int l, int d) const { return buckets_[lecBase_ + static_cast<size_t>(l) * kDayStride + static_cast<size_t>(d)]; }
  const std::vector<int32_t>& grpBucket(int g, int d) const { return buckets_[grpBase_ + static_cast<size_t>(g) * kDayStride + static_cast<size_t>(d)]; }
  const std::vector<int32_t>& roomBucket(int r, int d) const { return buckets_[roomBase_ + static_cast<size_t>(r) * kDayStride + static_cast<size_t>(d)]; }

  // ── snapshots ─────────────────────────────────────────────────────────────
  void snapshotInto(std::vector<Spot>& out) const;
  void restore(const std::vector<Spot>& in);

 private:
  size_t lecBucketId(int l, int d) const { return lecBase_ + static_cast<size_t>(l) * kDayStride + static_cast<size_t>(d); }
  size_t grpBucketId(int g, int d) const { return grpBase_ + static_cast<size_t>(g) * kDayStride + static_cast<size_t>(d); }
  size_t roomBucketId(int r, int d) const { return roomBase_ + static_cast<size_t>(r) * kDayStride + static_cast<size_t>(d); }
  size_t absBucketId(int a, int d) const { return absBase_ + static_cast<size_t>(a) * kDayStride + static_cast<size_t>(d); }

  void touch(size_t bid);
  void touchAll(int i, int day, int room);
  void addStat(size_t bid, const BucketStat& s, int sign);
  BucketStat recompute(size_t bid) const;
  void insertInto(int i);
  void removeFrom(int i);

  const Problem& p_;
  std::vector<Gene> genes_;
  std::vector<std::vector<int32_t>> buckets_;
  std::vector<BucketStat> stats_;
  std::vector<size_t> dirty_;
  std::vector<uint8_t> isDirty_;
  Counters c_;
  Weights w_;
  uint64_t work_ = 0;
  int unplaced_ = 0;
  size_t lecBase_ = 0, grpBase_ = 0, roomBase_ = 0, absBase_ = 0;
};

}  // namespace tg
