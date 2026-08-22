// The interned problem: everything the search reads, with every string turned into a dense index.
//
// This mirrors `SolverProblem` in `timetable-ui/src/app/timetable-solver.ts` exactly — the same
// nine Π terms, the same hard filters, the same "more specific wins" constraint resolution — so
// that a schedule produced here can be scored by the JavaScript harness's independent validator and
// the two numbers must agree. Where the semantics are subtle the comment says which document fixes
// them: `TIMETABLE-GENERATION.md` §§1–4 for the model, `scripts/timetable-bench/validate.mjs` for
// the scoring.
#pragma once

#include <array>
#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

#include "mask.hpp"

namespace tg {

// Days are 1..7; index 0 is never used, and the stride of 8 lets a day index a bucket row with no
// arithmetic. Same choice, same reason, as the TypeScript solver.
inline constexpr int kDayStride = 8;

enum Parity : uint8_t { kWeekly = 0, kNumerator = 1, kDenominator = 2 };
enum PlaceKind : uint8_t { kPlaceRoom = 0, kPlaceAbstractHere = 1, kPlaceAbstractNowhere = 2, kPlaceOnline = 3 };

inline bool weeksOverlap(uint8_t a, uint8_t b) { return a == kWeekly || b == kWeekly || a == b; }
/// Whether a class of parity `p` is taught in calendar week `w` (1 = numerator, 2 = denominator).
inline bool inWeek(uint8_t p, int w) { return p == kWeekly || p == static_cast<uint8_t>(w); }

/// One subject's resolved rules for one day. `notAfter` of `kNoLimit` means unset.
struct DayRules {
  int notBefore = -1;
  int notAfter = std::numeric_limits<int>::max();
  int maxPerDay = -1;
  // Forbidden [from, to) windows, flattened as pairs.
  std::vector<int> windows;

  bool allows(int start, int end) const {
    if (notBefore >= 0 && start < notBefore) return false;
    if (end > notAfter) return false;
    for (size_t i = 0; i + 1 < windows.size(); i += 2) {
      if (start < windows[i + 1] && windows[i] < end) return false;
    }
    return true;
  }
  bool trivial() const {
    return notBefore < 0 && notAfter == std::numeric_limits<int>::max() && maxPerDay < 0 && windows.empty();
  }
};

struct ClassTime {
  int setId = 0;
  int startMinutes = 0;
  std::string id;
};

/// A class session to be placed, or an immovable class the run must schedule around.
struct Gene {
  int reqIndex = -1;          // -1 for an external fixed entry
  bool movable = false;
  bool anyRoom = false;       // room domain is the unrestricted faculty fallback
  uint8_t placeKind = kPlaceRoom;

  // Slices into the flat entity pools.
  int lecFrom = 0, lecCount = 0;
  int grpFrom = 0, grpCount = 0;

  int durationMinutes = 0;
  uint8_t durSlot = 0;        // index into Problem::durationList, cached off the hot path
  int students = 0;
  int abstractRoom = -1;
  int homeBuilding = -1;

  // Domains: `slots` is packed (day, timeIdx, parity); `rooms` holds room indices, or the single
  // -1 of a class that is in no room at all.
  int slotFrom = 0, slotCount = 0;
  int roomFrom = 0, roomCount = 0;

  // Current placement.
  int day = -1;
  int timeIdx = -1;
  int room = -1;
  uint8_t parity = kWeekly;
  int start = -1;
  int end = -1;
  int building = -1;
  Mask mask;  // the compressed-axis interval it occupies
};

/// A packed (day, timeIdx, parity) triple. The layout is arbitrary but must round-trip.
inline int packSlot(int day, int timeIdx, int parity) { return (day * 4 + parity) * 4096 + timeIdx; }
inline int slotDay(int s) { return (s / 4096) / 4; }
inline int slotParity(int s) { return (s / 4096) % 4; }
inline int slotTime(int s) { return s % 4096; }

struct Problem {
  // ── dimensions ──────────────────────────────────────────────────────────
  int nLecturers = 0;
  int nGroups = 0;
  int nRooms = 0;
  int nBuildings = 0;
  int nAbstract = 0;
  int academicHourMinutes = 40;

  std::vector<int> days;                       // the working days, 1..7
  std::vector<ClassTime> times;                // sorted by start minute
  std::vector<std::vector<int>> timesBySet;    // set index -> time indices
  std::vector<int> distinctStarts;             // every bell start on any grid, ascending

  // ── the compressed time axis ────────────────────────────────────────────
  std::vector<int> ticks;      // sorted distinct minute values: every start and every reachable end
  Mask bellStartTicks;         // ticks that are a bell start on some grid
  int tickCount = 0;

  // ── places ──────────────────────────────────────────────────────────────
  std::vector<int> roomBuilding;         // room -> building, -1 when unknown
  std::vector<char> isFacultyRoom;       // room -> may this run schedule into it freely
  std::vector<int> travel;               // from * nBuildings + to, directed, minutes
  std::vector<int> abstractCapacity;     // -1 when unset
  std::vector<int> abstractBuilding;
  int abstractRoomTravelMinutes = 0;
  int universityCommuteMinutes = 0;
  bool travelKnown = false;

  // ── rules, one row per subject, `kDayStride` per row ─────────────────────
  std::vector<DayRules> lecturerRules;
  std::vector<DayRules> groupRules;
  std::vector<DayRules> roomRules;

  // ── genes and their flat pools ──────────────────────────────────────────
  std::vector<Gene> genes;
  int movableCount = 0;                  // genes[0 .. movableCount) come from requirements
  std::vector<int> movable;              // indices this run may move
  std::vector<int> lecPool, grpPool, slotPool, roomPool;

  // ── identity, for writing results back ──────────────────────────────────
  std::vector<std::string> reqKeys;      // requirement index -> key
  std::vector<std::string> roomIds;      // room index -> id
  std::vector<std::string> timeIds;      // time index -> id
  std::vector<std::string> geneLabels;   // for the conflict report

  // ── reported at load time ───────────────────────────────────────────────
  struct Unplaceable {
    std::string key;
    std::string label;
    std::string reason;
  };
  std::vector<Unplaceable> unplaceable;

  const int* lecturersOf(const Gene& g) const { return lecPool.data() + g.lecFrom; }
  const int* groupsOf(const Gene& g) const { return grpPool.data() + g.grpFrom; }
  const int* slotsOf(const Gene& g) const { return slotPool.data() + g.slotFrom; }
  const int* roomsOf(const Gene& g) const { return roomPool.data() + g.roomFrom; }

  /// Minutes to get from one class's place to another's. See TIMETABLE-GENERATION.md §1.2, Π₄/Π₅:
  /// one rule per way a class can be held, and every absence reads as "no journey".
  int journeyMinutes(const Gene& a, const Gene& b) const {
    const bool aOn = a.placeKind == kPlaceOnline;
    const bool bOn = b.placeKind == kPlaceOnline;
    if (aOn && bOn) return 0;
    if (aOn || bOn) return universityCommuteMinutes;
    if (a.abstractRoom >= 0 && a.abstractRoom == b.abstractRoom) return 0;
    if (a.placeKind == kPlaceAbstractNowhere || b.placeKind == kPlaceAbstractNowhere) {
      return abstractRoomTravelMinutes;
    }
    const int ba = a.building, bb = b.building;
    if (ba < 0 || bb < 0 || ba == bb) return 0;
    return travel[static_cast<size_t>(ba) * nBuildings + bb];
  }

  /// The building a gene is in once placed in `room` — the room's for an ordinary class, and the
  /// abstract room's otherwise, so a roomless class does not lose its address on every move.
  int buildingFor(const Gene& g, int room) const {
    if (g.placeKind != kPlaceRoom) return g.homeBuilding;
    return room >= 0 ? roomBuilding[room] : -1;
  }

  /// The compressed-axis mask of a class in duration bucket `ds` starting at time index `ti`.
  Mask maskAt(int ti, int ds) const {
    return timeMasks[static_cast<size_t>(ti) * durationList.size() + static_cast<size_t>(ds)];
  }

  // Filled by the loader: a mask per (timeIdx, duration bucket). Durations are few, so they are
  // interned into a tiny table rather than recomputed per move.
  std::vector<Mask> timeMasks;
  std::vector<int> durationList;   // distinct durations in minutes
  int durationSlot(int durationMinutes) const {
    for (size_t i = 0; i < durationList.size(); ++i) {
      if (durationList[i] == durationMinutes) return static_cast<int>(i);
    }
    return -1;
  }
};

/// One placement to write back.
struct Placement {
  std::string key;
  int dayOfWeek = 0;
  std::string classStartTimeId;
  std::string roomId;   // empty when the class is in no room
  uint8_t parity = kWeekly;
};

}  // namespace tg
