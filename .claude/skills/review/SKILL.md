---
name: review
description: >-
  Conducts post-implementation review covering test coverage, lint, type checks, test fixes,
  and local testing preparation. Runs all automated verification, identifies gaps, fixes issues,
  and presents a testing checklist so the user can verify the work manually. Use this skill after
  implementation and commits are done — as the final quality gate before creating an MR. Also use
  when the user says "review this", "check my work", "run the checks", "verify everything",
  "is this ready", or "final review". Pairs with /commit (before) and /glab-mr-manager (after).
allowed-tools: Read, Bash, Edit, Write, Agent
argument-hint: "[branch-name or 'current']"
---

# Review

You are the final quality gate. Implementation is done, commits are made. Your job is to verify
everything works, catch what was missed, and prepare the user for manual testing and MR creation.

This is not a code review for style or architecture — that happened during planning and expert
panel. This is about correctness: do the tests pass, is coverage adequate, are there real bugs
hiding in the diff, and can the user test it locally.

## Process

### Phase 1: Scope the Changes

Identify everything that changed:

```bash
git diff --name-only main...HEAD
```

Read the commit log to understand the narrative:

```bash
git log --oneline main...HEAD
```

Categorize the changes:
- **Implementation files**: New or modified source code
- **Test files**: New or modified tests
- **Configuration**: Environment, deployment, infrastructure changes
- **Documentation**: READMEs, comments, API docs

### Phase 2: Automated Verification

Run all automated checks. Execute each and capture the output:

1. **Type checking** — Run the project's type checker (tsc, mypy, etc.)
2. **Linting** — Run the project's linter (eslint, ruff, etc.)
3. **Unit tests** — Run the full test suite
4. **Build** — Verify the project builds cleanly

If any check fails:
- Read the error output carefully
- Fix the issue
- Re-run to confirm the fix
- Commit the fix using `/commit`

Report results:

> **Automated Verification:**
> - Type check: [PASS/FAIL — details if failed]
> - Lint: [PASS/FAIL — details if failed]
> - Tests: [PASS/FAIL — X passed, Y failed, Z skipped]
> - Build: [PASS/FAIL — details if failed]

### Phase 3: Test Coverage Analysis

For each implementation file that changed, check if adequate tests exist:

- Read the implementation file and identify key behaviors, branches, and edge cases
- Read the corresponding test file (if it exists)
- Identify gaps: untested paths, missing edge cases, happy-path-only coverage

Present findings:

> **Test Coverage:**
> - `[file1.ts]`: [Covered / Gaps — what's missing]
> - `[file2.ts]`: [Covered / Gaps — what's missing]
> - `[file3.ts]`: [No tests — needs: X, Y, Z]

If there are significant gaps, offer to write the missing tests. Write them, run them, and
commit with `/commit`.

### Phase 4: Bug Verification

Run `/review-pr` against the branch to hunt for real bugs in the diff. This is a separate pass
from coverage analysis — it reads full files (not just diffs) and looks for:

- **Race conditions and concurrency issues**
- **Logic errors and off-by-one mistakes**
- **Security holes** (injection, auth bypass, data exposure)
- **Contract mismatches** (type/name/semantic disagreements across modules)
- **Failure path gaps** (unhandled exceptions, partial failures, missing cleanup)

If `/review-pr` surfaces findings, triage them:
- **Critical/High**: Fix immediately, re-run tests, commit with `/commit`
- **Medium**: Present to the user for a judgment call
- **Low**: Note in the report but don't block

### Phase 5: Change Review

Do a final read-through of all changed files with fresh eyes. Look for:

- **Leftover debug code**: console.log, print statements, TODO comments that should be resolved
- **Inconsistencies**: Naming that doesn't match the codebase, patterns that diverge from siblings
- **Missing error handling**: Unhandled promise rejections, uncaught exceptions, missing validation
- **Hardcoded values**: Magic numbers or strings that should be constants or config

If anything is found, present it, fix it, and commit.

### Phase 6: Local Testing Preparation

Prepare the user to test manually. This is the handoff — you've done everything automated,
now the user needs to verify with their own eyes.

Present a testing checklist:

> **Ready for Manual Testing**
>
> All automated checks pass. Here's how to test locally:
>
> **Setup:**
> - [Any environment setup needed]
> - [Services to start, env vars to set]
>
> **Test scenarios:**
> - [ ] [Scenario 1 — steps to reproduce, expected result]
> - [ ] [Scenario 2 — steps to reproduce, expected result]
> - [ ] [Edge case 1 — steps to reproduce, expected result]
>
> **Regression checks:**
> - [ ] [Existing feature that could be affected — how to verify]
>
> Once manual testing passes, this is ready for MR creation with `/glab-mr-manager`.

## Principles

- **Green before anything else.** All automated checks must pass before moving to analysis.
- **Fix what you find.** Don't just report issues — fix them and commit.
- **Coverage is about behavior, not lines.** A test that exercises the happy path and 3 edge cases beats 100% line coverage with no assertions.
- **The user does manual testing.** You do everything else.
- **Err on the side of thoroughness.** Better to check something unnecessary than to miss something real.

## Error Handling

| Issue | Resolution |
|-------|------------|
| Tests fail on code you didn't write | Investigate if the failure is related to your changes. If not, flag it but don't fix unrelated code. |
| No test framework set up | Flag this as a gap. Offer to set up the minimal test infrastructure. |
| Build requires external services | Document the dependency. Provide mock/stub alternatives if possible. |
| Can't determine what to test manually | Read the requirements document. Every acceptance criterion is a manual test scenario. |
| Linter has rules you disagree with | Follow the project's rules. Don't disable or override linter config. |
