#!/usr/bin/env bash
# 007-A02: the guard only looked at Read and Bash, so Grep (and other tools that return file
# content) read .env and put the matching lines in the conversation.
. "$(dirname "$0")/lib.sh"

test_grep_on_dotenv_is_blocked() {
  expect_block guard-secrets.sh "$(grep_json 'API_KEY' '.env')" 'Grep path=.env'
  expect_block guard-secrets.sh "$(grep_json 'API_KEY' '.env.local')" 'Grep path=.env.local'
  expect_block guard-secrets.sh "$(grep_json 'API_KEY' '.env*')" 'Grep path=.env*'
  expect_block guard-secrets.sh "$(grep_json 'API_KEY' 'apps/api/.env')" 'Grep nested .env'
}

test_grep_on_a_secret_glob_or_etc_is_blocked() {
  # glob written in the glob field rather than the path
  expect_block guard-secrets.sh \
    "$(grep_json 'KEY' 'apps/api' '.env*')" 'Grep glob=.env*'
  # a dotfile glob in the glob field reaches .env without spelling it (007-A01 rule)
  expect_block guard-secrets.sh "$(grep_json 'KEY' '.' '.*')" 'Grep glob=.*'
  expect_block guard-secrets.sh "$(grep_json 'KEY' '.' '.??*')" 'Grep glob=.??*'
  expect_block guard-secrets.sh \
    "$(grep_json 'KEY' '/etc/wings-crm')" 'Grep /etc/wings-crm'
}

test_ordinary_grep_stays_allowed() {
  expect_allow guard-secrets.sh \
    "$(grep_json 'requirePermission' 'apps/api/src')" 'Grep in src'
  expect_allow guard-secrets.sh \
    "$(grep_json 'TODO' 'README.md')" 'Grep README'
  expect_allow guard-secrets.sh \
    "$(grep_json 'DATABASE_URL' 'apps/api')" 'Grep a secret name in source'
  expect_allow guard-secrets.sh \
    "$(grep_json 'KEY' 'apps/api' '*.ts')" 'Grep glob *.ts'
}

run_tests
