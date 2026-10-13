# Third-party skills installed in this project

Installed 2026-09-19 by copying from public GitHub repositories at the commits
below. No installer script was run, no hook was registered, nothing was written
outside `.claude/skills/`, and no skill has been invoked yet.

| Skill | Source | Commit | Licence |
| --- | --- | --- | --- |
| `humanizer` | blader/humanizer | 9862685f575c | MIT |
| `seo` + 21 `seo-*` sub-skills | AgriciDaniel/claude-seo | 92795530b4cc | MIT |
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill | de5f12b40077 | MIT |
| `remotion-best-practices` | remotion-dev/skills | bbb139d5ba37 | none declared |
| `grill-me`, `grilling`, `handoff` | mattpocock/skills (`skills/productivity/`) | c55ee46073ed | MIT |

Notes on the mattpocock/skills entries:

- `grill-me` is a one-line stub that calls the `grilling` skill, which holds the
  actual interview instructions, so `grilling` was installed as its dependency
  even though only `grill-me` and `handoff` were asked for.
- `grill-me` and `handoff` set `disable-model-invocation: true`: they only run
  when the user types `/grill-me` or `/handoff`. `grilling` can be triggered by
  the model when the user uses "grill" phrasing.
- `handoff` writes its document to the OS temporary directory, outside the
  repository, and tells the agent to redact secrets and personal data — keep
  that in mind given the no-personal-data rule in `AGENTS.md`.
- All three are plain text: no scripts, no URLs, no hooks. Copied verbatim; the
  repository's `LICENSE` was added to each folder.

Deliberately left out of claude-seo:

- `seo-google` and its scripts (`keyword_planner.py`, `google_auth.py`,
  `google_report.py`, GA4/GSC/Indexing/IndexNow). It talks to the Google Ads
  API — read-only, but its reference recommends running a small paid campaign
  to get exact volumes, and this server holds real Google Ads credentials. That
  sits too close to the ad-spend non-negotiable in `AGENTS.md` to install
  without a decision.
- `seo-dataforseo`, `seo-image-gen` and everything under `extensions/`: they
  send data to third-party vendors.
- `hooks/` (a PostToolUse hook that runs a script on every file edit) and
  `agents/` (would go in `.claude/agents/`, outside what was asked for).

Local changes to the copied text: `${CLAUDE_PLUGIN_ROOT}` paths rewritten to
project-relative `.claude/skills/...` paths, as each project's own manual
installer does. claude-seo's Python tools need a one-off `/seo setup` that
creates a virtualenv and installs packages; it has not been run.

## Installed 2026-09-22, via `npx skills add` and `npx impeccable install`

Unlike the batch above, these were not copied by hand: the `skills` CLI
clones each source repo, writes the skill into `.agents/skills/<name>`
(a directory several agent harnesses share), and symlinks it into
`.claude/skills/<name>`; `impeccable install` does the same but mirrors
into `.agents/`, `.claude/` (skill + four `impeccable-*` agents) and
`.github/agents|hooks|skills/` at once, plus a `.codex/hooks.json`. Nothing
was invoked yet beyond the installers themselves. `skills-lock.json` at the
repo root (written by the `skills` CLI) records the exact commit each of the
first four came from as a content hash, checked on `skills update`.

| Skill | Source | Commit | Licence | When to use |
| --- | --- | --- | --- | --- |
| `frontend-design` | anthropics/skills | `34040c9c5685` | Apache-2.0 | Every new screen, and every design review |
| `canvas-design` | anthropics/skills | `34040c9c5685` | Apache-2.0 | The Graphic Design agent |
| `brandkit` | leonxlnx/taste-skill (`skills/brandkit/`, one of 13 sub-skills — the rest, including `design-taste-frontend`, were deliberately left out) | `5217fb45be2c` | MIT (repo licence; the sub-skill carries none of its own) | The Graphic Design agent |
| `animate` | emilkowalski/skills | `85e8e2363b71` | MIT (repo licence; the sub-skill carries none of its own) | Interface animations |
| `impeccable` | npm `impeccable` (engine v0.1.5) | n/a — installed from the published package, not a cloned repo | Apache-2.0 | Every new screen, and every design review |

`remotion-best-practices` (already installed, see the table above) was left
untouched, and nothing else from `emilkowalski/skills` or `taste-skill` was
installed.

`impeccable install` was run once, non-interactively (`-y`), and detected
every agent harness this checkout has traces of (Claude Code, a generic
`.agents` consumer, GitHub Copilot, Codex) rather than only Claude Code —
this was not narrowed to `--providers=claude-code`, since nothing in the
request asked to restrict it. `PRODUCT.md` (repo root, per impeccable's own
schema) was written from `CLAUDE.md`'s existing product record, not from
`/impeccable init`'s interactive interview — that command has not been run,
so its later steps (workflow defaults, live-mode config) have not happened
either.

The install also wrote a `PostToolUse`/`Stop` hook pair (runs impeccable's
own detector after edits to UI files) into `.claude/settings.local.json` —
which this repo has never tracked (it was already untracked before this
install, same as `.env`). That file staying local means these hooks fire
only in a session that already has it locally; sharing them project-wide
would mean moving that hook block into a new, tracked `.claude/settings.json`
instead, which nobody asked for here.

`eslint.config.js`'s ignore list grew to match: `.agents/**`, `.codex/**`
and `.github/agents|hooks|skills/**` are now skipped for the same reason
`.claude/**` already was — vendored skill payloads, not ours to lint.
`.github/workflows/` is untouched and still linted as before (it never held
JS/TS).
