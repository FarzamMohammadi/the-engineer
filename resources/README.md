# Resources

Static artifacts shipped with The Engineer and loaded into agent context at runtime.

These files enhance agent capabilities during task phases. They are not compiled — they are resolved by absolute path and referenced in phase prompts so the CLI can read them on demand.

## Structure

- `docs/` — Behavioral and operational guides embedded into phase prompts
- `skills/` — Reusable skill instructions referenced by path in phase prompts (each skill is a directory with `SKILL.md` + optional supporting files like `personas/*.md`)

## Skills

Skills in `resources/skills/` are referenced by absolute path in phase prompts. The orchestrator resolves the absolute path to each skill file at prompt-build time and embeds that path in the prompt. The CLI reads skill files on demand using its Read tool — no content is inlined into prompts.

This makes skills portable across any CLI tool: the CLI receives a path, not CLI-specific registration or format. Skills are accessible from any worktree because the prompt contains absolute paths back to The Engineer's source tree.

Each skill directory contains:
- `SKILL.md` — the skill instructions
- `personas/` (optional) — supporting persona files, listed individually by absolute path

Skills are mapped to specific RRPIR phases:
- **execution** — `commit`
- **self_review** — `commit`, `expert-panel-review`
- **integration** — `commit`
- Other phases receive no skills
