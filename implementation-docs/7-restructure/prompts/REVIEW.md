# Phase: REVIEW — Deep Audit + Security Verification

**Wave 5 (Sequential)** — Runs after all Wave 4 merges are complete.
**Branch:** Work directly on `main` (no separate branch — fixes are committed directly).
**Scope:** Full codebase audit. Find bugs, security issues, inconsistencies, dead code, missing tests.

---

## Context

The Engineer is an autonomous software engineering agent. Layer 7 has restructured the entire codebase across Waves 1-4 (phases R0 through R10). Every core component has been decomposed, interfaces extracted, security hardened, CLI polished, OSS files added, and data lifecycle managed.

This is the quality gate. Nothing ships to the world without passing this review. Every change from Layer 7 is now on `main`. Your job is to find everything that's wrong, inconsistent, or missing — and fix it.

**Philosophy:** Read `docs/philosophy.md` — especially "Post-Completion Rigor." The work isn't done when the code compiles.

**Persona:** Read `docs/persona.md` — This is the engineer who "runs analysis on their own work" and "refactors for clarity and quality."

---

## Pre-Work: Read These Files

1. `docs/persona.md` — identity standard
2. `docs/philosophy.md` — rigor standard
3. `implementation-docs/7-restructure/assessment.md` — what Layer 7 was supposed to fix
4. `implementation-docs/7-restructure/phase-plan.md` — all phases and their status
5. `implementation-docs/7-restructure/decisions.md` — decisions made during Layer 7

---

## The 11 Verification Steps

### 1. Interface Compliance Audit

Verify that every Core component implements its interface correctly:

- For each interface defined in R0, find its implementation
- Verify all methods are present with correct signatures
- Verify return types match
- Check that no component uses a concrete class where an interface is expected (grep for class imports in Core components — they should import interfaces)
- Check dependency injection: constructors should accept interfaces, not classes

```bash
# Find all interface definitions
grep -rn "export interface I" src/core/

# Find all class declarations and their implements clauses
grep -rn "class .* implements" src/core/

# Find concrete class imports in Core (potential violations)
grep -rn "import.*from.*index" src/core/ | grep -v "interface\|type\|Schema"
```

### 2. Event Topology Verification

If R5 added declarative event topology:

- Verify every `eventBus.subscribe()` call goes through the topology declaration
- Verify no stray `subscribe()` calls remain outside the topology
- Verify all events in `src/schemas/events.ts` are represented in the topology
- Verify subscriber registrations match the topology file

```bash
# Find all subscribe calls
grep -rn "\.subscribe(" src/

# Find all publish calls and verify they use declared event types
grep -rn "\.publish(" src/
```

### 3. Security Hardening Verification

Verify all security fixes from R8:

- **Command injection:** BashTool blocks dangerous patterns (`;`, `&&`, `||`, backticks, `$(...)` when in restricted mode)
- **Workspace escape:** symlink detection with `realpath` canonicalization in WorkspaceManager and BashTool
- **Secret sanitization:** `sanitizeSecrets()` is called at all LLM context chokepoints (verify the 3 chokepoints from Phase 6.5)
- **GIT_* env:** Only specific GIT_ variables are passed, not wildcards
- **Input validation:** Safety scope parameters are validated

```bash
# Check sanitization chokepoints
grep -rn "sanitizeSecrets" src/

# Check env passthrough in BashTool
grep -rn "GIT_" src/plugins/tool/bash-tool/

# Check realpath/canonicalization
grep -rn "realpath\|resolve(" src/core/workspace-manager/ src/plugins/tool/bash-tool/
```

### 4. Dead Code Detection

Find and remove dead code:

- Unused exports (functions, types, constants exported but never imported)
- Unused imports
- Unreachable code paths
- Commented-out code blocks (unless they're intentional TODO markers)
- Test helpers that no test uses

```bash
# Biome should catch unused imports
pnpm lint

# Manual check for unused exports
# Look for exports that only appear once in the codebase (their definition)
```

### 5. Test Coverage Gaps

Identify untested or under-tested code:

- Every new module from Layer 7 must have tests
- Every decomposed sub-module must have its own test file
- Contract suites must still pass for all 5 adapter types
- Integration tests must cover the new component boundaries
- Edge cases: empty inputs, invalid configs, concurrent access

```bash
# Run all tests with coverage
pnpm test -- --coverage

# Check that every src/ module has a corresponding test
# (manual inspection of src/ vs test/ structure)
```

### 6. Import Graph Integrity

Verify the three-tier import rules still hold:

- Plugins never import Core directly (only through adapters)
- Adapters never import Plugins
- Core never imports Plugins or Adapters
- No circular dependencies

```bash
# Run the boundary test
pnpm test -- test/boundary/tier-import-rules.test.ts

# Manual check for circular imports
# Look for import cycles between core/ components
```

### 7. Config Schema Completeness

Verify all new config added in Layer 7 is:

- Defined in Zod schemas with proper defaults
- Documented (at minimum, JSDoc comments on the schema)
- Hot-reloadable where specified
- Validated during `engineer doctor`
- Present in template configs from `engineer init`

### 8. Error Handling Consistency

Verify error handling follows the project's patterns:

- Tagged errors (if introduced in R0) are used consistently
- No bare `throw new Error("string")` in new code (use typed error classes)
- Adapter errors use `createAdapterError()`
- All async operations have proper error boundaries
- No swallowed errors (catch blocks that do nothing)

```bash
# Find bare Error throws in new/modified files
grep -rn "throw new Error(" src/core/

# Find empty catch blocks
grep -rn "catch.*{" src/ -A1 | grep -B1 "^.*}$"
```

### 9. Documentation Accuracy

Verify all documentation from R9:

- `CONTRIBUTING.md` — all commands work, all paths are valid
- `docs/architecture.md` — Mermaid diagrams are accurate, component descriptions match reality
- `docs/plugin-development.md` — code examples compile, method signatures match actual source
- `CHANGELOG.md` — format is correct
- Issue/PR templates — render correctly on GitHub

### 10. Performance Verification

Verify R10 data lifecycle:

- Retention cleanup actually deletes old data
- Database PRAGMAs are applied
- Subscriber timeout guard works
- No performance regressions in EventBus publish speed

### 11. Regression Check

Run the full test suite multiple times to catch flaky tests:

```bash
pnpm test
pnpm test
pnpm test
```

All three runs must pass with the same test count. If any test is flaky, fix it.

---

## What to Fix

For each issue found:

1. **Document it** — Note the file, line, issue, and severity
2. **Fix it** — Make the correction directly
3. **Test it** — Ensure the fix doesn't break anything
4. **Commit it** — Small, focused commits with descriptive messages

Group fixes into logical commits:
- `review: Fix interface compliance issues in X, Y, Z`
- `review: Remove dead code from A, B, C`
- `review: Add missing tests for D, E, F`
- `review: Fix security gap in G`
- `review: Update docs accuracy in H`

---

## Verification

After all fixes:

```bash
pnpm test          # All tests pass
pnpm lint          # 0 errors, 0 warnings
pnpm typecheck     # 0 errors
```

Count total tests — should be >= the pre-review count (fixes may add tests, never remove them unless removing truly invalid tests).

---

## Output

Create a review summary at `implementation-docs/7-restructure/review-findings.md` with:

- Total issues found (by severity: critical, high, medium, low)
- Total issues fixed
- Any issues deferred (with justification)
- Final test count
- Final lint/typecheck status

Update `implementation-docs/7-restructure/phase-plan.md` — mark REVIEW as DONE.
