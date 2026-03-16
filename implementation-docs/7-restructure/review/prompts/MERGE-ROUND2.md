# Merge Prompt: Round 2 (Polish — 3 Lenses)

> Merge branches from lenses F, G, H for a single phase back to main.

---

## Context

3 parallel Claude Code sessions just reviewed phase `{PHASE}` through independent lenses, each in its own worktree branch:

| Branch | Lens | Worktree |
|--------|------|----------|
| `review/F-{PHASE}` | Logging & Observability | `../engineer-F-{PHASE}` |
| `review/G-{PHASE}` | Performance & Resources | `../engineer-G-{PHASE}` |
| `review/H-{PHASE}` | Config & DX | `../engineer-H-{PHASE}` |

Each branch has a `recap.md` at its repo root summarizing what was changed and why.

**Run this prompt from the main repo directory (not a worktree).**

---

## Your Role

You are the integration engineer. Your job is to merge 3 independent review branches cleanly into main. These lenses rarely conflict (logging, performance, and config touch different concerns), but verify.

**You are my partner, not my tool.** If a conflict is ambiguous, ask me before resolving.

---

## Merge Procedure

### Step 1: Read All Recaps

```bash
cat ../engineer-F-{PHASE}/recap.md
cat ../engineer-G-{PHASE}/recap.md
cat ../engineer-H-{PHASE}/recap.md
```

Summarize the changes from all 3 lenses for me before proceeding.

### Step 2: Merge Sequentially (Squash)

Squash merge branches one at a time into main. Order (least to most cross-cutting):

1. **G (Performance)** first — targeted optimizations, localized changes
2. **F (Logging)** — adds log statements, unlikely to conflict with perf
3. **H (Config & DX)** — config changes may touch the same files as logging

For each:
```bash
git merge --squash review/{LENS}-{PHASE}
# Resolve any conflicts, stage — but do NOT commit yet
```

**Do NOT commit between merges.** Squash all 3 branches into the working tree first, then make ONE single commit at the end.

### Step 3: Resolve Conflicts

Same rules as Round 1 — lenses don't overlap, apply both sides when possible.

### Step 4: Collect Deferred Findings

Before cleaning up, extract ALL "Findings Deferred" sections from every recap and append them to the persistent deferred log:

```bash
echo -e "\n## Round 2 — {PHASE}\n" >> implementation-docs/7-restructure/review/deferred.md
```

Append each lens's deferred findings with its lens ID. Then clean up:

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

### Step 6: Single Squash Commit

Stage everything and use the `/commit` skill to create ONE commit containing all changes from all 3 lenses. The skill will analyze the diff and craft the right title and description.

```bash
git add -A
```

Then run `/commit`.

### Step 7: Cleanup Worktrees & Branches

```bash
git worktree remove ../engineer-F-{PHASE}
git worktree remove ../engineer-G-{PHASE}
git worktree remove ../engineer-H-{PHASE}
git branch -D review/F-{PHASE} review/G-{PHASE} review/H-{PHASE}
```

### Step 8: Summary

Report: single commit hash, conflicts resolved, test results, deferred findings.
