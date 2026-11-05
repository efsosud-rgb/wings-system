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

test_wildcard_on_dotnames_is_blocked() {
  # `cat .*` reaches .env without spelling it; the brace forms expand to it too.
  expect_block guard-secrets.sh "$(bash_json 'cat .*')" 'cat .*'
  expect_block guard-secrets.sh "$(bash_json 'head -3 .*')" 'head .*'
  expect_block guard-secrets.sh "$(bash_json 'grep -r KEY .*')" 'grep -r KEY .*'
  expect_block guard-secrets.sh "$(bash_json 'cat .??*')" 'cat .??*'
  expect_block guard-secrets.sh "$(bash_json 'cat .[e]nv')" 'cat .[e]nv'
  expect_block guard-secrets.sh "$(bash_json 'cat .e*')" 'cat .e*'
  expect_block guard-secrets.sh "$(bash_json 'base64 .*')" 'base64 .*'
}

test_brace_expansion_of_dotenv_is_blocked() {
  expect_block guard-secrets.sh "$(bash_json 'cat {.env,README.md}')" 'cat {.env,...}'
  expect_block guard-secrets.sh "$(bash_json 'cat {,apps/api/}.env')" 'cat {,dir/}.env'
  expect_block guard-secrets.sh "$(bash_json 'cat ./{.env}')" 'cat ./{.env}'
}

test_other_dotfiles_stay_allowed() {
  # the wildcard rule is about a dot-name, not every `*`: a glob past a slash cannot reach .env
  expect_allow guard-secrets.sh "$(bash_json 'cat .gitignore')" 'cat .gitignore'
  expect_allow guard-secrets.sh "$(bash_json 'cat .github/workflows/ci.yml')" 'cat workflow yml'
  expect_allow guard-secrets.sh "$(bash_json 'grep -r x .github')" 'grep in .github'
  expect_allow guard-secrets.sh "$(bash_json 'cat ./src/*.ts')" 'cat src glob'
}

test_escaped_reader_name_is_blocked() {
  # the shell joins `c"a"t` and `c\at` into `cat`; the reader name must not hide the read
  expect_block guard-secrets.sh "$(bash_json 'c\at .env')" 'c\at .env'
  expect_block guard-secrets.sh "$(bash_json 'ca\t .env')" 'ca\t .env'
  expect_block guard-secrets.sh "$(bash_json 'c"a"t .env')" 'c"a"t .env'
  expect_block guard-secrets.sh "$(bash_json "c'a't .env")" "c'a't .env"
  expect_block guard-secrets.sh "$(bash_json 'cat .en\v')" 'cat .en\v'
}

test_listing_and_examples_still_allowed() {
  # only reading is blocked; the example files stay readable on purpose
  expect_allow guard-secrets.sh "$(bash_json 'ls -la .env*')" 'ls .env*'
  expect_allow guard-secrets.sh "$(bash_json 'cat .env.example')" 'cat .env.example'
  expect_allow guard-secrets.sh "$(bash_json 'cat .env.example*')" 'cat .env.example*'
  expect_allow guard-secrets.sh "$(read_json '.env.sample')" 'Read .env.sample'
}

run_tests
