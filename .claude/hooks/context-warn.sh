#!/usr/bin/env bash
# UserPromptSubmit: when the last assistant turn used >150k tokens of context, tell the model to warn
# the user (one line) and suggest /compact or /handoff + /clear. Silent otherwise.
input=$(cat)
tp=$(jq -r '.transcript_path // empty' <<<"$input")
[ -r "$tp" ] || exit 0
# 007-A09: read the whole transcript, not the last 300 lines: a heavy turn pushes the last main
# assistant entry back past that window. Subagent (sidechain) entries carry their own usage and
# do not describe this session's context, so they are skipped.
tokens=$(jq -rs '[.[] | select(.type=="assistant" and (.isSidechain|not)) | .message.usage // empty] | last
  | if . then ((.input_tokens//0)+(.cache_creation_input_tokens//0)+(.cache_read_input_tokens//0)) else 0 end' "$tp" 2>/dev/null)
[ "${tokens:-0}" -ge 150000 ] || exit 0
jq -n --arg k "$(( tokens / 1000 ))" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:("O contexto desta sessão está em ~" + $k + "k tokens (limite de aviso: 150k). Antes de continuar, avise o Eric em UMA linha e sugira /compact (mesma tarefa) ou /handoff + /clear (outra onda/branch). Não pare a tarefa por isso.")}}'
