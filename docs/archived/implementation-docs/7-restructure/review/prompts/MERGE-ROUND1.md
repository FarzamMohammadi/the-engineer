# Merge Prompt: Round 1 (Craft — 5 Lenses)

> Merge branches from lenses A, B, C, D, E for a single phase back to main.

---

## Context

5 parallel Claude Code sessions just reviewed phase `{PHASE}` through independent lenses, each in its own worktree branch:

| Branch | Lens | Worktree |
|--------|------|----------|
| `review/A-{PHASE}` | Structure & Organization | `../engineer-A-{PHASE}` |
| `review/B-{PHASE}` | Naming & Readability | `../engineer-B-{PHASE}` |
| `review/C-{PHASE}` | Abstractions & API Design | `../engineer-C-{PHASE}` |
| `review/D-{PHASE}` | Error Handling & Edge Cases | `../engineer-D-{PHASE}` |
| `review/E-{PHASE}` | Security & Trust Boundaries | `../engineer-E-{PHASE}` |

Each branch has a `recap.md` at its repo root summarizing what was changed and why.

**Run this prompt from the main repo directory (not a worktree).**

---

## Your Role

You are the integration engineer. Your job is to merge 5 independent review branches cleanly into main. You understand what each lens was doing (they don't overlap in scope), so you can resolve conflicts intelligently.

**You are my partner, not my tool.** If a conflict is ambiguous or two lenses made contradictory changes, ask me before resolving.

---

## Merge Procedure

### Step 1: Read All Recaps

Read `recap.md` from each worktree to understand what changed:

```bash
cat ../engineer-A-{PHASE}/recap.md
cat ../engineer-B-{PHASE}/recap.md
cat ../engineer-C-{PHASE}/recap.md
cat ../engineer-D-{PHASE}/recap.md
cat ../engineer-E-{PHASE}/recap.md
```

Summarize the changes from all 5 lenses for me before proceeding.

### Step 2: Merge Sequentially (Squash)

Merge branches one at a time into main using `--squash`, in this order (least likely to conflict → most likely):

1. **A (Structure)** first — file moves/renames that other lenses build on
2. **E (Security)** — adds validation/sanitization, rarely conflicts with naming
3. **D (Error handling)** — adds error paths, independent of naming
4. **B (Naming)** — renames throughout, may conflict with C
5. **C (Abstractions)** — interface changes, merge last as most cross-cutting

For each:
```bash
git merge --squash review/{LENS}-{PHASE}
# Resolve any conflicts, then stage — but do NOT commit yet
```

**Do NOT commit between merges.** Squash all 5 branches into the working tree first, then make ONE single commit at the end.

### Step 3: Resolve Conflicts

If conflicts occur during any squash merge:
- **Read both sides** — understand what each lens intended
- **Lenses don't overlap in scope** — a naming change (B) and an error handling addition (D) in the same file should merge cleanly by applying both
- **If genuinely contradictory** — ask me which to keep
- Stage resolved files and continue to next squash merge

### Step 4: Collect Deferred Findings

Before cleaning up, extract ALL "Findings Deferred" sections from every recap into a persistent file:

```bash
# Create or append to the deferred findings log
echo -e "\n## Round 1 — {PHASE}\n" >> implementation-docs/7-restructure/review/deferred.md
```

For each recap that has deferred findings, append them with the lens ID. This file persists across all rounds and phases — nothing gets lost.

Then clean up recap files:

```bash
rm -f recap.md
```

### Step 5: Verify

```bash
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
pnpm test
npx biome check src/ test/
```

All must pass. Fix any issues before committing.

### Step 6: Single Squash Commit

Stage everything and use the `/commit` skill to create ONE commit containing all changes from all 5 lenses. The skill will analyze the diff and craft the right title and description.

```bash
git add -A
```

Then run `/commit`.

### Step 7: Cleanup Worktrees & Branches

```bash
# Remove worktrees
git worktree remove ../engineer-A-{PHASE}
git worktree remove ../engineer-B-{PHASE}
git worktree remove ../engineer-C-{PHASE}
git worktree remove ../engineer-D-{PHASE}
git worktree remove ../engineer-E-{PHASE}

# Delete branches
git branch -D review/A-{PHASE} review/B-{PHASE} review/C-{PHASE} review/D-{PHASE} review/E-{PHASE}
```

### Step 8: Summary

Report:
- Single commit hash
- Conflicts resolved (if any)
- Test results
- Any deferred findings that need follow-up
