# Slice 4: Startup & Configuration

## Requirements

Gathered through Q&A (Session 9). Research saved to `.claude/temp/research/slice-04-startup.md`.

### Goals (Priority Order)

1. **First impression quality** — the "5-minute clone-and-run" experience for a brand new user
2. **Code quality to OSS standard** — coding standards from Slice 1 applied across all startup/config files
3. **Simplification** — reduce unnecessary complexity; less code = better first impression + easier to maintain
4. **Resilience hardening** — only if discovered along the way, not a deliberate hunt

### Two User Personas

- **New user:** Just cloned the repo, zero context. Guided through everything with explicit confirmation before any action on their behalf.
- **Power user:** Has their own seed config directory, uses `reset.sh` for fast resets. Contextually aware.

### Core Principle

**Never act on the user's behalf without asking.** Every action is presented with explicit confirmation.

## Decisions Made (Session 9 Q&A)

### Getting Started Path

```bash
# Prerequisites (documented in README): Node.js 22+, pnpm
git clone ... && cd the-engineer
pnpm run setup    # install deps + build + npm link — idempotent, safe for anyone anytime
engineer start    # first-run setup + start daemon
```

- New `pnpm run setup` script = `pnpm install && pnpm build && npm link`. Idempotent. One script, clear name, does all preparation. Works for new and returning users.
- Global prerequisites (Node, pnpm) are the user's responsibility — can't auto-install (OS-specific). README documents them; if missing, guide the user to the official install docs and have them re-run.
- Note: `pnpm setup` is a pnpm built-in — the project script is only reachable as `pnpm run setup`. Always write it explicitly in docs.

### OS Detection Gate

Programmatic check (`process.platform`) at the start of interactive setup:

- **macOS:** "Detected: macOS — fully tested and supported." → continue
- **Linux:** "Detected: Linux — highly compatible but not yet thoroughly tested. Proceed?" → confirm to continue
- **Windows/other:** "Detected: Windows — not currently supported. Requires a POSIX environment." → block, exit gracefully

Honest, transparent communication about testing status. macOS and Linux are POSIX-compatible and work together; Windows is out of scope for v1.

### Interactive Setup Flow

Current 10-step flow is structurally sound. Changes:
- Add **Step 0**: OS detection gate
- Add **confirmation after the detection summary** before plugin selection
- Polish steps 2-10 for clarity and isolation; keep the prompt count (each is a discrete, well-scoped question)

### Seed Directory — Option A (sanitize + dogfood)

**CRITICAL TO DOCUMENT.**

- `seed-example/` currently contains personal config (hardcoded `cli_path` to a developer machine, a specific repo, `logging.level: debug`). **Sanitize it to generic placeholders** — it becomes a tracked, in-repo *reference* showing the seed-directory structure (`configs/` + `plugins/` layout).
- Personal seeds live in `seed-example-*` directories — gitignored. The owner dogfoods the setup feature to generate `seed-example-farzam/`.
- `.gitignore`: add `seed-example-*` pattern (ignores personal seeds, keeps `seed-example/` itself tracked).
- `reset.sh` behavior:
  - No argument → runs interactive `engineer start` (no seed)
  - With argument → runs `engineer start --seed <dir>`
- `reset.sh` fixes: cross-platform `PNPM_HOME` (currently hardcoded macOS `$HOME/Library/pnpm`); general cleanup.

### Simplification — Removals (confirmed)

- **Remove `checkCliArtifacts`** from `doctor.ts` (~65 lines) — scans `~/.claude/projects/`, hardcodes one LLM plugin's directory layout (Plugin Opacity violation), diagnoses a different tool, near-zero value.
- **Strip config-version machinery** from `loader.ts` (~30 lines) — `CURRENT_CONFIG_VERSION`, `ConfigVersionSchema`, `detectConfigVersion`, version-mismatch warning. Currently dead in practice; YAGNI for pre-v1. Document as future consideration (see below).
- **Delete `Output.table()`** — dead code, zero call sites.
- **Remove `"quiet"` `OutputMode`** — half-implemented, no `--quiet` flag exists, unreachable branches.
- Consolidate the duplicated `checkRequirementsMet` (setup.ts ↔ prompts.ts).
- Fix the double `findResolvedEnvVars` config-dir scan in `start.ts`.
- Make `getNumberPaths` private if `knip` allows.

### Code Quality (confirmed)

- `doctor.ts` stays as **one cohesive file** (do not split).
- Extract the ~60-line APE-proof signal-handling block from `start.ts` into its own unit.
- Coding standards audit across all in-scope files: newspaper order, `function` declarations, return type annotations, JSDoc on exports, guard clauses, `import type`, full names.
- Rename abbreviations: `clr` → `colorize`, `wsRoot` → `workspaceRoot`, etc.
- Fix orphaned JSDoc + stale category numbering in `doctor.ts`.
- Fix inline type imports (`cli/index.ts`, `start.ts`) → top-level `import type`.
- CLI version single-sourced from `package.json` (remove hardcoded `VERSION`).

### CLI Restructure — Screaming Architecture (confirmed)

- Reorganize `src/cli/` so the directory tree and file names reveal intent without opening files
  (Uncle Bob's Screaming Architecture). Group start-related files under `commands/start/`, group
  terminal output, group bundled config-template content.
- Its own phase, placed **before** the audit so the audit sees the final shape.
- Target layout finalized as a design activity at the start of that phase, with owner sign-off.
- Document the principle as a **"Structure Reveals Intent"** coding standard.

### New Coding Standards (confirmed)

- **Single Source of Truth** — a value defined once, derived everywhere; no duplicated constants.
- **Structure Reveals Intent** — directory grouping and file names make purpose obvious without opening the file.

### Cross-Cutting

- **Nice error handling across all user flows** (`setup.sh`, `reset.sh`, `engineer start`,
  first-run setup) — every failure produces a clear, actionable message; never a raw stack trace.

## Future Considerations to Document

In `future-considerations.md`:
- **Config schema versioning** — current decision: one latest version per plugin/OS, manually updated by users as they wish. Revisable future option: explicit config-schema versioning, possibly with version selection at startup.
- **OS-agnostic startup/config/setup** — consolidate the existing "OS-Specific Plugin Selection" entry with the broader OS-agnostic vision.
- **Remove stale entries**: "Telegram Receive Capability" and "`engineer telegram-setup` CLI Command" — both features are already built (verified in `telegram-comm.ts`).

## Docs to Update (must stay in sync)

- `README.md` — new getting-started path (`pnpm run setup` → `engineer start`), prerequisites.
- `docs/cli.md` — rewrite "Installing the CLI" for `pnpm run setup`; fix the stale doctor category table.
- `docs/configuration/README.md` — remove the stale `engineer init` section; fix `--config` → `--config-dir`.
- `docs/plugins/trigger/github-trigger.md` — remove the stale `engineer init` reference.
- `future-considerations.md` — see above.

## Tests to Update (must stay in sync)

- `tests/unit/cli/setup/setup.test.ts`, `tests/unit/cli/commands/doctor.test.ts`, `tests/unit/cli/output.test.ts`,
  `tests/unit/config/loader.test.ts` — update for signature/behavior changes (removals, renames, OS detection).
- New tests for OS detection (pure function) and any extracted units.

## Implementation Plan

Full plan: `.claude/temp/create-plan/slice-04-startup.md` (panel-reviewed, 11 decisions).

Five phases, one focused session each, every phase ends green (build + lint + tests):

1. **Simplification & Removals** — strip config-version machinery, remove `checkCliArtifacts`,
   delete `Output.table()` + `"quiet"` mode, consolidate `checkRequirementsMet`, fix double scan.
2. **Getting-Started Path** — `scripts/setup.sh` (confirm + hardened errors), rework `reset.sh`,
   sanitize `seed-example/`, `.gitignore` `seed-example-*`, README + `cli.md`.
3. **OS Detection & Setup UX** — `detectOperatingSystem()` + gate, detection-summary confirmation,
   messaging polish, `future-considerations.md` updates.
4. **CLI Restructure (Screaming Architecture)** — agree target `src/cli/` layout, extract
   signal-handling unit, move/regroup files, add "Structure Reveals Intent" standard.
5. **Coding Standards Audit** — full standards sweep of the restructured shape, rename
   abbreviations, fix stale JSDoc/docs, version single-sourcing, final green sweep.

Ordering: removals before audit (audit less code); restructure before audit (audit final shape).

## Status

- [x] Requirements gathering (Session 9)
- [x] Research (Session 9 — `.claude/temp/research/slice-04-startup.md`)
- [x] Planning (Session 9 — `.claude/temp/create-plan/slice-04-startup.md`)
- [ ] Implementation — Phase 1 next
- [ ] Review
