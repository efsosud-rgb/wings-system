#!/usr/bin/env bash
# 007-A07: `gh api` sends POST/PATCH with -f/-F/--input alone, so requiring -X/--method let
# `gh api repos/.../git/refs/heads/main -f sha=abc` move main on the remote.
. "$(dirname "$0")/lib.sh"

test_field_flags_on_main_ref_are_blocked() {
  expect_block guard-production.sh \
    "$(bash_json 'gh api repos/o/r/git/refs/heads/main -f sha=abc')" 'gh api -f on main ref'
  expect_block guard-production.sh \
    "$(bash_json 'gh api repos/o/r/git/refs/heads/main -F sha=abc')" 'gh api -F on main ref'
  expect_block guard-production.sh \
    "$(bash_json 'gh api repos/o/r/git/refs/heads/main --input body.json')" 'gh api --input on main ref'
}

test_merge_endpoint_with_field_is_blocked() {
  expect_block guard-production.sh \
    "$(bash_json 'gh api repos/o/r/merges -f base=main')" 'gh api merges -f base=main'
  expect_block guard-production.sh \
    "$(bash_json 'gh api --method PATCH repos/o/r/git/refs/heads/main -f sha=abc')" \
    'gh api --method PATCH on main ref'
  expect_block guard-production.sh \
    "$(bash_json 'gh api -X DELETE repos/o/r/git/refs/heads/main')" 'gh api -X DELETE on main ref'
}

test_reads_and_other_calls_stay_allowed() {
  expect_allow guard-production.sh \
    "$(bash_json 'gh api repos/o/r/git/refs/heads/main -X GET')" 'gh api -X GET on main ref'
  expect_allow guard-production.sh \
    "$(bash_json 'gh api repos/o/r/pulls/42')" 'gh api read'
  expect_allow guard-production.sh "$(bash_json 'gh pr view 42')" 'gh pr view'
  expect_allow guard-production.sh \
    "$(bash_json 'gh api repos/o/r/issues/1 -f title=x')" 'gh api -f on an issue'
}

run_tests
