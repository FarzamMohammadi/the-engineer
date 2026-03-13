# Merge Prompt: Wave 4

**Purpose:** Merge both Wave 4 branches back into `main`.

Wave 4 has 2 branches developed in parallel from the post-Wave-3 `main`. R9 is docs-only (no src/ changes). R10 adds data lifecycle to src/. They should not conflict.

---

## Context

The Engineer is an autonomous software engineering agent. Layer 7 is a structural restructuring across 6 waves. Waves 1-3 are complete and merged. Wave 4 has 2 parallel branches from the post-Wave-3 main.

**Read these before starting:**
1. `implementation-docs/7-restructure/phase-plan.md` — wave structure and phase descriptions

---

## Branches to Merge

Merge in this order:

1. `layer7/R9` — OSS Foundation (root-level files and docs/ only, no src/)
2. `layer7/R10` — Data Lifecycle + Performance (src/ changes)

---

## Merge Procedure

### Step 0: Ensure clean state

```bash
git checkout main
git status  # Must be clean
git pull origin main  # Get latest (post-Wave-3)
```

### Step 1: Merge each branch

```bash
# Merge R9 (docs only — should be conflict-free)
git merge layer7/R9 --no-ff -m "Merge layer7/R9: OSS Foundation"
pnpm test
pnpm lint
pnpm typecheck

# Merge R10 (data lifecycle)
git merge layer7/R10 --no-ff -m "Merge layer7/R10: Data Lifecycle + Performance"
pnpm test
pnpm lint
pnpm typecheck
```

### Step 2: Full verification

```bash
pnpm test          # All tests must pass
pnpm lint          # Zero errors, zero warnings
pnpm typecheck     # Zero errors
```

---

## Conflict Resolution Guidelines

### Expected: No conflicts

R9 touches only root-level files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.github/` templates, `docs/architecture.md`, `docs/plugin-development.md`). R10 touches `src/` (event bus, database, config schemas, new lifecycle manager). These are completely disjoint.

### Possible conflict zones (unlikely)

1. **`package.json`** — If R9 somehow modifies package.json (it shouldn't), and R10 adds dependencies. Resolution: include both changes.

2. **`docs/` files** — R9 creates `docs/architecture.md` and `docs/plugin-development.md`. R10 should not touch docs. No conflict expected.

3. **Config schemas** — R10 adds retention/database config. R9 doesn't touch schemas. No conflict expected.

### If conflicts do occur

Same principles as Waves 2-3: include both changes, alphabetize barrel exports, merge all schema fields.

---

## Post-Merge Verification Checklist

- [ ] Both branches merged to main
- [ ] `pnpm test` — all tests pass
- [ ] `pnpm lint` — 0 errors, 0 warnings
- [ ] `pnpm typecheck` — 0 errors
- [ ] `git log --oneline -5` — shows 2 merge commits
- [ ] No merge conflict markers in any file
- [ ] OSS files exist: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/architecture.md`, `docs/plugin-development.md`
- [ ] Data lifecycle manager exists and has tests
- [ ] Event retention cleanup works (verified by R10 tests)
- [ ] Database tuning PRAGMAs are applied

---

## Rollback Plan

```bash
git reflog
git reset --hard <commit-before-wave4-merges>
```

---

## Final Step

```bash
git log --oneline -10  # Document the merge history
```

Update `implementation-docs/7-restructure/phase-plan.md` — mark all Wave 4 phases as MERGED.
