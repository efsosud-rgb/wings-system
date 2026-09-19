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

Deliberately left out of claude-seo:

- `seo-google` and its scripts (`keyword_planner.py`, `google_auth.py`,
  `google_report.py`, GA4/GSC/Indexing/IndexNow). It talks to the Google Ads
  API — read-only, but its reference recommends running a small paid campaign
  to get exact volumes, and this server holds real Google Ads credentials. That
  sits too close to the ad-spend non-negotiable in `CLAUDE.md` to install
  without a decision.
- `seo-dataforseo`, `seo-image-gen` and everything under `extensions/`: they
  send data to third-party vendors.
- `hooks/` (a PostToolUse hook that runs a script on every file edit) and
  `agents/` (would go in `.claude/agents/`, outside what was asked for).

Local changes to the copied text: `${CLAUDE_PLUGIN_ROOT}` paths rewritten to
project-relative `.claude/skills/...` paths, as each project's own manual
installer does. claude-seo's Python tools need a one-off `/seo setup` that
creates a virtualenv and installs packages; it has not been run.
