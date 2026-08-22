// A 128-bit time mask.
//
// Every time in this problem — a bell start, the end of a class — is one of a few dozen distinct
// minute values, so the day is compressed onto an axis of "ticks": the sorted distinct endpoints.
// A class then occupies a contiguous run of elementary intervals between consecutive ticks, and the
// two questions the search asks most often become bit operations:
//
//   do these two classes overlap?        (a & b) != 0
//   how many пари did this entity skip?  popcount(span(u) & ~u & bellStarts)
//
// 128 bits is deliberate headroom: the benchmark instances need 22 and a real faculty with four
// class durations across two bell grids needs about 40, but a university that adds a third grid
// should not need a recompile. The cost over a single word is two instructions on the paths that
// matter, which is nothing next to what the mask replaces (a sort per bucket per week).
#pragma once

#include <bit>
#include <cstdint>

namespace tg {

struct Mask {
  uint64_t lo = 0;
  uint64_t hi = 0;

  static constexpr int kBits = 128;

  constexpr bool empty() const { return (lo | hi) == 0; }
  constexpr explicit operator bool() const { return !empty(); }

  constexpr Mask operator&(const Mask& o) const { return Mask{lo & o.lo, hi & o.hi}; }
  constexpr Mask operator|(const Mask& o) const { return Mask{lo | o.lo, hi | o.hi}; }
  constexpr Mask operator~() const { return Mask{~lo, ~hi}; }
  constexpr bool operator==(const Mask& o) const { return lo == o.lo && hi == o.hi; }
  Mask& operator|=(const Mask& o) { lo |= o.lo; hi |= o.hi; return *this; }
  Mask& operator&=(const Mask& o) { lo &= o.lo; hi &= o.hi; return *this; }

  constexpr bool intersects(const Mask& o) const { return ((lo & o.lo) | (hi & o.hi)) != 0; }

  int popcount() const { return std::popcount(lo) + std::popcount(hi); }

  /// Index of the lowest set bit; undefined on an empty mask.
  int lowest() const { return lo ? std::countr_zero(lo) : 64 + std::countr_zero(hi); }
  /// Index of the highest set bit; undefined on an empty mask.
  int highest() const { return hi ? 127 - std::countl_zero(hi) : 63 - std::countl_zero(lo); }

  void setBit(int b) {
    if (b < 64) lo |= (uint64_t{1} << b);
    else hi |= (uint64_t{1} << (b - 64));
  }
  bool testBit(int b) const {
    return b < 64 ? ((lo >> b) & 1) != 0 : ((hi >> (b - 64)) & 1) != 0;
  }

  /// Bits 0 .. n-1 set.
  static Mask below(int n) {
    if (n <= 0) return Mask{};
    if (n >= 128) return Mask{~uint64_t{0}, ~uint64_t{0}};
    if (n < 64) return Mask{(uint64_t{1} << n) - 1, 0};
    if (n == 64) return Mask{~uint64_t{0}, 0};
    return Mask{~uint64_t{0}, (uint64_t{1} << (n - 64)) - 1};
  }

  /// Bits [from, to) set.
  static Mask range(int from, int to) { return below(to) & ~below(from); }

  /// Every bit from the lowest set bit to the highest, inclusive — the closed convex hull.
  Mask span() const {
    if (empty()) return Mask{};
    const int a = lowest();
    const int b = highest();
    return range(a, b + 1);
  }
};

}  // namespace tg
