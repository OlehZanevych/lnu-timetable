// xoshiro256++ — small, fast, and good enough for a search that draws a few billion numbers.
//
// The generator is per worker and seeded by stride, so two workers never walk the same sequence:
// two searches whose random streams overlap are one search that costs twice as much.
#pragma once

#include <cstdint>

namespace tg {

class Rng {
 public:
  explicit Rng(uint64_t seed) {
    // SplitMix64 to fill the state, so a small seed still produces a well-mixed start.
    uint64_t z = seed ? seed : 0x9E3779B97F4A7C15ULL;
    for (uint64_t& s : s_) {
      z += 0x9E3779B97F4A7C15ULL;
      uint64_t x = z;
      x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
      x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
      s = x ^ (x >> 31);
    }
  }

  uint64_t next() {
    const uint64_t r = rotl(s_[0] + s_[3], 23) + s_[0];
    const uint64_t t = s_[1] << 17;
    s_[2] ^= s_[0];
    s_[3] ^= s_[1];
    s_[1] ^= s_[2];
    s_[0] ^= s_[3];
    s_[2] ^= t;
    s_[3] = rotl(s_[3], 45);
    return r;
  }

  /// Uniform in [0, n) — Lemire's multiply-shift, without the rejection loop, which is a
  /// negligible bias at these bounds and saves a branch in the hottest function in the program.
  uint32_t below(uint32_t n) {
    return static_cast<uint32_t>((static_cast<uint64_t>(static_cast<uint32_t>(next() >> 32)) * n) >> 32);
  }
  int belowI(int n) { return n <= 0 ? 0 : static_cast<int>(below(static_cast<uint32_t>(n))); }

  double unit() { return static_cast<double>(next() >> 11) * 0x1.0p-53; }

  bool chance(double p) { return unit() < p; }

 private:
  static uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }
  uint64_t s_[4]{};
};

}  // namespace tg
