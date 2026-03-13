# Merge Prompt: Wave 2

**Purpose:** Merge all 6 Wave 2 branches back into `main`.

Wave 2 branches were developed in parallel from the same `main` base (post-R0). They modify different parts of the codebase, but conflicts are possible where multiple phases touch shared files (schemas, barrel exports, test helpers).

---

## Context

The Engineer is an autonomous software engineering agent. Layer 7 is a structural restructuring. Wave 1 (R0 — Interface Foundation) was merged to `main` first. Wave 2 has 6 parallel branches that all branched from the post-R0 main.

**Read these before starting:**
1. `implementation-docs/7-restructure/phase-plan.md` — wave structure and phase descriptions
2. `implementation-docs/7-restructure/assessment.md` — what Layer 7 is fixing

---

## Branches to Merge

Merge in this order (least likely to conflict first):

1. `layer7/R1` — Safety Layer split (CostTracker + PolicyEngine)
2. `layer7/R2a` — TaskEngine decomposition
3. `layer7/R2b` — SessionMemory decomposition
4. `layer7/R2c` — Registry decomposition
5. `layer7/R3` — Daemon decomposition (6 subsystems)
6. `layer7/R4` — Orchestrator decomposition (5 subsystems)

---

## Merge Procedure

### Step 0: Ensure clean state

```bash
git checkout main
git status  # Must be clean
git pull origin main  # Get latest (post-R0)
```

### Step 1: Merge each branch sequentially

For each branch in order:

```bash
# Merge the branch
git merge layer7/R1 --no-ff -m "Merge layer7/R1: Safety Layer split (CostTracker + PolicyEngine)"

# Run tests immediately after merge
pnpm test

# If tests fail, investigate and fix before proceeding
# If merge conflicts occur, resolve them (see conflict resolution below)

# Verify lint and typecheck
pnpm lint
pnpm typecheck
```

Repeat for R2a, R2b, R2c, R3, R4.

### Step 2: After all merges, full verification

```bash
pnpm test          # All tests must pass
pnpm lint          # Zero errors, zero warnings
pnpm typecheck     # Zero errors
```

---

## Conflict Resolution Guidelines

### Likely conflict zones

1. **`src/schemas/` barrel exports (`index.ts`)** — Multiple phases may add new schema exports. Resolution: include all exports from all branches.

2. **`src/core/` barrel exports** — New modules may both add to the same barrel. Resolution: include all.

3. **`src/schemas/config.ts`** — Multiple phases may add config schema fields. Resolution: merge all new fields.

4. **`src/schemas/events.ts`** — Multiple phases may add event types. Resolution: include all new events.

5. **`test/helpers/mock-factories.ts`** — Multiple phases may add or modify factories. Resolution: include all.

6. **`test/helpers/integration-context.ts`** — Component wiring may change. Resolution: wire all decomposed components.

7. **`src/cli/bootstrap.ts`** — Component instantiation order may change. Resolution: update to use all decomposed components.

### Resolution principles

- **When in doubt, include both.** If two branches add different exports/imports, include all of them.
- **Barrel files:** Combine all exports. Order alphabetically.
- **Schema files:** Merge all new fields/types. Ensure no duplicate names.
- **Test files:** If two branches modify the same test file, ensure both sets of changes are present.
- **Import paths:** After decomposition, imports may change. Ensure all import paths are valid post-merge.

### If a merge is genuinely irreconcilable

Stop. Document what conflicts exist and why they can't be auto-resolved. This indicates a design issue in the wave planning that needs human judgment.

---

## Post-Merge Verification Checklist

- [ ] All 6 branches merged to main
- [ ] `pnpm test` — all tests pass (count should be >= pre-merge count)
- [ ] `pnpm lint` — 0 errors, 0 warnings
- [ ] `pnpm typecheck` — 0 errors
- [ ] `git log --oneline -10` — shows 6 merge commits
- [ ] No leftover merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in any file
- [ ] All new modules are importable (no broken barrel exports)
- [ ] `test/boundary/tier-import-rules.test.ts` passes (three-tier enforcement still valid)

---

## Rollback Plan

If a merge creates unsolvable issues:

```bash
# Find the commit before merges started
git reflog

# Reset to that point
git reset --hard <commit-before-merges>
```

Then investigate what went wrong in the conflicting branches before retrying.

---

## Final Step

After all merges pass verification:

```bash
git log --oneline -20  # Document the merge history
```

Update `implementation-docs/7-restructure/phase-plan.md` — mark all Wave 2 phases as MERGED.
