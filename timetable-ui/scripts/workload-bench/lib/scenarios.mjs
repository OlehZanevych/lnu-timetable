/**
 * The eight scenarios. Each isolates one thing that can make the search expensive, so that a timing
 * curve can be attributed rather than merely observed.
 *
 * Knobs:
 *   `mode`             — 'all' or 'gaps', passed straight to the generator.
 *   `demandRatio`      — total planned hours ÷ total annual capacity. Below 1 the instance is
 *                        comfortably feasible; above 1 it provably is not, and the run must report
 *                        that rather than loop.
 *   `candidatePool`    — how many lecturers are qualified for a given course. A function of the
 *                        department size, because "every colleague is a candidate" and "two people
 *                        can teach this" are different problems.
 *   `ceilings`/`floors`— probability that a lecturer carries a MAX_ or MIN_ constraint of each family,
 *                        and how tight it is. Floors are what the repair pass exists for; ceilings
 *                        are what makes the greedy's feasibility scan reject candidates.
 *   `preAssigned`      — share of positions that already have their lecturers before the run.
 *   `individualShare`  — share of CONSULTATION positions taught INDIVIDUALLY, which routes work to
 *                        `distributeStudents` instead of the slot search.
 */

/** @typedef {import('./dataset.mjs').ScenarioSpec} ScenarioSpec */

export const SCENARIOS = [
  {
    key: 'baseline',
    title: 'Typical department',
    description:
      'A department as one actually is: comfortable but not idle (80 % of the annual ceiling ' +
      'planned), a handful of qualified candidates per discipline, ceilings on most staff and ' +
      'floors on some. The reference point every other scenario is read against.',
    mode: 'all',
    demandRatio: 0.80,
    candidatePool: () => 5,
    ceilings: { hours: 0.85, courses: 0.35, byType: 0.30, byTypeCategory: 0.20, tightness: 1.35 },
    floors:   { hours: 0.30, byType: 0.20, byTypeCategory: 0.10, tightness: 0.55 },
    preAssigned: 0,
    individualShare: 0.15
  },
  {
    key: 'unconstrained',
    title: 'No individual constraints',
    description:
      'Identical structure to the baseline, but no lecturer carries a constraint of their own — only ' +
      'the university-wide default ceiling applies. Isolates the cost the search pays for merely ' +
      'having slots and candidates, with every feasibility check trivially satisfied. The control.',
    mode: 'all',
    demandRatio: 0.80,
    candidatePool: () => 5,
    ceilings: { hours: 0, courses: 0, byType: 0, byTypeCategory: 0, tightness: 1 },
    floors:   { hours: 0, byType: 0, byTypeCategory: 0, tightness: 1 },
    preAssigned: 0,
    individualShare: 0.15
  },
  {
    key: 'tight-ceilings',
    title: 'Tight ceilings, no floors',
    description:
      'Every lecturer carries an hour ceiling close to what they will actually be given, plus ' +
      'distinct-course ceilings of every family. Nobody has a floor, so the repair pass has nothing ' +
      'to do and the whole cost lands on the greedy feasibility scan.',
    mode: 'all',
    demandRatio: 0.92,
    candidatePool: () => 5,
    ceilings: { hours: 1.0, courses: 0.80, byType: 0.75, byTypeCategory: 0.60, tightness: 1.08 },
    floors:   { hours: 0, byType: 0, byTypeCategory: 0, tightness: 1 },
    preAssigned: 0,
    individualShare: 0.15
  },
  {
    key: 'tight-floors',
    title: 'Floors on most staff',
    description:
      'The mirror image: generous ceilings, but most lecturers must reach a minimum number of hours ' +
      'and of distinct courses by type. The greedy alone cannot satisfy a floor — it can only fill ' +
      'slots — so this is the scenario in which the repair pass does real work.',
    mode: 'all',
    demandRatio: 0.80,
    candidatePool: () => 5,
    ceilings: { hours: 0.60, courses: 0.10, byType: 0.10, byTypeCategory: 0.05, tightness: 1.60 },
    floors:   { hours: 0.85, byType: 0.65, byTypeCategory: 0.45, tightness: 0.80 },
    preAssigned: 0,
    individualShare: 0.15
  },
  {
    key: 'sparse-candidates',
    title: 'Two or three candidates per discipline',
    description:
      'The narrow-expertise department: each discipline has only two or three people who can teach ' +
      'it. Feasible pools are tiny, so most-constrained-first ordering decides almost everything and ' +
      'the improvement pass has nowhere to move to.',
    mode: 'all',
    demandRatio: 0.80,
    candidatePool: () => 2,
    ceilings: { hours: 0.85, courses: 0.35, byType: 0.30, byTypeCategory: 0.20, tightness: 1.35 },
    floors:   { hours: 0.30, byType: 0.20, byTypeCategory: 0.10, tightness: 0.55 },
    preAssigned: 0,
    individualShare: 0.15
  },
  {
    key: 'dense-candidates',
    title: 'Broad interchangeability',
    description:
      'The opposite of the previous one: a dozen people are qualified for each discipline, as at a ' +
      'large general-education department. Every feasibility scan walks a long list, and the ' +
      'improvement pass has many better candidates to try. The worst case for the candidate loop.',
    mode: 'all',
    demandRatio: 0.80,
    candidatePool: (lecturers) => Math.min(lecturers, 12),
    ceilings: { hours: 0.85, courses: 0.35, byType: 0.30, byTypeCategory: 0.20, tightness: 1.35 },
    floors:   { hours: 0.30, byType: 0.20, byTypeCategory: 0.10, tightness: 0.55 },
    preAssigned: 0,
    individualShare: 0.15
  },
  {
    key: 'gaps-mode',
    title: 'Filling gaps in an existing plan',
    description:
      'Half the positions already have their lecturers and are locked; the run only fills what is ' +
      'missing. This is the common case in practice — a department revisits its plan in September — ' +
      'and it is the one where locked assignments consume capacity that the repair and improvement ' +
      'passes are then forbidden to reclaim.',
    mode: 'gaps',
    demandRatio: 0.80,
    candidatePool: () => 5,
    ceilings: { hours: 0.85, courses: 0.35, byType: 0.30, byTypeCategory: 0.20, tightness: 1.35 },
    floors:   { hours: 0.30, byType: 0.20, byTypeCategory: 0.10, tightness: 0.55 },
    preAssigned: 0.50,
    individualShare: 0.15
  },
  {
    key: 'oversubscribed',
    title: 'More work than the department can hold',
    description:
      'Planned hours exceed the annual capacity of the whole department by about a third, with tight ' +
      'ceilings on top. Provably infeasible: the correct behaviour is to fill what can be filled and ' +
      'report the rest. Included because the failure path is the one an algorithm is most likely to ' +
      'spend unbounded time in, and a paper should show it does not.',
    mode: 'all',
    demandRatio: 1.35,
    candidatePool: () => 5,
    ceilings: { hours: 1.0, courses: 0.70, byType: 0.60, byTypeCategory: 0.45, tightness: 1.02 },
    floors:   { hours: 0.40, byType: 0.25, byTypeCategory: 0.15, tightness: 0.70 },
    preAssigned: 0,
    individualShare: 0.15
  }
];

/** The department sizes the study sweeps. */
export const SIZES = [10, 20, 40, 80, 160, 320];

/**
 * Seed for a (scenario, size) cell. Distinct per cell so that two cells are not correlated samples,
 * and a pure function of the cell so the whole matrix is reproducible from nothing but this file.
 */
export function seedFor(scenarioKey, lecturers, repeat = 0) {
  let h = 2166136261;
  for (const ch of `${scenarioKey}|${lecturers}|${repeat}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const scenarioByKey = (key) => SCENARIOS.find((s) => s.key === key);
