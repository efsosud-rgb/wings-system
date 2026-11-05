#!/usr/bin/env bash
# Locks the guards' behaviour as it stands before d-t111: what is already blocked must stay
# blocked, and what is allowed on purpose (ordinary reads) must stay allowed. No attack here.
. "$(dirname "$0")/lib.sh"

test_production_blocks_deploys() {
  expect_block guard-production.sh \
    "$(bash_json 'wings-deploy production')" 'wings-deploy production'
  expect_block guard-production.sh \
    "$(bash_json 'cd /opt/wings-system && wings-deploy production')" \
    'wings-deploy production after &&'
  expect_block guard-production.sh \
    "$(bash_json 'wings-deploy prod')" 'wings-deploy prod'
  expect_block guard-production.sh \
    "$(bash_json 'wings-env set API_KEY --app api-prod')" 'wings-env set on api-prod'
  expect_block guard-production.sh \
    "$(bash_json 'wings-env restart web-prod')" 'wings-env restart on web-prod'
  expect_block guard-production.sh \
    "$(bash_json 'curl https://app.engmbukkyuk3d07qqolmm5xt.coolify.example')" 'coolify production app id'
}

test_production_blocks_main_moves() {
  expect_block guard-production.sh \
    "$(bash_json 'git push origin main')" 'git push origin main'
  expect_block guard-production.sh \
    "$(bash_json 'git push origin refs/heads/main')" 'git push refs/heads/main'
  expect_block guard-production.sh \
    "$(bash_json 'git push --all origin')" 'git push --all'
  expect_block guard-production.sh \
    "$(bash_json 'git push --mirror origin')" 'git push --mirror'
  expect_block guard-production.sh \
    "$(bash_json 'git branch -D main')" 'git branch -D main'
  expect_block guard-production.sh \
    "$(bash_json 'git branch -f main HEAD~1')" 'git branch -f main'
  expect_block guard-production.sh \
    "$(bash_json 'git update-ref refs/heads/main abc')" 'git update-ref main'
  expect_block guard-production.sh \
    "$(bash_json 'gh pr merge 5')" 'gh pr merge'
  expect_block guard-production.sh \
    "$(bash_json 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc')" \
    'gh api -X PATCH on main ref'
}

test_production_allows_ordinary_reads() {
  expect_allow guard-production.sh "$(bash_json 'git status')" 'git status'
  expect_allow guard-production.sh "$(bash_json 'git log --oneline -5')" 'git log'
  expect_allow guard-production.sh "$(bash_json 'git diff --stat')" 'git diff'
  expect_allow guard-production.sh "$(bash_json 'git checkout -b feature/x')" 'git checkout -b feature'
  expect_allow guard-production.sh "$(bash_json 'git switch develop')" 'git switch develop'
  expect_allow guard-production.sh "$(bash_json 'gh pr view 42')" 'gh pr view'
  expect_allow guard-production.sh "$(bash_json 'gh pr create --base develop --draft')" 'gh pr create'
  expect_allow guard-production.sh "$(bash_json 'ls -la')" 'ls'
  expect_allow guard-production.sh "$(bash_json 'cat README.md')" 'cat README.md'
  expect_allow guard-production.sh "$(bash_json 'pnpm test')" 'pnpm test'
  expect_allow guard-production.sh "$(bash_json 'wings-env list')" 'wings-env list'
  expect_allow guard-production.sh "$(bash_json 'wings-deploy staging')" 'wings-deploy staging'
}

test_release_variable_is_read_from_the_environment() {
  # Only the terminal that started with WINGS_ALLOW_PRODUCTION=1 is released.
  expect_allow guard-production.sh "$(bash_json 'git push origin main')" 'released push to main' \
    WINGS_ALLOW_PRODUCTION=1
}

test_secrets_blocks_reading_env_files() {
  expect_block guard-secrets.sh "$(bash_json 'cat .env')" 'cat .env'
  expect_block guard-secrets.sh "$(bash_json 'cat .env.local')" 'cat .env.local'
  expect_block guard-secrets.sh "$(bash_json 'cat ./apps/api/.env')" 'cat nested .env'
  expect_block guard-secrets.sh "$(bash_json 'grep -r KEY .env')" 'grep .env'
  expect_block guard-secrets.sh "$(bash_json 'head .env.production')" 'head .env.production'
  expect_block guard-secrets.sh "$(read_json '.env')" 'Read .env'
  expect_block guard-secrets.sh "$(read_json '/opt/app/.env.production')" 'Read nested .env'
  expect_block guard-secrets.sh "$(bash_json 'cat /etc/wings-crm/api.env')" 'cat /etc/wings-crm'
  expect_block guard-secrets.sh "$(bash_json 'cat deploy/private.pem')" 'cat .pem'
  expect_block guard-secrets.sh "$(bash_json 'cat ~/.ssh/id_rsa')" 'cat id_rsa'
}

test_secrets_blocks_environment_dumps() {
  expect_block guard-secrets.sh "$(bash_json 'printenv')" 'printenv'
  expect_block guard-secrets.sh "$(bash_json 'env')" 'env'
  expect_block guard-secrets.sh "$(bash_json 'export -p')" 'export -p'
  expect_block guard-secrets.sh "$(bash_json 'printenv OPENROUTER_API_KEY')" 'printenv secret var'
  expect_block guard-secrets.sh "$(bash_json 'docker inspect api')" 'docker inspect'
  expect_block guard-secrets.sh \
    "$(bash_json 'echo $OPENROUTER_API_KEY')" 'echo secret var'
  expect_block guard-secrets.sh \
    "$(bash_json 'cat <<< "$DATABASE_URL"')" 'here-string with secret var'
}

test_secrets_allows_ordinary_reads() {
  expect_allow guard-secrets.sh "$(bash_json 'cat .env.example')" 'cat .env.example'
  expect_allow guard-secrets.sh "$(bash_json 'cat .env.sample')" 'cat .env.sample'
  expect_allow guard-secrets.sh "$(read_json '.env.example')" 'Read .env.example'
  expect_allow guard-secrets.sh "$(bash_json 'cat README.md')" 'cat README.md'
  expect_allow guard-secrets.sh "$(bash_json 'ls -la')" 'ls'
  expect_allow guard-secrets.sh "$(bash_json 'git status')" 'git status'
  expect_allow guard-secrets.sh "$(bash_json 'grep -r TODO src/')" 'grep in src'
  expect_allow guard-secrets.sh "$(read_json 'src/index.ts')" 'Read a normal file'
  expect_allow guard-secrets.sh "$(bash_json 'cp .env.example .env')" 'cp .env.example .env (write only)'
  expect_allow guard-secrets.sh "$(bash_json 'wings-env list')" 'wings-env list'
}

run_tests
