#!/usr/bin/env bash
# How much of a result is the algorithm and how much is luck.
#
# One binary, one instance, one configuration, six PRNG seeds. At n = 12 800 and 180 s this returns
# soft 11, 27, 17, 23, 19, 29 — a factor of 2.6 between the luckiest and the unluckiest run of the
# *same algorithm on the same input*. Every A/B in this study is sized against that spread, and the
# single-run comparisons that preceded it were measuring noise.
#
# It is also the justification for `restartAfter`: if which basin the construction lands in matters
# this much, a long budget is better spent sampling the distribution than polishing one draw.
set -u
cd "$(dirname "$0")/.."
INST=${1:-bench/instances/n12800-s1.json.gz}
TIME=${2:-180000}
for sd in 11 22 33 44 55 66; do
  build/timetable-solve --instance "$INST" --time "$TIME" --threads 2 --quiet --seed "$sd" \
    --out /tmp/var.json > /tmp/var.sum
  python3 -c "
import json
d = json.load(open('/tmp/var.sum'))
print('seed $sd -> soft', d['soft'], 'f', d['objective'],
      'restarts', sum(w.get('restarts', 0) for w in d['workers']))
"
done
