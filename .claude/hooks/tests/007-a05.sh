#!/usr/bin/env bash
# 007-A05: between `git` and the subcommand the old extraction accepted only options without a
# separate argument, so `git -c user.name=x push origin main` extracted `user` and was skipped.
. "$(dirname "$0")/lib.sh"

# A throwaway repository standing on main, so the branch checks apply to it and not to the worktree.
MAINREPO=$(mktemp -d)
git -C "$MAINREPO" init -q -b main
git -C "$MAINREPO" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m init
[ "$(git -C "$MAINREPO" rev-parse --abbrev-ref HEAD)" = main ] || {
  echo 'FAIL fixture: throwaway repo is not on main' >&2
  exit 1
}
trap 'rm -rf "$MAINREPO"' EXIT

test_option_with_argument_before_subcommand_is_blocked() {
  expect_block guard-production.sh \
    "$(bash_json 'git -c user.name=x push origin main')" 'git -c ... push origin main'
  expect_block guard-production.sh \
    "$(bash_json 'git --git-dir=.git push origin main')" 'git --git-dir push origin main'
  expect_block guard-production.sh \
    "$(bash_json 'git --git-dir .git push origin main')" 'git --git-dir .git push origin main'
  expect_block guard-production.sh \
    "$(bash_json 'git --work-tree=. push origin main')" 'git --work-tree push origin main'
}

test_merge_and_reset_on_main_with_options_are_blocked() {
  expect_block guard-production.sh \
    "$(bash_json 'git -c user.name=x merge feature' "$MAINREPO")" 'git -c ... merge while on main'
  expect_block guard-production.sh \
    "$(bash_json 'git -c core.pager=cat reset --hard main' "$MAINREPO")" \
    'git -c ... reset --hard main while on main'
}

test_ordinary_git_with_an_option_stays_allowed() {
  expect_allow guard-production.sh "$(bash_json 'git -c core.pager=cat log --oneline -3')" \
    'git -c ... log'
  expect_allow guard-production.sh "$(bash_json 'git -c core.pager=cat diff --stat')" \
    'git -c ... diff'
}

run_tests
