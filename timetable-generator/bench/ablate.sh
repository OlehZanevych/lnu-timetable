#!/usr/bin/env bash
# Which of the seven neighbourhoods is carrying the result. One variant at a time, same instances,
# same seeds, same budget — the only honest way to read a portfolio.
set -euo pipefail
INSTDIR=${INSTDIR:-bench/instances}
OUT=${OUT:-bench/results/ablation.jsonl}
TIME=${TIME:-60000}
SIZES=${SIZES:-"3200 6400 12800"}
SEEDS=${SEEDS:-"1 2 3"}
mkdir -p "$(dirname "$OUT")"
run() {
  local label=$1; shift
  for size in $SIZES; do for seed in $SEEDS; do
    name=$(printf "n%05d-s%s" "$size" "$seed"); f="$INSTDIR/$name.json.gz"
    [[ -f "$f" ]] || continue
    pl=$(mktemp)
    s=$(build/timetable-solve --instance "$f" --time "$TIME" --threads 2 --out "$pl" --quiet "$@")
    node bench/score.mjs "$f" "$pl" "$s" "$label" "$TIME" 2 >> "$OUT"
    tail -n1 "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`${r.label.padEnd(14)} ${r.instance} soft=${String(r.check.soft).padStart(5)} f=${String(r.check.objective).padStart(9)} hard=${r.check.hard} moves=${r.moves}`)})'
    rm -f "$pl"
  done; done
}
run full
run no-kopt   --no-kopt
run no-lns    --no-lns
run no-repack --no-repack
run no-chain  --no-chain
run no-kempe  --no-kempe
run no-cluster --no-cluster
run plus-dayfix --dayfix
run plus-winfix --winfix
run cost-aware  --cost-aware
run simple    --simple
