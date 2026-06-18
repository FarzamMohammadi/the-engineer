---
name: assess-run
description: "Assess a run of The Engineer on this machine — investigate what its daemon actually did on a task and judge how well it did it, end to end, to find what to improve in The Engineer itself. Reads the run's own artifacts (the ~/.engineer SQLite store, traces, journals), the commits, and the PR. Use this whenever the user wants to evaluate, diagnose, or post-mortem an Engineer run/task/daemon execution: 'assess this run', 'how did the engineer do', 'why did this task get stuck / fail / crash', 'it stopped halfway, what happened', 'diagnose task X', 'what can we improve from this run', 'how did it do against the whole flow'. This is for The Engineer's OWN runs (dogfooding), not for reviewing an external project (use investigate-project) or reviewing an uncommitted diff (use /review or /code-review)."
allowed-tools: Read, Bash, Write, Edit
argument-hint: "[task-id-or-prefix] [optional: status note, e.g. 'stopped at self-review with a merge conflict']"
---

# Assess Run

Post-mortem one run of The Engineer — a task moving through (or stopped in, or crashed out of) the pipeline — and turn it into improvements to The Engineer itself.

Hold two questions apart:
1. **Was this run good?** — the machinery, each phase, the commits, the PR.
2. **What should change in The Engineer** so the next run is better?

Deliverable: a short report at `.claude/temp/assess-run/<task-short>-<date>.md`, then walk it with the owner.

## Principles

- **The trail is the evidence.** Judge only from what the system recorded — DB, traces, commits, PR. If you can't reconstruct the story from the trail, that gap is itself a finding.
- **Honest, not flattering.** A post-mortem, not a status report. If a phase phoned it in, say so with the artifact. If it was clean, say why, so it's repeatable.
- **Improvements are principles, never patches.** A prompt fix must sharpen the agent's judgment across the next hundred tasks, not the one case. "Gather must persist acceptance criteria to the structured field" generalizes; "when the issue mentions a prefix, check the classifier" does not.
- **Tiered, not exhaustive.** Reconstruct cheaply from the DB first; open a raw trace only when a hypothesis needs the agent's actual words. Most of a clean run isn't worth reading.

## 1. Pick the run and the mode

The argument is a task id or prefix. With none, run triage with no argument to list recent runs and ask. The owner often hands you the situation ("stopped at self-review", "crashed") — treat it as the lead, confirm it against the trail.

Mode shapes emphasis: **completed** (did it finish *good*, not just finish?) · **stopped** (active/blocked/queued — why, and is the stop legitimate or a defect?) · **crashed** (root cause, and did recovery work?).

Home defaults to `~/.engineer`; honor `--home` / `$ENGINEER_HOME`.

## 2. Triage — reconstruct the lifecycle

```bash
.claude/skills/assess-run/scripts/triage.sh <task-id-or-prefix>      # --home <dir> for a custom data dir
```

Read-only, daemon-safe. Eleven sections: task scope/cost/counters · sessions (`end_reason`) · pipeline journey · state transitions · decisions (chosen + reasoning) · errors & termination (the kill story) · checkpoints · data-integrity flags · events · trace files · workspace (own commits vs merged-in).

Reconstruct the arc before judging. Highest signal: sessions `end_reason` + transitions (every block / preempt / crash / retry / re-entry, with why and who); the pipeline journey (a sub-phase repeating or a backward jump = rework — cross-check the counters); decisions (was each route and each skipped lens justified?); the §8 flags (impossible orderings, stale stamps). Note anomalies as hypotheses; don't conclude yet.

## 3. Assess the layers

Open a raw trace (§Deep-dive) only when a hypothesis needs it.

- **Core mechanics** — the kill story in §6 (a legitimate stop, or did the system punish itself — e.g. counting owner-blocked wait as active?), counters vs the journey, the §8 flags, cost ceilings firing and recovering, comms reaching the owner. Usually **bugs** — the highest-value findings.
- **Pipeline** — take the sub-phases that actually ran (§3) and judge each against its phase's intent: did gather extract *and persist* intent + criteria; did research/planning ground and question itself; did execution match the plan and pass gates honestly; were skipped lenses defensible; did the route to PR thrash. (Empty structured fields → open the artifact: *never extracted* ≠ *extracted but not persisted* — different findings.)
- **Commits** — the task's own commits (§11 `--no-merges`): cohesive, green, honest titles (one prose sentence, no `feat:` prefix, never a feature-shaped title on a non-feature commit); the diff covers the criteria, tests and docs included.
- **PR** — the `pr-description` trace + `gh pr view <n> --json number,state,mergeable,mergeStateStatus,reviewDecision,body`: does it give a reviewer the *why*, satisfy the criteria, survive review?
- **Observability** — wherever you had to *guess*: a decision made but not inspectable, a counter that lied, an error with no recovery context. Each blind spot is a finding.

The bar is the run's own Definition of Done and the "what happened / now / next" observability test. Evidence for every verdict — a session id, a transition, a commit, a trace line. Never a vibe.

## 4. Backlog, then write and walk

Turn findings into a ranked list. Each item: what (with evidence), category, fix-as-principle, priority (impact × recurrence).

| Category | Lands in |
|---|---|
| **Core bug** | `src/core/**` — counter, state, recovery, data integrity, comms |
| **Phase-prompt principle** | `src/core/orchestrator/pipeline/<phase>/<sub-phase>.ts` |
| **Observability gap** | the emitting site |
| **Doc / UX gap** | `docs/**`, CLI output |

Write to `.claude/temp/assess-run/<task-short>-<date>.md` (`mkdir -p` first):

```markdown
# Run Assessment — <title> (<task-short>)
**Task:** <id> · **Mode:** completed|stopped|crashed · **Assessed:** <date>
**Outcome:** <one honest sentence>

## What happened
<the lifecycle arc — blocks/retries/re-entries, rework, cost>

## Run quality
<layer by layer, evidence per claim; weak spots and what genuinely worked>

## Improvement backlog (for The Engineer)
<ranked, categorized table>
```

Walk it with the owner — lead with the verdict and the top improvements. They decide what to file or fix; only if they ask, draft an `engineer`-labeled issue or hand an item to `/create-plan`.

## Deep-dive reference

Open the one trace a finding points at — never a whole large file blind.

**One sub-phase trace** — pick a file from triage §10 and read it the right way (its reasoning, the tools it used, how it ended):

```bash
.claude/skills/assess-run/scripts/peek.sh <ndjson-file>      # --full for all reasoning, not the head
```

**Ad-hoc DB** (read-only) when the spine isn't enough — store is `~/.engineer/data/engineer.db`:

```bash
DB=~/.engineer/data/engineer.db
sqlite3 -readonly "$DB" "SELECT input, output FROM observations WHERE task_id LIKE '<prefix>%' AND name='<decision>';"   # a decision's full reasoning (it's in input, not metadata)
sqlite3 -readonly "$DB" "SELECT type,name,status,substr(error_message,1,60) FROM observations WHERE session_id='<full-session-id>' AND type='agent_activity' ORDER BY start_time;"   # parsed trace as rows
sqlite3 -readonly "$DB" "SELECT phase, key_findings, open_questions, next_action FROM checkpoints WHERE task_id LIKE '<prefix>%' ORDER BY timestamp;"   # full checkpoint content (spine §7 shows lengths)
```
