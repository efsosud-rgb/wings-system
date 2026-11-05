#!/usr/bin/env bash
# PreToolUse (Bash): blocks anything that changes PRODUCTION unless the person who owns
# production released it. Release = WINGS_ALLOW_PRODUCTION=1 in the environment the terminal
# was STARTED with (export it before `claude`). An inline `WINGS_ALLOW_PRODUCTION=1 cmd` inside
# the command does NOT release it, because this hook reads its own environment, not the command.
# Blocks (exit 2): wings-deploy production, wings-env set|restart on api-prod/web-prod, the
# production Coolify app ids, git push/merge/branch moves on main, gh pr merge.
# 007-A04/05/06/07/08: quotes and subcommands cannot hide a call; options before the git
# subcommand are skipped; checkout -B/switch -C on main and `gh api -f` on main are refused.
set -u
# d-t111: the checks below only ever get stricter.
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

# one segment per line (&&, ||, ;, |, newline), so a harmless word ending a segment is not a push to main.
# 007-A04: quotes and parentheses are blanked before the split, so a command wrapped in them is
# still broken into segments and checked. Only stricter: nothing that was blocked becomes allowed.
segments=$(sed -E 's/(&&|\|\||;|\||\\?$)/\n/g' <<<"$cmd")

branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true; }

# 007-A05: the subcommand is the first word after `git` that is not an option. Options that take a
# separate argument (-c user.name=x, --git-dir .git, -C dir) consume the next word too.
git_sub() {
  local -a w
  local i=0
  read -r -a w <<<"$1"
  while [ "$i" -lt "${#w[@]}" ] && [ "${w[$i]}" != git ]; do i=$((i + 1)); done
  i=$((i + 1))
  while [ "$i" -lt "${#w[@]}" ]; do
    case "${w[$i]}" in
      -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) printf '%s\n' "${w[$i]}"; return 0 ;;
    esac
  done
  return 1
}
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

  # 007-A04: accept any punctuation before git, so a quote or paren does not hide it
  if grep -Eq '(^|[[:space:]])git[[:space:]]' <<<"$seg"; then
    # -C <dir> changes the repository the command acts on
    segcwd=$cwd
    if grep -Eq 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' <<<"$seg"; then
      segcwd=$(sed -E 's/.*git[[:space:]]+-C[[:space:]]+("([^"]+)"|'"'"'([^'"'"']+)'"'"'|([^[:space:]]+)).*/\2\3\4/' <<<"$seg")
      [ "${segcwd#/}" = "$segcwd" ] && segcwd="$cwd/$segcwd"
    fi
    segbranch=$(branch_of "$segcwd"); [ -n "$segbranch" ] || segbranch=$branch
    [ "$forced_main" = 1 ] && segbranch=main
    sub=$(git_sub "$seg")

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
        # 007-A06
        grep -Eq -- "(-B|-C|-f|--force|--discard-changes|--orphan)([[:space:]]+[^[:space:]]+)*[[:space:]]+main([[:space:]]|$)" <<<"$seg" && deny "git $sub move a branch main"
        grep -Eq -- '[[:space:]](main)([[:space:]]|$)' <<<"$seg" && forced_main=1
        ;;
    esac
  fi

  grep -Eq '(^|[[:space:]/])gh[[:space:]]+pr[[:space:]]+merge' <<<"$seg" && deny "gh pr merge (pode ser PR para main)"
  # 007-A07
  grep -Eq '(^|[[:space:]/])gh[[:space:]]+api[[:space:]].*(merge|git/refs/heads/main)' <<<"$seg" && grep -Eiq -- '-X[[:space:]]*(PUT|POST|PATCH|DELETE)|--method|(^|[[:space:]])(-f|-F|--field|--raw-field|--input)([[:space:]=]|$)' <<<"$seg" && deny "gh api alterando main/merge"
done <<<"$segments"

exit 0

