# Plan: Slice 4 — Startup & Configuration

**Date**: 2026-05-19 | **Stakes**: Standard
**Upstream**: `.claude/temp/research/slice-04-startup.md` | `implementation-docs/9-oss-ready/slices/04-startup.md`
**Status**: Panel-Reviewed

## Intent

Bring the startup, configuration, and first-run setup code to OSS-grade quality, polish the
new-user "5-minute clone-and-run" experience, and delete what doesn't earn its place. The single
most important reason: this is the first-impression path — the code a new user runs before they
trust the project, and the code a new contributor reads first.

## Decisions

### D1: Four sequenced phases, one session each
**Choice**: Phase 1 Removals → Phase 2 Getting-Started → Phase 3 OS Detection & Setup UX → Phase 4 Coding Standards Audit. Each phase is one focused session that ends green (build + lint + tests pass).
**Context**: ~3000 LOC across ~22 files exceeds a single context budget. The dashboard slice took 3 sessions; this is comparable.
**Rejected**: Three phases (merge OS detection into audit) — that session would carry new code *and* a full audit, too much for one budget.
**Consequence**: "Audit last" means Phase 4 audits the *final* shape of every file, including code Phase 3 adds. No wasted effort.

### D2: `setup.sh` is a real script with a confirmation prompt, not a documented one-liner
**Choice**: `pnpm run setup` invokes `scripts/setup.sh` — it prints what it will do, asks Y/n, then runs `pnpm install` + `pnpm build` + `pnpm link --global` with colored section output and explicit failure handling.
**Context**: The owner wants a delightful, confirm-before-acting first command. Bare command chaining can't do that.
**Rejected**: Three documented commands in the README (Pike's instinct — clearer, no script to maintain). Rejected because the confirmation UX and "never act without asking" are explicit requirements.
**Consequence**: A bash script enters the maintained surface. It must be disciplined — `set -euo pipefail`, actionable error messages on every failure path (notably `pnpm link --global` permission failures).

### D3: Sanitize `seed-example/` into a tracked generic reference (Option A)
**Choice**: Replace the personal values in `seed-example/` (hardcoded `cli_path`, personal repo, `logging.level: debug`) with generic placeholders. It stays tracked as the in-repo reference for seed-directory structure. Personal seeds live in gitignored `seed-example-*` directories. The owner dogfoods the setup feature to generate `seed-example-farzam/`.
**Context**: The tracked `seed-example/` currently leaks one developer's machine config. Verified: no test or CI consumes it as a runnable seed — sanitizing is safe.
**Rejected**: Stop tracking `seed-example/` entirely — loses the in-repo onboarding example of seed structure.
**Consequence**: `seed-example/` becomes documentation-by-example, never a runnable seed. The team becomes its own user of the seed feature.

### D4: `reset.sh` — no-arg runs interactive, with-arg runs `--seed`
**Choice**: `reset.sh` still wipes/builds/links. Final step: no argument → `engineer start` (interactive); `reset.sh <dir>` → `engineer start --seed <dir>`. Fix the hardcoded macOS `PNPM_HOME`. Document the new behavior in the script header.
**Context**: Bare `reset.sh` currently auto-seeds from `seed-example/` — which after D3 is just placeholders. The seed must become an explicit choice.
**Rejected**: Keep `seed-example/` as the default seed — contradicts D3.
**Consequence**: Workflow change for the primary user: bare `./scripts/reset.sh` no longer auto-seeds. Must be documented in the script header.

### D5: Strip config-version machinery
**Choice**: Delete `CURRENT_CONFIG_VERSION`, `ConfigVersionSchema`, `ConfigVersion`, `detectConfigVersion`, the version-mismatch warning, and the `version` field from `ConfigBundle`.
**Context**: Verified zero consumers — nothing reads `bundle.version`. `detectConfigVersion` always returns `1` (no template writes a `version:` field). Fully dead code. YAGNI for a pre-v1 project with "zero backward compatibility."
**Rejected**: Keep it as forward-looking scaffolding — it does not do what a real versioning system needs (no prompt, no migration); when v2 config arrives it will be redesigned anyway.
**Consequence**: Config versioning becomes a documented future consideration. Current decision: one latest version per plugin/OS, manually updated by users.

### D6: Remove `checkCliArtifacts` from doctor
**Choice**: Delete the `~/.claude/projects/` disk-usage check entirely.
**Context**: It hardcodes one LLM plugin's on-disk layout (Plugin Blindness violation), diagnoses a *different tool*, and is informational-only with near-zero value.
**Rejected**: Make it generic / gate it behind the active LLM plugin — not worth the effort for a low-value check.
**Consequence**: `doctor` has 8 unconditional checks + 1 conditional (risky config). Category numbering gets corrected in Phase 4.

### D7: OS gate — Windows blocks always, Linux confirms only when interactive
**Choice**: `detectOperatingSystem()` classifies the platform. macOS → continue. Linux → print "not thoroughly tested" note; in interactive setup, require a confirm; in `--seed` non-interactive mode, print the note and proceed. Windows → block with a clear message, in both interactive and `--seed` modes.
**Context**: Windows cannot run the daemon either way. Linux is highly compatible; a CI/automation `--seed` run has no human to confirm.
**Consequence**: The gate must not regress existing E2E tests that exercise `engineer start` on macOS/Linux runners.

### D8: `doctor.ts` stays one cohesive file
**Choice**: Do not split `doctor.ts` despite its 725 lines.
**Context**: It is one cohesive concept (health checks). Coding standards: "cohesion matters more than line count."
**Consequence**: The file stays large but navigable via section dividers.

### D9: CLI version single-sourced from `package.json` + a new coding standard
**Choice**: The CLI reads its version from `package.json` instead of a hardcoded `VERSION` constant. Add a "Single Source of Truth" standard to `docs/coding-standards.md`.
**Context**: `cli/index.ts` and `package.json` both hardcode `"0.0.1"` — duplicated constant. The owner values centralization and wants the principle codified.
**Consequence**: One version source. The new standard generalizes the existing schema-first single-source rule to all derived values.

### D10: Nice error handling across all user flows (cross-cutting)
**Choice**: Every failure mode in the slice's user flows — `setup.sh`, `reset.sh`, `engineer start`, first-run setup — produces a clear, actionable message. Never a raw stack trace or bare bash error.
**Context**: Explicit owner requirement. This is the first-impression path; a cryptic failure here loses trust permanently.
**Consequence**: Each phase's verification includes exercising failure paths, not just the happy path.

### D11: CLI directory restructure — Screaming Architecture
**Choice**: Reorganize `src/cli/` so the directory tree and file names reveal intent without opening files — group start-related files under `commands/start/`, group terminal output, group bundled config-template content. The target layout is finalized at the start of Phase 4 as a design activity with owner sign-off. Document the principle as a "Structure Reveals Intent" coding standard.
**Context**: `src/cli/commands/` is a flat dump of 9 files — `start.ts` / `start-background.ts` / `start-dashboard.ts` obviously belong together. The top of `src/cli/` mixes unrelated concerns (`output.ts`, `templates.ts`, `home.ts`, `pid.ts`). Uncle Bob's Screaming Architecture: structure should make purpose obvious at a glance.
**Rejected**: Leave the structure flat — it mumbles its intent; a new contributor must open files to navigate.
**Consequence**: Restructure is its own phase (Phase 4), placed before the audit so the audit sees the final shape. Moving files updates imports across the codebase — mechanical but wide.

## Scope Boundary

**Delivering**:
- `pnpm run setup` → `scripts/setup.sh` with confirmation + hardened error handling
- Reworked `reset.sh` (no-arg interactive, with-arg seed, cross-platform, documented)
- Sanitized `seed-example/`; `.gitignore` `seed-example-*` pattern
- OS detection gate in first-run setup
- Confirmation step after the detection summary; setup messaging polish
- Removal of `checkCliArtifacts`, config-version machinery, `Output.table()`, `"quiet"` mode
- Consolidated `checkRequirementsMet`; fixed double config-scan; privatized `getNumberPaths`
- `src/cli/` directory restructure (Screaming Architecture); extracted signal-handling unit
- Full coding-standards audit of all in-scope files
- CLI version single-sourced; new "Single Source of Truth" + "Structure Reveals Intent" coding standards
- Synced docs: README, `cli.md`, `configuration/README.md`, `plugins/trigger/github-trigger.md`, `future-considerations.md`
- Synced + new tests

**Deferring**:
- Windows support — out of scope for v1; documented as a future consideration
- `pidFilePath` deduplication — consolidating would make Core import from the CLI layer (layer violation); the duplication is one trivial `join()`
- Config-content drift between `templates.ts` / `seed-example/` / schemas — known, accepted; not fixable without restructuring
- Generating `seed-example/` from `templates.ts` — larger refactor, out of slice scope

## Task Breakdown

### Phase 1 — Simplification & Removals (one session)

#### Task 1.1: Strip config-version machinery [estimated: 20m]
**Goal**: No config-version code remains; config still loads.
**Where**: `src/config/loader.ts`, `src/schemas/config.ts`, `tests/unit/config/loader.test.ts`, `tests/unit/schemas/config.test.ts`.
**Approach**: Delete `detectConfigVersion`, the version-mismatch warning block, the `version` field from `ConfigBundle` and the returned bundle. Delete `CURRENT_CONFIG_VERSION`, `ConfigVersionSchema`, `ConfigVersion` from `schemas/config.ts`. Remove now-unused imports. Update tests that reference any of these.
**Depends on**: Nothing (verified: zero consumers of `bundle.version`).
**Verify**: `pnpm typecheck && pnpm test config` green; `grep -r "ConfigVersion\|CURRENT_CONFIG_VERSION\|detectConfigVersion" src/ tests/` returns nothing.
**Commit**: `/commit`.

#### Task 1.2: Remove `checkCliArtifacts` from doctor [estimated: 15m]
**Goal**: The `~/.claude/projects/` check is gone; doctor still runs.
**Where**: `src/cli/commands/doctor.ts`, `tests/unit/cli/commands/doctor.test.ts`, `docs/cli.md`.
**Approach**: Delete `checkCliArtifacts` and its entry in `runAllChecks`. Remove the now-unused `homedir`/`statSync` imports if orphaned. Update `doctor.test.ts`. Update the `cli.md` doctor category table to match reality.
**Depends on**: Nothing.
**Verify**: `pnpm test doctor` green; `engineer doctor` runs and shows no CLI-artifacts category.
**Commit**: `/commit`.

#### Task 1.3: Delete `Output.table()` and remove `"quiet"` mode [estimated: 15m]
**Goal**: No dead output code; `Output` API is what's actually used.
**Where**: `src/cli/output.ts`, `tests/unit/cli/output.test.ts`.
**Approach**: Delete the `table()` method. Remove `"quiet"` from `OutputMode`, the `quiet` branches, and the `--quiet` references in the class JSDoc. Update `output.test.ts`.
**Depends on**: Nothing.
**Verify**: `pnpm test output` green; `grep -rn "quiet\|\.table(" src/cli/` shows no dead references.
**Commit**: `/commit`.

#### Task 1.4: Consolidate `checkRequirementsMet`, fix double scan, privatize `getNumberPaths` [estimated: 15m]
**Goal**: One `checkRequirementsMet`; `start.ts` scans the config dir once; `getNumberPaths` is private.
**Where**: `src/cli/setup/prompts.ts`, `src/cli/setup/setup.ts`, `src/cli/commands/start.ts`, `src/config/loader.ts`.
**Approach**: Make `prompts.ts` import `checkRequirementsMet` from `setup.ts`; delete the duplicate. In `start.ts`, scan once and reuse the result for both `captureEnvVarsToFile` and `discoveredVars`. Remove the `export` on `getNumberPaths` if `knip` allows.
**Depends on**: Nothing.
**Verify**: `pnpm lint` green (knip passes); `pnpm test` green.
**Commit**: `/commit`.

#### Task 1.5: Document config-versioning future consideration [estimated: 10m]
**Goal**: The versioning decision is recorded.
**Where**: `implementation-docs/future-considerations.md`.
**Approach**: Add an entry — current decision is one latest version per plugin/OS, manually updated; revisable future option is explicit config-schema versioning with possible startup version selection.
**Depends on**: Task 1.1.
**Verify**: Entry reads clearly.
**Commit**: `/commit` (may group with 1.1).

### Phase 2 — Getting-Started Path (one session)

#### Task 2.1: Create `scripts/setup.sh` + wire `pnpm run setup` [estimated: 45m]
**Goal**: `pnpm run setup` runs a confirm-then-execute script that installs, builds, and links.
**Where**: `scripts/setup.sh` (new), `package.json`.
**Approach**: Bash script, `set -euo pipefail`. Print the three steps it will run; ask Y/n. On confirm, run `pnpm install` → `pnpm build` → `pnpm link --global`, each with a clear colored section header. Handle every failure path explicitly with an actionable message — especially `pnpm link --global` permission failure (suggest the fix), install failure, build failure. End with "✓ Ready — run `engineer start`". Add `"setup": "bash scripts/setup.sh"` to `package.json`.
**Depends on**: Nothing.
**Verify**: On a clean clone, `pnpm run setup` confirms, runs all three steps, and `engineer` resolves afterward. Manually trigger a failure (e.g., simulate link failure) and confirm the message is clear.
**Commit**: `/commit`.

#### Task 2.2: Rework `reset.sh` [estimated: 30m]
**Goal**: `reset.sh` wipes/builds/links, then runs interactive or seeded start; works cross-platform.
**Where**: `scripts/reset.sh`.
**Approach**: Keep wipe/build/link and `--persist-data`. Replace the hardcoded `PNPM_HOME` with cross-platform resolution (or rely on the user's existing pnpm setup). No argument → `engineer start`; `reset.sh <seed-dir>` → `engineer start --seed <seed-dir>`. Rewrite the header comment to document the new behavior. Apply the same error-handling discipline as `setup.sh`.
**Depends on**: Nothing.
**Verify**: `./scripts/reset.sh` reaches interactive setup; `./scripts/reset.sh seed-example/` reaches seeded setup; header documents both.
**Commit**: `/commit`.

#### Task 2.3: Sanitize `seed-example/` + `.gitignore` pattern [estimated: 20m]
**Goal**: `seed-example/` carries only generic placeholders; personal seeds are gitignored.
**Where**: `seed-example/configs/*.yaml`, `seed-example/plugins/*.yaml`, `.gitignore`.
**Approach**: Replace `cli_path` absolute path with `claude` (PATH default), personal repo with `your-github-username`/`your-repo-name`, `logging.level: debug` with `info`. Keep `${VAR}` refs for secrets. Add `seed-example-*` to `.gitignore`; remove the stale `seed/` line.
**Depends on**: Nothing (verified: no test/CI consumes `seed-example/`).
**Verify**: `git check-ignore seed-example-farzam` ignores it; `git check-ignore seed-example` does NOT; no personal values remain in `seed-example/`.
**Commit**: `/commit`.

#### Task 2.4: Update README + `cli.md` getting-started [estimated: 25m]
**Goal**: Docs describe the real getting-started path.
**Where**: `README.md`, `docs/cli.md`.
**Approach**: README — prerequisites (Node 22+, pnpm), then `git clone` → `pnpm run setup` → `engineer start`. `cli.md` — rewrite "Installing the CLI" for `pnpm run setup`; document `reset.sh` behavior and the seed-directory convention.
**Depends on**: Tasks 2.1-2.3.
**Verify**: A reader following only the README reaches a running daemon.
**Commit**: `/commit`.

### Phase 3 — OS Detection & Setup UX (one session)

#### Task 3.1: `detectOperatingSystem()` pure function + tests [estimated: 25m]
**Goal**: A pure, tested function that classifies the platform.
**Where**: `src/cli/setup/os-detection.ts` (new), `tests/unit/cli/setup/os-detection.test.ts` (new).
**Approach**: Pure function — takes `process.platform` (injectable for tests), returns `{ platform, support: "full" | "preview" | "unsupported", message }`. macOS → full, Linux → preview, else → unsupported. Test all three classifications.
**Depends on**: Nothing.
**Verify**: `pnpm test os-detection` green.
**Commit**: `/commit`.

#### Task 3.2: Wire the OS gate into setup [estimated: 30m]
**Goal**: macOS continues; Linux warns (+ confirms when interactive); Windows blocks.
**Where**: `src/cli/setup/setup.ts`, `src/cli/setup/prompts.ts`, `src/cli/commands/start.ts`.
**Approach**: At the start of first-run setup, classify the OS. `unsupported` → print a clear message, exit gracefully (both interactive and `--seed`). `preview` → print the note; in interactive mode require a confirm, in `--seed` mode proceed. `full` → a one-line "fully supported" note.
**Depends on**: Task 3.1.
**Verify**: Existing E2E tests (`engineer start`) still pass on macOS/Linux. Manually: Linux path shows the confirm; a simulated unsupported platform exits cleanly.
**Commit**: `/commit`.

#### Task 3.3: Detection-summary confirmation + setup messaging polish [estimated: 25m]
**Goal**: The user confirms before plugin selection; messaging is accurate.
**Where**: `src/cli/setup/prompts.ts`, `src/cli/setup/setup.ts`.
**Approach**: After `showDetectionSummary`, add a confirm before plugin selection. Fix the "First run — auto-configuring from environment..." line (it precedes an interactive flow — make it accurate). Review all setup prompts for clarity and isolation.
**Depends on**: Task 3.2.
**Verify**: Walk the interactive setup on a clean clone — each step is clear, the confirm appears.
**Commit**: `/commit`.

#### Task 3.4: Update `future-considerations.md` [estimated: 15m]
**Goal**: OS-agnostic vision consolidated; stale Telegram entries removed.
**Where**: `implementation-docs/future-considerations.md`.
**Approach**: Consolidate the existing "OS-Specific Plugin Selection" entry with the broader OS-agnostic startup/config/setup vision. Remove "Telegram Receive Capability" and "`engineer telegram-setup` CLI Command" — both verified already built.
**Depends on**: Nothing.
**Verify**: No stale Telegram entries remain; OS section is coherent.
**Commit**: `/commit` (may group with 3.3).

### Phase 4 — CLI Restructure: Screaming Architecture (one session)

#### Task 4.1: Agree the target `src/cli/` structure [estimated: 20m]
**Goal**: A target directory layout, signed off by the owner.
**Where**: Design activity — no code yet.
**Approach**: Propose the regrouped `src/cli/` layout (start-related files under `commands/start/`, terminal output grouped, bundled config-template content grouped, primitives at the top). Walk it with the owner; settle the exact directory names and groupings. The Phase-2/3 sketch is the starting point, not the final word.
**Depends on**: Phases 1-3 complete.
**Verify**: Owner confirms the layout.
**Commit**: No commit — design step.

#### Task 4.2: Extract start.ts signal-handling into its own unit [estimated: 30m]
**Goal**: The APE-proof shutdown logic lives in its own file, born in its right place.
**Where**: `src/cli/commands/start.ts`, new `src/cli/commands/start/shutdown.ts` (per the agreed structure).
**Approach**: Extract the ~60-line signal-handling block into a focused unit with a clear interface (takes daemon + cleanup callbacks, registers handlers). `start.ts` calls it.
**Depends on**: Task 4.1.
**Verify**: `pnpm build` green; manually: Ctrl+C once → graceful, twice → hard exit.
**Commit**: `/commit`.

#### Task 4.3: Move and regroup files per the agreed structure [estimated: 40m]
**Goal**: `src/cli/` matches the agreed layout; the tree reveals intent.
**Where**: `src/cli/` (all files), every importer across `src/` and `tests/`.
**Approach**: Move/rename files into the agreed directories. Update every import path. Update test file locations to mirror (`tests/` mirrors `src/`). Run `madge` to confirm no circular dependencies were introduced.
**Depends on**: Task 4.1, Task 4.2.
**Verify**: `pnpm build && pnpm lint && pnpm test` green; `pnpm run check:circular` clean; the tree visibly reveals intent.
**Commit**: `/commit`.

#### Task 4.4: Add the "Structure Reveals Intent" coding standard [estimated: 10m]
**Goal**: The Screaming Architecture principle is codified.
**Where**: `docs/coding-standards.md`.
**Approach**: Extend the structure sections with a standard — directory grouping and file names must make purpose obvious without opening the file.
**Depends on**: Task 4.3.
**Verify**: Standard reads clearly and matches the restructured tree.
**Commit**: `/commit` (may group with 4.3).

### Phase 5 — Coding Standards Audit (one session)

#### Task 5.1: Coding-standards audit of all in-scope TS files [estimated: 60m]
**Goal**: Every in-scope file conforms to `docs/coding-standards.md`.
**Where**: All restructured `src/cli/`, `src/config/`, `src/plugins/loader.ts`, `src/plugins/builtin.ts` files.
**Approach**: File by file — newspaper order, `function` declarations, return-type annotations, JSDoc on exports, guard clauses, separate `import type`. Fix `index.ts` `console.error` → `process.stderr.write` consistency. Fix inline type imports in `cli/index.ts` and `start.ts`.
**Depends on**: Phases 1-4 complete (audits the final, restructured shape).
**Verify**: `pnpm lint` green; manual read confirms newspaper order and JSDoc coverage.
**Commit**: `/commit` (group logically — e.g., per directory).

#### Task 5.2: Rename abbreviations [estimated: 20m]
**Goal**: No abbreviated identifiers in in-scope files.
**Where**: `output.ts` (`clr`→`colorize`), `doctor.ts` (`wsRoot`→`workspaceRoot`), `progress.ts` (`msg`), others found during 5.1.
**Approach**: Rename; update all references and tests.
**Depends on**: Task 5.1.
**Verify**: `pnpm test` green; `pnpm lint` green.
**Commit**: `/commit`.

#### Task 5.3: Fix doctor.ts orphaned JSDoc + stale numbering [estimated: 15m]
**Goal**: `doctor.ts` JSDoc and category numbering are correct.
**Where**: `doctor.ts`.
**Approach**: Reattach the orphaned `runAllChecks` JSDoc; correct or remove the stale "Category N" numbering comments.
**Depends on**: Task 5.1.
**Verify**: Manual read; `pnpm lint` green.
**Commit**: `/commit` (may group with 5.1).

#### Task 5.4: CLI version from package.json + "Single Source of Truth" standard [estimated: 20m]
**Goal**: One version source; the principle is codified.
**Where**: `src/cli/index.ts`, `docs/coding-standards.md`.
**Approach**: CLI reads `version` from `package.json` (import with a JSON attribute, or read at runtime); remove the hardcoded `VERSION`. Verify the build output resolves `package.json` correctly. Add a "Single Source of Truth" standard to `coding-standards.md`.
**Depends on**: Task 5.1.
**Verify**: `engineer --version` prints the `package.json` version after `pnpm build`.
**Commit**: `/commit`.

#### Task 5.5: Fix stale docs [estimated: 15m]
**Goal**: No doc references a non-existent command or flag.
**Where**: `docs/configuration/README.md`, `docs/plugins/trigger/github-trigger.md`.
**Approach**: Remove the "First Run: `engineer init`" section from `configuration/README.md`; fix `--config` → `--config-dir`. Remove the `engineer init` reference in `github-trigger.md`.
**Depends on**: Nothing.
**Verify**: `grep -rn "engineer init\|--config\b" docs/` returns nothing stale.
**Commit**: `/commit`.

#### Task 5.6: Final green sweep [estimated: 15m]
**Goal**: Whole slice ends green.
**Where**: Repo-wide.
**Approach**: `pnpm build && pnpm lint && pnpm test:all`. Fix any straggler.
**Depends on**: All prior tasks.
**Verify**: All three commands exit 0.
**Commit**: `/commit` if anything changed.

## Verification Contract

| Check | Type | Command or Observation |
|-------|------|------------------------|
| Types compile | Auto | `pnpm typecheck` |
| Lint clean | Auto | `pnpm lint` (biome + tsc + knip + madge) |
| No circular deps after restructure | Auto | `pnpm run check:circular` (Phase 4) |
| Unit tests pass | Auto | `pnpm test` |
| All tiers pass | Auto | `pnpm test:all` (end of Phase 5) |
| Build succeeds | Auto | `pnpm build` |
| Clean-clone setup works | Manual | `pnpm run setup` on a fresh clone → `engineer` resolves |
| Getting-started works | Manual | Follow README only → running daemon (Phase 2) |
| Interactive setup is clear | Manual | Walk first-run setup on a clean clone (Phase 3) |
| OS gate doesn't regress E2E | Auto | `pnpm test:e2e` after Phase 3 |
| Failure paths are graceful | Manual | Trigger setup.sh / reset.sh / start failures → clear actionable messages |

## Risks

| Risk | If It Happens | Mitigation |
|------|---------------|------------|
| `pnpm link --global` fails on a new user's machine (permissions) | New user stuck at the first command | `setup.sh` catches it and prints the actionable fix; documented in README |
| OS gate regresses E2E tests that run `engineer start` | CI/test breakage | Phase 3 verification runs `pnpm test:e2e`; gate passes through on macOS/Linux |
| Removing config-version `version` field breaks a consumer | Type or runtime error | Verified zero consumers before planning; Task 1.1 re-greps |
| `seed-example/` sanitization breaks a hidden consumer | Seeded setup fails | Verified no test/CI consumer; `reset.sh` reference is reworked in the same slice |
| CLI reading `package.json` fails post-build (path resolution) | `engineer --version` breaks | Task 4.5 verifies against the built `dist/` output, not just source |
| `reset.sh` behavior change surprises the primary user | Confusion, lost muscle memory | New behavior documented in the script header; called out explicitly |
| CLI restructure breaks imports or introduces a circular dependency | Build failure | Task 4.3 runs `pnpm build`, `pnpm lint`, and `pnpm run check:circular`; restructure is its own phase so breakage is isolated and easy to bisect |

## Panel Review

**Panelists**: Torvalds, Pike, Hipp, Technical Architect (conducted directly — the project philosophy and the owner's "no sub-agents" preference both favor a single agent with full context over delegated subagents).

**Incorporated**:
- Pre-flight verification that `ConfigBundle.version` has zero consumers — done, confirmed dead (D5, Task 1.1).
- Pre-flight verification that `seed-example/` has no test/CI consumer — done, confirmed safe (D3, Task 2.3).
- `setup.sh` hardened: `set -euo pipefail` + explicit failure handling, especially `pnpm link` permissions (D2, Task 2.1).
- "Manually verified on a clean clone" added to the verification contract (Phases 2, 3).
- `reset.sh` task explicitly preserves wipe/build/link and documents the new behavior in the header (D4, Task 2.2).
- Phase 3 verification explicitly runs `pnpm test:e2e` to confirm the OS gate doesn't regress E2E.
- Cross-cutting "nice error handling across all user flows" elevated to a decision (D10).

**Declined**:
- Pike's "a little copying is better than a little dependency" on `checkRequirementsMet` — declined because both copies live within `src/cli/setup/`; this is within-module de-duplication, not a cross-boundary dependency. Kept the consolidation (Task 1.4).
- `agent.md` / `AGENT-README.md` consolidation — moot: the owner confirmed there is no `agent.md`; it was already consolidated into `AGENT-README.md`.

**Added post-panel (owner direction)**:
- D11 — the CLI directory restructure (Screaming Architecture) was added by the owner after the panel review. It was not panel-stress-tested, but it is low-risk: a mechanical file reorganization, isolated in its own phase (Phase 4), gated by `pnpm build` + `pnpm lint` + `pnpm run check:circular`.

## References
- Requirements: `implementation-docs/9-oss-ready/slices/04-startup.md`
- Research: `.claude/temp/research/slice-04-startup.md`
- Methodology: `implementation-docs/9-oss-ready/approach.md`
