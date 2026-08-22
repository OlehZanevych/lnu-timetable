#!/usr/bin/env bash
# Runs the C++ solver over a set of archived timetable-bench instances and scores every result with
# the harness's own independent validator, never with the solver's counters. One JSON line per run.
#
#   bench/run.sh --instances DIR --out results.jsonl --time 30000 --threads 2 --sizes "400 800"
set -euo pipefail

SOLVER=${SOLVER:-build/timetable-solve}
INSTANCES=""
OUT="bench/results.jsonl"
TIME=30000
THREADS=0
SEEDS="1 2 3 4 5"
SIZES=""
LABEL="default"
EXTRA=""
LOGDIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instances) INSTANCES="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --time) TIME="$2"; shift 2;;
    --threads) THREADS="$2"; shift 2;;
    --seeds) SEEDS="$2"; shift 2;;
    --sizes) SIZES="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --logdir) LOGDIR="$2"; shift 2;;
    --extra) EXTRA="$2"; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done

[[ -n "$INSTANCES" ]] || { echo "--instances is required" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
[[ -n "$LOGDIR" ]] && mkdir -p "$LOGDIR"

for size in $SIZES; do
  for seed in $SEEDS; do
    name=$(printf "n%05d-s%s" "$size" "$seed")
    file="$INSTANCES/$name.json.gz"
    [[ -f "$file" ]] || { echo "skip $name (no such instance)" >&2; continue; }
    pl=$(mktemp)
    log=""
    [[ -n "$LOGDIR" ]] && log="--log $LOGDIR/$LABEL-$name.csv"
    # shellcheck disable=SC2086
    summary=$("$SOLVER" --instance "$file" --time "$TIME" --threads "$THREADS" \
                        --out "$pl" --quiet $log $EXTRA)
    node bench/score.mjs "$file" "$pl" "$summary" "$LABEL" "$TIME" "$THREADS" >> "$OUT"
    tail -n 1 "$OUT" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const r = JSON.parse(s);
        console.log(`${r.label} ${r.instance} t=${r.timeMs}ms → HARD=${r.check.hard} soft=${r.check.soft} ` +
                    `f=${r.check.objective} ref=${r.referenceSoft} feasible=${r.check.feasible} moves=${r.moves}`);
      });'
    rm -f "$pl"
  done
done
