#include "instance_io.hpp"

#include "state.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <set>
#include <stdexcept>

namespace tg {
namespace {

int parseMinutes(const std::string& hhmm) {
  if (hhmm.size() < 4) return -1;
  int h = 0, m = 0;
  size_t i = 0;
  if (!std::isdigit(static_cast<unsigned char>(hhmm[0]))) return -1;
  while (i < hhmm.size() && std::isdigit(static_cast<unsigned char>(hhmm[i]))) h = h * 10 + (hhmm[i++] - '0');
  if (i >= hhmm.size() || hhmm[i] != ':') return -1;
  ++i;
  while (i < hhmm.size() && std::isdigit(static_cast<unsigned char>(hhmm[i]))) m = m * 10 + (hhmm[i++] - '0');
  return h * 60 + m;
}

/// The benchmark archives write a pair as a two-element array; the service writes it as an object
/// with named fields. Both are read here rather than converted by whichever caller happens to be
/// second, so there is exactly one loader and it cannot drift from either producer.
const std::string& pairFirst(const Json& v) {
  if (v.isArray()) return v[0].asString();
  if (v.has("roomId")) return v["roomId"].asString();
  if (v.has("subjectId")) return v["subjectId"].asString();
  return v["id"].asString();
}

const std::string& pairSecond(const Json& v) {
  if (v.isArray()) return v[1].asString();
  return v["buildingId"].asString();
}

/// A directed walk, written either as `"from>to"` or as a pair of named ids.
bool travelPair(const Json& v, std::string& from, std::string& to) {
  if (v.isArray()) {
    const std::string& k = v[0].asString();
    const size_t gt = k.find('>');
    if (gt == std::string::npos) return false;
    from = k.substr(0, gt);
    to = k.substr(gt + 1);
    return true;
  }
  from = v["fromBuildingId"].asString();
  to = v["toBuildingId"].asString();
  return !from.empty() && !to.empty();
}

uint8_t parityCode(const std::string& s) {
  if (s == "NUMERATOR") return kNumerator;
  if (s == "DENOMINATOR") return kDenominator;
  return kWeekly;
}

/// Interns strings to dense indices, in first-seen order.
class Interner {
 public:
  int get(const std::string& s) {
    auto it = map_.find(s);
    if (it != map_.end()) return it->second;
    const int id = static_cast<int>(names_.size());
    map_.emplace(s, id);
    names_.push_back(s);
    return id;
  }
  int find(const std::string& s) const {
    auto it = map_.find(s);
    return it == map_.end() ? -1 : it->second;
  }
  int size() const { return static_cast<int>(names_.size()); }
  const std::vector<std::string>& names() const { return names_; }

 private:
  std::unordered_map<std::string, int> map_;
  std::vector<std::string> names_;
};

/// "More specific wins": a day-specific row overrides the every-day row of the same type, except
/// UNAVAILABLE windows, which accumulate. Mirrors `resolveRules` in the TypeScript solver, which in
/// turn mirrors the rule schema.sql states.
std::vector<DayRules> resolveRules(const Json& rows) {
  std::vector<DayRules> out(kDayStride);
  if (!rows.isArray() || rows.size() == 0) return out;

  static const char* kScalarTypes[] = {"NOT_BEFORE", "NOT_AFTER", "MAX_CLASSES_PER_DAY"};
  for (const char* type : kScalarTypes) {
    const Json* general = nullptr;
    for (const auto& c : rows.items()) {
      if (c["type"].asString() == type && c["dayOfWeek"].isNull()) { general = &c; break; }
    }
    for (int d = 1; d <= 7; ++d) {
      const Json* row = general;
      for (const auto& c : rows.items()) {
        if (c["type"].asString() == type && !c["dayOfWeek"].isNull() && c["dayOfWeek"].asInt() == d) {
          row = &c;
          break;
        }
      }
      if (!row) continue;
      DayRules& r = out[static_cast<size_t>(d)];
      const std::string& v = (*row)["value"].asString();
      if (std::string(type) == "NOT_BEFORE") {
        r.notBefore = parseMinutes(v);
      } else if (std::string(type) == "NOT_AFTER") {
        const int mv = parseMinutes(v);
        r.notAfter = mv < 0 ? std::numeric_limits<int>::max() : mv;
      } else {
        const long n = std::strtol(v.c_str(), nullptr, 10);
        r.maxPerDay = n >= 0 ? static_cast<int>(n) : -1;
      }
    }
  }

  for (const auto& c : rows.items()) {
    if (c["type"].asString() != "UNAVAILABLE") continue;
    const std::string& v = c["value"].asString();
    const size_t dash = v.find('-');
    if (dash == std::string::npos) continue;
    const int from = parseMinutes(v.substr(0, dash));
    const int to = parseMinutes(v.substr(dash + 1));
    if (from < 0 || to < 0) continue;
    if (c["dayOfWeek"].isNull()) {
      for (int d = 1; d <= 7; ++d) {
        out[static_cast<size_t>(d)].windows.push_back(from);
        out[static_cast<size_t>(d)].windows.push_back(to);
      }
    } else {
      const int d = c["dayOfWeek"].asInt();
      if (d >= 1 && d < kDayStride) {
        out[static_cast<size_t>(d)].windows.push_back(from);
        out[static_cast<size_t>(d)].windows.push_back(to);
      }
    }
  }
  return out;
}

void loadRuleTable(const Json& pairs, const Interner& subjects, std::vector<DayRules>& out) {
  out.assign(static_cast<size_t>(subjects.size()) * kDayStride, DayRules{});
  if (!pairs.isArray()) return;
  for (const auto& entry : pairs.items()) {
    const int id = subjects.find(pairFirst(entry));
    if (id < 0) continue;
    std::vector<DayRules> rules = resolveRules(entry.isObject() ? entry["constraints"] : entry[1]);
    for (int d = 0; d < kDayStride; ++d) {
      out[static_cast<size_t>(id) * kDayStride + static_cast<size_t>(d)] = std::move(rules[static_cast<size_t>(d)]);
    }
  }
}

}  // namespace

Problem loadProblem(const Json& j) {
  Problem p;
  p.academicHourMinutes = j["academicHourMinutes"].isNumber() ? j["academicHourMinutes"].asInt() : 40;
  if (p.academicHourMinutes <= 0) p.academicHourMinutes = 40;

  for (const auto& d : j["days"].items()) p.days.push_back(d.asInt());
  if (p.days.empty()) p.days = {1, 2, 3, 4, 5, 6};

  // ── class times, sorted by start; the sets keep their own ordinals ──────────────────────────
  Interner sets;
  {
    struct Raw { std::string id; int set; int start; };
    std::vector<Raw> raw;
    for (const auto& t : j["classTimes"].items()) {
      raw.push_back({t["id"].asString(), sets.get(t["setId"].asString()), parseMinutes(t["startTime"].asString())});
    }
    std::stable_sort(raw.begin(), raw.end(), [](const Raw& a, const Raw& b) { return a.start < b.start; });
    p.timesBySet.assign(static_cast<size_t>(sets.size()), {});
    for (const auto& r : raw) {
      const int idx = static_cast<int>(p.times.size());
      p.times.push_back(ClassTime{r.set, r.start, r.id});
      p.timeIds.push_back(r.id);
      p.timesBySet[static_cast<size_t>(r.set)].push_back(idx);
    }
  }
  {
    std::set<int> starts;
    for (const auto& t : p.times) starts.insert(t.startMinutes);
    p.distinctStarts.assign(starts.begin(), starts.end());
  }

  // ── durations actually used, and the compressed time axis ──────────────────────────────────
  {
    std::set<int> durs;
    for (const auto& r : j["requirements"].items()) {
      durs.insert(std::max(1, r["durationHours"].asInt(1)) * p.academicHourMinutes);
    }
    for (const auto& e : j["fixedEntries"].items()) {
      durs.insert(std::max(1, e["durationHours"].asInt(1)) * p.academicHourMinutes);
    }
    if (durs.empty()) durs.insert(2 * p.academicHourMinutes);
    p.durationList.assign(durs.begin(), durs.end());

    std::set<int> tickSet;
    for (const auto& t : p.times) {
      tickSet.insert(t.startMinutes);
      for (int d : p.durationList) tickSet.insert(t.startMinutes + d);
    }
    // Fixed entries may sit on times no `classTimes` row names — an external class scheduled by
    // another faculty on a grid this problem does not carry. Their endpoints must be on the axis
    // too, or their interval would round onto the wrong elementary intervals.
    for (const auto& e : j["fixedEntries"].items()) {
      const int s = parseMinutes(e["startTime"].asString());
      if (s < 0) continue;
      tickSet.insert(s);
      tickSet.insert(s + std::max(1, e["durationHours"].asInt(1)) * p.academicHourMinutes);
    }
    p.ticks.assign(tickSet.begin(), tickSet.end());
    p.tickCount = static_cast<int>(p.ticks.size());
    if (p.tickCount > Mask::kBits) {
      throw std::runtime_error("time axis needs " + std::to_string(p.tickCount) +
                               " ticks, which exceeds the " + std::to_string(Mask::kBits) +
                               "-bit mask; widen tg::Mask");
    }
    for (int s : p.distinctStarts) {
      const auto it = std::lower_bound(p.ticks.begin(), p.ticks.end(), s);
      p.bellStartTicks.setBit(static_cast<int>(it - p.ticks.begin()));
    }
    p.timeMasks.assign(p.times.size() * p.durationList.size(), Mask{});
    for (size_t ti = 0; ti < p.times.size(); ++ti) {
      for (size_t di = 0; di < p.durationList.size(); ++di) {
        const int s = p.times[ti].startMinutes;
        const int e = s + p.durationList[di];
        const int a = static_cast<int>(std::lower_bound(p.ticks.begin(), p.ticks.end(), s) - p.ticks.begin());
        const int b = static_cast<int>(std::lower_bound(p.ticks.begin(), p.ticks.end(), e) - p.ticks.begin());
        p.timeMasks[ti * p.durationList.size() + di] = Mask::range(a, b);
      }
    }
  }
  const auto tickIndex = [&p](int minute) {
    return static_cast<int>(std::lower_bound(p.ticks.begin(), p.ticks.end(), minute) - p.ticks.begin());
  };
  const auto maskForMinutes = [&](int start, int end) { return Mask::range(tickIndex(start), tickIndex(end)); };

  // ── rooms, buildings, abstract rooms ───────────────────────────────────────────────────────
  Interner rooms, buildings, abstracts, lecturers, groups;
  std::vector<char> facultyRoom;
  for (const auto& r : j["rooms"].items()) {
    const int id = rooms.get(r.asString());
    if (static_cast<int>(facultyRoom.size()) <= id) facultyRoom.resize(static_cast<size_t>(id) + 1, 0);
    facultyRoom[static_cast<size_t>(id)] = 1;
  }
  for (const auto& r : j["requirements"].items()) {
    for (const auto& x : r["roomIds"].items()) rooms.get(x.asString());
  }
  for (const auto& e : j["fixedEntries"].items()) {
    if (e["roomId"].isString()) rooms.get(e["roomId"].asString());
  }
  for (const auto& pair : j["roomBuilding"].items()) rooms.get(pairFirst(pair));
  for (const auto& pair : j["roomConstraints"].items()) rooms.get(pairFirst(pair));

  for (const auto& a : j["abstractRooms"].items()) {
    abstracts.get(a["id"].asString());
    if (a["buildingId"].isString()) buildings.get(a["buildingId"].asString());
  }
  // A shared place named by a class but absent from `abstractRooms` still has to be interned, or
  // two classes in the *same* unlisted place would each become "an abstract room with no address"
  // and be charged the flat journey between them. The validator compares the raw id and answers
  // zero; interning every id it sees is what makes the two agree.
  for (const auto& r : j["requirements"].items()) {
    if (r["abstractRoomId"].isString()) abstracts.get(r["abstractRoomId"].asString());
  }
  for (const auto& e : j["fixedEntries"].items()) {
    if (e["abstractRoomId"].isString()) abstracts.get(e["abstractRoomId"].asString());
  }
  for (const auto& pair : j["roomBuilding"].items()) buildings.get(pairSecond(pair));
  for (const auto& pair : j["buildingTravel"].items()) {
    std::string from, to;
    if (!travelPair(pair, from, to)) continue;
    buildings.get(from);
    buildings.get(to);
  }

  // Entity ids: every lecturer and group named anywhere.
  for (const auto& r : j["requirements"].items()) {
    for (const auto& x : r["lecturerIds"].items()) lecturers.get(x.asString());
    for (const auto& x : r["groupIds"].items()) groups.get(x.asString());
  }
  for (const auto& e : j["fixedEntries"].items()) {
    for (const auto& x : e["lecturerIds"].items()) lecturers.get(x.asString());
    for (const auto& x : e["groupIds"].items()) groups.get(x.asString());
  }
  for (const auto& pair : j["lecturerConstraints"].items()) lecturers.get(pairFirst(pair));
  for (const auto& pair : j["groupConstraints"].items()) groups.get(pairFirst(pair));

  p.nRooms = rooms.size();
  p.nBuildings = buildings.size();
  p.nAbstract = abstracts.size();
  p.nLecturers = lecturers.size();
  p.nGroups = groups.size();
  p.roomIds = rooms.names();
  facultyRoom.resize(static_cast<size_t>(p.nRooms), 0);
  p.isFacultyRoom.assign(facultyRoom.begin(), facultyRoom.end());

  p.roomBuilding.assign(static_cast<size_t>(p.nRooms), -1);
  for (const auto& pair : j["roomBuilding"].items()) {
    const int r = rooms.find(pairFirst(pair));
    if (r >= 0) p.roomBuilding[static_cast<size_t>(r)] = buildings.find(pairSecond(pair));
  }
  p.travel.assign(static_cast<size_t>(p.nBuildings) * static_cast<size_t>(std::max(1, p.nBuildings)), 0);
  for (const auto& pair : j["buildingTravel"].items()) {
    std::string from, to;
    if (!travelPair(pair, from, to)) continue;
    const int a = buildings.find(from);
    const int b = buildings.find(to);
    const int v = pair.isObject() ? pair["minutes"].asInt() : pair[1].asInt();
    if (a >= 0 && b >= 0 && v > 0) {
      p.travel[static_cast<size_t>(a) * p.nBuildings + b] = v;
      p.travelKnown = true;
    }
  }
  p.abstractCapacity.assign(static_cast<size_t>(p.nAbstract), -1);
  p.abstractBuilding.assign(static_cast<size_t>(p.nAbstract), -1);
  for (const auto& a : j["abstractRooms"].items()) {
    const int id = abstracts.find(a["id"].asString());
    if (id < 0) continue;
    if (a["capacity"].isNumber()) p.abstractCapacity[static_cast<size_t>(id)] = a["capacity"].asInt();
    if (a["buildingId"].isString()) p.abstractBuilding[static_cast<size_t>(id)] = buildings.find(a["buildingId"].asString());
  }
  p.abstractRoomTravelMinutes = j["abstractRoomTravelMinutes"].asInt(0);
  p.universityCommuteMinutes = j["universityCommuteMinutes"].asInt(0);
  if (p.abstractRoomTravelMinutes > 0 || p.universityCommuteMinutes > 0) p.travelKnown = true;

  loadRuleTable(j["lecturerConstraints"], lecturers, p.lecturerRules);
  loadRuleTable(j["groupConstraints"], groups, p.groupRules);
  loadRuleTable(j["roomConstraints"], rooms, p.roomRules);

  // ── genes ──────────────────────────────────────────────────────────────────────────────────
  const auto pushEntities = [](std::vector<int>& pool, const Json& ids, const Interner& in, int& from, int& count) {
    from = static_cast<int>(pool.size());
    count = 0;
    for (const auto& x : ids.items()) {
      const int v = in.find(x.asString());
      if (v >= 0) { pool.push_back(v); ++count; }
    }
  };

  const auto& reqs = j["requirements"].items();
  p.reqKeys.reserve(reqs.size());
  for (size_t ri = 0; ri < reqs.size(); ++ri) {
    const Json& r = reqs[ri];
    p.reqKeys.push_back(r["key"].asString());

    Gene g;
    g.reqIndex = static_cast<int>(ri);
    g.durationMinutes = std::max(1, r["durationHours"].asInt(1)) * p.academicHourMinutes;
    g.durSlot = static_cast<uint8_t>(std::max(0, p.durationSlot(g.durationMinutes)));
    g.students = std::max(0, r["studentsCount"].asInt(0));
    pushEntities(p.lecPool, r["lecturerIds"], lecturers, g.lecFrom, g.lecCount);
    pushEntities(p.grpPool, r["groupIds"], groups, g.grpFrom, g.grpCount);

    const bool online = r["isOnline"].asBool();
    // The shared place is recorded even for an online class. Being online decides *where the class
    // is* — nowhere — and so wins for the travel terms; it does not decide whether the class counts
    // against a place's capacity, and the validator charges it either way.
    const bool namesAbstract = r["abstractRoomId"].isString();
    g.abstractRoom = namesAbstract ? abstracts.find(r["abstractRoomId"].asString()) : -1;
    g.homeBuilding = g.abstractRoom >= 0 ? p.abstractBuilding[static_cast<size_t>(g.abstractRoom)] : -1;
    g.placeKind = online ? kPlaceOnline
                         : (namesAbstract ? (g.homeBuilding >= 0 ? kPlaceAbstractHere : kPlaceAbstractNowhere)
                                          : kPlaceRoom);

    const auto& roomIds = r["roomIds"].items();
    g.anyRoom = g.placeKind == kPlaceRoom && roomIds.empty();
    g.roomFrom = static_cast<int>(p.roomPool.size());
    g.roomCount = 0;
    if (g.placeKind != kPlaceRoom) {
      // A real, admissible "no room" choice — not an absence. An empty domain would report a
      // perfectly placeable class as unplaceable.
      p.roomPool.push_back(-1);
      g.roomCount = 1;
    } else if (!roomIds.empty()) {
      for (const auto& x : roomIds) {
        const int v = rooms.find(x.asString());
        if (v >= 0) { p.roomPool.push_back(v); ++g.roomCount; }
      }
    } else {
      // The unrestricted fallback is *this faculty's* rooms, never every room the problem mentions:
      // the others belong to somebody else and do not even have their constraints loaded.
      for (int rid = 0; rid < p.nRooms; ++rid) {
        if (p.isFacultyRoom[static_cast<size_t>(rid)]) { p.roomPool.push_back(rid); ++g.roomCount; }
      }
    }

    const Json& cur = r["current"];
    const bool hasCurrent = cur.isObject();
    bool immovable = r["locked"].asBool() && hasCurrent;

    static const std::vector<int> kNoTimes;
    const int setId = sets.find(r["classStartTimeSetId"].asString());
    const std::vector<int>& setTimes =
        setId >= 0 ? p.timesBySet[static_cast<size_t>(setId)] : kNoTimes;
    const bool biweekly = r["isBiweekly"].asBool();

    g.slotFrom = static_cast<int>(p.slotPool.size());
    g.slotCount = 0;
    if (!immovable) {
      for (int day : p.days) {
        for (int ti : setTimes) {
          const int start = p.times[static_cast<size_t>(ti)].startMinutes;
          const int end = start + g.durationMinutes;
          bool ok = true;
          for (int k = 0; k < g.lecCount && ok; ++k) {
            const int l = p.lecPool[static_cast<size_t>(g.lecFrom + k)];
            ok = p.lecturerRules[static_cast<size_t>(l) * kDayStride + day].allows(start, end);
          }
          for (int k = 0; k < g.grpCount && ok; ++k) {
            const int gr = p.grpPool[static_cast<size_t>(g.grpFrom + k)];
            ok = p.groupRules[static_cast<size_t>(gr) * kDayStride + day].allows(start, end);
          }
          if (!ok) continue;
          if (biweekly) {
            p.slotPool.push_back(packSlot(day, ti, kNumerator));
            p.slotPool.push_back(packSlot(day, ti, kDenominator));
            g.slotCount += 2;
          } else {
            p.slotPool.push_back(packSlot(day, ti, kWeekly));
            ++g.slotCount;
          }
        }
      }
      if (g.slotCount == 0 || g.roomCount == 0) {
        const char* reason = g.roomCount == 0
            ? "no admissible room"
            : (setTimes.empty() ? "the workload's bell set names no start time"
                                : "lecturer or group time rules leave no admissible slot");
        p.unplaceable.push_back({r["key"].asString(), r["courseName"].asString(), reason});
        // If it is already scheduled it stays where it is: dropping it would let the rest of the
        // run schedule into a slot the timetable still occupies.
        if (!hasCurrent) continue;
        immovable = true;
      }
    }

    g.movable = !immovable;
    if (hasCurrent) {
      g.day = cur["dayOfWeek"].asInt(-1);
      g.timeIdx = -1;
      const std::string& tid = cur["classStartTimeId"].asString();
      for (size_t t = 0; t < p.timeIds.size(); ++t) {
        if (p.timeIds[t] == tid) { g.timeIdx = static_cast<int>(t); break; }
      }
      g.room = cur["roomId"].isString() ? rooms.find(cur["roomId"].asString()) : -1;
      g.parity = parityCode(cur["weekParity"].asString());
      g.start = g.timeIdx >= 0 ? p.times[static_cast<size_t>(g.timeIdx)].startMinutes : -1;
      g.end = g.start >= 0 ? g.start + g.durationMinutes : -1;
      g.building = p.buildingFor(g, g.room);
      g.mask = g.timeIdx >= 0 ? p.maskAt(g.timeIdx, g.durSlot) : Mask{};
    } else {
      g.parity = biweekly ? kNumerator : kWeekly;
    }

    // Sorted so that "is this placement in the gene's domain?" — which a swap and a permutation
    // ask on every candidate — is a binary search rather than a scan of up to 1 620 rooms.
    std::sort(p.slotPool.begin() + g.slotFrom, p.slotPool.begin() + g.slotFrom + g.slotCount);
    std::sort(p.roomPool.begin() + g.roomFrom, p.roomPool.begin() + g.roomFrom + g.roomCount);

    p.geneLabels.push_back(r["courseName"].asString() + (r["hourType"].isString() ? " (" + r["hourType"].asString() + ")" : ""));
    p.genes.push_back(std::move(g));
  }

  p.movableCount = static_cast<int>(p.genes.size());

  for (const auto& e : j["fixedEntries"].items()) {
    Gene g;
    g.reqIndex = -1;
    g.movable = false;
    g.durationMinutes = std::max(1, e["durationHours"].asInt(1)) * p.academicHourMinutes;
    g.durSlot = static_cast<uint8_t>(std::max(0, p.durationSlot(g.durationMinutes)));
    g.students = std::max(0, e["studentsCount"].asInt(0));
    pushEntities(p.lecPool, e["lecturerIds"], lecturers, g.lecFrom, g.lecCount);
    pushEntities(p.grpPool, e["groupIds"], groups, g.grpFrom, g.grpCount);

    const bool online = e["isOnline"].asBool();
    const bool namesAbstract = e["abstractRoomId"].isString();
    g.abstractRoom = namesAbstract ? abstracts.find(e["abstractRoomId"].asString()) : -1;
    g.homeBuilding = g.abstractRoom >= 0 ? p.abstractBuilding[static_cast<size_t>(g.abstractRoom)] : -1;
    g.placeKind = online ? kPlaceOnline
                         : (namesAbstract ? (g.homeBuilding >= 0 ? kPlaceAbstractHere : kPlaceAbstractNowhere)
                                          : kPlaceRoom);
    g.slotFrom = static_cast<int>(p.slotPool.size());
    g.slotCount = 0;
    g.roomFrom = static_cast<int>(p.roomPool.size());
    g.roomCount = 0;

    g.day = e["dayOfWeek"].asInt(-1);
    g.parity = parityCode(e["weekParity"].asString());
    g.start = parseMinutes(e["startTime"].asString());
    g.end = g.start >= 0 ? g.start + g.durationMinutes : -1;
    g.room = e["roomId"].isString() ? rooms.find(e["roomId"].asString()) : -1;
    g.building = p.buildingFor(g, g.room);
    g.timeIdx = -1;
    g.mask = g.start >= 0 ? maskForMinutes(g.start, g.end) : Mask{};

    p.geneLabels.push_back("external:" + e["id"].asString());
    p.genes.push_back(std::move(g));
  }

  for (int i = 0; i < p.movableCount; ++i) {
    if (p.genes[static_cast<size_t>(i)].movable) p.movable.push_back(i);
  }
  return p;
}


void applyPlacements(State& s, const Problem& p, const Json& placements) {
  std::unordered_map<std::string, int> geneByKey;
  for (int i = 0; i < p.movableCount; ++i) {
    const int ri = p.genes[static_cast<size_t>(i)].reqIndex;
    if (ri >= 0) geneByKey.emplace(p.reqKeys[static_cast<size_t>(ri)], i);
  }
  std::unordered_map<std::string, int> timeById;
  for (size_t t = 0; t < p.timeIds.size(); ++t) timeById.emplace(p.timeIds[t], static_cast<int>(t));
  std::unordered_map<std::string, int> roomById;
  for (size_t r = 0; r < p.roomIds.size(); ++r) roomById.emplace(p.roomIds[r], static_cast<int>(r));

  for (const auto& e : placements.items()) {
    auto gi = geneByKey.find(e["key"].asString());
    if (gi == geneByKey.end()) continue;
    auto ti = timeById.find(e["classStartTimeId"].asString());
    if (ti == timeById.end()) continue;
    int room = -1;
    if (e["roomId"].isString()) {
      auto ri = roomById.find(e["roomId"].asString());
      room = ri == roomById.end() ? -1 : ri->second;
    }
    s.placeRaw(gi->second, e["dayOfWeek"].asInt(), ti->second,
               static_cast<int>(parityCode(e["weekParity"].asString())), room);
  }
  s.flush();
}

void freezePlaced(Problem& p) {
  for (int i = 0; i < p.movableCount; ++i) {
    Gene& g = p.genes[static_cast<size_t>(i)];
    if (g.movable && g.day >= 0 && g.timeIdx >= 0) g.movable = false;
  }
  p.movable.clear();
  for (int i = 0; i < p.movableCount; ++i) {
    if (p.genes[static_cast<size_t>(i)].movable) p.movable.push_back(i);
  }
}

Json placementsToJson(const Problem& p, const std::vector<Gene>& genes) {
  Json out = Json::array({});
  for (int i = 0; i < p.movableCount; ++i) {
    const Gene& g = genes[static_cast<size_t>(i)];
    if (!g.movable || g.day < 0 || g.timeIdx < 0) continue;
    Json e = Json::object();
    e.set("key", Json{p.reqKeys[static_cast<size_t>(g.reqIndex)]});
    e.set("dayOfWeek", Json{g.day});
    e.set("classStartTimeId", Json{p.timeIds[static_cast<size_t>(g.timeIdx)]});
    if (g.room >= 0) e.set("roomId", Json{p.roomIds[static_cast<size_t>(g.room)]});
    else e.set("roomId", Json{});
    e.set("weekParity", Json{std::string(g.parity == kNumerator ? "NUMERATOR"
                                        : g.parity == kDenominator ? "DENOMINATOR" : "WEEKLY")});
    out.push(std::move(e));
  }
  return out;
}

}  // namespace tg
