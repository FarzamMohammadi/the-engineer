---
name: wrap-session
description: Wrap up the current session by updating active.md, logging the session, committing, and providing the next session's starter prompt. Use at the end of every working session.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Skill
argument-hint: [optional notes about the session]
---

# Wrap Session

End the current session cleanly so the next one picks up without losing a beat.

---

## Step 1: Update `temp-docs/active.md`

Read `temp-docs/active.md`, then update the **Status** section to reflect:
- What was just completed this session
- What we're doing next session
- Current state of the overall work

Keep the rest of active.md intact (Current Focus, What We're Doing, Deliverables). Only the Status section changes.

---

## Step 2: Log the Session

1. Check `temp-docs/sessions/` for the latest session number
2. Create the next sequential file (e.g., `002.md`, `003.md`)

Format:

```markdown
# Session [NNN] — [YYYY-MM-DD]

## What Happened

[2-4 sentences summarizing the session. Be succinct.]

## Decisions Made

[Numbered list of decisions, or "None" if purely execution work.]

## What's Next

[What the next session should start with.]
```

---

## Step 3: Commit

Run `/commit` to stage and commit all changes from this session.

---

## Step 4: Starter Prompt

Generate a starter prompt for the next session. This is a self-contained message the user can paste into a fresh chat to pick up exactly where this session ended.

The prompt should:
- Tell the agent which files to read first and in what order (active.md, goals.md, philosophy.md, latest session log)
- State the project context in one sentence
- State the working mode (architecture only, no code, collaborate deeply, use Q&A tool, never rush)
- Say to pick up where the last session left off

Present it in a code block, ready to copy-paste.

---

## Output

Present to the user:
1. Summary of what was logged
2. List of files updated/created
3. The starter prompt in a code block
