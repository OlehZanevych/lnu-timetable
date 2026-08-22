// The headless runner: the same solver core the desktop application drives, with a command line
// instead of a window. It exists so that every measurement in the study can be reproduced without
// Qt, on a machine with nothing but a compiler.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "core/instance_io.hpp"
#include "core/json.hpp"
#include "core/model.hpp"
#include "core/search.hpp"
#include "core/state.hpp"

using namespace tg;

namespace {

struct Args {
  std::string instance;
  std::string problemFile;
  std::string out;
  std::string log;
  std::string mode = "solve";
  SearchOptions opts;
  bool quiet = false;
};

void usage() {
  std::fprintf(stderr,
               "timetable-solve — the LNU timetable generator's search core\n"
               "\n"
               "  --instance FILE      a timetable-bench archive: {meta, problem, hidden}\n"
               "  --problem FILE       a bare SolverProblem JSON\n"
               "  --mode M             solve | score-hidden | score (default solve)\n"
               "  --time MS            wall-clock budget (default 30000)\n"
               "  --threads N          search workers (default: hardware concurrency)\n"
               "  --seed N             base PRNG seed\n"
               "  --out FILE           write the placement list here\n"
               "  --log FILE           write the run's trajectory here (.jsonl or .csv)\n"
               "  --engine E           lahc | sa | dlas  (default lahc)\n"
               "  --keep               keep existing placements; only schedule what has none\n"
               "  --no-chain --no-lns --no-repack --no-kopt --no-kempe --no-cluster\n"
               "  --dayfix             enable the exhaustive (entity, day) re-pack (measured: worse)\n"
               "  --winfix             enable the window-directed move (measured: worse)\n"
               "  --cost-aware         select operators by reward per unit work (measured: worse)\n"
               "  --simple             move and targeted swap only, as the browser solver runs\n"
               "  --lahc-canonical     write the current cost back into the LAHC slot (Burke-Bykov)\n"
               "  --no-cooperate       workers do not adopt one another's schedules\n"
               "  --restart-after N    moves without an incumbent before a fresh construction (0 = off)\n"
               "  --recombine          enable cluster-wise crossover between pool members (measured: worse)\n"
               "  --pool N             elite pool size\n"
               "  --ils                hand the tail to the ILS loop (measured: worse)\n"
               "  --ils-descent N      strict-descent moves per ILS cycle\n"
               "  --no-restart         perturb the working state instead of kicking the incumbent\n"
               "  --kick-min N --kick-max N   adaptive kick strength, in classes\n"
               "  --stagnation N       moves without a new incumbent before a kick\n"
               "  --kopt-extra N       free placements added to the permutation pool (0 = pure permutation)\n"
               "  --kopt-k N           widest permutation the deep phase escalates to\n"
               "  --quiet\n");
}

}  // namespace

int main(int argc, char** argv) {
  Args a;
  for (int i = 1; i < argc; ++i) {
    const std::string s = argv[i];
    const auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string{}; };
    if (s == "--instance") a.instance = next();
    else if (s == "--problem") a.problemFile = next();
    else if (s == "--mode") a.mode = next();
    else if (s == "--time") a.opts.timeLimitMs = std::stoll(next());
    else if (s == "--threads") a.opts.threads = std::stoi(next());
    else if (s == "--seed") a.opts.seed = std::stoull(next());
    else if (s == "--out") a.out = next();
    else if (s == "--log") a.log = next();
    else if (s == "--engine") a.opts.engine = next();
    else if (s == "--keep") a.opts.keepExisting = true;
    else if (s == "--no-chain") a.opts.chainRate = 0;
    else if (s == "--no-lns") a.opts.useLns = false;
    else if (s == "--no-repack") a.opts.useRepack = false;
    else if (s == "--no-kopt") a.opts.useKopt = false;
    else if (s == "--no-cluster") a.opts.useClusters = false;
    else if (s == "--no-kempe") a.opts.useKempe = false;
    else if (s == "--no-dayfix") a.opts.useDayRepack = false;
    else if (s == "--dayfix") a.opts.useDayRepack = true;
    else if (s == "--no-winfix") a.opts.useCloseWindow = false;
    else if (s == "--winfix") a.opts.useCloseWindow = true;
    else if (s == "--cost-aware") a.opts.costAwareSelection = true;
    else if (s == "--lahc-canonical") a.opts.lahcCanonical = true;
    else if (s == "--restart-after") a.opts.restartAfter = std::stoll(next());
    else if (s == "--no-cooperate") a.opts.cooperate = false;
    else if (s == "--no-restart-fresh") a.opts.restartAfter = 0;
    else if (s == "--no-recombine") a.opts.useRecombine = false;
    else if (s == "--recombine") a.opts.useRecombine = true;
    else if (s == "--pool") a.opts.poolSize = std::stoi(next());
    else if (s == "--recombine-rate") a.opts.recombineRate = std::stod(next());
    else if (s == "--no-ils") a.opts.useIls = false;
    else if (s == "--ils") a.opts.useIls = true;
    else if (s == "--ils-after") a.opts.ilsAfter = std::stoll(next());
    else if (s == "--ils-focus") a.opts.ilsFocus = std::stod(next());
    else if (s == "--ils-reanchor") a.opts.ilsReanchor = std::stoll(next());
    else if (s == "--ils-descent") a.opts.ilsDescent = std::stoi(next());
    else if (s == "--no-restart") a.opts.restartFromBest = false;
    else if (s == "--kick-min") a.opts.kickMin = std::stoi(next());
    else if (s == "--kick-max") a.opts.kickMax = std::stoi(next());
    else if (s == "--stagnation") a.opts.stagnationMoves = std::stoll(next());
    else if (s == "--kopt-extra") a.opts.koptExtra = std::stoi(next());
    else if (s == "--kopt-k") a.opts.koptK = std::stoi(next());
    else if (s == "--simple") {
      // Everything but the two single-class neighbourhoods — the shape of the search the browser
      // solver runs, for the ablation table.
      a.opts.chainRate = 0;
      a.opts.useKempe = false;
      a.opts.useLns = false;
      a.opts.useKopt = false;
      a.opts.useRepack = false;
      a.opts.useDayRepack = false;
      a.opts.useCloseWindow = false;
    }
    else if (s == "--lahc") a.opts.lahcLength = std::stoi(next());
    else if (s == "--quiet") a.quiet = true;
    else if (s == "--help" || s == "-h") { usage(); return 0; }
    else { std::fprintf(stderr, "unknown option %s\n", s.c_str()); usage(); return 2; }
  }
  if (a.instance.empty() && a.problemFile.empty()) { usage(); return 2; }

  try {
    Json root = Json::parseFile(a.instance.empty() ? a.problemFile : a.instance);
    const Json& problemJson = a.instance.empty() ? root : root["problem"];
    Problem p = loadProblem(problemJson);
    if (a.opts.keepExisting) freezePlaced(p);

    if (a.mode == "score-hidden") {
      State s(p);
      // Start from an empty schedule. A requirement carrying a `current` that the hidden list does
      // not mention is *unplaced* as far as the validator is concerned, and leaving it where it sat
      // would score a class the validator never sees.
      for (int i : p.movable) s.placeRaw(i, -1, -1, p.genes[static_cast<size_t>(i)].parity, -1);
      s.flush();
      applyPlacements(s, p, root["hidden"]);
      const Counters& c = s.counters();
      Json o = Json::object();
      o.set("lecturerConflicts", Json{static_cast<long long>(c.lecConflicts)});
      o.set("groupConflicts", Json{static_cast<long long>(c.grpConflicts)});
      o.set("roomConflicts", Json{static_cast<long long>(c.roomConflicts)});
      o.set("groupTravel", Json{static_cast<long long>(c.grpTravel)});
      o.set("lecturerTravel", Json{static_cast<long long>(c.lecTravel)});
      o.set("abstractRoomOverflow", Json{static_cast<long long>(c.absOverflow)});
      o.set("lecturerWindowHalves", Json{static_cast<long long>(c.lecWinHalves)});
      o.set("groupWindowHalves", Json{static_cast<long long>(c.grpWinHalves)});
      o.set("mixedHalves", Json{static_cast<long long>(c.mixedHalves)});
      o.set("hard", Json{static_cast<long long>(c.hard())});
      o.set("objective", Json{s.objective()});
      std::cout << o.dump() << "\n";
      return 0;
    }

    const auto t0 = std::chrono::steady_clock::now();
    SearchResult r = solve(p, a.opts);
    const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    if (!a.out.empty()) {
      Json placements = placementsToJson(p, r.best);
      FILE* f = std::fopen(a.out.c_str(), "w");
      if (!f) { std::fprintf(stderr, "cannot write %s\n", a.out.c_str()); return 1; }
      const std::string text = placements.dump();
      std::fwrite(text.data(), 1, text.size(), f);
      std::fputc('\n', f);
      std::fclose(f);
    }
    if (!a.log.empty()) writeTrajectory(a.log, r);

    if (!a.quiet) {
      std::printf(
          "n=%d movable=%d hard=%lld soft=%lld objective=%.0f moves=%lld wall=%.2fs threads=%d\n",
          static_cast<int>(p.genes.size()), static_cast<int>(p.movable.size()),
          static_cast<long long>(r.hard), static_cast<long long>(r.soft), r.objective,
          static_cast<long long>(r.moves), wall, a.opts.threads);
    }
    Json summary = r.summary();
    summary.set("wallSeconds", Json{wall});
    std::cout << summary.dump() << "\n";
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "error: %s\n", e.what());
    return 1;
  }
}
