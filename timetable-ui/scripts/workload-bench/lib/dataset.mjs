/**
 * Builds one `GenInput` for the workload generator, plus the statistics that let a reader check the
 * instance is believable rather than take it on trust.
 *
 * The build is deterministic in the seed and free of I/O, so `generate-datasets.mjs` (which writes
 * files) and `run-benchmark.mjs` (which may want extra unwritten seeds) share it without either
 * owning it.
 *
 * ## How the instance is sized
 *
 * The one number that anchors everything is the statutory ceiling: 600 academic hours per full post
 * per academic year (ст. 56 Закону України «Про вищу освіту»). A department of L lecturers can
 * absorb 600·L hours, so an instance is specified by the *fraction* of that capacity the plan asks
 * for — `demandRatio` — and courses are added until the planned hours reach it. The number of
 * courses is therefore an **output**, not an input, which is what keeps the instances comparable
 * across sizes: the same fraction of capacity is being fought over each time.
 */

import { Rng } from './rng.mjs';
import {
  STATUTORY_MAX_HOURS_PER_YEAR, POSITIONS, POSITION_PROFILE, COURSE_TYPES,
  GROUPS_PER_COURSE, HOUR_ROWS, GROUP_SIZE, TWO_LECTURER_LAB,
  COURSE_STEMS, DEGREE_PROGRAM_NAMES, HOUR_TYPE_UK
} from './model.mjs';

const AFFINITY_KEY = {
  LECTURE: 'lectureAffinity',
  PRACTICAL: 'practicalAffinity',
  LAB: 'labAffinity',
  CONSULTATION: 'practicalAffinity',
  ASSESSMENT: 'practicalAffinity'
};

/**
 * @param {{ lecturers: number, scenario: object, seed: number }} spec
 * @returns {{ meta: object, stats: object, input: object }}
 */
export function buildDataset({ lecturers: lecturerCount, scenario, seed }) {
  resetIds();
  const rng = new Rng(seed);
  const capacity = lecturerCount * STATUTORY_MAX_HOURS_PER_YEAR;
  const targetDemand = Math.round(capacity * scenario.demandRatio);
  const poolSize = Math.max(1, Math.min(lecturerCount, scenario.candidatePool(lecturerCount)));

  // ── Staff ──────────────────────────────────────────────────────────────────
  const staff = [];
  for (let i = 0; i < lecturerCount; i++) {
    const position = rng.weighted(POSITIONS);
    staff.push({
      id: `L${i + 1}`,
      name: `${position[0]}${position.slice(1).toLowerCase().replace('_', ' ')} №${i + 1}`,
      position,
      profile: POSITION_PROFILE[position]
    });
  }

  // ── Degree programmes the department serves ──────────────────────────────────────
  const degreeProgramCount = Math.max(1, Math.min(DEGREE_PROGRAM_NAMES.length, Math.round(lecturerCount / 12) + 1));
  const degreePrograms = DEGREE_PROGRAM_NAMES.slice(0, degreeProgramCount);

  // ── Courses and delivery positions, until the plan reaches the target ──────
  const workloads = [];
  const courses = [];
  let demand = 0;
  let courseIndex = 0;
  let groupIndex = 0;
  let studentIndex = 0;
  let guard = 0;

  while (demand < targetDemand && guard++ < 100000) {
    const id = `C${++courseIndex}`;
    const stem = COURSE_STEMS[(courseIndex - 1) % COURSE_STEMS.length];
    const suffix = courseIndex > COURSE_STEMS.length ? ` (${Math.ceil(courseIndex / COURSE_STEMS.length)})` : '';
    const courseType = rng.weighted(COURSE_TYPES);
    const semester = rng.int(1, 8);
    const groupCount = Number(rng.weighted(GROUPS_PER_COURSE));

    const groups = [];
    for (let g = 0; g < groupCount; g++) {
      groups.push({ id: `G${++groupIndex}`, size: rng.triangular(GROUP_SIZE.lo, GROUP_SIZE.hi, GROUP_SIZE.mode) });
    }

    // Who is qualified to teach this discipline at all. Drawn once per course, because expertise
    // attaches to the subject, not to the individual class block.
    const qualified = rng.sample(staff, poolSize);

    const course = {
      id, name: stem + suffix, courseType, semester,
      degreeProgram: degreePrograms[courseIndex % degreePrograms.length],
      groups: groupCount, qualified: qualified.map((l) => l.id),
      hourRows: [], positions: 0, hours: 0
    };

    for (const row of HOUR_ROWS) {
      if (!rng.chance(row.p)) continue;
      const hours = rng.step(row.lo, row.hi, 2);
      course.hourRows.push({ hourType: row.hourType, hours });

      // CONSULTATION is the row that can be delivered one-to-one; everything else is a class.
      const individual = row.hourType === 'CONSULTATION' && rng.chance(scenario.individualShare);

      if (individual) {
        const studentIds = [];
        for (const g of groups) {
          for (let s = 0; s < g.size; s++) studentIds.push(`S${++studentIndex}`);
        }
        // Individual supervision is drawn from a **wider** pool than class teaching. Supervising a
        // student's own work is something most of a кафедра can do, and in practice it is spread
        // across the department rather than landing on the two people who lecture the discipline.
        // Modelling it with the narrow class-teaching pool made a single consultation cost one
        // lecturer half a year, which is an artefact of the model rather than anything real.
        const supervisors = rng.sample(staff, Math.min(staff.length, Math.max(6, poolSize * 3)));
        const w = makeWorkload({
          rng, course, hourType: row.hourType, hours, teachingFormat: 'INDIVIDUALLY',
          lecturerCount: 1, qualified: supervisors, staff, studentIds, poolSize
        });
        workloads.push(w);
        course.positions++;
        demand += hours * studentIds.length;
        course.hours += hours * studentIds.length;
        continue;
      }

      const perGroup = row.perGroup ? groups : [null];
      for (const g of perGroup) {
        const needsTwo = row.hourType === 'LAB' && rng.chance(TWO_LECTURER_LAB);
        const n = needsTwo ? 2 : 1;
        const w = makeWorkload({
          rng, course, hourType: row.hourType, hours,
          teachingFormat: row.format, lecturerCount: n, qualified, staff,
          groupName: g?.id, poolSize
        });
        workloads.push(w);
        course.positions++;
        demand += hours * n;
        course.hours += hours * n;
      }
    }

    // A course with no hour rows at all contributes nothing; drop it rather than emit a stub.
    if (!course.hourRows.length) { courseIndex--; continue; }
    courses.push(course);
  }

  // ── Constraints, calibrated against what each lecturer can expect to receive ──
  const expectation = estimateLoad(workloads, staff);
  const constraintsByLecturer = new Map();
  for (const l of staff) {
    constraintsByLecturer.set(l.id, buildConstraints(rng, l, expectation.get(l.id), scenario));
  }

  // ── Pre-existing assignments, for 'gaps' mode ──────────────────────────────
  //
  // A half-built plan that already breaks its own ceilings is not a realistic starting point — a
  // department does not save one — and it would also poison the measurement, since the run is
  // forbidden to move a locked assignment and would be blamed for a breach it inherited. So the
  // pre-assignment respects every ceiling it can see, exactly as the person editing the plan would.
  let preAssignedSlots = 0;
  if (scenario.preAssigned > 0) {
    const held = new Map(staff.map((l) => [l.id, {
      hours: 0, all: new Set(),
      byType: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() },
      mandatory: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() },
      elective: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() }
    }]));

    for (const w of workloads) {
      if (!rng.chance(scenario.preAssigned) || !w.candidates.length) continue;

      if (w.teachingFormat === 'INDIVIDUALLY') {
        const half = Math.floor((w.studentIds?.length ?? 0) / 2);
        w.assignedStudents = (w.studentIds ?? []).slice(0, half).map((s, i) => ({
          studentId: s, lecturerId: w.candidates[i % w.candidates.length].lecturerId
        }));
        preAssignedSlots += w.assignedStudents.length ? 1 : 0;
        continue;
      }

      const chosen = [];
      for (const c of rng.shuffle([...w.candidates])) {
        if (chosen.length >= w.lecturerCount) break;
        const limits = constraintsByLecturer.get(c.lecturerId) ?? {};
        if (fitsCeilings(held.get(c.lecturerId), w, limits, STATUTORY_MAX_HOURS_PER_YEAR)) {
          chosen.push(c.lecturerId);
          applyHeld(held.get(c.lecturerId), w);
        }
      }
      w.assignedLecturerIds = chosen;
      preAssignedSlots += chosen.length;
    }
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  const input = {
    mode: scenario.mode,
    defaultMaxHoursPerYear: STATUTORY_MAX_HOURS_PER_YEAR,
    lecturers: staff.map((l) => ({ id: l.id, name: l.name, constraints: constraintsByLecturer.get(l.id) })),
    workloads: workloads.map(stripInternals)
  };

  const stats = summarise({
    input, courses, staff, capacity, demand, poolSize, preAssignedSlots,
    constraintsByLecturer, degreeProgramCount
  });

  return {
    meta: {
      scenario: scenario.key, lecturers: lecturerCount, seed,
      mode: scenario.mode, demandRatio: scenario.demandRatio
    },
    stats,
    input
  };
}

// ── Position construction ────────────────────────────────────────────────────

function makeWorkload({ rng, course, hourType, hours, teachingFormat, lecturerCount,
                        qualified, staff, studentIds, groupName, poolSize }) {
  const affinityKey = AFFINITY_KEY[hourType];

  // Of the people qualified for the discipline, those whose position would realistically be given
  // *this kind* of class. A professor is a candidate for the lecture, not for every lab.
  let pool = qualified.filter((l) => rng.chance(l.profile[affinityKey]));

  // A position with no candidates at all is a real situation and the generator reports it, but it
  // should be rare rather than systematic — so fall back to the most affine qualified person.
  if (!pool.length) {
    const best = [...qualified].sort((a, b) => b.profile[affinityKey] - a.profile[affinityKey]);
    pool = best.slice(0, Math.max(1, Math.min(lecturerCount, best.length)));
  }
  if (pool.length < lecturerCount) {
    for (const l of qualified) { if (!pool.includes(l) && pool.length < lecturerCount) pool.push(l); }
  }

  const candidates = pool.map((l) => {
    const base = rng.triangular(35, 100, 72) + l.profile.desirabilityBonus;
    const candidate = { lecturerId: l.id, desirability: Math.max(1, Math.min(100, Math.round(base))) };
    if (teachingFormat === 'INDIVIDUALLY') {
      // MIN_STUDENTS is the desired count, MAX_STUDENTS the ceiling — the two candidate-level
      // constraints in the schema, and the only ones `distributeStudents` reads.
      const total = studentIds?.length ?? 0;
      const fair = Math.max(1, Math.round(total / Math.max(1, pool.length)));
      candidate.minStudents = Math.max(1, Math.round(fair * 0.7));
      candidate.maxStudents = Math.max(candidate.minStudents, Math.round(fair * 1.8));
    }
    return candidate;
  });

  return {
    id: `W${++makeWorkload.counter}`,
    lecturerCount,
    assignedLecturerIds: [],
    candidates,
    hours,
    hourType,
    courseId: course.id,
    courseType: course.courseType,
    teachingFormat,
    studentIds,
    assignedStudents: teachingFormat === 'INDIVIDUALLY' ? [] : undefined,
    label: `${course.name}${groupName ? ` · ${groupName}` : ''} · ${HOUR_TYPE_UK[hourType]} · семестр ${course.semester}`
  };
}
makeWorkload.counter = 0;

/** Drops fields the generator never reads, keeping the committed JSON to the actual contract. */
function stripInternals(w) {
  const out = {
    id: w.id, lecturerCount: w.lecturerCount, assignedLecturerIds: w.assignedLecturerIds,
    candidates: w.candidates, hours: w.hours, hourType: w.hourType,
    courseId: w.courseId, courseType: w.courseType, teachingFormat: w.teachingFormat,
    label: w.label
  };
  if (w.studentIds) out.studentIds = w.studentIds;
  if (w.assignedStudents) out.assignedStudents = w.assignedStudents;
  return out;
}

// ── Constraint calibration ───────────────────────────────────────────────────

/**
 * What each lecturer can expect to be given, if the work were shared evenly among the candidates
 * for each position. Ceilings and floors are then expressed as multiples of that rather than as
 * absolute numbers, which is the only way "a tight ceiling" means the same thing at ten lecturers
 * and at three hundred.
 */
function estimateLoad(workloads, staff) {
  const out = new Map(staff.map((l) => [l.id, {
    hours: 0, courses: new Set(),
    byType: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() },
    mandatory: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() },
    elective: { LECTURE: new Set(), PRACTICAL: new Set(), LAB: new Set() }
  }]));

  for (const w of workloads) {
    if (!w.candidates.length) continue;
    const share = w.teachingFormat === 'INDIVIDUALLY'
      ? (w.hours * (w.studentIds?.length ?? 0)) / w.candidates.length
      : (w.hours * w.lecturerCount) / w.candidates.length;
    for (const c of w.candidates) {
      const e = out.get(c.lecturerId);
      if (!e) continue;
      e.hours += share;
      if (!['LECTURE', 'PRACTICAL', 'LAB'].includes(w.hourType)) continue;
      e.courses.add(w.courseId);
      e.byType[w.hourType].add(w.courseId);
      if (w.courseType === 'MANDATORY') e.mandatory[w.hourType].add(w.courseId);
      if (w.courseType === 'ELECTIVE' || w.courseType === 'ELECTIVE_GROUP') e.elective[w.hourType].add(w.courseId);
    }
  }

  // The sets above count every course the lecturer *could* take; scale to what they would actually
  // hold if positions were shared out evenly.
  for (const e of out.values()) {
    e.expCourses = Math.max(1, Math.round(e.courses.size * 0.55));
    e.expByType = {};
    e.expMandatory = {};
    e.expElective = {};
    for (const t of ['LECTURE', 'PRACTICAL', 'LAB']) {
      e.expByType[t] = Math.max(1, Math.round(e.byType[t].size * 0.55));
      e.expMandatory[t] = Math.max(1, Math.round(e.mandatory[t].size * 0.55));
      e.expElective[t] = Math.max(1, Math.round(e.elective[t].size * 0.55));
    }
  }
  return out;
}

function buildConstraints(rng, lecturer, expected, scenario) {
  const c = {};
  const { ceilings, floors } = scenario;
  const hours = Math.max(60, Math.round(expected?.hours ?? 300));

  // Hour bounds. The ceiling never exceeds what the lecturer's position allows in practice.
  if (rng.chance(ceilings.hours)) {
    c.MAX_HOURS_PER_YEAR = Math.min(lecturer.profile.maxHours, Math.round(hours * ceilings.tightness));
  }
  if (rng.chance(floors.hours)) {
    c.MIN_HOURS_PER_YEAR = Math.max(1, Math.round(hours * floors.tightness));
  }

  // Distinct courses across all taught hour types.
  if (rng.chance(ceilings.courses)) {
    c.MAX_COURSES = Math.max(1, Math.round((expected?.expCourses ?? 4) * ceilings.tightness));
  }

  for (const t of ['LECTURE', 'PRACTICAL', 'LAB']) {
    if (rng.chance(ceilings.byType)) {
      c[`MAX_${t}_COURSES`] = Math.max(1, Math.round((expected?.expByType?.[t] ?? 2) * ceilings.tightness));
    }
    if (rng.chance(floors.byType)) {
      c[`MIN_${t}_COURSES`] = Math.max(1, Math.round((expected?.expByType?.[t] ?? 2) * floors.tightness));
    }
    if (rng.chance(ceilings.byTypeCategory)) {
      c[`MAX_MANDATORY_${t}_COURSES`] = Math.max(1, Math.round((expected?.expMandatory?.[t] ?? 2) * ceilings.tightness));
    }
    if (rng.chance(floors.byTypeCategory)) {
      c[`MIN_MANDATORY_${t}_COURSES`] = Math.max(1, Math.round((expected?.expMandatory?.[t] ?? 2) * floors.tightness));
    }
    if (rng.chance(ceilings.byTypeCategory)) {
      c[`MAX_ELECTIVE_${t}_COURSES`] = Math.max(1, Math.round((expected?.expElective?.[t] ?? 1) * ceilings.tightness));
    }
    if (rng.chance(floors.byTypeCategory)) {
      c[`MIN_ELECTIVE_${t}_COURSES`] = Math.max(1, Math.round((expected?.expElective?.[t] ?? 1) * floors.tightness));
    }
  }

  // A floor above its own ceiling is not a hard instance, it is a contradictory one — and it would
  // make the repair pass chase something unreachable for reasons that say nothing about the search.
  for (const key of Object.keys(c)) {
    if (!key.startsWith('MIN_')) continue;
    const max = c[`MAX_${key.slice(4)}`];
    if (max != null && c[key] > max) c[key] = max;
  }
  return c;
}

// ── Statistics ───────────────────────────────────────────────────────────────

function summarise({ input, courses, staff, capacity, demand, poolSize, preAssignedSlots,
                     constraintsByLecturer, degreeProgramCount }) {
  const w = input.workloads;
  const byFormat = tally(w, (x) => x.teachingFormat);
  const byHourType = tally(w, (x) => x.hourType);
  const byCourseType = tally(w, (x) => x.courseType);
  const slots = w.filter((x) => x.teachingFormat !== 'INDIVIDUALLY')
                 .reduce((n, x) => n + x.lecturerCount, 0);
  const candidateEdges = w.reduce((n, x) => n + x.candidates.length, 0);
  const students = w.reduce((n, x) => n + (x.studentIds?.length ?? 0), 0);

  const usedConstraints = new Set();
  for (const map of constraintsByLecturer.values()) for (const k of Object.keys(map)) usedConstraints.add(k);

  const positionsPerCourse = courses.length ? w.length / courses.length : 0;

  return {
    lecturers: staff.length,
    degreePrograms: degreeProgramCount,
    courses: courses.length,
    coursesPerLecturer: round2(courses.length / staff.length),
    positions: w.length,
    positionsPerCourse: round2(positionsPerCourse),
    positionsPerLecturer: round2(w.length / staff.length),
    slots,
    slotsPerLecturer: round2(slots / staff.length),
    candidateEdges,
    candidatesPerPosition: round2(candidateEdges / Math.max(1, w.length)),
    candidatePoolPerCourse: poolSize,
    positionsWithNoCandidates: w.filter((x) => !x.candidates.length).length,
    students,
    plannedHours: Math.round(demand),
    capacityHours: capacity,
    demandRatio: round2(demand / capacity),
    plannedHoursPerLecturer: Math.round(demand / staff.length),
    preAssignedSlots,
    byFormat, byHourType, byCourseType,
    constraintTypesUsed: [...usedConstraints].sort(),
    constraintsPerLecturer: round2(
      [...constraintsByLecturer.values()].reduce((n, m) => n + Object.keys(m).length, 0) / staff.length
    )
  };
}

/** The ceiling half of the constraint semantics, as `schema.sql` defines them. */
function fitsCeilings(state, w, limits, defaultMaxHours) {
  if (!state) return false;
  const maxHours = num(limits.MAX_HOURS_PER_YEAR) ?? defaultMaxHours;
  if (maxHours != null && state.hours + w.hours > maxHours) return false;

  const t = ['LECTURE', 'PRACTICAL', 'LAB'].includes(w.hourType) ? w.hourType : null;
  if (!t) return true;

  const maxAll = num(limits.MAX_COURSES);
  if (maxAll != null && !state.all.has(w.courseId) && state.all.size + 1 > maxAll) return false;

  const check = (bucket, key) => {
    const max = num(limits[key]);
    return max == null || bucket.has(w.courseId) || bucket.size + 1 <= max;
  };
  if (!check(state.byType[t], `MAX_${t}_COURSES`)) return false;
  if (w.courseType === 'MANDATORY' && !check(state.mandatory[t], `MAX_MANDATORY_${t}_COURSES`)) return false;
  if ((w.courseType === 'ELECTIVE' || w.courseType === 'ELECTIVE_GROUP')
      && !check(state.elective[t], `MAX_ELECTIVE_${t}_COURSES`)) return false;
  return true;
}

function applyHeld(state, w) {
  state.hours += w.hours;
  const t = ['LECTURE', 'PRACTICAL', 'LAB'].includes(w.hourType) ? w.hourType : null;
  if (!t) return;
  state.all.add(w.courseId);
  state.byType[t].add(w.courseId);
  if (w.courseType === 'MANDATORY') state.mandatory[t].add(w.courseId);
  if (w.courseType === 'ELECTIVE' || w.courseType === 'ELECTIVE_GROUP') state.elective[t].add(w.courseId);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const tally = (list, key) => {
  const out = {};
  for (const x of list) { const k = key(x); out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

const round2 = (n) => Math.round(n * 100) / 100;

/** Resets the workload id counter; call before building a dataset that must be reproducible alone. */
export function resetIds() { makeWorkload.counter = 0; }
