#!/bin/sh
# Points this clone's git hooks at the versioned .githooks/ folder (pre-push refuses direct pushes
# to develop, main and homologacao). Run once per clone or worktree checkout: sh scripts/instalar-hooks.sh
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "Ganchos instalados: core.hooksPath = .githooks (pre-push recusa push direto em develop, main e homologacao)."
