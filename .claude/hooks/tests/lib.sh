#!/usr/bin/env bash
# Tiny assert helpers for the hook tests. No framework: each test file sources this, defines
# test_* functions and calls run_tests. Exit 2 from a PreToolUse hook means "blocked".
set -u

TESTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOOKS_DIR=$(cd "$TESTS_DIR/.." && pwd)
PASSED=0
FAILED=0
LAST_OUT=""

# bash_json <command> [cwd] -> the JSON Claude Code sends for a Bash PreToolUse call
bash_json() {
  jq -nc --arg c "$1" --arg d "${2:-$PWD}" \
    '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}'
}

# read_json <path> -> PreToolUse JSON for Read
read_json() {
  jq -nc --arg p "$1" '{tool_name:"Read",tool_input:{file_path:$p}}'
}

# grep_json <pattern> <path> [glob] -> PreToolUse JSON for Grep
grep_json() {
  jq -nc --arg pat "$1" --arg p "$2" --arg g "${3:-}" \
    '{tool_name:"Grep",tool_input:({pattern:$pat,path:$p} + (if $g == "" then {} else {glob:$g} end))}'
}

# run_hook <hook> <json> [env assignments...] -> sets RC and OUT
run_hook() {
  local hook=$1 json=$2
  shift 2
  OUT=$(printf '%s' "$json" | env "$@" bash "$HOOKS_DIR/$hook" 2>&1)
  RC=$?
}

# expect <want_rc> <hook> <json> <label> [env assignments...]
expect() {
  local want=$1 hook=$2 json=$3 label=$4
  shift 4
  run_hook "$hook" "$json" "$@"
  if [ "$RC" = "$want" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL %s: wanted rc=%s, got rc=%s :: %s\n' \
      "$label" "$want" "$RC" "$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
  LAST_OUT=$OUT
}

# expect_block <hook> <json> <label> [env...] -> rc 2 and a BLOQUEADO message
expect_block() {
  local hook=$1 json=$2 label=$3
  shift 3
  expect 2 "$hook" "$json" "$label" "$@"
  if [ "$RC" = 2 ] && ! grep -Eq 'BLOQUEADO' <<<"$OUT"; then
    FAILED=$((FAILED + 1))
    printf 'FAIL %s: blocked without the BLOQUEADO message\n' "$label"
  fi
}

# expect_allow <hook> <json> <label> [env...] -> rc 0
expect_allow() {
  expect 0 "$1" "$2" "$3" "${@:4}"
}

# run_tests -> runs every test_* function and exits 1 when something failed
run_tests() {
  local name
  for name in $(declare -F | awk '{print $3}' | grep '^test_' | sort); do
    "$name"
  done
  printf '%s: %d passed, %d failed\n' "$(basename "$0")" "$PASSED" "$FAILED"
  [ "$FAILED" -eq 0 ]
}
