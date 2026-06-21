#!/usr/bin/env bash
#
# assess-run triage — dump the deterministic "spine" of one Engineer run (task)
# from the read-only SQLite store, so /assess-run can reconstruct the lifecycle
# before spending tokens reading raw agent traces.
#
# Read-only by construction: every query runs through `sqlite3 -readonly`. The
# daemon can be live — SQLite WAL allows concurrent readers — and nothing here
# writes. Output is plain text in clearly delimited sections for the agent to
# interpret; this script never judges, it only gathers.
#
# Usage:
#   triage.sh <task-id-or-prefix> [--home <dir>]
#   triage.sh                       # no arg → list recent runs to pick from
#
# Home resolution: --home flag > $ENGINEER_HOME > ~/.engineer
set -euo pipefail

HOME_DIR="${ENGINEER_HOME:-$HOME/.engineer}"
PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --home=*) HOME_DIR="${1#*=}"; shift ;;
    -h|--help) echo "usage: triage.sh <task-id-or-prefix> [--home <dir>]"; exit 0 ;;
    *) PREFIX="$1"; shift ;;
  esac
done

DB="$HOME_DIR/data/engineer.db"
[ -f "$DB" ] || { echo "ERROR: no database at $DB — set --home or \$ENGINEER_HOME to the Engineer data directory"; exit 1; }

q()  { sqlite3 -readonly -batch "$DB" "$@"; }
qc() { sqlite3 -readonly -batch -header -column "$DB" "$@"; }

list_recent() {
  qc "SELECT substr(id,1,12) id, state, phase, sub_phase, substr(title,1,44) title, datetime(created_at) created
      FROM tasks ORDER BY created_at DESC LIMIT 15;"
}

# ── Resolve the run ───────────────────────────────────────────────────────────
if [ -z "$PREFIX" ]; then
  echo "No task id given. Recent runs (pass one as the argument):"
  echo
  list_recent
  exit 0
fi

MATCHES="$(q "SELECT id FROM tasks WHERE id LIKE '${PREFIX}%' ORDER BY created_at;")"
COUNT="$(printf '%s' "$MATCHES" | grep -c . || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "No task matches prefix '${PREFIX}'. Recent runs:"; echo
  list_recent; exit 1
elif [ "$COUNT" -gt 1 ]; then
  echo "Prefix '${PREFIX}' is ambiguous — matches ${COUNT} tasks:"; echo
  printf '%s\n' "$MATCHES"; exit 1
fi
TID="$MATCHES"

hr() { printf '\n══════════════════════════════════════════════════════════════════════\n'; }
sec() { hr; echo "$1"; hr; }

# ── 1. The task row (identity, state, scope, cost, counters) ───────────────────
sec "1. TASK  ($TID)"
q ".mode line" "SELECT
    id, state, sub_state, phase, sub_phase, priority,
    title, description, repo,
    total_reworks, phase_iteration,
    consecutive_crash_count, consecutive_agent_unavailable_count,
    agent_tokens, printf('%.2f', agent_cost_usd) AS cost_usd,
    created_at, started_at, completed_at, last_transition_at
  FROM tasks WHERE id = '$TID';"

echo; echo "── acceptance_criteria ──"
q "SELECT acceptance_criteria FROM tasks WHERE id = '$TID';"
echo; echo "── recorded decisions ──"
q "SELECT decisions FROM tasks WHERE id = '$TID';"
echo; echo "── blocked payload (typed: reason / category / needed) ──"
q "SELECT coalesce(blocked,'(none)') FROM tasks WHERE id = '$TID';"
echo; echo "── review payload ──"
q "SELECT coalesce(review,'(none)') FROM tasks WHERE id = '$TID';"

# ── 2. Sessions — one per dispatch; end_reason tells the stop story ────────────
sec "2. SESSIONS  (each dispatch; end_reason = completed|preempted|crashed|blocked)"
qc "SELECT substr(id,1,14) session, datetime(started_at) started, datetime(ended_at) ended,
      coalesce(end_reason,'(still running)') end_reason
    FROM sessions WHERE task_id = '$TID' ORDER BY started_at;"

# ── 3. The pipeline journey — every sub-phase run, in order ────────────────────
# Built from phase_transition observations (the authoritative sub-phase record),
# NOT agent_call — so non-LLM sub-phases (verify, push, create-pr, await-review,
# auto-merge) appear too, not only the ones that called an agent. One row per
# sub-phase RUN in true executed order; its outcome is the matching
# sub_phase_result (the next result of that sub-phase after the start), or
# "running" when a start has no result yet. Repeats of a sub-phase and backward
# jumps (e.g. a second execution/implement) are the rework signal — grade each
# run against its phase's intent, don't expect a fixed list. The routing and
# verdict behind each run are in §5 (decisions); per-gate output is in the trace
# (§10). This section is the executed spine, not a re-derivation of that detail.
sec "3. PIPELINE JOURNEY  (every sub-phase run in order — repeats & backward jumps = rework)"
qc "SELECT datetime(s.start_time) at,
      json_extract(s.input,'\$.phase') phase,
      json_extract(s.input,'\$.subPhase') sub_phase,
      coalesce(
        (SELECT json_extract(r.input,'\$.outcome') FROM observations r
           WHERE r.task_id = s.task_id AND r.type = 'phase_transition'
             AND r.name = 'sub_phase_result'
             AND json_extract(r.input,'\$.subPhase') = json_extract(s.input,'\$.subPhase')
             AND r.start_time >= s.start_time
           ORDER BY r.start_time LIMIT 1),
        'running') outcome
    FROM observations s
    WHERE s.task_id = '$TID' AND s.type = 'phase_transition' AND s.name = 'sub_phase_started'
    ORDER BY s.start_time;"

# ── 4. State machine history ──────────────────────────────────────────────────
sec "4. STATE TRANSITIONS  (from → to, why, who)"
qc "SELECT datetime(timestamp) at, from_state||' → '||to_state move,
      substr(reason,1,40) reason, triggered_by
    FROM state_transitions WHERE task_id = '$TID' ORDER BY timestamp;"

# ── 5. Orchestrator decisions — routing, skips, gates, WITH reasoning ─────────
# route:* = where the orchestrator sent the task next (it decides the route, the
# agent never picks a phase). skip:* = a review lens that was skipped. The full
# reasoning lives in observations.input (chosen option + why) — NOT metadata,
# which is empty for these rows. We surface it here so the decision surface reads
# as inspectable (which it is); §Deep-dive pulls the complete input/output.
sec "5. DECISIONS  (route:* / skip:* / gates / autonomy — chosen + reasoning)"
qc "SELECT datetime(start_time) at, name decision,
      coalesce(json_extract(input,'\$.chosen'),'') chosen,
      substr(coalesce(json_extract(input,'\$.reasoning'), json_extract(input,'\$.context'), input),1,72) why
    FROM observations
    WHERE task_id = '$TID' AND type IN ('decision_point','safety_verdict')
    ORDER BY start_time;"

# ── 6. Errors & termination — the bug surface and the kill story, co-located ──
# For crashed/stopped runs the termination CAUSE is usually the finding, and it
# is spread across three tables. Pull it together: error observations, journal
# errors, crashed sessions, the abnormal transitions (failed / hard_cap / stuck /
# crash), and the health.* events that often precede a kill.
sec "6. ERRORS & TERMINATION  (bug surface + the kill story)"
echo "── error observations ──"
qc "SELECT datetime(start_time) at, name, phase, substr(error_message,1,66) error
    FROM observations WHERE task_id = '$TID' AND (type = 'error' OR level = 'error' OR status = 'error')
    ORDER BY start_time;"
echo; echo "── journal error entries (summary + detail) ──"
q ".mode line" "SELECT timestamp, phase, summary, substr(coalesce(error_detail,detail,''),1,300) AS detail
    FROM journal_entries WHERE task_id = '$TID' AND type = 'error' ORDER BY timestamp;"
echo "── abnormal transitions (failed / hard_cap / stuck / crash) ──"
qc "SELECT datetime(timestamp) at, from_state||' → '||to_state move, reason, triggered_by
    FROM state_transitions WHERE task_id = '$TID'
      AND (to_state='failed' OR reason LIKE '%hard_cap%' OR reason LIKE '%stuck%' OR reason LIKE '%crash%')
    ORDER BY timestamp;"
echo "── crashed sessions ──"
qc "SELECT substr(id,1,14) session, datetime(ended_at) ended FROM sessions
    WHERE task_id = '$TID' AND end_reason = 'crashed' ORDER BY started_at;"
echo "── health.* events naming this task (stuck/unhealthy precede many kills) ──"
qc "SELECT datetime(timestamp) at, type, substr(payload,1,80) payload FROM events
    WHERE type LIKE 'health.%' AND payload LIKE '%${TID}%' ORDER BY timestamp;"

# ── 7. Checkpoints — what each phase carried forward ──────────────────────────
# Carry-forward infra: if it's wired, every phase should populate key_findings /
# open_questions / next_action. All-empty rows on every phase is itself a finding
# (built-but-unwired observability) — the observer's what-happened/now/next view
# reads this, so empty shells assert "nothing to carry" with false authority.
sec "7. CHECKPOINTS  (phase carry-forward — all-empty across phases is a finding)"
qc "SELECT datetime(timestamp) at, phase, substr(sub_phase,1,12) sub,
      length(key_findings) kf_len, length(open_questions) oq_len, substr(next_action,1,40) next_action
    FROM checkpoints WHERE task_id = '$TID' ORDER BY timestamp;"
echo "(kf_len/oq_len: 2 = empty JSON array '[]'. Open one row's full content via §Deep-dive if non-empty.)"

# ── 8. Data-integrity checks — deterministic anomaly flags ────────────────────
# Catch the impossible-ordering / stale-stamp class of Core bug by construction,
# so it's never left to the assessor eyeballing raw timestamps in §1.
sec "8. DATA-INTEGRITY CHECKS  (deterministic flags — empty = clean)"
q "SELECT '⚠ completed_at precedes started_at — '||completed_at||' < '||started_at
   FROM tasks WHERE id='$TID' AND completed_at IS NOT NULL AND started_at IS NOT NULL AND completed_at < started_at
   UNION ALL
   SELECT '⚠ completed_at is set but state is not completed (state='||state||') — stale/uncleared stamp'
   FROM tasks WHERE id='$TID' AND completed_at IS NOT NULL AND state!='completed';"
echo "counters: total_reworks / phase_iteration — cross-check against §3 backward jumps:"
qc "SELECT total_reworks, phase_iteration FROM tasks WHERE id='$TID';"

# ── 9. Key events — git, cost, comms ──────────────────────────────────────────
sec "9. EVENTS  (audit trail: git / cost / comms)"
echo "── git & delivery ──"
qc "SELECT datetime(timestamp) at, type, substr(payload,1,70) payload FROM events
    WHERE task_id = '$TID' AND (type LIKE 'git.%' OR type LIKE 'workspace.%')
    ORDER BY timestamp;"
echo; echo "── cost trajectory (per agent step) ──"
qc "SELECT datetime(timestamp) at, printf('\$%.2f', json_extract(payload,'\$.spend_usd')) spend,
      json_extract(payload,'\$.operation') operation, json_extract(payload,'\$.total_tokens') tokens,
      json_extract(payload,'\$.model_id') model FROM events
    WHERE task_id = '$TID' AND type = 'cost.incurred' ORDER BY timestamp;"
echo "── comms (to/from the owner) ──"
qc "SELECT datetime(timestamp) at, type, substr(payload,1,60) payload FROM events
    WHERE task_id = '$TID' AND type LIKE 'comm.%' ORDER BY timestamp;"

# ── 10. Trace files — raw agent conversations, for targeted deep-dive ─────────
# Per-sub-phase NDJSON streams, all dispatches together under traces/sessions/<task-id>/,
# named <sub-phase>-<timestamp>.ndjson. Large (often 100s of KB). Do NOT read whole —
# open the specific one a finding points at, and grep/jq within it (see SKILL.md §Deep-dive).
sec "10. TRACE FILES  (raw agent conversations — open only the ones a finding points at)"
TDIR="$HOME_DIR/traces/sessions/$TID"
if [ -d "$TDIR" ]; then
  echo "dir: $TDIR"
  ls -lh "$TDIR"/*.ndjson 2>/dev/null | awk '{printf "   %6s  %s\n", $5, $NF}' || echo "   (no trace files)"
else
  echo "No trace directory at $TDIR (traces may have been swept, or none emitted yet)."
fi

# ── 11. Workspace — the actual deliverable: commits & diff ────────────────────
# Separate the task's OWN work from anything merged in. When a pr_event re-entry
# (§3/§4) pulled the base into the branch, `base..HEAD` mixes merged-in commits
# and files with the task's contribution — judge scope on the task's own commits.
sec "11. WORKSPACE  (commits & diff — separate the task's own work from merged-in)"
WS="$(q "SELECT coalesce(json_extract(workspace,'\$.worktree_path'),'') FROM tasks WHERE id = '$TID';")"
BASE="$(q "SELECT coalesce(json_extract(workspace,'\$.base_branch'),'') FROM tasks WHERE id = '$TID';")"
if [ -n "$WS" ] && [ -d "$WS" ]; then
  echo "worktree: $WS    base: ${BASE:-origin/HEAD}"
  REF="origin/${BASE:-HEAD}"
  echo; echo "── the task's OWN commits (--no-merges, $REF..HEAD) ──"
  git -C "$WS" log --oneline --no-decorate --no-merges "$REF..HEAD" 2>/dev/null \
    || git -C "$WS" log --oneline --no-merges -20 2>/dev/null || echo "   (could not read git log)"
  MERGES="$(git -C "$WS" log --oneline --merges "$REF..HEAD" 2>/dev/null || true)"
  if [ -n "$MERGES" ]; then
    echo; echo "── merge commits present (base was pulled in — diff includes merged-in files) ──"
    printf '%s\n' "$MERGES"
  fi
  echo; echo "── diffstat vs base ──"
  git -C "$WS" diff --stat "$REF...HEAD" 2>/dev/null | tail -40 \
    || echo "   (could not compute diffstat — base ref unknown)"
else
  echo "No workspace recorded on the task (worktree may have been reaped after completion)."
fi

hr
echo "Spine complete. Next: interpret it, then deep-dive only where a finding points (§10 trace files, §11 diff)."
