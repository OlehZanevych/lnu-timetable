/**
 * Everything a paper about this algorithm would need to report, derived from one (input, result)
 * pair.
 *
 * Two rules shaped this file.
 *
 * **The validator does not trust the generator.** `verifyPlan` re-derives every lecturer's load from
 * the returned assignments and re-checks every constraint against the semantics written in
 * `schema.sql`, using none of the generator's own bookkeeping. If the search has a bug — a ceiling
 * counted twice, a course left in a set after a move — this is what catches it, and a feasibility
 * claim that rests on the searcher's own opinion of feasibility is worth nothing.
 *
 * Ceiling breaches are **attributed**, not merely counted, because three quite different things can
 * cause one and only the first is a defect in the search:
 *
 *   `search`      — the slot assignments the run chose break a ceiling. A bug.
 *   `individual`  — the slots are within the ceiling and only the individual-supervision hours added
 *                   by `distributeStudents` push past it. That routine assigns students by candidate
 *                   MIN_STUDENTS / MAX_STUDENTS alone and never consults `Load.canTake`, so it can
 *                   and does overrun the annual ceiling. That is the algorithm as written, not a
 *                   fault in the measurement.
 *   `pre-existing`— in `gaps` mode, locked assignments that already broke the ceiling before the run
 *                   started. The run is forbidden to move them, so it cannot be blamed for them.
 *
 * **Quality is reported against a bound, not in the abstract.** A total desirability of 41 208 means
 * nothing on its own. Against the sum of the best candidate available for each slot — a genuine
 * upper bound, since no slot can do better than its best candidate — it becomes an optimality gap
 * that is comparable across instances and across sizes.
 */

const COUNTED = ['LECTURE', 'PRACTICAL', 'LAB'];
const isMandatory = (t) => t === 'MANDATORY';
const isElective = (t) => t === 'ELECTIVE' || t === 'ELECTIVE_GROUP';

// ── Independent re-derivation of the plan's cost ──────────────────────────────

/**
 * Replays the returned plan against the input and reports what each lecturer ends up holding, plus
 * every constraint the plan breaks. Written from the schema, not from the generator.
 */
export function verifyPlan(input, result) {
  const byId = new Map(input.workloads.map((w) => [w.id, w]));
  const blank = (l) => ({
    id: l.id, hours: 0, individualHours: 0, constraints: l.constraints ?? {},
    all: new Set(),
    byType: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() },
    mandatory: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() },
    elective: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() }
  });
  const state = new Map(input.lecturers.map((l) => [l.id, blank(l)]));

  // What the locked assignments alone already cost, in `gaps` mode. Anything they break is not
  // attributable to this run.
  const before = new Map(input.lecturers.map((l) => [l.id, blank(l)]));
  if (input.mode === 'gaps') {
    for (const w of input.workloads) {
      if (w.teachingFormat === 'INDIVIDUALLY') continue;
      for (const id of w.assignedLecturerIds ?? []) accrue(before.get(id), w);
    }
  }

  const structural = [];

  for (const a of result.assignments) {
    const w = byId.get(a.workloadId);
    if (!w) { structural.push(`assignment for unknown workload ${a.workloadId}`); continue; }

    if (w.teachingFormat === 'INDIVIDUALLY') {
      const roster = new Set(w.studentIds ?? []);
      const seen = new Set();
      for (const p of a.studentAssignments ?? []) {
        if (!roster.has(p.studentId)) structural.push(`${w.id}: student ${p.studentId} is not on the roster`);
        if (seen.has(p.studentId)) structural.push(`${w.id}: student ${p.studentId} assigned twice`);
        seen.add(p.studentId);
        const cand = w.candidates.find((c) => c.lecturerId === p.lecturerId);
        if (!cand) { structural.push(`${w.id}: ${p.lecturerId} supervises but is not a candidate`); continue; }
        const s = state.get(p.lecturerId);
        if (s) s.individualHours += w.hours;
      }
      // MAX_STUDENTS is a candidate-level ceiling; check it here, since nothing else does.
      const per = new Map();
      for (const p of a.studentAssignments ?? []) per.set(p.lecturerId, (per.get(p.lecturerId) ?? 0) + 1);
      for (const [lid, n] of per) {
        const cand = w.candidates.find((c) => c.lecturerId === lid);
        if (cand?.maxStudents != null && n > cand.maxStudents) {
          structural.push(`${w.id}: ${lid} supervises ${n} students over a ceiling of ${cand.maxStudents}`);
        }
      }
      continue;
    }

    if (new Set(a.lecturerIds).size !== a.lecturerIds.length) {
      structural.push(`${w.id}: the same lecturer appears twice`);
    }
    if (a.lecturerIds.length > w.lecturerCount) {
      structural.push(`${w.id}: ${a.lecturerIds.length} lecturers for ${w.lecturerCount} slots`);
    }
    for (const id of a.lecturerIds) {
      const known = w.candidates.some((c) => c.lecturerId === id);
      const preExisting = (w.assignedLecturerIds ?? []).includes(id);
      if (!known && !preExisting) structural.push(`${w.id}: ${id} assigned but is not a candidate`);
      const s = state.get(id);
      if (!s) continue;                       // a lecturer outside the department: not our capacity
      accrue(s, w);
    }
  }

  const ceilingViolations = [];
  const floorViolations = [];
  const loads = [];

  for (const s of state.values()) {
    const c = s.constraints;
    const was = before.get(s.id);
    const maxHours = num(c.MAX_HOURS_PER_YEAR) ?? input.defaultMaxHoursPerYear;
    const total = s.hours + s.individualHours;

    if (maxHours != null && total > maxHours) {
      // The slots alone are what the search chose; individual supervision is added afterwards by a
      // routine that does not consult the ceiling at all.
      const cause = was.hours > maxHours ? 'pre-existing'
                  : s.hours > maxHours ? 'search'
                  : 'individual';
      ceilingViolations.push({
        lecturerId: s.id, rule: 'MAX_HOURS_PER_YEAR', limit: maxHours, actual: total,
        slotHours: s.hours, individualHours: s.individualHours, cause
      });
    }
    const minHours = num(c.MIN_HOURS_PER_YEAR);
    if (minHours != null && total < minHours) {
      floorViolations.push({ lecturerId: s.id, rule: 'MIN_HOURS_PER_YEAR', limit: minHours, actual: total, short: minHours - total });
    }
    checkCourses('COURSES', s.all.size, was.all.size);
    for (const t of COUNTED) {
      checkCourses(`${t}_COURSES`, s.byType[t].size, was.byType[t].size);
      checkCourses(`MANDATORY_${t}_COURSES`, s.mandatory[t].size, was.mandatory[t].size);
      checkCourses(`ELECTIVE_${t}_COURSES`, s.elective[t].size, was.elective[t].size);
    }
    function checkCourses(suffix, actual, previously) {
      const max = num(c[`MAX_${suffix}`]);
      if (max != null && actual > max) {
        ceilingViolations.push({ lecturerId: s.id, rule: `MAX_${suffix}`, limit: max, actual,
          cause: previously > max ? 'pre-existing' : 'search' });
      }
      const min = num(c[`MIN_${suffix}`]);
      if (min != null && actual < min) {
        floorViolations.push({ lecturerId: s.id, rule: `MIN_${suffix}`, limit: min, actual, short: min - actual });
      }
    }

    loads.push({
      lecturerId: s.id, hours: total, slotHours: s.hours, individualHours: s.individualHours,
      courses: s.all.size, maxHours
    });
  }

  const byCause = (k) => ceilingViolations.filter((v) => v.cause === k);
  // Severity, not headcount. Spreading an unavoidable overrun across more people raises the count of
  // breaching lecturers while lowering the harm to each, so the count alone cannot say whether a
  // change helped; total hours over the ceiling can.
  const ceilingOverrunHours = ceilingViolations
    .filter((v) => v.rule === 'MAX_HOURS_PER_YEAR')
    .reduce((n, v) => n + (v.actual - v.limit), 0);
  return {
    ceilingOverrunHours,
    structural, ceilingViolations, floorViolations, loads,
    ceilingBySearch: byCause('search'),
    ceilingByIndividual: byCause('individual'),
    ceilingPreExisting: byCause('pre-existing')
  };
}

/** Adds one non-individual workload to a lecturer's re-derived load. */
function accrue(s, w) {
  if (!s) return;
  s.hours += w.hours;
  const t = COUNTED.includes(w.hourType) ? w.hourType : null;
  if (!t) return;
  s.all.add(w.courseId);
  s.byType[t].add(w.courseId);
  if (isMandatory(w.courseType)) s.mandatory[t].add(w.courseId);
  if (isElective(w.courseType)) s.elective[t].add(w.courseId);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Desirability bound ───────────────────────────────────────────────────────

/**
 * An upper bound on achievable desirability: every slot filled by its single best candidate,
 * ignoring that one lecturer cannot hold two slots at once and ignoring every ceiling. Loose by
 * construction — no relaxation this cheap is tight — but it is a genuine bound, so the gap it
 * produces is an honest ceiling on how much a better search could win.
 */
export function desirabilityBound(input) {
  let bound = 0;
  let slots = 0;
  for (const w of input.workloads) {
    if (w.teachingFormat === 'INDIVIDUALLY' || !w.candidates.length) continue;
    const need = input.mode === 'gaps'
      ? Math.max(0, w.lecturerCount - (w.assignedLecturerIds?.length ?? 0))
      : w.lecturerCount;
    if (need <= 0) continue;
    const best = [...w.candidates].sort((a, b) => b.desirability - a.desirability);
    for (let i = 0; i < Math.min(need, best.length); i++) bound += best[i].desirability;
    slots += need;
  }
  return { bound, slots };
}

// ── Distribution statistics ──────────────────────────────────────────────────

export function distribution(values) {
  if (!values.length) return { n: 0, mean: 0, sd: 0, cv: 0, min: 0, max: 0, p50: 0, p90: 0, gini: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const sd = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  // Gini on a non-negative distribution: the standard mean-difference form. 0 = everyone equal.
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * sorted[i];
  const gini = sum > 0 ? cum / (n * sum) : 0;
  return {
    n, mean: r2(mean), sd: r2(sd), cv: mean > 0 ? r3(sd / mean) : 0,
    min: sorted[0], max: sorted[n - 1],
    p50: sorted[Math.floor(n * 0.5)], p90: sorted[Math.min(n - 1, Math.floor(n * 0.9))],
    gini: r3(gini)
  };
}

// ── The row a results table gets ─────────────────────────────────────────────

/**
 * @param {object} dataset  the parsed JSON fixture ({ meta, stats, input })
 * @param {object} result   what `generateWorkloads` returned
 * @param {object} timing   { msMean, msMin, msMax, msSd, repeats } across repeats
 */
export function measure(dataset, result, timing) {
  const { input, stats, meta } = dataset;
  const v = verifyPlan(input, result);
  const { bound, slots: boundSlots } = desirabilityBound(input);

  const hours = v.loads.map((l) => l.hours);
  const courses = v.loads.map((l) => l.courses);
  const utilisation = v.loads
    .filter((l) => l.maxHours)
    .map((l) => l.hours / l.maxHours);

  const t = result.telemetry;
  const issueCounts = {};
  for (const i of result.issues) issueCounts[i.kind] = (issueCounts[i.kind] ?? 0) + 1;

  const individualTotal = input.workloads
    .filter((w) => w.teachingFormat === 'INDIVIDUALLY')
    .reduce((n, w) => n + (w.studentIds?.length ?? 0), 0);
  const individualPlaced = result.assignments
    .reduce((n, a) => n + (a.studentAssignments?.length ?? 0), 0);

  return {
    // ── identification ──
    dataset: `${meta.scenario}-${meta.lecturers}`,
    scenario: meta.scenario,
    lecturers: meta.lecturers,
    mode: input.mode,
    seed: meta.seed,

    // ── instance size ──
    courses: stats.courses,
    positions: stats.positions,
    slotsRequested: result.requestedSlots,
    candidateEdges: stats.candidateEdges,
    candidatesPerPosition: stats.candidatesPerPosition,
    students: stats.students,
    demandRatio: stats.demandRatio,
    constraintsPerLecturer: stats.constraintsPerLecturer,

    // ── performance ──
    msMean: r3(timing.msMean),
    msMin: r3(timing.msMin),
    msMax: r3(timing.msMax),
    msSd: r3(timing.msSd),
    repeats: timing.repeats,
    msSetup: r3(t.ms.setup),
    msGreedy: r3(t.ms.greedy),
    msRepair: r3(t.ms.repair),
    msImprove: r3(t.ms.improve),
    msIndividual: r3(t.ms.individual),
    msReport: r3(t.ms.report),
    usPerSlot: result.requestedSlots ? r3((timing.msMean * 1000) / result.requestedSlots) : 0,
    slotsPerSecond: timing.msMean > 0 ? Math.round((result.requestedSlots / timing.msMean) * 1000) : 0,

    // ── work done (machine-independent) ──
    opsCanTake: t.ops.canTake,
    opsFeasibleScan: t.ops.feasibleScan,
    opsFeasibleCandidates: t.ops.feasibleCandidates,
    opsGreedySortComparisons: t.ops.greedySortComparisons,
    opsLoadAdd: t.ops.loadAdd,
    opsLoadRemove: t.ops.loadRemove,
    opsDeficitEvaluations: t.ops.deficitEvaluations,
    opsDeficitLecturerScans: t.ops.deficitLecturerScans,
    repairPasses: t.ops.repairPasses,
    repairProbes: t.ops.repairProbes,
    repairMoves: t.ops.repairMoves,
    improvePasses: t.ops.improvePasses,
    improveProbes: t.ops.improveProbes,
    improveMoves: t.ops.improveMoves,
    canTakePerSlot: result.requestedSlots ? r2(t.ops.canTake / result.requestedSlots) : 0,

    // ── solution quality ──
    slotsFilled: result.filledSlots,
    fillRate: result.requestedSlots ? r4(result.filledSlots / result.requestedSlots) : 1,
    totalDesirability: result.totalDesirability,
    desirabilityBound: bound,
    optimalityGap: bound > 0 ? r4(1 - result.totalDesirability / bound) : 0,
    meanDesirability: result.filledSlots ? r2(result.totalDesirability / result.filledSlots) : 0,
    boundSlots,

    // ── feasibility, checked independently ──
    structuralErrors: v.structural.length,
    ceilingViolations: v.ceilingViolations.length,
    ceilingViolationsBySearch: v.ceilingBySearch.length,
    ceilingViolationsByIndividual: v.ceilingByIndividual.length,
    ceilingViolationsPreExisting: v.ceilingPreExisting.length,
    ceilingOverrunHours: v.ceilingOverrunHours,
    floorViolations: v.floorViolations.length,
    floorShortfall: v.floorViolations.reduce((s, f) => s + f.short, 0),
    lecturersBelowFloor: new Set(v.floorViolations.map((f) => f.lecturerId)).size,

    // ── load balance ──
    hoursMean: distribution(hours).mean,
    hoursSd: distribution(hours).sd,
    hoursCv: distribution(hours).cv,
    hoursMin: distribution(hours).min,
    hoursMax: distribution(hours).max,
    hoursGini: distribution(hours).gini,
    coursesMean: distribution(courses).mean,
    coursesMax: distribution(courses).max,
    utilisationMean: utilisation.length ? r3(utilisation.reduce((s, u) => s + u, 0) / utilisation.length) : 0,
    lecturersWithNoWork: hours.filter((h) => h === 0).length,

    // ── individual supervision ──
    studentsPlaced: individualPlaced,
    studentsTotal: individualTotal,
    studentPlacementRate: individualTotal ? r4(individualPlaced / individualTotal) : 1,

    // ── what the run reported ──
    issuesTotal: result.issues.length,
    issuesUnfilled: issueCounts.unfilled ?? 0,
    issuesUnmetMinimum: issueCounts['unmet-minimum'] ?? 0,
    issuesNoCandidates: issueCounts['no-candidates'] ?? 0,
    issuesNoStudents: issueCounts['no-students'] ?? 0,
    issuesOverCeiling: issueCounts['over-ceiling'] ?? 0,

    // ── details, kept out of the CSV ──
    _violations: {
      search: v.ceilingBySearch.slice(0, 10),
      individual: v.ceilingByIndividual.slice(0, 5),
      preExisting: v.ceilingPreExisting.slice(0, 5),
      structural: v.structural.slice(0, 10)
    }
  };
}

/**
 * A fingerprint of the plan, for checking that two runs of the same input agree. Order-insensitive
 * within a workload, order-sensitive across them (the generator returns a stable order).
 */
export function planFingerprint(result) {
  const parts = [];
  for (const a of [...result.assignments].sort((x, y) => x.workloadId.localeCompare(y.workloadId))) {
    parts.push(`${a.workloadId}=${[...a.lecturerIds].sort().join(',')}`);
    if (a.studentAssignments?.length) {
      parts.push(`${a.workloadId}#${a.studentAssignments.map((p) => `${p.studentId}>${p.lecturerId}`).sort().join(',')}`);
    }
  }
  // FNV-1a over the joined string: enough to detect a differing plan, cheap enough to run every time.
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Least-squares fit of log(y) against log(x): the empirical growth exponent α in y ≈ c·x^α, plus the
 * R² that says whether a power law describes the data at all. This is the headline number for a
 * scaling section — α ≈ 1 is linear, α ≈ 2 quadratic — and R² is what stops it being asserted when
 * the points do not actually lie on a line.
 */
export function powerLawFit(points) {
  const usable = points.filter((p) => p.x > 0 && p.y > 0);
  if (usable.length < 3) return { alpha: null, r2: null, n: usable.length };
  const xs = usable.map((p) => Math.log(p.x));
  const ys = usable.map((p) => Math.log(p.y));
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const alpha = sxx === 0 ? null : sxy / sxx;
  const r2v = sxx === 0 || syy === 0 ? null : (sxy * sxy) / (sxx * syy);
  return { alpha: alpha == null ? null : r3(alpha), r2: r2v == null ? null : r4(r2v), n };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;
