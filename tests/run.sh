#!/usr/bin/env bash
# Runs the offline test suites, each with a time limit and a heap cap (an uncapped run once crashed
# the machine), and fails unless every suite exits 0 and its last "N/N passed" line has both numbers
# equal. A suite that exits 0 without that line, or with a partial count, has not finished: it fails.
#
#   tests/run.sh                    every tests/*.test.js and tests/*.test.mjs
#   tests/run.sh tests/x.test.js    only the suites named (paths from the repo root, or absolute)
#
# The limits default to 120 s and 1024 MB; RUN_TIME_LIMIT and RUN_HEAP_MB override them (for
# checking the runner itself, not for routine runs).
set -u
cd "$(dirname "$0")/.." || exit 2

limit=${RUN_TIME_LIMIT:-120}
heap=${RUN_HEAP_MB:-1024}

if [ $# -gt 0 ]; then suites=("$@"); else suites=(tests/*.test.js tests/*.test.mjs); fi

log=$(mktemp "${TMPDIR:-/tmp}/watchlist-test.XXXXXX") || exit 2
trap 'rm -f "$log"' EXIT

total=0; failing=0; passed_cases=0; total_cases=0
for f in "${suites[@]}"; do
  total=$((total + 1))
  name=$(basename "$f")
  # The outer 2>/dev/null keeps the shell's own "Alarm clock" / "Abort trap" notice out of the report.
  { perl -e 'alarm shift; exec @ARGV' "$limit" node --max-old-space-size="$heap" "$f" > "$log" 2>&1; } 2>/dev/null
  status=$?
  summary=$(grep -E '[0-9]+/[0-9]+ passed$' "$log" | tail -n 1)
  p=; t=
  if [ -n "$summary" ]; then
    counts=$(printf '%s\n' "$summary" | grep -oE '[0-9]+/[0-9]+ passed$')
    p=${counts%%/*}; t=${counts#*/}; t=${t%% *}
    passed_cases=$((passed_cases + p)); total_cases=$((total_cases + t))
  fi
  reason=
  if [ "$status" -eq 142 ]; then reason="timed out after ${limit} s"   # SIGALRM from the time limit
  elif [ "$status" -gt 128 ]; then reason="killed by signal $((status - 128))"
  elif [ "$status" -ne 0 ] && [ -n "$summary" ] && [ "$p" != "$t" ]; then reason="$((t - p)) of $t cases failed"
  elif [ "$status" -ne 0 ]; then reason="exited non-zero"
  elif [ -z "$summary" ]; then reason="no \"N/N passed\" line (incomplete run)"
  elif [ "$p" != "$t" ] || [ "$t" -eq 0 ]; then reason="incomplete count $p/$t"
  fi
  if [ -n "$reason" ]; then
    failing=$((failing + 1))
    echo "FAIL $name: $reason; exit $status; last summary: ${summary:-none}"
  else
    echo "ok   $name: $p/$t"
  fi
done

echo "suites=$total failing=$failing cases=$passed_cases/$total_cases"
[ "$failing" -eq 0 ]
