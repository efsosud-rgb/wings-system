#!/bin/sh
# Points this clone's git hooks at the versioned .githooks/ folder (pre-push refuses direct pushes
# to develop, main and homologacao). Run once per clone: sh scripts/instalar-hooks.sh
# Not in a worktree: core.hooksPath would land in the config it shares with the main checkout.
set -e
cd "$(git rev-parse --show-toplevel)"
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  echo "Isto é um worktree: o gancho iria para o repositório compartilhado. Rode num clone próprio." >&2
  exit 1
fi
git config core.hooksPath .githooks
echo "Ganchos instalados: core.hooksPath = .githooks (pre-push recusa push direto em develop, main e homologacao)."
