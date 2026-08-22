#!/usr/bin/env bash
# The whole study, in the order the conclusions depend on one another.
#
#   1. does the eighth neighbourhood pay?      — decides what the rest measures
#   2. ablation                                 — which of them carries the result
#   3. head to head against the shipped TypeScript solver, on this host, at this moment
#   4. budget ladder                            — what an hour actually buys
#
# Every result is scored by the harness's own independent validator, never by the solver's counters.
set -u
cd "$(dirname "$0")/.."
R=bench/results
mkdir -p "$R" bench/logs

echo "### 0. feasibility regression on maximally-tight MAX_CLASSES_PER_DAY caps"
# The one hard rule that is a property of a set rather than of a placement. bench/tighten.mjs pulls
# every cap down to the hidden schedule's own peak, so any operator that moves several classes at
# once and forgets to ask again shows up here as constraintBreaches > 0.
for s in 1 2 3; do
  node bench/tighten.mjs "bench/instances/n03200-s$s.json.gz" "bench/instances-cap/n03200-s$s.json.gz" >/dev/null
done
node bench/tighten.mjs bench/instances/n06400-s1.json.gz bench/instances-cap/n06400-s1.json.gz >/dev/null
bench/run.sh --instances bench/instances-cap --out "$R/capped.jsonl" --time 30000 --threads 2 \
  --sizes "3200 6400" --seeds "1 2 3" --label capped

echo "### 1. two mechanisms that sound right and are not"
# The default, against (a) adding an exhaustive (entity, day) re-pack and (b) selecting operators by
# reward per unit of work rather than by reward. Both are switches rather than deletions so that the
# measurement can be repeated; both lose.
bench/run.sh --instances bench/instances --out "$R/ab-dayfix.jsonl" --time 30000 --threads 2 \
  --sizes "3200 6400 12800" --seeds "1 2 3 4 5" --label default
bench/run.sh --instances bench/instances --out "$R/ab-dayfix.jsonl" --time 30000 --threads 2 \
  --sizes "3200 6400 12800" --seeds "1 2 3 4 5" --label plus-dayfix --extra "--dayfix"
bench/run.sh --instances bench/instances --out "$R/ab-dayfix.jsonl" --time 30000 --threads 2 \
  --sizes "3200 6400 12800" --seeds "1 2 3 4 5" --label plus-winfix --extra "--winfix"
bench/run.sh --instances bench/instances --out "$R/ab-dayfix.jsonl" --time 30000 --threads 2 \
  --sizes "3200 6400 12800" --seeds "1 2 3 4 5" --label cost-aware --extra "--cost-aware"

echo "### 2. ablation"
INSTDIR=bench/instances OUT="$R/ablation.jsonl" TIME=60000 SIZES="3200 6400 12800" SEEDS="1 2 3" \
  bench/ablate.sh

echo "### 3. head to head, same host, same clock"
for size in 400 800 1600 3200 6400 12800; do
  for seed in 1 2 3; do
    f="bench/instances/$(printf "n%05d-s%s" "$size" "$seed").json.gz"
    [ -f "$f" ] || continue
    node bench/run-ts.mjs --instance "$f" --time 30000 --workers 2 --out "$R/headtohead.jsonl" --label ts-2w
  done
done
bench/run.sh --instances bench/instances --out "$R/headtohead.jsonl" --time 30000 --threads 2 \
  --sizes "400 800 1600 3200 6400 12800" --seeds "1 2 3" --label cpp-2t

echo "### 4. budget ladder"
bench/budget-ladder.sh bench/instances/n12800-s1.json.gz ladder-12800 60000 300000 900000 3600000
bench/budget-ladder.sh bench/instances-tight/n06400-s1.json.gz ladder-tight6400 60000 300000 900000 3600000

echo "### done"
