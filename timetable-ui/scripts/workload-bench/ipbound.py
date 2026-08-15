#!/usr/bin/env python3
"""
An exact optimality bound for the workload-assignment problem of article 2.

The harness's own bound (`lib/metrics.mjs`, `desirabilityBound`) sums, over slots,
the desirability of each slot's single best candidate. It ignores that one lecturer
cannot hold two slots, ignores the annual hour ceiling and ignores every
distinct-course ceiling. It is a genuine upper bound and it is very loose.

This script solves the assignment problem itself as a mixed-integer program, with
HiGHS, so that the gap the paper reports is measured against something a better
search could actually attain.

WHAT IS MODELLED, EXACTLY

  variables   x[w,l] = 1 iff lecturer l holds one slot of workload w,
                       for every candidate l of every non-INDIVIDUALLY workload w
              y[l,scope,c] = 1 iff lecturer l holds course c inside `scope`
                       (created only where lecturer l has a MAX ceiling on `scope`)

  objective   max  sum  d(w,l) * x[w,l]            <- Eq. (objective) of the paper

  s.t.        sum_l x[w,l]  <=  need(w)            slots of w, minus any locked ones
              sum_w h(w) x[w,l]  <=  Hmax(l) - preHours(l)          hour ceiling
              x[w,l] <= y[l,scope,crs(w)]  for each scope w belongs to
              sum_c y[l,scope,c] <= Kmax(l,scope)               course ceilings

  The course scopes are exactly the ones `verifyPlan` re-derives: COURSES,
  {LECTURE,PRACTICAL,LAB}_COURSES, MANDATORY_*_COURSES and ELECTIVE_*_COURSES,
  and, as there, only LECTURE / PRACTICAL / LAB workloads enter a course set at
  all -- consultations and assessments cost hours and nothing else.

  In `gaps` mode the locked assignments are not decisions: their hours and their
  courses are subtracted from the right-hand sides, and a locked lecturer is
  removed from that workload's candidate list.

THE ONE RELAXATION, AND WHY IT KEEPS THIS AN UPPER BOUND

  Individual-supervision hours are NOT charged against the ceiling here. In the
  method they are assigned first, by a routine that never consults the ceiling,
  and they consume capacity the slot search then cannot use. Charging them would
  require fixing one particular student-to-supervisor map inside the bound, which
  would stop it being a bound on the problem and make it a bound on one heuristic
  decision. Leaving them out only enlarges the feasible set, so the optimum
  reported here is >= the true optimum of the full problem: the gap it yields is
  still an upper bound on the method's true gap, just a far tighter one.

  Floors are soft in the paper's formulation and do not appear in Eq. (objective),
  so they are absent here too. `--floors` adds them as hard constraints; that is a
  different problem (frequently infeasible) and is reported separately.

Writes one JSON row per instance to results/ip-bound.jsonl.
"""

import argparse
import json
import math
import os
import sys
import time

import highspy

COUNTED = ("LECTURE", "PRACTICAL", "LAB")
SCOPES = ["COURSES"]
for _t in COUNTED:
    SCOPES += [f"{_t}_COURSES", f"MANDATORY_{_t}_COURSES", f"ELECTIVE_{_t}_COURSES"]


def scopes_of(w):
    """The course scopes one workload belongs to, matching `accrue` in metrics.mjs."""
    t = w["hourType"]
    if t not in COUNTED:
        return ()
    out = ["COURSES", f"{t}_COURSES"]
    ct = w.get("courseType")
    if ct == "MANDATORY":
        out.append(f"MANDATORY_{t}_COURSES")
    if ct in ("ELECTIVE", "ELECTIVE_GROUP"):
        out.append(f"ELECTIVE_{t}_COURSES")
    return tuple(out)


def num(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None


def build(inp, floors=False, supervision=False):
    """Returns (model, meta) where model is a dict of the arrays HiGHS wants.

    With `supervision=True` the individual-supervision workloads become decisions of
    the same program rather than a relaxation: an integer count n[w,l] of students
    lecturer l supervises on position w, bounded by that candidate's MAX_STUDENTS,
    summing to the whole roster, and charging w.hours per student against the annual
    ceiling exactly as `distributeStudents` does. Students are interchangeable here
    because the cost of supervising one is the same for all of them, so counts
    suffice and the model stays small. The supervision variables carry no objective
    weight, because `totalDesirability` in the generator sums over slot workloads
    only -- they exist purely to consume capacity.
    """
    lecturers = {l["id"]: l for l in inp["lecturers"]}
    mode = inp.get("mode")
    default_max = inp.get("defaultMaxHoursPerYear")

    # ---- what the locked assignments already consume (gaps mode) -------------
    pre_hours = {lid: 0 for lid in lecturers}
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

    # ---- decision variables --------------------------------------------------
    xs = []                      # (workload, lecturerId, desirability)
    per_workload = []            # list of lists of column indices
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
            cols.append(len(xs))
            xs.append((w, c["lecturerId"], c["desirability"]))
        per_workload.append((cols, need))

    n_x = len(xs)
    cost = [float(d) for (_w, _l, d) in xs]
    lower = [0.0] * n_x
    upper = [1.0] * n_x
    integrality = [1] * n_x

    rows = []                    # (list[(col, coef)], lo, hi)

    # one lecturer per slot, at most `need` slots filled
    for cols, need in per_workload:
        rows.append(([(c, 1.0) for c in cols], -highspy.kHighsInf, float(need)))

    # ---- supervision counts, when they are decisions rather than a relaxation --
    sup_by_lect = {lid: [] for lid in lecturers}
    n_sup = 0
    if supervision:
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
            if need <= 0:
                continue
            cols = []
            for c in w["candidates"]:
                lid = c["lecturerId"]
                cap = c.get("maxStudents")
                hi = float(need if cap is None else max(0, cap - locked.get(lid, 0)))
                if hi <= 0:
                    continue
                col = len(lower)
                cols.append(col)
                lower.append(0.0)
                upper.append(min(hi, float(need)))
                integrality.append(1)
                cost.append(0.0)
                n_sup += 1
                if lid in sup_by_lect:
                    sup_by_lect[lid].append((col, float(w["hours"])))
            if not cols:
                continue
            # every student on the roster gets a supervisor: the method places 100 %
            rows.append(([(c, 1.0) for c in cols], float(need), float(need)))
            # hours the locked supervisions already cost
            for lid, k in locked.items():
                if lid in pre_hours:
                    pre_hours[lid] += k * w["hours"]

    # ---- per-lecturer constraints -------------------------------------------
    by_lect = {lid: [] for lid in lecturers}
    for col, (w, lid, _d) in enumerate(xs):
        if lid in by_lect:
            by_lect[lid].append((col, w))

    y_cols = {}                  # (lid, scope, courseId) -> column index

    for lid, l in lecturers.items():
        cons = l.get("constraints") or {}
        mine = by_lect[lid]
        sup = sup_by_lect[lid]
        if not mine and not sup:
            continue

        hmax = num(cons.get("MAX_HOURS_PER_YEAR"))
        if hmax is None:
            hmax = default_max
        if hmax is not None:
            rhs = float(hmax) - pre_hours[lid]
            terms = [(c, float(w["hours"])) for c, w in mine] + list(sup)
            rows.append((terms, -highspy.kHighsInf, rhs))
        if not mine:
            continue

        if floors:
            hmin = num(cons.get("MIN_HOURS_PER_YEAR"))
            if hmin is not None:
                rows.append(([(c, float(w["hours"])) for c, w in mine] + list(sup),
                             float(hmin) - pre_hours[lid], highspy.kHighsInf))

        for scope in SCOPES:
            kmax = num(cons.get(f"MAX_{scope}"))
            kmin = num(cons.get(f"MIN_{scope}")) if floors else None
            if kmax is None and kmin is None:
                continue
            # every course this lecturer could pick up inside this scope
            courses = {}
            for c, w in mine:
                if scope in scopes_of(w):
                    courses.setdefault(w["courseId"], []).append(c)
            already = pre_courses[lid][scope]
            free = {cid: cs for cid, cs in courses.items() if cid not in already}
            for cid, cs in free.items():
                key = (lid, scope, cid)
                col = len(lower)
                y_cols[key] = col
                lower.append(0.0)
                upper.append(1.0)
                integrality.append(1)
                cost.append(0.0)
                for c in cs:                      # x <= y
                    rows.append(([(c, 1.0), (col, -1.0)], -highspy.kHighsInf, 0.0))
            if kmax is not None:
                lo, hi = -highspy.kHighsInf, float(kmax) - len(already)
                rows.append(([(y_cols[(lid, scope, cid)], 1.0) for cid in free], lo, hi))
            if kmin is not None:
                rows.append(([(y_cols[(lid, scope, cid)], 1.0) for cid in free],
                             float(kmin) - len(already), highspy.kHighsInf))

    return {
        "cost": cost, "lower": lower, "upper": upper, "integrality": integrality,
        "rows": rows, "n_x": n_x, "n_y": len(y_cols), "n_sup": n_sup,
    }


def solve(model, time_limit, threads, gap):
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("time_limit", float(time_limit))
    h.setOptionValue("threads", int(threads))
    h.setOptionValue("mip_rel_gap", float(gap))

    n = len(model["cost"])
    h.addVars(n, [float(v) for v in model["lower"]], [float(v) for v in model["upper"]])
    h.changeColsIntegrality(n, list(range(n)), [highspy.HighsVarType.kInteger] * n)
    h.changeColsCost(n, list(range(n)), [float(c) for c in model["cost"]])
    h.changeObjectiveSense(highspy.ObjSense.kMaximize)

    starts, idx, val, los, his = [], [], [], [], []
    for coeffs, lo, hi in model["rows"]:
        starts.append(len(idx))
        for c, v in coeffs:
            idx.append(int(c))
            val.append(float(v))
        los.append(float(lo))
        his.append(float(hi))
    h.addRows(len(los), los, his, len(idx), starts, idx, val)

    t0 = time.time()
    h.run()
    secs = time.time() - t0
    info = h.getInfo()
    status = h.modelStatusToString(h.getModelStatus())
    # JSON has no Infinity or NaN, and an infeasible model reports both. Write null instead, so
    # every downstream reader gets valid JSON and has to decide what to do about a missing bound
    # rather than silently parsing a token no other language accepts.
    fin = lambda v: (float(v) if isinstance(v, (int, float)) and math.isfinite(v) else None)
    return {
        "status": status,
        "objective": fin(h.getObjectiveValue()),
        "dualBound": fin(info.mip_dual_bound),
        "mipGap": fin(info.mip_gap),
        "nodes": info.mip_node_count,
        "seconds": round(secs, 2),
        "cols": n,
        "rows": len(los),
        "nonzeros": len(idx),
    }


def capacity_audit(inp):
    """Aggregate hours accounting for one instance.

    Used only to answer one question the infeasibility results raise: when no assignment
    can place every student under every ceiling, is the department simply short of hours,
    or is the obstruction structural? `slack` is the department's whole statutory capacity
    minus the hours it is already committed to (locked assignments, in `gaps` mode) minus
    the hours every student on every supervision roster must consume wherever they are
    placed. A positive slack means the hours exist somewhere and the obstruction is which
    lecturers may take which students, not how many hours there are.
    """
    lecturers = {l["id"]: l for l in inp["lecturers"]}
    default_max = inp.get("defaultMaxHoursPerYear")
    capacity = 0
    for l in inp["lecturers"]:
        h = num((l.get("constraints") or {}).get("MAX_HOURS_PER_YEAR"))
        if h is None:
            h = default_max
        if h is not None:
            capacity += h
    locked = 0
    supervision = 0
    for w in inp["workloads"]:
        if w["teachingFormat"] == "INDIVIDUALLY":
            roster = w.get("studentIds") or []
            supervision += w["hours"] * len(roster)
            continue
        if inp.get("mode") == "gaps":
            held = [x for x in (w.get("assignedLecturerIds") or []) if x in lecturers]
            locked += w["hours"] * len(held)
    return {
        "capacityHours": capacity,
        "lockedSlotHours": locked,
        "supervisionHours": supervision,
        "slackHours": capacity - locked - supervision,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--out", default="results/ip-bound.jsonl")
    ap.add_argument("--metrics", default="results/metrics.json")
    ap.add_argument("--sizes", default="10,20,40")
    ap.add_argument("--scenarios", default="")
    ap.add_argument("--time-limit", type=float, default=900.0)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--gap", type=float, default=0.0)
    ap.add_argument("--floors", action="store_true")
    ap.add_argument("--supervision", action="store_true")
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
                r = json.loads(line)
                done.add((r["dataset"], r["floors"], r.get("supervision", False)))

    files = sorted(f for f in os.listdir(args.data) if f.endswith(".json") and f != "index.json")
    todo = []
    for f in files:
        name = f[:-5]
        scenario, _, size = name.rpartition("-")
        if int(size) not in sizes:
            continue
        if want and scenario not in want:
            continue
        if (name, args.floors, args.supervision) in done:
            continue
        todo.append((name, os.path.join(args.data, f)))

    print(f"{len(todo)} instance(s) to solve, floors={args.floors}, "
          f"supervision={args.supervision}", flush=True)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    for name, path in todo:
        ds = json.load(open(path))
        inp = ds["input"]
        model = build(inp, floors=args.floors, supervision=args.supervision)
        res = solve(model, args.time_limit, args.threads, args.gap)
        m = metrics.get(name)
        row = {
            "dataset": name,
            **capacity_audit(inp),
            "scenario": ds["meta"]["scenario"],
            "lecturers": ds["meta"]["lecturers"],
            "mode": inp.get("mode"),
            "seed": ds["meta"]["seed"],
            "floors": args.floors,
            "supervision": args.supervision,
            "xVars": model["n_x"],
            "yVars": model["n_y"],
            "supVars": model["n_sup"],
            **res,
            "method": (m or {}).get("totalDesirability"),
            "harnessBound": (m or {}).get("desirabilityBound"),
            "harnessGap": (m or {}).get("optimalityGap"),
            "slotsRequested": (m or {}).get("slotsRequested"),
            "slotsFilled": (m or {}).get("slotsFilled"),
            "solver": f"HiGHS {highspy.Highs().version()}",
            "timeLimit": args.time_limit,
        }
        # The gap is taken against the *dual* bound, not the incumbent: on a run that
        # hits the time limit the incumbent is only a feasible solution, whereas the
        # dual bound is a proven ceiling on the optimum, so 1 - method/dualBound is a
        # rigorous upper bound on the method's true gap either way. On a solve proved
        # optimal the two coincide.
        if row["method"] is not None and res["dualBound"]:
            row["ipGap"] = round(1 - row["method"] / res["dualBound"], 6)
            row["ipGapIncumbent"] = round(1 - row["method"] / res["objective"], 6) \
                if res["objective"] else None
        else:
            row["ipGap"] = None
            row["ipGapIncumbent"] = None
        with open(args.out, "a") as fh:
            fh.write(json.dumps(row) + "\n")
        print(
            f"{name:26s} {res['status']:22s} ip={(res['objective'] if res['objective'] is not None else float('nan')):>10.0f} "
            f"method={row['method']} harness={row['harnessBound']} "
            f"gap={row.get('ipGap')} {res['seconds']}s",
            flush=True,
        )


if __name__ == "__main__":
    sys.exit(main())
