#!/usr/bin/env bash
# 007-A06: `checkout -B main <ref>` and `switch -C main <ref>` recreate the main branch at
# another commit. The case only set forced_main=1, so the rewrite itself was never blocked.
. "$(dirname "$0")/lib.sh"

test_checkout_b_main_is_blocked() {
  expect_block guard-production.sh \
    "$(bash_json 'git checkout -B main origin/outra')" 'git checkout -B main'
  expect_block guard-production.sh \
    "$(bash_json 'git checkout --force main')" 'git checkout --force main'
  expect_block guard-production.sh \
    "$(bash_json 'git checkout -f main')" 'git checkout -f main'
}

test_switch_c_main_is_blocked() {
  expect_block guard-production.sh \
    "$(bash_json 'git switch -C main outra')" 'git switch -C main'
  expect_block guard-production.sh \
    "$(bash_json 'git switch --force main')" 'git switch --force main'
}

test_plain_switch_stays_allowed() {
  # switching TO main is a checkout, not a rewrite; the later push guard still applies
  expect_allow guard-production.sh "$(bash_json 'git checkout main')" 'git checkout main'
  expect_allow guard-production.sh "$(bash_json 'git switch develop')" 'git switch develop'
  expect_allow guard-production.sh \
    "$(bash_json 'git checkout -b feature/x')" 'git checkout -b feature/x'
  expect_allow guard-production.sh \
    "$(bash_json 'git switch -c feature/y')" 'git switch -c feature/y'
}

run_tests
