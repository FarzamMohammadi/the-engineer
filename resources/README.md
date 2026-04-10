# Resources

Static artifacts shipped with The Engineer and loaded into agent context at runtime.

These files enhance agent capabilities during task phases. They are not compiled — they are resolved by path from the repo root and read from disk by the orchestrator's prompt system.

## Structure

- `docs/` — Behavioral and operational guides embedded into phase prompts
- `skills/` — Reusable skill instructions injected into phase prompts (each skill is a directory with `SKILL.md` + optional supporting files like `personas/*.md`)

## Skills

Skills in `resources/skills/` are loaded by the skill loader (`src/core/orchestrator/prompts/skills.ts`) and injected as text into phase prompts. This makes skills portable across any CLI tool — the CLI receives skill content as embedded prompt text, with no CLI-specific registration or file path resolution required.

Each skill directory contains:
- `SKILL.md` — the skill instructions
- `personas/` (optional) — supporting persona files, inlined into the skill content automatically

Skills are mapped to specific RRPIR phases:
- **execution** — `commit`
- **self_review** — `commit`, `expert-panel-review`
- **integration** — `commit`
- Other phases receive no skills
