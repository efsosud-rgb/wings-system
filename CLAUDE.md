@AGENTS.md

# CLAUDE.md

Every rule is in `AGENTS.md`, imported above, so Codex and Jules get it too. This file keeps only what belongs to Claude Code.

- **Skills** live in `.claude/skills/`; `INSTALLED.md` there says what is installed and what was left out. `/handoff` and `/grill-me` run only when typed. `/handoff` writes its document to the OS temporary directory, not the repository, with secrets and personal data redacted, pointing to commits and docs instead of copying them.
- **Agents** in `.claude/agents/`, read-only and cheap for routine work: `repo-researcher` and `docs-checker` on haiku, `code-reviewer` on sonnet. The `impeccable-*` agents belong to the design skill. Each file explains its `model:`.
- **Hooks and settings:** `.claude/settings.json` is versioned. It wires the status line, `context-warn.sh` (every prompt), `guard-production.sh` (before Bash) and `guard-secrets.sh` (before Bash and Read), all in `.claude/hooks/`, and allows `wings-staging-sql`, `wings-deploy`, `wings-env` and `wings-openrouter`. `guard-production` blocks deploy or writes to production and push or merge into `main` without `WINGS_ALLOW_PRODUCTION=1`, which only Eric sets; `guard-secrets` blocks commands that print secret values. A blocking guard is a stop sign (AGENTS.md section 3). `.claude/settings.local.json` is personal and untracked; only a user-level git ignore on this machine hides it.
- **Contexto:** ao passar de ~150k tokens (a barra de status e o hook `context-warn` mostram), avise o Eric em uma linha e sugira `/compact` se a tarefa continua a mesma, ou `/handoff` + `/clear` se muda (AGENTS.md seção 5). Não pare a tarefa por isso.
