#!/usr/bin/env bash
# 007-A08: every hook read the JSON with jq and an empty read made the comparison fail, so the
# script ended with exit 0 ("allowed"). On a machine without jq nothing was guarded and nobody
# was told. A missing dependency must block (exit 2) with a clear message.
. "$(dirname "$0")/lib.sh"

# A PATH with the shell basics the hooks need, and deliberately no jq.
NOJQ=$(mktemp -d)
for t in bash sh sed grep egrep cat basename dirname head tail tr cut printf env sort; do
  p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$NOJQ/$t"
done
trap 'rm -rf "$NOJQ"' EXIT

test_production_guard_blocks_without_jq() {
  expect_block guard-production.sh "$(bash_json 'git status')" 'no jq: guard-production' \
    "PATH=$NOJQ"
}

test_secrets_guard_blocks_without_jq() {
  expect_block guard-secrets.sh "$(bash_json 'ls')" 'no jq: guard-secrets Bash' "PATH=$NOJQ"
  expect_block guard-secrets.sh "$(read_json 'README.md')" 'no jq: guard-secrets Read' "PATH=$NOJQ"
}

test_message_names_the_missing_dependency() {
  run_hook guard-secrets.sh "$(bash_json 'ls')" "PATH=$NOJQ"
  grep -Eqi 'jq' <<<"$OUT" || {
    FAILED=$((FAILED + 1))
    printf 'FAIL no jq: the block message does not name jq :: %s\n' "$OUT"
  }
}

test_with_jq_present_the_guards_behave_normally() {
  expect_allow guard-production.sh "$(bash_json 'git status')" 'with jq: guard-production'
  expect_allow guard-secrets.sh "$(bash_json 'ls')" 'with jq: guard-secrets'
}

test_unparseable_input_blocks() {
  # An empty tool_name would also fall through to exit 0; unreadable input must block too.
  expect_block guard-production.sh 'not json' 'unparseable input: guard-production'
  expect_block guard-secrets.sh 'not json' 'unparseable input: guard-secrets'
}

run_tests
