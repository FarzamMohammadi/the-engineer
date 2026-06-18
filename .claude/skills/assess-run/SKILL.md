---
name: assess-run
description: "Assess a run of The Engineer on this machine — investigate what its daemon actually did on a task and judge how well it did it, end to end, to find what to improve in The Engineer itself. Reads the run's own artifacts (the ~/.engineer SQLite store, traces, journals), the commits, and the PR. Use this whenever the user wants to evaluate, diagnose, or post-mortem an Engineer run/task/daemon execution: 'assess this run', 'how did the engineer do', 'why did this task get stuck / fail / crash', 'it stopped halfway, what happened', 'diagnose task X', 'what can we improve from this run', 'how did it do against the whole flow'. This is for The Engineer's OWN runs (dogfooding), not for reviewing an external project (use investigate-project) or reviewing an uncommitted diff (use /review or /code-review)."
argument-hint: "[task-id-or-prefix] [optional: status note, e.g. 'it stopped at self-review with a merge conflict']"
---

# Assess Run

Investigate a single run of The Engineer — one task moving (or having moved, or having stopped) through the pipeline — and judge how well the system did its job, layer by layer, against The Engineer's own bar. The point is **dogfooding**: every assessment turns a real run into concrete, prioritized improvements to The Engineer itself.

You hold two questions apart and answer both:

1. **Was this run good?** Did the machinery work, did each phase do real engineering, are the commits and the PR worthy?
2. **What in The Engineer should change** so the next run is better?

These are different. A run can succeed despite a weak phase; a run can fail on a Core bug while every phase did fine work. Never let one verdict stand in for the other.

## Mindset

- **The emitted trail is the evidence.** You judge from what the system recorded — the DB, the traces, the commits, the PR — exactly as the dashboard observer would. If *you* cannot reconstruct the story from the trail alone, that gap is itself a finding (it fails the project's own observability bar). Read [`docs/philosophy.md`](../../../docs/philosophy.md) § "Radical Observability" for the three tests you are implicitly applying.
- **Honest, not flattering.** This is a post-mortem, not a status report. Grade inflation here costs real future runs. If a phase phoned it in, say so plainly and show the evidence. If the run was genuinely clean, say that too — and study *why*, so the strength is repeatable.
- **Improvements are principles, never patches.** When you propose a change to a phase prompt, it must be a principle that strengthens the agent's judgment across the next hundred tasks — never a rule for the one case that exposed the gap. This is The Engineer's deepest design law (`docs/philosophy.md` § "Principles Over Prescriptions"). "Gather must extract acceptance criteria into the structured field, because downstream phases and the owner depend on it" generalizes. "When the issue mentions a prefix, check the classifier" does not. If a finding only helps one task category, it belongs in a task context, not a core prompt.
- **Tiered, not exhaustive.** The raw agent traces are large (hundreds of KB each). Reconstruct the lifecycle cheaply from the DB first, form hypotheses, and only then open the specific traces a finding points at. Most of a clean run is not worth reading.
- **Stay collaborative.** You surface findings and a recommended priority. The owner decides what gets filed or fixed. Walk the findings together; don't hand over a wall of text and stop.

---

## Step 0 — Orient

Establish three things before touching data:

1. **Which run.** The argument may be a task id or a unique prefix. If none was given, run the triage script with no argument (below) to list recent runs and ask the owner which one. A short prefix is fine — `engineer status` shows the short form.
2. **The owner's framing.** The owner often hands you the situation: *"it stopped at self-review,"* *"it crashed,"* *"the PR description came out weak."* Treat this as the lead, not the verdict — confirm it against the trail. Found context ≠ confirmed cause.
3. **The mode**, which shapes emphasis:
   - **Completed** — the task reached `completed`. Assess the whole lifecycle for quality and the delivered PR. The risk here is a run that *finished* without being *good*.
   - **Stopped mid-pipeline** — `active`, `blocked`, or `queued` and not moving. The first job is *why* it stopped, and whether the stop is legitimate (a real blocker awaiting the owner) or a defect (a loop, a misroute, a swallowed reply).
   - **Crashed / failed** — `failed`, or sessions ending in `crashed`. Find the root cause and whether recovery (retry, backoff, checkpoint resume) behaved correctly.

   The home directory defaults to `~/.engineer`; honor `--home` / `$ENGINEER_HOME` if the owner runs a custom data dir.

---

## Step 1 — Reconstruct the lifecycle (the spine)

Run the bundled triage script. It is read-only (the daemon can be live) and dumps the run's deterministic spine so you don't burn tokens re-deriving queries:

```bash
.claude/skills/assess-run/scripts/triage.sh <task-id-or-prefix>      # add --home <dir> for a custom data dir
```

It prints eleven sections: **task** (state, scope, acceptance criteria, recorded decisions, blocked/review payloads, cost, counters) · **sessions** (one per dispatch, with `end_reason`) · **pipeline journey** (sub-phase calls in order) · **state transitions** · **decisions** (`route:*` / `skip:*` / gates, each with its **chosen option and reasoning**) · **errors & termination** (the bug surface plus the co-located kill story — errors, abnormal transitions, `health.*` events) · **checkpoints** (phase carry-forward) · **data-integrity checks** (deterministic anomaly flags) · **events** (git / cost / comms) · **trace files** · **workspace** (the task's **own** commits vs merged-in, + diff).

Read the spine and reconstruct what happened as a narrative before judging anything. The highest-signal reads:

- **Sessions `end_reason` + state transitions** tell the whole arc — every block, preempt, crash, retry, and re-entry, with *why* and *who triggered it*. A `pr_event:*` re-entry, a `hard_cap_exceeded`, a `resumed_from_checkpoint` each change the story.
- **The pipeline journey** is where rework hides. A sub-phase repeating, or a *backward jump* (e.g. `delivery → execution`), means the orchestrator routed the work back. Match that against `total_reworks`/`phase_iteration` — if the counters don't reflect what the journey shows, that mismatch is a finding.
- **Decisions** (`route:*`, `skip:*`, gates, autonomy) are the orchestrator's reasoning made inspectable. The orchestrator picks the route; the agent never picks a phase. Sanity-check each routing and each skipped review lens — was skipping `security`/`architecture`/`code-quality` justified for this change?
- **Cost trajectory** shows where spend concentrated and whether a ceiling fired.

Write the narrative down (you'll need it for the report). Note every anomaly as a hypothesis to confirm — don't conclude yet.

---

## Step 2 — Assess the layers

Go layer by layer. For each, the spine usually tells you whether to dig; **open a raw trace (§Deep-dive) only when a hypothesis needs the agent's actual conversation to confirm.**

### A. Core mechanics — did the machinery work?
The invariant brain: state machine, scheduler, cost tracker, session lifecycle, event/observation integrity, health, comms, retries. Look for: the termination chain in §6 (`crashed` sessions, `error` observations, abnormal transitions, the `health.*` event that preceded a kill — was the kill *legitimate*, or did the system punish itself, e.g. counting owner-blocked wait as active time?); state loops or illegal-looking transitions; counters that disagree with the journey; the impossible-ordering / stale-stamp flags §8 raises for you; cost ceilings firing correctly (and recovering); `comm.send_failed` and whether the owner actually got reached. These are usually **bugs in The Engineer** — the highest-value findings.

### B. Pipeline quality — did each phase do real engineering?
Take the sub-phases that **actually ran** from §3 — don't assume a fixed topology, it can be re-sliced — and judge each against the intent of its phase:
- **Requirements** — did `gather` extract true intent, constraints, and acceptance criteria, and *persist them to the structured fields*? When those fields are empty (§1) on a richly-specified task, open the phase artifact (`requirements.md` / the gather checkpoint) before concluding — *never extracted* (a pipeline-quality gap, lands in the gather prompt) and *extracted but not persisted to the structured field* (an observability/Core gap, lands at the write site) are different findings in different categories. Don't conflate them.
- **Research / Planning** — did it ground in the codebase before deciding, find existing mechanisms to reuse, and question its own plan? Or jump to implementation?
- **Execution** — did the work match the plan and satisfy the criteria? Did `verify` gates pass honestly (a failing gate that the run moved past anyway is a finding)?
- **Review** — were the lenses applied or skipped, and was each skip defensible? Did `refine` actually improve the work or just churn?
- **Delivery** — was the route to PR clean, or did it thrash (push/create-pr/await-review re-entering)?

Grade against **Real Engineer Behavior** and **Post-Completion Rigor** (`docs/philosophy.md`). Pipeline-quality gaps usually become **phase-prompt principle** improvements — frame them as such.

### C. Commits — is the work complete and the history clean?
From §11, judge the task's **own** commits (the `--no-merges` list) — if a merge commit is present, the diffstat folds in base files, so don't attribute those to the task. Are the commits cohesive and logically grouped, each green, with titles that explain the *why*? Check against the project's commit discipline (`AGENTS.md` § "Commit Discipline" — one succinct high-level sentence, no needless prefixes/colons, never a feature-shaped title on a commit that ships no feature code). Duplicated, mislabeled, or "fix the previous commit" commits are findings. Confirm the diff actually covers the acceptance criteria (tests + docs + logging, not just code — the Definition of Done treats those as one unit).

### D. Final output — is the PR worthy?
Read the `pr-description` trace and the actual PR. Pull the PR state explicitly (the bare `gh pr view` emits only a deprecation warning and no body): `gh pr view <n> --json number,state,mergeable,mergeStateStatus,reviewDecision,isDraft,title,body` using `review.pr_number` from §1. Does the description give a reviewer the context, reasoning, and "why" behind the change — understandable on first read by someone with no context (Universal Audience)? Does the PR satisfy the acceptance criteria? Is it the kind of PR that survives review?

### E. Observability (meta) — could the trail tell the story?
While doing A–D, notice where you had to *guess* because the trail was thin — a decision recorded as made but not inspectable, a phase with no rationale, an error with no recovery context, a counter that lied. Each blind spot is an **observability gap** finding, judged against the three tests in `docs/philosophy.md` § "Radical Observability." This is the layer The Engineer cares about most; be exacting.

---

## Step 3 — Grade against the bar

Hold the run up to The Engineer's own **Definition of Done** (`docs/philosophy.md`) and the three observability tests. The DoD is the project's single source of truth for "good," so it's the right yardstick for "was this run good?" Be concrete: for each dimension, a clear verdict with the evidence (a session id, a transition, a commit, a trace line) — never a vibe.

---

## Step 4 — Write the report, then walk it

Write the assessment to `docs/archived/implementation-docs/run-assessments/<task-short>-<YYYY-MM-DD>.md` (create the directory if absent). Then walk the findings with the owner — lead with the verdict and the top improvements; let them pull on detail. Use this structure:

```markdown
# Run Assessment — <task title> (<task-short-id>)

**Task:** <id> · **Mode:** completed | stopped | crashed · **Assessed:** YYYY-MM-DD
**Outcome:** <one honest sentence — what the run achieved or where it stands>

## What happened
<the lifecycle narrative from Step 1 — the arc, the blocks/retries/re-entries, the rework, the cost>

## Run quality verdict
<honest assessment, layer by layer: Core mechanics · pipeline phases · commits · PR/delivery · observability.
Evidence for every claim. Call out both the weak spots and what genuinely went well.>

## Improvement backlog (for The Engineer)
<the categorized, ranked list — see Step 5. This is the payload of the whole exercise.>
```

Keep it scannable — tables and tight prose over walls of text. The reader's time is sacred.

---

## Step 5 — The improvement backlog

This is the output that matters. Turn findings into a ranked, categorized list. Each item carries: **what** (the gap, with evidence from the trail), **category**, **the fix as a principle**, and **priority** (impact × how often it'll recur across runs).

Categories — they route the fix to the right place:

| Category | Lands in | Framing |
|---|---|---|
| **Core bug** | `src/core/**` (engine, scheduler, cost, daemon, observability) | A concrete defect — counter, state, recovery, data integrity, comms. The highest-value kind. |
| **Phase-prompt principle** | `src/core/orchestrator/pipeline/<phase>/<sub-phase>.ts` | A generalizing principle that sharpens the agent's judgment in that phase. Never a task-specific rule. |
| **Observability gap** | the emitting site + `docs/.../observability.md` | A decision/error/state that should have been inspectable and wasn't. |
| **Doc / UX gap** | `docs/**`, CLI output | The trail was right but a human or the next agent couldn't follow it. |

End the conversation here, with the ranked list — the owner decides what to file or fix. If, and only if, they then ask, you can draft an `engineer`-labeled GitHub issue for an item, or hand a chosen item to `/create-plan`. Default is: surface, prioritize, stop.

---

## Deep-dive reference

When a hypothesis needs the agent's actual conversation, open the one trace it points at — never read a whole large file blind.

**Trace files** live at `~/.engineer/traces/sessions/<task-id>/<sub-phase>-<timestamp>.ndjson` (all dispatches together). Each line is one record; types are `system`, `assistant`, `user` (tool results), `result`, `rate_limit_event`. Target within a file rather than reading it whole:

```bash
T=~/.engineer/traces/sessions/<task-id>
# what the agent said (its reasoning/output), without the tool-result noise:
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$T/<file>.ndjson" | head -50
# every tool the agent invoked, in order:
jq -rc 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$T/<file>.ndjson" | sort | uniq -c
# the final result record (how the sub-phase ended):
jq -rc 'select(.type=="result")' "$T/<file>.ndjson"
```

**Ad-hoc DB queries** (always read-only) when the spine isn't enough — the store is `~/.engineer/data/engineer.db`:

```bash
DB=~/.engineer/data/engineer.db
# full text of a decision (alternatives, reasoning, confidence) the spine truncated:
sqlite3 -readonly "$DB" "SELECT input, output, metadata FROM observations WHERE task_id LIKE '<prefix>%' AND name='<decision>';"
# the agent_activity stream for one sub-phase (the parsed trace as queryable rows):
sqlite3 -readonly "$DB" "SELECT type,name,status,substr(error_message,1,60) FROM observations WHERE session_id='<full-session-id>' AND type='agent_activity' ORDER BY start_time;"
# checkpoints — full carry-forward content (spine §7 shows lengths; drill here when a row is non-empty):
sqlite3 -readonly "$DB" "SELECT phase, key_findings, open_questions, next_action FROM checkpoints WHERE task_id LIKE '<prefix>%' ORDER BY timestamp;"
```

`engineer why <task-id>` gives a quick human timeline if you want orientation before the script — but the script and these queries go deeper.

---

## Quality checklist

Before you call an assessment done:
- [ ] The lifecycle narrative is reconstructed from the trail, not assumed — every claim has an artifact behind it.
- [ ] Run quality and Engineer-improvements are kept separate; neither stands in for the other.
- [ ] Both weaknesses *and* genuine strengths are named (and strengths are explained so they're repeatable).
- [ ] Every prompt-improvement is a generalizing principle, not a patch for the one case.
- [ ] Each backlog item is categorized, evidenced, and prioritized — ready for the owner to triage.
- [ ] Deep-dives were targeted: you opened only the traces a finding required.
- [ ] You walked the findings with the owner and left the filing/fixing decision with them.
