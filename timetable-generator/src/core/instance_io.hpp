#pragma once

#include <string>
#include <vector>

#include "json.hpp"
#include "model.hpp"

namespace tg {

/// Reads a `SolverProblem` — the JSON shape the Angular client hands its solver, and the shape
/// `scripts/timetable-bench` archives its instances in — into the interned model.
Problem loadProblem(const Json& j);

/// The placement list the harness's validator expects: `{key, dayOfWeek, classStartTimeId,
/// roomId, weekParity}` per movable gene that got an assignment.
Json placementsToJson(const Problem& p, const std::vector<Gene>& genes);

/// Turns every class that already has a placement into an immovable one, and rebuilds the movable
/// list. This is what «зберегти наявні заняття» means: a class already in the timetable is not a
/// seed the search may improve on, it is a fact it must schedule around, exactly like another
/// faculty's class. Called after loading, before the search.
void freezePlaced(Problem& p);

/// Reads a placement list back onto the genes — used to score the benchmark's hidden reference
/// schedule with this evaluator and check it against the JavaScript validator's figures.
void applyPlacements(class State& s, const Problem& p, const Json& placements);

}  // namespace tg
