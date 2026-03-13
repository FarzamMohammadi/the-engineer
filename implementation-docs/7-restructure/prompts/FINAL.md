# Phase: FINAL — End-to-End Verification

**Wave 6 (Sequential)** — Runs after REVIEW is complete. This is the last step of Layer 7.
**Branch:** Work directly on `main`.
**Scope:** Holistic verification that the entire system works together after all restructuring.

---

## Context

The Engineer is an autonomous software engineering agent. Layer 7 has restructured the entire codebase (R0-R10) and passed a deep review (REVIEW phase). This is the final gate before Layer 7 is declared complete.

This phase does NOT look for code-level bugs (that was REVIEW). This phase verifies the system works as a whole — that all the decomposed pieces compose correctly, that the project builds and runs, that documentation is coherent, and that the codebase is ready for the next layer of work.

**Read these first:**
1. `docs/persona.md` — identity
2. `docs/philosophy.md` — beliefs
3. `implementation-docs/7-restructure/phase-plan.md` — all phases
4. `implementation-docs/7-restructure/review-findings.md` — what REVIEW found and fixed
5. `implementation-docs/active.md` — current state

---

## The 11 Verification Items

### 1. Full Build Chain

Verify the complete build pipeline works from a clean state:

```bash
rm -rf node_modules
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

All must pass. This catches any dependency issues, missing files, or build configuration problems introduced during restructuring.

### 2. Test Count Accounting

Document the final test count and compare with the pre-Layer-7 baseline (1,733 tests from Layer 6):

```bash
pnpm test 2>&1 | tail -5
```

The count should be >= 1,733. If it's lower, investigate why tests were removed. If it's significantly higher, note what was added.

Break down by tier:
- Unit tests (count)
- Integration tests (count)
- E2E tests (count)

### 3. CLI Smoke Test

Verify all 8 CLI commands work (or show helpful errors when expected):

```bash
# These should work
node src/index.ts --help
node src/index.ts --version
node src/index.ts doctor --home /tmp/engineer-test
node src/index.ts init --home /tmp/engineer-test
node src/index.ts config validate --home /tmp/engineer-test
node src/index.ts status --home /tmp/engineer-test
node src/index.ts logs --home /tmp/engineer-test --lines 1

# These need a running daemon (should fail gracefully)
node src/index.ts stop --home /tmp/engineer-test
```

Clean up: `rm -rf /tmp/engineer-test`

### 4. Import Graph Integrity (Final)

Run the three-tier boundary enforcement test:

```bash
pnpm test -- test/boundary/tier-import-rules.test.ts
```

Must pass. This is the architectural invariant — Core/Adapter/Plugin tiers must not violate import rules.

### 5. Contract Suite Compliance (Final)

Run all 5 adapter contract suites:

```bash
pnpm test -- contract
```

All fake plugins must still pass their contract suites. This verifies that adapter base class changes in Layer 7 didn't break the contract.

### 6. Integration Tests (Final)

Run all integration tests:

```bash
pnpm test -- test/integration/
```

These test real component interactions. If any fail, it means the decomposition broke a cross-component flow.

### 7. E2E Tests (Final)

Run all E2E tests:

```bash
pnpm test -- test/e2e/
```

These test the system end-to-end (daemon lifecycle, task happy path, crash recovery). Must pass.

### 8. Documentation Coherence

Verify that the documentation set is internally consistent:

- `README.md` — still accurate for the restructured codebase
- `docs/architecture.md` — component names, relationships, and diagrams match reality
- `docs/plugin-development.md` — references to adapter classes, method names, and file paths are correct
- `CONTRIBUTING.md` — all commands work, project structure section is accurate
- `implementation-docs/active.md` — status reflects Layer 7 completion

### 9. Decision Log Completeness

Verify that all decisions made during Layer 7 are documented:

```bash
cat implementation-docs/7-restructure/decisions.md
```

Every architectural decision from R0-R10 should be recorded with a number (D166+), rationale, and reference to the phase that made it. If decisions were made during the phases but not recorded, add them now.

### 10. Phase Plan Final Status

Update `implementation-docs/7-restructure/phase-plan.md` — every phase should show DONE:

| Phase | Status |
|-------|--------|
| R0 | DONE |
| R1 | DONE |
| R2a | DONE |
| R2b | DONE |
| R2c | DONE |
| R3 | DONE |
| R4 | DONE |
| R5 | DONE |
| R6 | DONE |
| R7 | DONE |
| R8 | DONE |
| R9 | DONE |
| R10 | DONE |
| REVIEW | DONE |
| FINAL | DONE |

### 11. active.md Update

Update `implementation-docs/active.md` to reflect Layer 7 completion:

- Add Layer 7 completion summary under the status section
- Update the "Current Focus" section to point to whatever comes next (Layer 6.10 War Room v2, or other deferred work)
- Include final test count, decision count, and a brief summary of what Layer 7 accomplished

---

## Session Log

Create `implementation-docs/sessions/NNN.md` (use the next available session number) documenting:

- Session purpose: Layer 7 FINAL verification
- Pre-state: Layer 7 phases R0-R10 + REVIEW complete
- Post-state: Layer 7 complete
- Final test count
- Final decision count (D166+)
- Summary of what Layer 7 accomplished (1-2 paragraphs)
- Any deferred items

---

## Memory Update

Update the MEMORY.md file (if the project uses one) to reflect:

- Layer 7: DONE
- Final test count
- Final decision range
- Next focus area

---

## Final Commit

```bash
git add -A
git commit -m "Layer 7 complete: Structural Restructuring

Final verification passed. All phases R0-R10 + REVIEW done.
Tests: [count]. Decisions: D166-D[last].

Session [NNN]."
```

---

## Definition of Done

Layer 7 is complete when ALL of the following are true:

- [ ] Clean build from scratch passes (install + typecheck + lint + test)
- [ ] Test count >= 1,733 (pre-Layer-7 baseline)
- [ ] All 8 CLI commands work or fail gracefully
- [ ] Three-tier import rules pass
- [ ] All 5 contract suites pass
- [ ] All integration tests pass
- [ ] All E2E tests pass
- [ ] Documentation is accurate and internally consistent
- [ ] All decisions are logged
- [ ] Phase plan shows all phases DONE
- [ ] active.md is updated
- [ ] Session log is created
