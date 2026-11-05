#!/usr/bin/env bash
# 007-A09: the warning read only the last 300 lines of the transcript. A heavy turn (many file
# reads or tool calls) pushes the last assistant entry further back and the 150k warning is lost.
. "$(dirname "$0")/lib.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# transcript with one assistant turn at 180k, followed by $1 tool-result lines
make_transcript() {
  local file=$1 filler=$2
  {
    printf '%s\n' '{"type":"assistant","message":{"usage":{"input_tokens":1000,"cache_creation_input_tokens":89000,"cache_read_input_tokens":90000}}}'
    local i=0
    while [ "$i" -lt "$filler" ]; do
      printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}'
      i=$((i + 1))
    done
  } >"$file"
}

test_heavy_turn_still_warns() {
  local tp="$TMP/heavy.jsonl"
  make_transcript "$tp" 400
  local out rc
  out=$(jq -nc --arg p "$tp" '{transcript_path:$p}' | bash "$HOOKS_DIR/context-warn.sh" 2>&1)
  rc=$?
  if [ "$rc" = 0 ] && grep -q 'additionalContext' <<<"$out"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL heavy turn: no warning after 400 lines of tool results\n'
  fi
}

test_sidechain_entry_does_not_hide_the_main_turn() {
  local tp="$TMP/side.jsonl"
  make_transcript "$tp" 0
  # a subagent record after the main turn carries its own, smaller usage
  printf '%s\n' '{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":500}}}' >>"$tp"
  local out
  out=$(jq -nc --arg p "$tp" '{transcript_path:$p}' | bash "$HOOKS_DIR/context-warn.sh" 2>&1)
  grep -q 'additionalContext' <<<"$out" || {
    FAILED=$((FAILED + 1))
    printf 'FAIL sidechain: a subagent record hid the main turn\n'
    return
  }
  PASSED=$((PASSED + 1))
}

test_small_context_stays_silent() {
  local tp="$TMP/small.jsonl"
  printf '%s\n' '{"type":"assistant","message":{"usage":{"input_tokens":1000}}}' >"$tp"
  local out
  out=$(jq -nc --arg p "$tp" '{transcript_path:$p}' | bash "$HOOKS_DIR/context-warn.sh" 2>&1)
  if [ -z "$out" ]; then PASSED=$((PASSED + 1)); else
    FAILED=$((FAILED + 1)); printf 'FAIL small context: warned when it should stay silent\n'
  fi
}

run_tests
