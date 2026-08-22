#include "state.hpp"

#include <algorithm>
#include <cmath>

namespace tg {

State::State(const Problem& problem) : p_(problem), genes_(problem.genes) {
  lecBase_ = 0;
  grpBase_ = lecBase_ + static_cast<size_t>(p_.nLecturers) * kDayStride;
  roomBase_ = grpBase_ + static_cast<size_t>(p_.nGroups) * kDayStride;
  absBase_ = roomBase_ + static_cast<size_t>(p_.nRooms) * kDayStride;
  const size_t total = absBase_ + static_cast<size_t>(p_.nAbstract) * kDayStride;
  buckets_.assign(total, {});
  stats_.assign(total, BucketStat{});
  isDirty_.assign(total, 0);
  dirty_.reserve(64);
  rebuild();
}

void State::insertInto(int i) {
  const Gene& g = genes_[static_cast<size_t>(i)];
  const int d = g.day;
  for (int k = 0; k < g.lecCount; ++k) {
    buckets_[lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], d)].push_back(i);
  }
  for (int k = 0; k < g.grpCount; ++k) {
    buckets_[grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], d)].push_back(i);
  }
  if (g.room >= 0) buckets_[roomBucketId(g.room, d)].push_back(i);
  if (g.abstractRoom >= 0) buckets_[absBucketId(g.abstractRoom, d)].push_back(i);
}

void State::removeFrom(int i) {
  const Gene& g = genes_[static_cast<size_t>(i)];
  const int d = g.day;
  const auto drop = [i](std::vector<int32_t>& v) {
    for (size_t k = 0; k < v.size(); ++k) {
      if (v[k] == i) {
        v[k] = v.back();
        v.pop_back();
        return;
      }
    }
  };
  for (int k = 0; k < g.lecCount; ++k) drop(buckets_[lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], d)]);
  for (int k = 0; k < g.grpCount; ++k) drop(buckets_[grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], d)]);
  if (g.room >= 0) drop(buckets_[roomBucketId(g.room, d)]);
  if (g.abstractRoom >= 0) drop(buckets_[absBucketId(g.abstractRoom, d)]);
}

void State::addStat(size_t bid, const BucketStat& s, int sign) {
  if (bid < grpBase_) {
    c_.lecConflicts += sign * s.conflicts;
    c_.lecTravel += sign * s.travel;
    c_.lecWinHalves += sign * (s.winNum + s.winDen);
  } else if (bid < roomBase_) {
    c_.grpConflicts += sign * s.conflicts;
    c_.grpTravel += sign * s.travel;
    c_.grpWinHalves += sign * (s.winNum + s.winDen);
    c_.mixedHalves += sign * (s.mixNum + s.mixDen);
  } else if (bid < absBase_) {
    c_.roomConflicts += sign * s.conflicts;
  } else {
    c_.absOverflow += sign * s.overflow;
  }
}

BucketStat State::recompute(size_t bid) const {
  BucketStat out;
  const std::vector<int32_t>& b = buckets_[bid];
  if (b.empty()) return out;

  if (bid >= absBase_) {
    const int a = static_cast<int>((bid - absBase_) / kDayStride);
    const int cap = p_.abstractCapacity[static_cast<size_t>(a)];
    if (cap < 0) return out;
    // The sum of a set of intervals peaks at one of their starts, so testing every distinct start
    // instant finds every breach. Charged once per instant, not once per class in it. The two
    // calendar weeks are walked separately and — unlike the window terms — not averaged: a weekly
    // class over capacity is over it every week.
    std::vector<int> here;
    std::vector<int> starts;
    here.reserve(b.size());
    starts.reserve(b.size());
    for (int week = 1; week <= 2; ++week) {
      here.clear();
      starts.clear();
      for (int32_t idx : b) {
        const Gene& g = genes_[static_cast<size_t>(idx)];
        if (!inWeek(g.parity, week)) continue;
        here.push_back(idx);
        starts.push_back(g.start);
      }
      if (here.empty()) continue;
      std::sort(starts.begin(), starts.end());
      starts.erase(std::unique(starts.begin(), starts.end()), starts.end());
      for (int t : starts) {
        int sum = 0;
        for (int32_t idx : here) {
          const Gene& g = genes_[static_cast<size_t>(idx)];
          if (g.start <= t && t < g.end) sum += g.students;
        }
        if (sum > cap) ++out.overflow;
      }
    }
    return out;
  }

  const bool isRoom = bid >= roomBase_;
  const bool isGrp = !isRoom && bid >= grpBase_;

  // Π₁/Π₂/Π₃ and, for the two people families, Π₄/Π₅.
  const bool wantTravel = !isRoom && p_.travelKnown;
  for (size_t x = 0; x < b.size(); ++x) {
    const Gene& a = genes_[static_cast<size_t>(b[x])];
    for (size_t y = x + 1; y < b.size(); ++y) {
      const Gene& c = genes_[static_cast<size_t>(b[y])];
      if (!weeksOverlap(a.parity, c.parity)) continue;
      if (a.mask.intersects(c.mask)) { ++out.conflicts; continue; }
      if (!wantTravel) continue;
      // Order the pair in time first: building_travel_times is directed and the two directions
      // routinely disagree, so reading the journey in the bucket's arbitrary order would score
      // roughly half of all cross-building pairs against the wrong figure.
      const Gene& f = a.start <= c.start ? a : c;
      const Gene& l = a.start <= c.start ? c : a;
      const int need = p_.journeyMinutes(f, l);
      if (need <= 0) continue;
      if (l.start - f.end < need) ++out.travel;
    }
  }

  if (isRoom) return out;

  // Π₇/Π₈ — a вікно is a whole пара the entity was free for. The union of the day's occupied
  // elementary intervals, spanned from first to last, minus what is occupied, intersected with the
  // bell starts: exactly the ticks nobody used.
  for (int week = 1; week <= 2; ++week) {
    Mask occ;
    bool anyOnline = false;
    bool anyInPlace = false;
    for (int32_t idx : b) {
      const Gene& g = genes_[static_cast<size_t>(idx)];
      if (!inWeek(g.parity, week)) continue;
      occ |= g.mask;
      if (isGrp) {
        if (g.placeKind == kPlaceOnline) anyOnline = true;
        else anyInPlace = true;
      }
    }
    const int w = occ.empty() ? 0 : (occ.span() & ~occ & p_.bellStartTicks).popcount();
    if (week == 1) { out.winNum = w; out.occNum = occ; } else { out.winDen = w; out.occDen = occ; }
    if (isGrp && anyOnline && anyInPlace) {
      if (week == 1) out.mixNum = 1; else out.mixDen = 1;
    }
  }
  return out;
}

void State::touch(size_t bid) {
  if (isDirty_[bid]) return;
  isDirty_[bid] = 1;
  dirty_.push_back(bid);
  addStat(bid, stats_[bid], -1);
}

void State::touchAll(int i, int day, int room) {
  if (day < 0) return;
  const Gene& g = genes_[static_cast<size_t>(i)];
  for (int k = 0; k < g.lecCount; ++k) touch(lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], day));
  for (int k = 0; k < g.grpCount; ++k) touch(grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], day));
  if (room >= 0) touch(roomBucketId(room, day));
  if (g.abstractRoom >= 0) touch(absBucketId(g.abstractRoom, day));
}

void State::placeRaw(int i, int day, int timeIdx, int parity, int room) {
  Gene& g = genes_[static_cast<size_t>(i)];
  if (g.movable) {
    if (g.day >= 0 && day < 0) ++unplaced_;
    else if (g.day < 0 && day >= 0) --unplaced_;
  }
  touchAll(i, g.day, g.room);
  touchAll(i, day, room);
  if (g.day >= 0) removeFrom(i);
  g.day = day;
  g.timeIdx = timeIdx;
  g.parity = static_cast<uint8_t>(parity);
  g.room = room;
  g.building = p_.buildingFor(g, room);
  g.start = timeIdx >= 0 ? p_.times[static_cast<size_t>(timeIdx)].startMinutes : -1;
  g.end = g.start >= 0 ? g.start + g.durationMinutes : -1;
  g.mask = timeIdx >= 0 ? p_.maskAt(timeIdx, g.durSlot) : Mask{};
  if (day >= 0) insertInto(i);
}

void State::flush() {
  work_ += dirty_.size();
  for (size_t bid : dirty_) {
    stats_[bid] = recompute(bid);
    addStat(bid, stats_[bid], +1);
    isDirty_[bid] = 0;
  }
  dirty_.clear();
}

void State::rebuild() {
  for (auto& b : buckets_) b.clear();
  unplaced_ = 0;
  for (const Gene& g : genes_) {
    if (g.movable && g.day < 0) ++unplaced_;
  }
  for (size_t i = 0; i < genes_.size(); ++i) {
    if (genes_[i].day >= 0) insertInto(static_cast<int>(i));
  }
  c_ = Counters{};
  for (size_t bid = 0; bid < buckets_.size(); ++bid) {
    stats_[bid] = recompute(bid);
    addStat(bid, stats_[bid], +1);
    isDirty_[bid] = 0;
  }
  dirty_.clear();
}

bool State::placementAllowed(int i, int day, int timeIdx, int parity, int room) const {
  const Gene& g = genes_[static_cast<size_t>(i)];
  const int start = p_.times[static_cast<size_t>(timeIdx)].startMinutes;
  const int end = start + g.durationMinutes;
  if (room >= 0 && !p_.roomRules[static_cast<size_t>(room) * kDayStride + day].allows(start, end)) return false;

  // MAX_CLASSES_PER_DAY counts per calendar week, not per row: WEEKLY falls in both and
  // NUMERATOR/DENOMINATOR in one each, so the cap must hold for (WEEKLY + NUMERATOR) and for
  // (WEEKLY + DENOMINATOR) separately.
  const auto exceeds = [&](const std::vector<int32_t>& bucket, int cap) {
    if (cap < 0) return false;
    int num = (parity == kWeekly || parity == kNumerator) ? 1 : 0;
    int den = (parity == kWeekly || parity == kDenominator) ? 1 : 0;
    for (int32_t j : bucket) {
      if (j == i) continue;
      const uint8_t pj = genes_[static_cast<size_t>(j)].parity;
      if (pj == kWeekly || pj == kNumerator) ++num;
      if (pj == kWeekly || pj == kDenominator) ++den;
    }
    return num > cap || den > cap;
  };

  for (int k = 0; k < g.lecCount; ++k) {
    const int l = p_.lecPool[static_cast<size_t>(g.lecFrom + k)];
    const int cap = p_.lecturerRules[static_cast<size_t>(l) * kDayStride + day].maxPerDay;
    if (cap >= 0 && exceeds(buckets_[lecBucketId(l, day)], cap)) return false;
  }
  for (int k = 0; k < g.grpCount; ++k) {
    const int gr = p_.grpPool[static_cast<size_t>(g.grpFrom + k)];
    const int cap = p_.groupRules[static_cast<size_t>(gr) * kDayStride + day].maxPerDay;
    if (cap >= 0 && exceeds(buckets_[grpBucketId(gr, day)], cap)) return false;
  }
  if (room >= 0) {
    const int cap = p_.roomRules[static_cast<size_t>(room) * kDayStride + day].maxPerDay;
    if (cap >= 0 && exceeds(buckets_[roomBucketId(room, day)], cap)) return false;
  }
  return true;
}

double State::surrogate() const {
  const auto sq = [](double x) { return x * x; };
  return w_.lecturerConflicts * sq(static_cast<double>(c_.lecConflicts)) +
         w_.groupConflicts * sq(static_cast<double>(c_.grpConflicts)) +
         w_.roomConflicts * sq(static_cast<double>(c_.roomConflicts)) +
         w_.groupTravel * sq(static_cast<double>(c_.grpTravel)) +
         w_.lecturerTravel * sq(static_cast<double>(c_.lecTravel)) +
         w_.abstractRoomOverflow * sq(static_cast<double>(c_.absOverflow)) +
         w_.lecturerWindows * sq(static_cast<double>(c_.lecWinHalves) / 2.0) +
         w_.groupWindows * sq(static_cast<double>(c_.grpWinHalves) / 2.0) +
         w_.mixedOnlineDays * sq(static_cast<double>(c_.mixedHalves) / 2.0);
}

double State::objective() const {
  const auto sq = [](double x) { return x * x; };
  const double lw = std::round(static_cast<double>(c_.lecWinHalves) / 2.0);
  const double gw = std::round(static_cast<double>(c_.grpWinHalves) / 2.0);
  const double mx = std::round(static_cast<double>(c_.mixedHalves) / 2.0);
  return w_.lecturerConflicts * sq(static_cast<double>(c_.lecConflicts)) +
         w_.groupConflicts * sq(static_cast<double>(c_.grpConflicts)) +
         w_.roomConflicts * sq(static_cast<double>(c_.roomConflicts)) +
         w_.groupTravel * sq(static_cast<double>(c_.grpTravel)) +
         w_.lecturerTravel * sq(static_cast<double>(c_.lecTravel)) +
         w_.abstractRoomOverflow * sq(static_cast<double>(c_.absOverflow)) +
         w_.lecturerWindows * sq(lw) + w_.groupWindows * sq(gw) + w_.mixedOnlineDays * sq(mx);
}

void State::collectHot(std::vector<int>& out) const {
  out.clear();
  for (size_t bid = 0; bid < buckets_.size(); ++bid) {
    const BucketStat& s = stats_[bid];
    if (s.conflicts == 0 && s.travel == 0 && s.overflow == 0) continue;
    for (int32_t j : buckets_[bid]) {
      if (genes_[static_cast<size_t>(j)].movable) out.push_back(j);
    }
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
}

int State::clashCountAt(int i, int day, const Mask& mask, int parity, int room) const {
  const Gene& g = genes_[static_cast<size_t>(i)];
  int n = 0;
  const auto scan = [&](const std::vector<int32_t>& b) {
    for (int32_t j : b) {
      if (j == i) continue;
      const Gene& o = genes_[static_cast<size_t>(j)];
      if (!weeksOverlap(static_cast<uint8_t>(parity), o.parity)) continue;
      if (mask.intersects(o.mask)) ++n;
    }
  };
  for (int k = 0; k < g.lecCount; ++k) scan(buckets_[lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], day)]);
  for (int k = 0; k < g.grpCount; ++k) scan(buckets_[grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], day)]);
  if (room >= 0) scan(buckets_[roomBucketId(room, day)]);
  return n;
}

int State::peopleClashesAt(int i, int day, const Mask& mask, int parity) const {
  const Gene& g = genes_[static_cast<size_t>(i)];
  int n = 0;
  const auto scan = [&](const std::vector<int32_t>& b) {
    for (int32_t j : b) {
      if (j == i) continue;
      const Gene& o = genes_[static_cast<size_t>(j)];
      if (!weeksOverlap(static_cast<uint8_t>(parity), o.parity)) continue;
      if (mask.intersects(o.mask)) ++n;
    }
  };
  for (int k = 0; k < g.lecCount; ++k) scan(buckets_[lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], day)]);
  for (int k = 0; k < g.grpCount; ++k) scan(buckets_[grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], day)]);
  return n;
}

int State::roomClashesAt(int self, int day, const Mask& mask, int parity, int room) const {
  if (room < 0) return 0;
  int n = 0;
  for (int32_t j : buckets_[roomBucketId(room, day)]) {
    if (j == self) continue;
    const Gene& o = genes_[static_cast<size_t>(j)];
    if (!weeksOverlap(static_cast<uint8_t>(parity), o.parity)) continue;
    if (mask.intersects(o.mask)) ++n;
  }
  return n;
}

double State::windowCostOfAdding(int i, int day, int parity, const Mask& mask) const {
  const Gene& g = genes_[static_cast<size_t>(i)];
  double add = 0;
  const auto probe = [&](size_t bid, double weight) {
    const BucketStat& s = stats_[bid];
    if (parity == kWeekly || parity == kNumerator) {
      add += weight * (windowsOf(s.occNum | mask) - s.winNum);
    }
    if (parity == kWeekly || parity == kDenominator) {
      add += weight * (windowsOf(s.occDen | mask) - s.winDen);
    }
  };
  for (int k = 0; k < g.lecCount; ++k) probe(lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], day), w_.lecturerWindows);
  for (int k = 0; k < g.grpCount; ++k) probe(grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], day), w_.groupWindows);
  return add;
}

int State::travelCostOfAdding(int i, int day, const Mask& mask, int parity, int room) const {
  if (!p_.travelKnown) return 0;
  Gene probe = genes_[static_cast<size_t>(i)];
  probe.room = room;
  probe.building = p_.buildingFor(probe, room);
  probe.mask = mask;
  probe.parity = static_cast<uint8_t>(parity);
  probe.start = 0;
  // The start/end are needed for the gap arithmetic; derive them from the mask's tick span.
  const int lo = mask.empty() ? 0 : mask.lowest();
  const int hi = mask.empty() ? 0 : mask.highest();
  probe.start = p_.ticks[static_cast<size_t>(lo)];
  probe.end = p_.ticks[static_cast<size_t>(std::min<int>(hi + 1, p_.tickCount - 1))];

  int n = 0;
  const Gene& g = genes_[static_cast<size_t>(i)];
  const auto scan = [&](const std::vector<int32_t>& b) {
    for (int32_t j : b) {
      if (j == i) continue;
      const Gene& o = genes_[static_cast<size_t>(j)];
      if (!weeksOverlap(probe.parity, o.parity)) continue;
      if (probe.mask.intersects(o.mask)) continue;
      const Gene& f = probe.start <= o.start ? probe : o;
      const Gene& l = probe.start <= o.start ? o : probe;
      const int need = p_.journeyMinutes(f, l);
      if (need > 0 && l.start - f.end < need) ++n;
    }
  };
  for (int k = 0; k < g.lecCount; ++k) scan(buckets_[lecBucketId(p_.lecPool[static_cast<size_t>(g.lecFrom + k)], day)]);
  for (int k = 0; k < g.grpCount; ++k) scan(buckets_[grpBucketId(p_.grpPool[static_cast<size_t>(g.grpFrom + k)], day)]);
  return n;
}

int State::occupantOf(int self, int day, const Mask& mask, int parity, int room) const {
  if (room < 0) return -1;
  for (int32_t j : buckets_[roomBucketId(room, day)]) {
    if (j == self) continue;
    const Gene& o = genes_[static_cast<size_t>(j)];
    if (!o.movable) continue;
    if (!weeksOverlap(static_cast<uint8_t>(parity), o.parity)) continue;
    if (mask.intersects(o.mask)) return j;
  }
  return -1;
}


void State::collectWarm(std::vector<int>& out) const {
  out.clear();
  for (size_t bid = 0; bid < absBase_; ++bid) {
    if (bid >= roomBase_) break;  // rooms have no window term
    const BucketStat& s = stats_[bid];
    if (s.winNum == 0 && s.winDen == 0 && s.mixNum == 0 && s.mixDen == 0) continue;
    for (int32_t j : buckets_[bid]) {
      if (genes_[static_cast<size_t>(j)].movable) out.push_back(j);
    }
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
}

void State::worstWindowBuckets(std::vector<size_t>& out, size_t limit) const {
  out.clear();
  std::vector<std::pair<int, size_t>> scored;
  for (size_t bid = 0; bid < roomBase_; ++bid) {
    const BucketStat& s = stats_[bid];
    const int w = s.winNum + s.winDen;
    if (w == 0) continue;
    // A group window is worth four lecturer windows in β, so the list is ordered by what the
    // objective actually charges rather than by the raw count.
    const int weighted = bid >= grpBase_ ? w * 4 : w;
    scored.emplace_back(-weighted, bid);
  }
  std::sort(scored.begin(), scored.end());
  for (size_t k = 0; k < scored.size() && k < limit; ++k) out.push_back(scored[k].second);
}

void State::bucketMembers(size_t bid, std::vector<int>& out) const {
  out.clear();
  for (int32_t j : buckets_[bid]) {
    if (genes_[static_cast<size_t>(j)].movable) out.push_back(j);
  }
}

void State::snapshotInto(std::vector<Spot>& out) const {
  out.resize(genes_.size());
  for (size_t i = 0; i < genes_.size(); ++i) out[i] = spotOf(static_cast<int>(i));
}

void State::restore(const std::vector<Spot>& in) {
  for (int i : p_.movable) {
    const Spot& s = in[static_cast<size_t>(i)];
    const Gene& g = genes_[static_cast<size_t>(i)];
    if (g.day == s.day && g.timeIdx == s.timeIdx && g.room == s.room && g.parity == s.parity) continue;
    placeRaw(i, s.day, s.timeIdx, s.parity, s.room);
  }
  flush();
}

}  // namespace tg
