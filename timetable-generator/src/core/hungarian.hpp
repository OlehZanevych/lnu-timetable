// The Hungarian method (Jonker–Volgenant shortest-augmenting-path form), O(n³).
//
// It is here for one operator: given k classes and the k placements they currently occupy between
// them, which permutation of those placements is best? That is a linear assignment problem the
// moment the cost of putting class c at placement q can be read independently, which it can once
// the k classes are lifted out of the schedule — and the residual coupling between them is small
// enough that the exact optimum of the relaxed matrix is an excellent starting point for the
// true-delta refinement that follows.
#pragma once

#include <algorithm>
#include <limits>
#include <vector>

namespace tg {

/// `cost` is row-major n×n. Returns `assign[row] = column` minimising the total.
inline void hungarian(const std::vector<double>& cost, int n, std::vector<int>& assign) {
  constexpr double kInf = std::numeric_limits<double>::infinity();
  std::vector<double> u(static_cast<size_t>(n) + 1, 0), v(static_cast<size_t>(n) + 1, 0);
  std::vector<int> p(static_cast<size_t>(n) + 1, 0), way(static_cast<size_t>(n) + 1, 0);

  for (int i = 1; i <= n; ++i) {
    p[0] = i;
    int j0 = 0;
    std::vector<double> minv(static_cast<size_t>(n) + 1, kInf);
    std::vector<char> used(static_cast<size_t>(n) + 1, 0);
    do {
      used[static_cast<size_t>(j0)] = 1;
      const int i0 = p[static_cast<size_t>(j0)];
      double delta = kInf;
      int j1 = 0;
      for (int j = 1; j <= n; ++j) {
        if (used[static_cast<size_t>(j)]) continue;
        const double cur = cost[static_cast<size_t>(i0 - 1) * static_cast<size_t>(n) + static_cast<size_t>(j - 1)] -
                           u[static_cast<size_t>(i0)] - v[static_cast<size_t>(j)];
        if (cur < minv[static_cast<size_t>(j)]) {
          minv[static_cast<size_t>(j)] = cur;
          way[static_cast<size_t>(j)] = j0;
        }
        if (minv[static_cast<size_t>(j)] < delta) {
          delta = minv[static_cast<size_t>(j)];
          j1 = j;
        }
      }
      for (int j = 0; j <= n; ++j) {
        if (used[static_cast<size_t>(j)]) {
          u[static_cast<size_t>(p[static_cast<size_t>(j)])] += delta;
          v[static_cast<size_t>(j)] -= delta;
        } else {
          minv[static_cast<size_t>(j)] -= delta;
        }
      }
      j0 = j1;
    } while (p[static_cast<size_t>(j0)] != 0);
    do {
      const int j1 = way[static_cast<size_t>(j0)];
      p[static_cast<size_t>(j0)] = p[static_cast<size_t>(j1)];
      j0 = j1;
    } while (j0 != 0);
  }

  assign.assign(static_cast<size_t>(n), -1);
  for (int j = 1; j <= n; ++j) {
    if (p[static_cast<size_t>(j)] >= 1) assign[static_cast<size_t>(p[static_cast<size_t>(j)] - 1)] = j - 1;
  }
}

}  // namespace tg
