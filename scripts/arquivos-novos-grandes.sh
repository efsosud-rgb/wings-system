#!/bin/sh
# Fails when this branch adds a text file with more than 600 lines (decision of 27/10/2026,
# docs/decisoes.md). Usage: sh scripts/arquivos-novos-grandes.sh <base commit or ref>
# Skipped: binaries, renames, and generated or vendored files (lockfile, drizzle snapshots,
# third-party agent tooling, the Studio fork).
set -e
base=${1:?usage: arquivos-novos-grandes.sh <base>}
tab=$(printf '\t')
git diff --diff-filter=A --numstat "$base" HEAD | {
  found=0
  while IFS="$tab" read -r added _deleted file; do
    [ "$added" = "-" ] && continue
    case "$file" in
      pnpm-lock.yaml | apps/api/migrations/meta/* | .claude/* | .agents/* | .codex/* | .github/agents/* | .github/hooks/* | .github/skills/* | packages/studio/src/* | packages/studio/tests/*) continue ;;
    esac
    if [ "$added" -gt 600 ]; then
      echo "Arquivo novo com $added linhas (máximo 600): $file. Quebre por módulo." >&2
      found=1
    fi
  done
  exit $found
}
