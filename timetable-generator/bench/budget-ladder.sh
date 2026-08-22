#!/usr/bin/env bash
# Quality against wall-clock budget on one instance: the measurement that decides whether an hour is
# worth spending. The shipped TypeScript solver converges at about five minutes and returns the same
# schedule at nine (TIMETABLE-GENERATION.md §8); this is the same question asked of the new search.
set -euo pipefail
INST=$1; LABEL=$2; shift 2
for t in "$@"; do
  pl=$(mktemp)
  s=$(build/timetable-solve --instance "$INST" --time "$t" --threads 2 --out "$pl" --quiet \
        --log "bench/logs/$LABEL-$t.csv")
  node bench/score.mjs "$INST" "$pl" "$s" "$LABEL" "$t" 2 >> bench/results/budget.jsonl
  tail -n1 bench/results/budget.jsonl | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`${r.label} ${r.instance} ${r.timeMs}ms → HARD=${r.check.hard} soft=${r.check.soft} f=${r.check.objective} moves=${r.moves}`)})'
  rm -f "$pl"
done
