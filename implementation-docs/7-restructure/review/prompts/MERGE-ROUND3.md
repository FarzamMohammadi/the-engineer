# Merge Prompt: Round 3 (Coherence — 2 Lenses)

> Merge branches from lenses I, J for a phase group back to main.

---

## Context

2 parallel Claude Code sessions just reviewed phase group `{PHASE_GROUP}` through independent lenses, each in its own worktree branch:

| Branch | Lens | Worktree |
|--------|------|----------|
| `review/I-{PHASE_GROUP}` | Consistency & Patterns | `../engineer-I-{PHASE_GROUP}` |
| `review/J-{PHASE_GROUP}` | Minimalism & Dead Code | `../engineer-J-{PHASE_GROUP}` |

Each branch has a `recap.md` at its repo root summarizing what was changed and why.

**Run this prompt from the main repo directory (not a worktree).**

---

## Your Role

You are the integration engineer. These two lenses can conflict — Lens I might standardize a pattern that Lens J wants to delete entirely. Read both recaps carefully and resolve with judgment.

**You are my partner, not my tool.** If Lens I standardized something that Lens J deleted, ask me which direction to go.

---

## Merge Procedure

### Step 1: Read All Recaps

```bash
cat ../engineer-I-{PHASE_GROUP}/recap.md
cat ../engineer-J-{PHASE_GROUP}/recap.md
```

Summarize and flag any potential conflicts before proceeding.

### Step 2: Merge Sequentially (Squash)

Squash merge both branches. Order:

1. **J (Minimalism)** first — deletions are easier to merge when they go first
2. **I (Consistency)** — standardizations applied on top of the leaner codebase

```bash
git merge --squash review/J-{PHASE_GROUP}
# Resolve any conflicts, stage — but do NOT commit yet
git merge --squash review/I-{PHASE_GROUP}
# Resolve any conflicts, stage — but do NOT commit yet
```

**Do NOT commit between merges.** Squash both branches into the working tree first, then make ONE single commit at the end.

### Step 3: Resolve Conflicts

**Key tension:** Lens I standardizes, Lens J deletes. If they conflict:
- If J deleted dead code that I was trying to standardize → J wins (can't standardize what doesn't exist)
- If I standardized a pattern that J simplified → evaluate which result is cleaner, ask me if unclear

### Step 4: Collect Deferred Findings

Before cleaning up, extract ALL "Findings Deferred" sections from every recap and append them to the persistent deferred log:

```bash
echo -e "\n## Round 3 — {PHASE_GROUP}\n" >> implementation-docs/7-restructure/review/deferred.md
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

Stage everything and use the `/commit` skill to create ONE commit containing all changes from both lenses. The skill will analyze the diff and craft the right title and description.

```bash
git add -A
```

Then run `/commit`.

### Step 7: Cleanup Worktrees & Branches

```bash
git worktree remove ../engineer-I-{PHASE_GROUP}
git worktree remove ../engineer-J-{PHASE_GROUP}
git branch -D review/I-{PHASE_GROUP} review/J-{PHASE_GROUP}
```

### Step 8: Summary

Report: single commit hash, conflicts resolved, test results, deferred findings.
