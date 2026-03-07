---
name: wrap-session
description: Wrap up the current session by updating active.md with current state and logging the session in temp-docs/sessions/. Use at the end of every working session.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob
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

## Output

Present to the user:
1. Summary of what was logged
2. List of files updated
