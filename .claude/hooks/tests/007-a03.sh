#!/usr/bin/env bash
# 007-A03: `git` was not in the READERS list and `HEAD:.env` has a colon before the name, so
# `git diff .env` and `git show HEAD:.env` printed the file straight into the conversation.
. "$(dirname "$0")/lib.sh"

test_git_diff_and_show_of_dotenv_are_blocked() {
  expect_block guard-secrets.sh "$(bash_json 'git diff .env')" 'git diff .env'
  expect_block guard-secrets.sh "$(bash_json 'git show HEAD:.env')" 'git show HEAD:.env'
  expect_block guard-secrets.sh "$(bash_json 'git show HEAD~1:.env.local')" 'git show HEAD~1:.env.local'
  expect_block guard-secrets.sh "$(bash_json 'git log -p -- .env')" 'git log -p -- .env'
  expect_block guard-secrets.sh "$(bash_json 'git cat-file -p main:.env')" 'git cat-file -p main:.env'
  expect_block guard-secrets.sh "$(bash_json 'git grep KEY main -- .env')" 'git grep main -- .env'
}

test_git_on_secret_globs_and_backups_is_blocked() {
  expect_block guard-secrets.sh "$(bash_json 'git diff .env*')" 'git diff .env*'
  expect_block guard-secrets.sh "$(bash_json 'git show HEAD:.env~')" 'git show HEAD:.env~'
}

test_ordinary_git_stays_allowed() {
  expect_allow guard-secrets.sh "$(bash_json 'git status')" 'git status'
  expect_allow guard-secrets.sh "$(bash_json 'git log --oneline -5')" 'git log'
  expect_allow guard-secrets.sh "$(bash_json 'git diff --stat')" 'git diff'
  expect_allow guard-secrets.sh "$(bash_json 'git diff src/index.ts')" 'git diff a source file'
  expect_allow guard-secrets.sh "$(bash_json 'git show HEAD:README.md')" 'git show README.md'
  expect_allow guard-secrets.sh \
    "$(bash_json 'git show HEAD:.env.example')" 'git show HEAD:.env.example'
}

run_tests
