#!/usr/bin/env bash
# The experiment behind §6a of STUDY.md: what to do when the search stops improving.
#
# Three arms, the same six PRNG seeds each, one instance. Paired on purpose — the run-to-run spread
# on a single instance is a factor of 2.6 (see variance.sh), so an unpaired comparison at this sample
# size measures luck. Every arm is the same binary; only the escape differs.
#
#   base      the original perturbation: displace 10–20 % of the timetable from the *working* state
#   kick      restart-from-incumbent: restore the best schedule, break a small related set, repair
#   pop       kick, plus cluster-wise recombination with a member of the shared pool
#
# Result at 180 s (mean soft): base 25.8, kick 20.2, pop 23.3.
set -u
cd "$(dirname "$0")/.."
INST=${1:-bench/instances/n12800-s1.json.gz}
TIME=${2:-180000}
OUT=bench/results/arms.jsonl
mkdir -p bench/results
: > "$OUT"
for sd in 11 22 33 44 55 66; do
  for arm in base kick pop; do
    case $arm in
      base) extra="--no-restart --no-recombine --no-restart-fresh";;
      kick) extra="--no-recombine --no-restart-fresh";;
      pop)  extra="--recombine --no-restart-fresh";;
    esac
    build/timetable-solve --instance "$INST" --time "$TIME" --threads 2 --quiet --seed "$sd" \
      $extra --out /tmp/arm.json > /tmp/arm.sum
    python3 - "$arm" "$sd" "$OUT" << 'PY'
import json, sys
arm, seed, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open('/tmp/arm.sum'))
r = {'arm': arm, 'seed': seed, 'soft': d['soft'], 'f': d['objective'], 'hard': d['hard'],
     'kicks': sum(w['perturbations'] for w in d['workers']),
     'restarts': sum(w.get('restarts', 0) for w in d['workers']),
     'recomb': sum(w.get('recombinations', 0) for w in d['workers'])}
print(json.dumps(r), flush=True)
open(out, 'a').write(json.dumps(r) + '\n')
PY
  done
done
