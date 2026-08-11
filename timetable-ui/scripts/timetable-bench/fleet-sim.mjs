/**
 * Exhaustively exercises the portfolio's completion arithmetic under every interleaving of
 * done/fail messages, for fleets of 1..4. Transcribed from faculty-timetable-list.ts — it tests
 * the logic, not the component, which is the most a headless sandbox can check.
 */
function makeRun(fleetSize) {
  const st = { fleetSize, finished: [], failures: 0, busy: true, solved: null, error: null };
  const finishIfIdle = () => {
    if (st.finished.length + st.failures < st.fleetSize) return;
    if (!st.finished.length) return;
    let best = st.finished[0];
    for (const r of st.finished) if (r.hard < best.hard || (r.hard === best.hard && r.obj < best.obj)) best = r;
    if (!st.busy) return;
    st.busy = false; st.solved = best;
  };
  return {
    st,
    done: (r) => { if (!st.busy) return; st.finished.push(r); finishIfIdle(); },
    fail: () => {
      if (!st.busy) return;
      st.failures++;
      if (st.failures >= st.fleetSize) { st.busy = false; st.error = 'all failed'; return; }
      finishIfIdle();
    }
  };
}

let checked = 0, bad = 0;
for (let k = 1; k <= 4; k++) {
  // every sequence of k events drawn from {done(i), fail}
  const events = [];
  const gen = (acc) => {
    if (acc.length === k) { events.push(acc.slice()); return; }
    for (let i = 0; i <= k; i++) { acc.push(i); gen(acc); acc.pop(); }
  };
  gen([]);
  for (const seq of events) {
    const run = makeRun(k);
    const results = [];
    for (const e of seq) {
      if (e === k) run.fail();
      else { const r = { hard: e % 2, obj: 100 - e }; results.push(r); run.done(r); }
    }
    checked++;
    const anyDone = results.length > 0;
    const st = run.st;
    // Invariants: the run always terminates; it reports either a result or an error, never both,
    // never neither; and when results exist the chosen one is the lexicographic best.
    if (st.busy) { console.log('STUCK', k, seq); bad++; continue; }
    if (!!st.solved === !!st.error) { console.log('AMBIGUOUS', k, seq, st.solved, st.error); bad++; continue; }
    if (anyDone) {
      let best = results[0];
      for (const r of results) if (r.hard < best.hard || (r.hard === best.hard && r.obj < best.obj)) best = r;
      if (st.solved !== best) { console.log('NOT BEST', k, seq); bad++; }
    } else if (!st.error) { console.log('NO ERROR ON ALL-FAIL', k, seq); bad++; }
  }
}
console.log(`${checked} interleavings checked, ${bad} violations`);
