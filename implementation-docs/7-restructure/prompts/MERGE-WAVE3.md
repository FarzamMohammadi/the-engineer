# Merge Prompt: Wave 3

**Purpose:** Merge all 4 Wave 3 branches back into `main`.

Wave 3 branches were developed in parallel from the post-Wave-2 `main`. They build on the decomposed components from Wave 2.

---

## Context

The Engineer is an autonomous software engineering agent. Layer 7 is a structural restructuring across 6 waves. Waves 1-2 are complete and merged. Wave 3 has 4 parallel branches that all branched from the post-Wave-2 main.

**Read these before starting:**
1. `implementation-docs/7-restructure/phase-plan.md` — wave structure and phase descriptions
2. `implementation-docs/7-restructure/assessment.md` — what Layer 7 is fixing

---

## Branches to Merge

Merge in this order:

1. `layer7/R5` — Declarative Event Topology
2. `layer7/R6` — Plugin Discovery + Scaffolding + Hooks
3. `layer7/R7` — CLI Polish
4. `layer7/R8` — Security Hardening

---

## Merge Procedure

### Step 0: Ensure clean state

```bash
git checkout main
git status  # Must be clean
git pull origin main  # Get latest (post-Wave-2)
```

### Step 1: Merge each branch sequentially

For each branch in order:

```bash
# Merge the branch
git merge layer7/R5 --no-ff -m "Merge layer7/R5: Declarative Event Topology"

# Run tests immediately after merge
pnpm test

# If tests fail, investigate and fix before proceeding
# If merge conflicts occur, resolve them (see conflict resolution below)

# Verify lint and typecheck
pnpm lint
pnpm typecheck
```

Repeat for R6, R7, R8.

### Step 2: After all merges, full verification

```bash
pnpm test          # All tests must pass
pnpm lint          # Zero errors, zero warnings
pnpm typecheck     # Zero errors
```

---

## Conflict Resolution Guidelines

### Likely conflict zones

1. **Event Bus (`src/core/event-bus/`)** — R5 (declarative topology) changes how subscriptions are wired. R8 (security) may add validation. Resolution: topology declaration is the source of truth; security validation layers on top.

2. **Registry (`src/core/registry/`)** — R6 (plugin discovery/scaffolding) modifies how plugins are found and loaded. If Registry was decomposed in Wave 2, R6 builds on that decomposition. Resolution: ensure R6's changes work with the decomposed Registry.

3. **CLI (`src/cli/`)** — R7 (CLI polish) may conflict with R6 (new `create-plugin` command) or R8 (security-related CLI changes). Resolution: include all new commands, ensure no name collisions.

4. **Barrel exports (`index.ts` files)** — Multiple phases may add exports. Resolution: include all, alphabetize.

5. **Config schemas (`src/schemas/config.ts`)** — R5 may add topology config, R6 may add plugin discovery config, R8 may add security config. Resolution: merge all fields.

6. **`src/cli/bootstrap.ts`** — Component wiring changes from R5 (topology) and R6 (discovery). Resolution: wire both.

7. **BashTool (`src/plugins/tool/bash-tool/`)** — R8 (security hardening) adds command injection protection. Should not conflict with other phases but verify.

### Resolution principles

- **Same as Wave 2:** When in doubt, include both. Barrel files combine all exports. Schema files merge all fields.
- **Event topology takes precedence** for how subscriptions are registered — R5 defines the declarative model, other phases should use it.
- **Security additions are additive** — R8 adds guards and validation; these should layer on top of other changes, not replace them.

### If a merge is genuinely irreconcilable

Stop. Document what conflicts exist and why they can't be auto-resolved. This indicates a design issue that needs human judgment.

---

## Post-Merge Verification Checklist

- [ ] All 4 branches merged to main
- [ ] `pnpm test` — all tests pass (count should be >= pre-merge count)
- [ ] `pnpm lint` — 0 errors, 0 warnings
- [ ] `pnpm typecheck` — 0 errors
- [ ] `git log --oneline -10` — shows 4 merge commits
- [ ] No leftover merge conflict markers in any file
- [ ] All new modules are importable
- [ ] `test/boundary/tier-import-rules.test.ts` passes
- [ ] Event topology declaration file exists and is used (from R5)
- [ ] `engineer create-plugin` command works (from R6, if applicable)
- [ ] CLI has colors/formatting improvements (from R7)
- [ ] Security hardening tests pass (from R8)

---

## Rollback Plan

If a merge creates unsolvable issues:

```bash
git reflog
git reset --hard <commit-before-wave3-merges>
```

Investigate conflicting branches before retrying.

---

## Final Step

After all merges pass verification:

```bash
git log --oneline -20  # Document the merge history
```

Update `implementation-docs/7-restructure/phase-plan.md` — mark all Wave 3 phases as MERGED.
