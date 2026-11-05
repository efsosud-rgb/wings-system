#!/usr/bin/env bash
# 007-A04: the command was split on &&, ||, ; and | but `git` was only recognised after a space,
# so `bash -c "git push origin main"`, `echo $(git push ...)` and `xargs git push` went through.
. "$(dirname "$0")/lib.sh"

test_quoted_git_push_to_main_is_blocked() {
  expect_block guard-production.sh "$(bash_json 'bash -c "git push origin main"')" 'bash -c "git push origin main"'
  expect_block guard-production.sh "$(bash_json "bash -c 'git push origin main'")" "bash -c 'git push origin main'"
  expect_block guard-production.sh "$(bash_json 'sh -c "git push origin main"')" 'sh -c "git push origin main"'
  expect_block guard-production.sh "$(bash_json 'bash -lc "git push origin main"')" 'bash -lc "git push origin main"'
}

test_command_substitution_is_blocked() {
  expect_block guard-production.sh "$(bash_json 'echo $(git push origin main)')" 'echo $(git push ...)'
  expect_block guard-production.sh "$(bash_json 'x=$(git push origin main)')" '$(git push ...) in assignment'
  expect_block guard-production.sh "$(bash_json 'echo `git push origin main`')" 'backticks'
}

test_parens_and_xargs_are_blocked() {
  expect_block guard-production.sh "$(bash_json '(git push origin main)')" '(git push origin main)'
  expect_block guard-production.sh "$(bash_json '{ git push origin main; }')" '{ git push ...; }'
  expect_block guard-production.sh \
    "$(bash_json 'printf "%s" main | xargs git push origin')" 'xargs git push'
  expect_block guard-production.sh \
    "$(bash_json 'eval "git push origin main"')" 'eval "git push ..."'
}

test_escaped_command_name_is_blocked() {
  # a backslash only escapes the next character: `\git` and `g\it` are `git` and must not slip by
  expect_block guard-production.sh "$(bash_json '\git push origin main')" '\git push origin main'
  expect_block guard-production.sh "$(bash_json 'g\it push origin main')" 'g\it push origin main'
  expect_block guard-production.sh "$(bash_json 'git\ push origin main')" 'git\ push origin main'
}

test_path_to_the_binary_is_blocked() {
  # `/usr/bin/git` and `./git` run the same git as `git`
  expect_block guard-production.sh "$(bash_json '/usr/bin/git push origin main')" '/usr/bin/git push'
  expect_block guard-production.sh "$(bash_json './git push origin main')" './git push'
  expect_block guard-production.sh "$(bash_json 'bash -c "/usr/bin/git push origin main"')" \
    'bash -c /usr/bin/git push'
}

test_nested_production_deploy_is_blocked() {
  expect_block guard-production.sh "$(bash_json 'bash -c "wings-deploy production"')" \
    'bash -c "wings-deploy production"'
  expect_block guard-production.sh "$(bash_json 'echo $(wings-env set X --app api-prod)')" \
    '$(wings-env set on api-prod)'
}

test_ordinary_commands_stay_allowed() {
  expect_allow guard-production.sh "$(bash_json 'echo "git status"')" 'echo "git status"'
  expect_allow guard-production.sh "$(bash_json 'echo $(git rev-parse HEAD)')" 'echo $(git rev-parse HEAD)'
  expect_allow guard-production.sh "$(bash_json 'bash -c "git status"')" 'bash -c "git status"'
  expect_allow guard-production.sh "$(bash_json 'git status && git log --oneline -3')" 'two reads'
  expect_allow guard-production.sh \
    "$(bash_json 'find . -name "*.ts" | xargs grep -l foo')" 'xargs grep'
  expect_allow guard-production.sh \
    "$(bash_json 'git push origin agente/d-t111-20261105-0030')" 'push own branch'
}

run_tests
