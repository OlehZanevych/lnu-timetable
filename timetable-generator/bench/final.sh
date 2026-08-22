#!/usr/bin/env bash
# The two measurements that have to be taken on the final algorithm.
set -u
cd "$(dirname "$0")/.."
R=bench/results
mkdir -p "$R" bench/logs

echo "### head to head, one host, one clock"
for size in 400 800 1600 3200 6400 12800; do
  for seed in 1 2 3; do
    f="bench/instances/$(printf "n%05d-s%s" "$size" "$seed").json.gz"
    [ -f "$f" ] || continue
    node bench/run-ts.mjs --instance "$f" --time 30000 --workers 2 --out "$R/headtohead.jsonl" --label ts-2w
  done
done
bench/run.sh --instances bench/instances --out "$R/headtohead.jsonl" --time 30000 --threads 2 \
  --sizes "400 800 1600 3200 6400 12800" --seeds "1 2 3" --label cpp-2t

echo "### budget ladder"
bench/budget-ladder.sh bench/instances/n12800-s1.json.gz ladder-12800 60000 300000 900000 3600000
bench/budget-ladder.sh bench/instances-tight/n06400-s1.json.gz ladder-tight6400 60000 300000 900000 3600000
echo "### done"
