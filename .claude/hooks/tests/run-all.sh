#!/usr/bin/env bash
# Runs every hook test. Exit 1 if any file fails. No database, no network: only bash, jq and git.
set -u
cd "$(dirname "$0")" || exit 1
failed=0
for f in baseline.sh 007-a*.sh; do
  [ -f "$f" ] || continue
  printf '== %s\n' "$f"
  bash "$f" || failed=1
done
[ "$failed" -eq 0 ] && echo "hooks: all green" || echo "hooks: FAILURES"
exit "$failed"
