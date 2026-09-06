#!/usr/bin/env python3
"""
A certified benchmark for the objective the generator actually optimises.

`ipbound.py` maximises total desirability subject to the hard constraints, which is only the
lowest-priority component of what `workload-generator.ts` targets. The generator's objective is the
lexicographic order

    min_lex ( U(a), D(a), -Z(a) )

-- cover as many slots as possible, then come as close to the floors as possible, then maximise
desirability -- and a desirability-only program is not a benchmark for it. The counterexample fits
in one line: one lecturer with two hours of capacity, slot A worth 100 desirability and costing two
hours, slots B and C worth 40 each and costing one hour each. Maximising desirability takes A and
covers one slot; the generator's objective takes B and C and covers two. A larger Z can be a worse
plan, so a gap measured against max Z is not an optimality gap for this problem.

This script solves that order the standard way, as three solves in priority sequence:

    stage 1   max  C = sum x                                    coverage
    stage 2   min  D = sum q + omega * sum r      s.t. C = C*   floor deficit
    stage 3   max  Z = sum d x                    s.t. C = C*, D <= D* + eps

Only after stage 3 is Z* the desirability of a lexicographically optimal plan, and only then is
1 - Z_generator / Z* an optimality gap. Stage 1 and stage 2 are the more useful outputs in practice:
they say how many slots a lawful plan could still cover and how much floor deficit is avoidable,
which is where the constructive generator has room to improve.

TWO MODELLING POINTS THAT ARE EASY TO GET WRONG, AND ARE THE REASON THIS IS A SEPARATE FILE

  1. THE COURSE INDICATORS NEED LINKING IN BOTH DIRECTIONS. In a ceiling-only model the one-way
     link x[w,l] <= y[l,g,c] is enough: a spurious y = 1 only consumes course capacity, so the
     solver never wants one. The moment a floor rewards holding a course, a spurious y = 1 pays
     for itself and the solver will take it -- it would satisfy MIN_LECTURE_COURSES for a lecturer
     who teaches no lecture. The reverse link y[l,g,c] <= sum of the x for that course pins the
     indicator to the assignment, and without it stage 2 reports a floor deficit that no plan
     achieves.

  2. THE DEFICIT MUST BE THE SAME FUNCTION THE GENERATOR MINIMISES. D(a) here is one unit per hour
     short plus omega per course short, omega = 10, matching `Load.deficit()` in the generator. A
     benchmark that prices the two shortfalls differently is not measuring the generator.

WHAT REMAINS A RELAXATION, AND IN WHICH DIRECTION

  Individual supervision enters as integer counts n[w,l] charging hours against the ceiling, as in
  `ipbound.py --supervision`. Which student goes to which supervisor does not matter to any term of
  the objective, so counts lose nothing. Where a lecturer's locked work already exceeds their
  ceiling the residual right-hand side is clamped at zero, so what the model solves there is the
  residual problem: that inherited overrun is outside the decision space of the model and of the
  generator alike, and no formulation makes such a plan lawful.

Writes one JSON row per instance to results/ip-lex.jsonl.
"""

import argparse
import json
import math
import os
import sys
import time

import highspy

from ipbound import SCOPES, scopes_of, num, capacity_audit

INF = highspy.kHighsInf
OMEGA = 10.0            # per course short, against one per hour short; see Load.deficit()


def build_lex(inp, omega=OMEGA):
    """The whole feasible set once, with the three objectives kept separately.

    Returns the HiGHS arrays plus, for each stage, the objective vector and the row index of the
    constraint that will pin the previous stage's optimum.
    """
    lecturers = {l["id"]: l for l in inp["lecturers"]}
    mode = inp.get("mode")
    default_max = inp.get("defaultMaxHoursPerYear")

    # ---- what the locked assignments already consume (gaps mode) -------------
    pre_hours = {lid: 0.0 for lid in lecturers}
    pre_courses = {lid: {s: set() for s in SCOPES} for lid in lecturers}
    if mode == "gaps":
        for w in inp["workloads"]:
            if w["teachingFormat"] == "INDIVIDUALLY":
                continue
            for lid in w.get("assignedLecturerIds") or []:
                if lid not in lecturers:
                    continue
                pre_hours[lid] += w["hours"]
                for s in scopes_of(w):
                    pre_courses[lid][s].add(w["courseId"])

    lower, upper, integrality = [], [], []
    cost_cov, cost_des = [], []          # stage 1 and stage 3 objective vectors
    rows = []

    def col(lo, hi, integer, cov=0.0, des=0.0):
        c = len(lower)
        lower.append(float(lo)); upper.append(float(hi))
        integrality.append(1 if integer else 0)
        cost_cov.append(float(cov)); cost_des.append(float(des))
        return c

    # ---- slot decisions ------------------------------------------------------
    xs = []                      # (workload, lecturerId)
    for w in inp["workloads"]:
        if w["teachingFormat"] == "INDIVIDUALLY":
            continue
        locked = set(w.get("assignedLecturerIds") or [])
        need = w["lecturerCount"] - (len(locked) if mode == "gaps" else 0)
        if need <= 0:
            continue
        cands = [c for c in w["candidates"] if c["lecturerId"] not in locked]
        if not cands:
            continue
        cols = []
        for c in cands:
            # Coverage weight 1, desirability weight d: one column, two objectives.
            j = col(0, 1, True, cov=1.0, des=float(c["desirability"]))
            cols.append(j)
            xs.append((w, c["lecturerId"]))
        rows.append(([(j, 1.0) for j in cols], -INF, float(need)))
    n_x = len(xs)

    by_lect = {lid: [] for lid in lecturers}
    for j, (w, lid) in enumerate(xs):
        if lid in by_lect:
            by_lect[lid].append((j, w))

    # ---- supervision counts --------------------------------------------------
    sup_by_lect = {lid: [] for lid in lecturers}
    n_sup = 0
    for w in inp["workloads"]:
        if w["teachingFormat"] != "INDIVIDUALLY":
            continue
        roster = list(w.get("studentIds") or [])
        if not roster or not w["candidates"]:
            continue
        locked = {}
        if mode == "gaps":
            on_roster = set(roster)
            for a in w.get("assignedStudents") or []:
                if a["studentId"] in on_roster:
                    locked[a["lecturerId"]] = locked.get(a["lecturerId"], 0) + 1
        need = len(roster) - sum(locked.values())
        if need > 0:
            cols = []
            for c in w["candidates"]:
                lid = c["lecturerId"]
                cap = c.get("maxStudents")
                hi = float(need if cap is None else max(0, cap - locked.get(lid, 0)))
                if hi <= 0:
                    continue
                j = col(0, min(hi, float(need)), True)
                cols.append(j)
                n_sup += 1
                if lid in sup_by_lect:
                    sup_by_lect[lid].append((j, float(w["hours"])))
            if cols:
                # every student on the roster gets a supervisor, as the generator guarantees
                rows.append(([(j, 1.0) for j in cols], float(need), float(need)))
        for lid, k in locked.items():
            if lid in pre_hours:
                pre_hours[lid] += k * w["hours"]

    # ---- per-lecturer constraints, floors included as deficit variables ------
    y_cols, q_cols, r_cols = {}, {}, {}
    for lid, l in lecturers.items():
        cons = l.get("constraints") or {}
        mine = by_lect[lid]
        sup = sup_by_lect[lid]
        if not mine and not sup:
            continue
        hour_terms = [(j, float(w["hours"])) for j, w in mine] + list(sup)

        hmax = num(cons.get("MAX_HOURS_PER_YEAR"))
        if hmax is None:
            hmax = default_max
        if hmax is not None:
            rows.append((hour_terms, -INF, max(0.0, float(hmax) - pre_hours[lid])))

        hmin = num(cons.get("MIN_HOURS_PER_YEAR"))
        if hmin is not None and hour_terms:
            # q >= Hmin - pre - assigned, q >= 0: one unit of D per hour short.
            need = float(hmin) - pre_hours[lid]
            if need > 0:
                q = col(0, need, False)
                q_cols[lid] = q
                rows.append((hour_terms + [(q, 1.0)], need, INF))

        if not mine:
            continue

        for scope in SCOPES:
            kmax = num(cons.get(f"MAX_{scope}"))
            kmin = num(cons.get(f"MIN_{scope}"))
            if kmax is None and kmin is None:
                continue
            courses = {}
            for j, w in mine:
                if scope in scopes_of(w):
                    courses.setdefault(w["courseId"], []).append(j)
            already = pre_courses[lid][scope]
            free = {cid: cs for cid, cs in courses.items() if cid not in already}
            for cid, cs in free.items():
                y = col(0, 1, True)
                y_cols[(lid, scope, cid)] = y
                for j in cs:
                    rows.append(([(j, 1.0), (y, -1.0)], -INF, 0.0))        # x <= y
                # y <= sum x: without this the solver buys floor credit for courses the
                # lecturer does not teach. See the header.
                rows.append(([(j, 1.0) for j in cs] + [(y, -1.0)], 0.0, INF))
            ys = [(y_cols[(lid, scope, cid)], 1.0) for cid in free]
            if kmax is not None and ys:
                rows.append((ys, -INF, float(kmax) - len(already)))
            if kmin is not None:
                short = float(kmin) - len(already)
                if short > 0:
                    r = col(0, short, False)
                    r_cols[(lid, scope)] = r
                    rows.append((ys + [(r, 1.0)], short, INF))

    n = len(lower)
    cost_def = [0.0] * n
    for j in q_cols.values():
        cost_def[j] = 1.0
    for j in r_cols.values():
        cost_def[j] = float(omega)

    return {
        "lower": lower, "upper": upper, "integrality": integrality, "rows": rows,
        "costCoverage": cost_cov, "costDeficit": cost_def, "costDesirability": cost_des,
        "n": n, "n_x": n_x, "n_y": len(y_cols), "n_sup": n_sup,
        "n_q": len(q_cols), "n_r": len(r_cols),
    }


def load(model):
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    n = model["n"]
    h.addVars(n, [float(v) for v in model["lower"]], [float(v) for v in model["upper"]])
    ints = [j for j in range(n) if model["integrality"][j]]
    if ints:
        h.changeColsIntegrality(len(ints), ints, [highspy.HighsVarType.kInteger] * len(ints))
    starts, idx, val, los, his = [], [], [], [], []
    for coeffs, lo, hi in model["rows"]:
        starts.append(len(idx))
        for c, v in coeffs:
            idx.append(int(c)); val.append(float(v))
        los.append(float(lo)); his.append(float(hi))
    h.addRows(len(los), los, his, len(idx), starts, idx, val)
    return h, len(los)


def run_stage(h, model, cost, maximise, time_limit, threads):
    n = model["n"]
    h.changeColsCost(n, list(range(n)), [float(c) for c in cost])
    h.changeObjectiveSense(highspy.ObjSense.kMaximize if maximise else highspy.ObjSense.kMinimize)
    h.setOptionValue("time_limit", float(time_limit))
    h.setOptionValue("threads", int(threads))
    t0 = time.time()
    h.run()
    secs = time.time() - t0
    info = h.getInfo()
    status = h.modelStatusToString(h.getModelStatus())
    fin = lambda v: (float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None)
    return {
        "status": status,
        "objective": fin(h.getObjectiveValue()),
        "dualBound": fin(info.mip_dual_bound),
        "seconds": round(secs, 2),
        "closed": status == "Optimal",
    }


def solve_lex(model, time_limit, threads, eps):
    """The three stages, each pinning the previous one's optimum.

    A stage that does not close leaves the stages after it undetermined: without C* there is no set
    of maximum-coverage plans to search inside. The row is written anyway, with the stage that
    stopped named, so a partial result is legible rather than silently dropped.
    """
    h, _ = load(model)
    out = {}

    s1 = run_stage(h, model, model["costCoverage"], True, time_limit, threads)
    out["stage1"] = s1
    if not s1["closed"]:
        out["stoppedAt"] = 1
        return out, h
    cstar = round(s1["objective"])
    # C = C*. The <= side already holds from the per-workload rows, so >= suffices and keeps the
    # relaxation tighter than an equality would.
    h.addRow(float(cstar), INF, model["n_x"], list(range(model["n_x"])), [1.0] * model["n_x"])

    s2 = run_stage(h, model, model["costDeficit"], False, time_limit, threads)
    out["stage2"] = s2
    if not s2["closed"]:
        out["stoppedAt"] = 2
        out["coverageOpt"] = cstar
        return out, h
    dstar = s2["objective"]
    didx = [j for j in range(model["n"]) if model["costDeficit"][j]]
    if didx:
        h.addRow(-INF, float(dstar) + eps, len(didx),
                 didx, [float(model["costDeficit"][j]) for j in didx])

    s3 = run_stage(h, model, model["costDesirability"], True, time_limit, threads)
    out["stage3"] = s3
    out["stoppedAt"] = 0 if s3["closed"] else 3
    out["coverageOpt"] = cstar
    out["deficitOpt"] = round(dstar, 6)
    return out, h


def method_values(m, omega=OMEGA):
    """What the method itself scored on the same three components, from the harness row."""
    if not m:
        return {}
    return {
        "methodCoverage": m.get("slotsFilled"),
        "methodDeficit": m.get("floorShortfall"),
        "methodDesirability": m.get("totalDesirability"),
        "methodDesirabilityPerSlot": (
            round(m["totalDesirability"] / m["slotsFilled"], 4)
            if m.get("slotsFilled") else None),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--out", default="results/ip-lex.jsonl")
    ap.add_argument("--metrics", default="results/metrics.json")
    ap.add_argument("--sizes", default="10,20,40,80,160,320")
    ap.add_argument("--scenarios", default="")
    ap.add_argument("--time-limit", type=float, default=600.0)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--omega", type=float, default=OMEGA)
    ap.add_argument("--eps", type=float, default=1e-6)
    args = ap.parse_args()

    sizes = [int(s) for s in args.sizes.split(",") if s]
    want = set(args.scenarios.split(",")) if args.scenarios else None

    metrics = {}
    if os.path.exists(args.metrics):
        for r in json.load(open(args.metrics))["rows"]:
            metrics[r["dataset"]] = r

    done = set()
    if os.path.exists(args.out):
        for line in open(args.out):
            line = line.strip()
            if line:
                done.add(json.loads(line)["dataset"])

    todo = []
    for f in sorted(x for x in os.listdir(args.data) if x.endswith(".json") and x != "index.json"):
        name = f[:-5]
        scenario, _, size = name.rpartition("-")
        if int(size) not in sizes or (want and scenario not in want) or name in done:
            continue
        todo.append((name, os.path.join(args.data, f), int(size)))
    # Cheapest first, so an interrupted sweep still has the small end of every scenario.
    todo.sort(key=lambda t: (t[2], t[0]))

    print(f"{len(todo)} instance(s), lexicographic, omega={args.omega}, "
          f"{args.time_limit}s per stage", flush=True)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    for name, path, _ in todo:
        ds = json.load(open(path))
        inp = ds["input"]
        model = build_lex(inp, omega=args.omega)
        res, _h = solve_lex(model, args.time_limit, args.threads, args.eps)
        m = metrics.get(name)
        row = {
            "dataset": name,
            "scenario": ds["meta"]["scenario"],
            "lecturers": ds["meta"]["lecturers"],
            "mode": inp.get("mode"),
            "omega": args.omega,
            "xVars": model["n_x"], "yVars": model["n_y"], "supVars": model["n_sup"],
            "qVars": model["n_q"], "rVars": model["n_r"],
            **capacity_audit(inp),
            **res,
            **method_values(m, args.omega),
            "slotsRequested": (m or {}).get("slotsRequested"),
            "solver": f"HiGHS {highspy.Highs().version()}",
            "timeLimit": args.time_limit,
        }
        s3 = res.get("stage3") or {}
        # As in ipbound.py the gap is taken against the dual bound, so a stage-3 run that hits the
        # time limit still yields a rigorous ceiling on what the method left uncollected.
        zb = s3.get("dualBound") or s3.get("objective")
        if row.get("methodDesirability") and zb:
            row["lexGap"] = round(1 - row["methodDesirability"] / zb, 6)
        else:
            row["lexGap"] = None
        if row.get("methodCoverage") is not None and res.get("coverageOpt") is not None:
            row["coverageShort"] = res["coverageOpt"] - row["methodCoverage"]
        with open(args.out, "a") as fh:
            fh.write(json.dumps(row) + "\n")
        st = res.get("stoppedAt")
        print(f"{name:24s} stopped={st} C*={res.get('coverageOpt')} "
              f"D*={res.get('deficitOpt')} Z*={(s3.get('objective') or float('nan')):.0f} "
              f"methodZ={row.get('methodDesirability')} gap={row.get('lexGap')} "
              f"covShort={row.get('coverageShort')} "
              f"{sum((res.get(f'stage{i}') or {}).get('seconds', 0) for i in (1, 2, 3)):.1f}s",
              flush=True)


if __name__ == "__main__":
    sys.exit(main())
