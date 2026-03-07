---
name: commit
description: Analyze code changes, group them into logical packages where appropriate, to create sequential, clear, descriptive commits with effective titles and detailed descriptions
argument-hint: [--staged | --all]
allowed-tools: Read, Bash
---

# Commit Skill

Analyze code changes, group them into logical packages where appropriate, to create sequential, clear, descriptive commits with effective titles and detailed descriptions.

---

## Levels of Detail

| Level | Component | Purpose |
|-------|-----------|---------|
| **Highest** | Title | Single sentence capturing all changes comprehensively yet succinctly |
| **Middle** | Description | One level deeper - enough to fully understand without viewing files |
| **Lowest** | Files | The actual diff - reader can inspect directly if needed |

---

## Step 1: Grouping

Analyze all changes and determine commit packages.

**Grouping Priority:**

| Priority | Criterion | Example |
|----------|-----------|---------|
| 1 | Feature cohesion | All files for user auth feature |
| 2 | Directory scope | All changes in `auth/` module |
| 3 | Logical separation | Config changes separate from code |
| 4 | Dependency order | Interface before implementation |

**Split Decision:**
- Can describe in one sentence? → Single commit
- Multiple unrelated changes? → Split by concern
- Too complex for one sentence? → Split by logical phase

**Commit Sequence (when splitting):**
- What change enables or defines the others? → Commit first
- Would a reviewer understand each commit in isolation?
- Does the sequence tell a coherent story?
- Order so earlier commits provide context for later ones

---

## Step 2: Title

Write one sentence that:
- Captures ALL changes at the highest level
- Is concise but comprehensive - effective word choice matters
- Clearly conveys what changed without granular file-by-file details
- Capitalize first letter and proper nouns (Claude Code, GitLab, OAuth2, README)
- Imperative mood ("Add" not "Added")
- No period at end
- Max 72 characters (prefer under 50)

**Good:**
- `Add OAuth2 authentication to login flow`
- `Update GitLab MR skill to fetch all comments`
- `Refactor design guide into modular directory structure`

**Bad:**
- `fix bug` (too vague)
- `Updated the thing` (past tense, vague)
- `Add feature, fix bug, update docs` (multiple things - split it)

---

## Step 3: Description

Write bullet points (or other clear format) that:
- Go one level deeper than the title
- Provide enough detail that reader fully understands WITHOUT looking at files
- Stay concise - not overly verbose or exhaustive
- Complement the title, don't repeat it

**Example:**
```
Add 8-step autonomous session protocol with cross-references

- Create autonomous-protocol.md defining discover/plan/execute/verify/document/commit/continue/stop steps
- Add cross-references to memory.md, execution.md, and core.md
- Create continuation-prompt-template.md for consistent session prompts
- Update CHANGELOG with Phase 3 entries
```

---

## Step 4: Execute

Stage files and commit using HEREDOC format:

```bash
git add file1.ts file2.ts

git commit -m "$(cat <<'EOF'
Title sentence here

- Description bullet 1
- Description bullet 2
- Description bullet 3
EOF
)"

git log -1 --oneline
```

If multiple commits, repeat for each in the planned sequence.

---

## Rules

- **Never add Co-Authored-By** or other attribution lines - only the user is credited
- **Never ask questions** - analyze and commit
- **Match project style** - check recent commits for conventions
