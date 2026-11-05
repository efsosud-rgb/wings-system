#!/usr/bin/env bash
# PreToolUse (Bash|Read): blocks commands that would PRINT secret values: .env files, /etc/wings-crm/*,
# environment dumps and variables named *TOKEN*/*SECRET*/*KEY*/*PASSWORD*. Using a secret without
# showing it (the wings-* helpers read their own files) is not blocked. Exit 2 = block.
set -u
# d-t111: the checks below only ever get stricter.
input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")

deny() {
  echo "BLOQUEADO (segredo): $1. Valores de segredo nunca entram na conversa nem em log. Use wings-env list (só nomes), wings-env set --from-file, ou peça ao Eric." >&2
  exit 2
}

# 007-A08: a missing dependency closes the guard (exit 0 would open it). Uses only builtins and
# variables already set, so it runs before anything that needs jq.
[ -n "${JQ_BIN:-$(command -v jq || true)}" ] || deny "falta o jq; a trava não consegue ler a chamada e não libera nada"

# secret-bearing files: any .env except .env.example/.env.sample/.env.template, /etc/wings-crm, environ dumps.
# The suffix after `.env` is any non-separator text, so globs and backups (`.env*`, `.env~`, `.env.bak`) match too.
# `:` is a separator so git's `HEAD:.env` form is recognised.
SECRET_FILE='(^|[[:space:]/="'"'"':])\.env([^[:space:]"'"'"';|&<>/]*)|/etc/wings-crm|/proc/[^[:space:]]*/environ|\.pem([[:space:]"'"'"']|$)|(^|/)id_(rsa|ed25519)'
SAFE_ENV='\.env\.(example|sample|template)'

if [ "$tool" != Bash ]; then
  # Any other tool that names a path (Read, Grep, NotebookRead...) would show the file's content.
  # settings.json must match every such tool; see DUVIDAS.md (007-A02).
  p=$(jq -r '[.tool_input.file_path, .tool_input.notebook_path, .tool_input.path, .tool_input.glob]
    | map(select(. != null and . != "")) | .[]' <<<"$input" 2>/dev/null)
  [ -n "$p" ] || exit 0
  grep -Eq "$SAFE_ENV" <<<"$p" && exit 0
  grep -Eq "$SECRET_FILE" <<<"$p" && deny "leitura de arquivo de segredo ($(basename "$(head -1 <<<"$p")"))"
  exit 0
fi

cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
# ignore the safe example files so they do not trip the file rule
scrub=$(sed -E 's/[^[:space:]"'"'"']*\.env\.(example|sample|template)([^[:alnum:]_.-]|$)/\2/g' <<<"$cmd")
# `cp SRC .env` / `mv SRC .env` only WRITE the last argument: do not count it as a read
scrub=$(sed -E 's/^([[:space:]]*(cp|mv)[[:space:]].*)[[:space:]]+[^[:space:]]+[[:space:]]*$/\1/' <<<"$scrub")

# `git` counts only for the subcommands that print a file's content; `git commit -m 'add .env'`
# writes text and is not a read.
READERS='(^|[^[:alnum:]_-])(cat|tac|head|tail|less|more|nl|bat|grep|egrep|fgrep|rg|ag|sed|awk|cut|sort|uniq|paste|tee|base64|xxd|od|hexdump|strings|diff|cmp|jq|yq|source|python3?|node|perl|ruby|php|xargs|cp|mv|scp|rsync|curl|wget|nc|openssl|gpg|tar|zip|7z|dd|docker[[:space:]]+cp)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])git[[:space:]]+([^;&|]*[[:space:]])?(show|diff|log|cat-file|grep|blame|whatchanged|archive|reflog)([^[:alnum:]_-]|$)|(^|[;&|(][[:space:]]*)\.[[:space:]]+[^[:space:]]|<[[:space:]]*[^[:space:]]'

if grep -Eq "$SECRET_FILE" <<<"$scrub"; then
  # listing / existence checks are fine
  if grep -Eq "$READERS" <<<"$scrub"; then
    deny "comando lê arquivo de segredo (.env, /etc/wings-crm, environ, chave)"
  fi
fi

# environment dumps
grep -Eq '(^|[;&|(`][[:space:]]*|\$\([[:space:]]*)(printenv|env|export[[:space:]]+-p|declare[[:space:]]+-[xp]+|set|compgen[[:space:]]+-e)([[:space:]]*($|[;&|)`<>]))' <<<"$cmd" && deny "dump do ambiente (printenv/env/export -p/set)"
grep -Eq '(^|[^[:alnum:]_-])printenv[[:space:]]+[^;&|]*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|PRIVATE)' <<<"$cmd" && deny "printenv de variável de segredo"
grep -Eq '(^|[^[:alnum:]_-])(docker[[:space:]]+(exec|run)[^;&|]*[[:space:]](env|printenv)([[:space:]]|$)|docker[[:space:]]+inspect|docker[[:space:]]+compose[[:space:]]+config)' <<<"$cmd" && deny "docker inspect/exec env expõe variáveis de ambiente"

# printing a secret-named variable: echo/printf/cat <<< / here-strings / string interpolation into a printer
SECRET_VAR='\$\{?[A-Za-z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL)[A-Za-z0-9_]*'
if grep -Eq "(^|[^[:alnum:]_-])(echo|printf|print|cat|tee|logger|wall|say)([^[:alnum:]_-]|$)[^;&|]*${SECRET_VAR}" <<<"$cmd"; then
  deny "imprime variável de segredo (TOKEN/SECRET/KEY/PASSWORD)"
fi
grep -Eq "<<<[[:space:]]*[\"']?${SECRET_VAR}" <<<"$cmd" && grep -Eq '(cat|tee|base64|xxd)' <<<"$cmd" && deny "here-string com variável de segredo"
exit 0
