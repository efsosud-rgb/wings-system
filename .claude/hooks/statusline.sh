#!/usr/bin/env bash
# statusLine: model, context size, and a warning from ~150k tokens (suggest /compact or /handoff + /clear).
input=$(cat)
read -r model tokens size pct < <(jq -r '
  def n: (. // 0);
  [ (.model.display_name // .model.id // "?"),
    ((.context_window.current_usage // null) as $u
      | if $u then (($u.input_tokens|n) + ($u.cache_creation_input_tokens|n) + ($u.cache_read_input_tokens|n))
        else ((.context_window.used_percentage|n) * (.context_window.context_window_size|n) / 100 | floor) end),
    (.context_window.context_window_size|n),
    (.context_window.used_percentage|n | floor) ] | map(tostring | gsub(" "; "_")) | join(" ")' <<<"$input" 2>/dev/null)
[ -n "${tokens:-}" ] || { echo "ctx ?"; exit 0; }
model=${model//_/ }
k=$(( (tokens + 500) / 1000 ))
if [ "${size:-0}" -gt 0 ]; then sz="/$(( size / 1000 ))k ${pct}%"; else sz=""; fi
branch=$(git -C "$(jq -r '.workspace.current_dir // .cwd // "."' <<<"$input")" rev-parse --abbrev-ref HEAD 2>/dev/null)
line="$model · ctx ${k}k${sz}"
[ -n "$branch" ] && line="$line · $branch"
if [ "$tokens" -ge 150000 ]; then
  printf '\033[33m%s\033[0m \033[1;31m⚠ contexto >150k: /compact ou /handoff + /clear\033[0m\n' "$line"
else
  printf '%s\n' "$line"
fi
