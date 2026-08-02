/// <reference lib="webworker" />

/**
 * Runs {@link solveTimetable} off the main thread.
 *
 * The search is a tight synchronous loop with no natural yield point, so on the main thread it
 * would freeze the page for as long as it runs — which is exactly the time the progress modal is
 * supposed to be animating. Here it owns its own thread, posts a `progress` message a few times a
 * second, and can be stopped mid-run: `cancel` sets a flag the solver checks between rounds, so a
 * cancelled run still returns the best schedule it had found rather than nothing.
 */

import {
  SolverConstraint,
  SolverOptions,
  SolverProblem,
  SolverProgress,
  SolverResult,
  solveTimetable
} from './timetable-solver';

/** `SolverProblem` with its three constraint maps flattened, so the message is plain data. */
export interface SerializedProblem extends Omit<SolverProblem, 'lecturerConstraints' | 'groupConstraints' | 'roomConstraints'> {
  lecturerConstraints: [string, SolverConstraint[]][];
  groupConstraints: [string, SolverConstraint[]][];
  roomConstraints: [string, SolverConstraint[]][];
}

export type SolverRequest =
  | { type: 'solve'; problem: SerializedProblem; options: Partial<SolverOptions> }
  | { type: 'cancel' };

export type SolverResponse =
  | { type: 'progress'; progress: SolverProgress }
  | { type: 'done'; result: SolverResult }
  | { type: 'error'; message: string };

let cancelled = false;

addEventListener('message', ({ data }: MessageEvent<SolverRequest>) => {
  if (data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (data.type !== 'solve') return;

  cancelled = false;
  try {
    const problem: SolverProblem = {
      ...data.problem,
      lecturerConstraints: new Map(data.problem.lecturerConstraints),
      groupConstraints: new Map(data.problem.groupConstraints),
      roomConstraints: new Map(data.problem.roomConstraints)
    };
    const result = solveTimetable(
      problem,
      data.options,
      (progress: SolverProgress) => post({ type: 'progress', progress }),
      () => cancelled
    );
    post({ type: 'done', result });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});

function post(message: SolverResponse) {
  (self as unknown as Worker).postMessage(message);
}
