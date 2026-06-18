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
    title, description, repo, workspace,
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

# ── 3. The pipeline journey — agent_call per sub-phase, in order ───────────────
# This is the most legible view of how the run actually moved through RRPIR.
# Watch for: error status, repeats of a sub-phase, and bounces back to an
# earlier phase (e.g. delivery → execution) that signal rework loops.
sec "3. PIPELINE JOURNEY  (sub-phase calls in order — repeats & backward jumps = rework)"
qc "SELECT datetime(start_time) at, phase, name sub_phase, status,
      printf('%.1fs', duration_ms/1000.0) dur, coalesce(substr(error_message,1,46),'') error
    FROM observations
    WHERE task_id = '$TID' AND type = 'agent_call'
    ORDER BY start_time;"

# ── 4. State machine history ──────────────────────────────────────────────────
sec "4. STATE TRANSITIONS  (from → to, why, who)"
qc "SELECT datetime(timestamp) at, from_state||' → '||to_state move,
      substr(reason,1,40) reason, triggered_by
    FROM state_transitions WHERE task_id = '$TID' ORDER BY timestamp;"

# ── 5. Orchestrator decisions — routing, skips, gates ─────────────────────────
# route:* = where the orchestrator sent the task next (it decides the route, the
# agent never picks a phase). skip:* = a review lens that was skipped. These are
# the system's reasoning made inspectable — check each one made sense.
sec "5. DECISIONS  (route:* / skip:* / gates / autonomy — the orchestrator's reasoning)"
qc "SELECT datetime(start_time) at, name decision, coalesce(substr(metadata,1,60),'') detail
    FROM observations
    WHERE task_id = '$TID' AND type IN ('decision_point','safety_verdict')
    ORDER BY start_time;"

# ── 6. Errors & crashes — the bug surface ─────────────────────────────────────
sec "6. ERRORS  (observations + journal errors + crashed sessions)"
echo "── error observations ──"
qc "SELECT datetime(start_time) at, name, phase, substr(error_message,1,70) error
    FROM observations WHERE task_id = '$TID' AND (type = 'error' OR level = 'error' OR status = 'error')
    ORDER BY start_time;"
echo; echo "── journal error entries (summary + detail) ──"
q ".mode line" "SELECT timestamp, phase, summary, substr(coalesce(error_detail,detail,''),1,300) AS detail
    FROM journal_entries WHERE task_id = '$TID' AND type = 'error' ORDER BY timestamp;"
echo "── crashed sessions ──"
qc "SELECT substr(id,1,14) session, datetime(ended_at) ended FROM sessions
    WHERE task_id = '$TID' AND end_reason = 'crashed' ORDER BY started_at;"

# ── 7. Key events — cost, git, comms, health ──────────────────────────────────
sec "7. EVENTS  (audit trail: git / cost / comms / health)"
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

# ── 8. Trace files — raw agent conversations, for targeted deep-dive ──────────
# Per-sub-phase NDJSON streams, all dispatches together under traces/sessions/<task-id>/,
# named <sub-phase>-<timestamp>.ndjson. Large (often 100s of KB). Do NOT read whole —
# open the specific one a finding points at, and grep/jq within it (see SKILL.md §Deep-dive).
sec "8. TRACE FILES  (raw agent conversations — open only the ones a finding points at)"
TDIR="$HOME_DIR/traces/sessions/$TID"
if [ -d "$TDIR" ]; then
  echo "dir: $TDIR"
  ls -lh "$TDIR"/*.ndjson 2>/dev/null | awk '{printf "   %6s  %s\n", $5, $NF}' || echo "   (no trace files)"
else
  echo "No trace directory at $TDIR (traces may have been swept, or none emitted yet)."
fi

# ── 9. Workspace — the actual deliverable: commits & diff ─────────────────────
sec "9. WORKSPACE  (commits & diff — the real output)"
# workspace is a JSON object; pull the worktree_path out of it (NULL-safe).
WS="$(q "SELECT coalesce(json_extract(workspace,'\$.worktree_path'),'') FROM tasks WHERE id = '$TID';")"
if [ -n "$WS" ] && [ -d "$WS" ]; then
  echo "worktree: $WS"; echo
  echo "── commits on this branch (not on the base) ──"
  git -C "$WS" log --oneline --no-decorate origin/HEAD..HEAD 2>/dev/null \
    || git -C "$WS" log --oneline -20 2>/dev/null || echo "   (could not read git log)"
  echo; echo "── diffstat vs base ──"
  git -C "$WS" diff --stat origin/HEAD...HEAD 2>/dev/null | tail -40 \
    || echo "   (could not compute diffstat — base ref unknown)"
else
  echo "No workspace recorded on the task (worktree may have been reaped after completion)."
fi

hr
echo "Spine complete. Next: interpret it, then deep-dive only where a finding points (§8 trace files, §9 diff)."
