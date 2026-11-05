#!/usr/bin/env bash
# 007-A01: the secret-file rule only accepted a delimiter after `.env`, so a glob (`cat .env*`)
# or a backup suffix (`head -3 .env~`) printed the file without being recognised as a secret.
. "$(dirname "$0")/lib.sh"

test_glob_after_dotenv_is_blocked() {
  expect_block guard-secrets.sh "$(bash_json 'cat .env*')" 'cat .env*'
  expect_block guard-secrets.sh "$(bash_json 'head -3 .env*')" 'head .env*'
  expect_block guard-secrets.sh "$(bash_json 'grep -r KEY .env*')" 'grep .env*'
  expect_block guard-secrets.sh "$(bash_json 'cat ./apps/api/.env*')" 'cat nested .env*'
  expect_block guard-secrets.sh "$(read_json '.env*')" 'Read .env*'
}

test_backup_suffix_after_dotenv_is_blocked() {
  expect_block guard-secrets.sh "$(bash_json 'head -3 .env~')" 'head .env~'
  expect_block guard-secrets.sh "$(bash_json 'cat .env.bak')" 'cat .env.bak'
  expect_block guard-secrets.sh "$(bash_json 'cat .env-old')" 'cat .env-old'
  expect_block guard-secrets.sh "$(read_json '.env~')" 'Read .env~'
  # a real override of the example is still a secret file
  expect_block guard-secrets.sh "$(bash_json 'cat .env.example.local')" 'cat .env.example.local'
}

test_listing_and_examples_still_allowed() {
  # only reading is blocked; the example files stay readable on purpose
  expect_allow guard-secrets.sh "$(bash_json 'ls -la .env*')" 'ls .env*'
  expect_allow guard-secrets.sh "$(bash_json 'cat .env.example')" 'cat .env.example'
  expect_allow guard-secrets.sh "$(bash_json 'cat .env.example*')" 'cat .env.example*'
  expect_allow guard-secrets.sh "$(read_json '.env.sample')" 'Read .env.sample'
}

run_tests
