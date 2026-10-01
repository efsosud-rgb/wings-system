#!/usr/bin/env bash
# PreToolUse (Bash): blocks anything that changes PRODUCTION unless the person who owns
# production released it. Release = WINGS_ALLOW_PRODUCTION=1 in the environment the terminal
# was STARTED with (export it before `claude`). An inline `WINGS_ALLOW_PRODUCTION=1 cmd` inside
# the command does NOT release it, because this hook reads its own environment, not the command.
# Blocks (exit 2): wings-deploy production, wings-env set|restart on api-prod/web-prod, the
# production Coolify app ids, git push/merge/branch moves on main, gh pr merge.
set -u
input=$(cat)
[ "$(jq -r '.tool_name // empty' <<<"$input")" = Bash ] || exit 0
[ "${WINGS_ALLOW_PRODUCTION:-}" = 1 ] && exit 0

cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cwd" ] || cwd=$PWD

deny() {
  echo "BLOQUEADO (produção): $1. Só o Eric libera produção: ele define WINGS_ALLOW_PRODUCTION=1 no terminal ANTES de iniciar o claude. Não tente contornar; peça a ele." >&2
  exit 2
}

PROD_IDS='engmbukkyuk3d07qqolmm5xt|di27x8hdkondbosmqmere9qf'
grep -Eq "$PROD_IDS" <<<"$cmd" && deny "comando cita um app de produção do Coolify"

# one segment per line (&&, ||, ;, |, newline), so `echo main && git push origin x` is not a push to main
segments=$(sed -E 's/(&&|\|\||;|\||\\?$)/\n/g' <<<"$cmd")

branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true; }
branch=$(branch_of "$cwd")
forced_main=0   # set by an earlier `git checkout main` in the same command line
MAIN_REF='(^|[[:space:]:+])((refs/heads/|origin/)?main)([[:space:]]|$)'

while IFS= read -r seg; do
  seg=$(sed -E 's/^[[:space:]]+//' <<<"$seg")
  [ -n "$seg" ] || continue

  grep -Eq '(^|[[:space:]/])wings-deploy[[:space:]]+(-[^[:space:]]+[[:space:]]+)*prod' <<<"$seg" && deny "wings-deploy production"
  if grep -Eq '(^|[[:space:]/])wings-env[[:space:]]' <<<"$seg" && grep -Eq '(api|web)-prod' <<<"$seg" && grep -Eq '[[:space:]](set|restart)[[:space:]]' <<<"$seg"; then
    deny "wings-env set/restart em app de produção"
  fi

  if grep -Eq '(^|[[:space:]])git[[:space:]]' <<<"$seg"; then
    # -C <dir> changes the repository the command acts on
    segcwd=$cwd
    if grep -Eq 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' <<<"$seg"; then
      segcwd=$(sed -E 's/.*git[[:space:]]+-C[[:space:]]+("([^"]+)"|'"'"'([^'"'"']+)'"'"'|([^[:space:]]+)).*/\2\3\4/' <<<"$seg")
      [ "${segcwd#/}" = "$segcwd" ] && segcwd="$cwd/$segcwd"
    fi
    segbranch=$(branch_of "$segcwd"); [ -n "$segbranch" ] || segbranch=$branch
    [ "$forced_main" = 1 ] && segbranch=main
    sub=$(sed -E 's/^.*(^|[[:space:]])git([[:space:]]+-C[[:space:]]+("[^"]+"|[^[:space:]]+))?([[:space:]]+-[-a-zA-Z]+(=[^[:space:]]+)?)*[[:space:]]+([a-z-]+).*$/\6/' <<<"$seg")

    case "$sub" in
      push)
        grep -Eq -- "$MAIN_REF" <<<"$seg" && deny "git push para main"
        grep -Eq -- '[[:space:]]--(all|mirror)([[:space:]]|$)' <<<"$seg" && deny "git push --all/--mirror inclui main"
        # bare `git push` / `git push origin` while standing on main
        if [ "$segbranch" = main ] && ! grep -Eq -- '[[:space:]]+[^-[:space:]]+[[:space:]]+[^-[:space:]]+' <<<"$(sed -E 's/^.*push//' <<<"$seg")"; then
          deny "git push estando na branch main"
        fi
        ;;
      merge|pull|rebase|cherry-pick|am|revert|reset)
        [ "$segbranch" = main ] && deny "git $sub dentro da branch main"
        ;;
      branch)
        grep -Eq -- "(-f|--force|-M|-D|-d|--delete|-m)([[:space:]]+[^[:space:]]+)*[[:space:]]+main([[:space:]]|$)" <<<"$seg" && deny "git branch altera main"
        ;;
      update-ref)
        grep -Eq 'refs/heads/main' <<<"$seg" && deny "git update-ref em main"
        ;;
      checkout|switch)
        grep -Eq -- '[[:space:]](main)([[:space:]]|$)' <<<"$seg" && forced_main=1
        ;;
    esac
  fi

  grep -Eq '(^|[[:space:]/])gh[[:space:]]+pr[[:space:]]+merge' <<<"$seg" && deny "gh pr merge (pode ser PR para main)"
  grep -Eq '(^|[[:space:]/])gh[[:space:]]+api[[:space:]].*(merge|git/refs/heads/main)' <<<"$seg" && grep -Eiq -- '-X[[:space:]]*(PUT|POST|PATCH|DELETE)|--method' <<<"$seg" && deny "gh api alterando main/merge"
done <<<"$segments"

exit 0
