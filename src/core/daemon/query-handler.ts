import type { CommMessageReceivedPayload } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { type Task, TaskStateSchema, TaskStates } from "../../schemas/task.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";
import type { NotificationRouter } from "./notification-router.js";

// ── Query Vocabulary ───────────────────────────────────────────────────────

/**
 * The supported inbound query forms. Slash-free by design: Telegram drops `/`-prefixed messages, so the
 * vocabulary is plain words the owner types directly (`status`, `cost`, `progress #N`, `help`).
 */
export type QueryKind = "status" | "cost" | "progress" | "help" | "unknown";

const PROGRESS_RE = /progress.*#(\d+)|#(\d+).*progress/;

/** Classify an inbound message into a supported query form, or `"unknown"` when no form matches. */
export function classifyQuery(content: string): QueryKind {
  const lower = content.toLowerCase();
  if (PROGRESS_RE.test(lower)) {
    return "progress";
  }
  if (lower.includes("cost")) {
    return "cost";
  }
  if (lower.includes("status")) {
    return "status";
  }
  if (lower.includes("help")) {
    return "help";
  }
  return "unknown";
}

/**
 * Whether an inbound message matches the query vocabulary. The poller uses this to discriminate a query
 * from an unblock reply BEFORE the sole-blocked fallback: a query-vocabulary match wins, so the owner can
 * ask `status` even while exactly one task is blocked.
 */
export function isQueryVocabulary(content: string): boolean {
  return classifyQuery(content) !== "unknown";
}

// ── Handler ──────────────────────────────────────────────────────────────────

export interface QueryHandlerDeps {
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  notifications: NotificationRouter;
  peopleDirectory: IPeopleDirectory;
  observer: IObserver;
}

/**
 * Why the poller routed this message to the query handler rather than treating it as an unblock reply.
 * `unmatched_multi_blocked` is the diagnostic case: a non-query message arrived while 2+ tasks were blocked,
 * so it could not be matched to one — the owner gets a "couldn't match" notice instead of a generic help.
 */
export type QueryRoutingReason = "query_vocabulary" | "no_blocked_task" | "unmatched_multi_blocked";

export interface HandleQueryOptions {
  /** Number of tasks blocked when the message arrived — drives the `unmatched_multi_blocked` notice. */
  blockedCount?: number;
  /** Why the poller routed this as a query (for observability + the unmatched-multi-blocked branch). */
  reason?: QueryRoutingReason;
}

/**
 * Handle an inbound communication message as a query.
 *
 * Keyword-matches the query form, routes to the data source, formats a short plain-language response, and
 * sends it back to the OWNER (single-user: the sender IS the owner) through the notification router. The
 * dashboard remains the full detail surface; these responses stay short and scannable.
 */
export function handleQuery(
  payload: CommMessageReceivedPayload,
  deps: QueryHandlerDeps,
  options: HandleQueryOptions = {},
): void {
  const { taskEngine, safetyLayer, notifications, peopleDirectory, observer } = deps;
  const kind = classifyQuery(payload.content);

  const response = formatResponse(kind, payload.content, { taskEngine, safetyLayer }, options);

  // Single-user: every human-targeted message resolves to the owner. The sender IS the owner, but the raw
  // sender handle (e.g. a Telegram username) is not a people-directory id — so resolve the owner explicitly
  // rather than relying on the router's getOwner() fallback when getPerson() misses.
  const owner = peopleDirectory.getOwner();
  if (!owner) {
    observer.warn("Inbound query received but no owner is configured — cannot reply", {
      kind,
      source: payload.source,
    });
    return;
  }

  notifications.notify({
    kind: NotificationKinds.status_response,
    taskId: null,
    personId: owner.id,
    message: response,
  });

  observer.observe(
    ObservationTypes.lifecycle,
    "inbound_query_handled",
    {
      query_kind: kind,
      routing_reason: options.reason ?? "query_vocabulary",
      source: payload.source,
      response_summary: response,
    },
    { level: "info" },
  );
}

// ── Response Formatting ────────────────────────────────────────────────────

interface FormatterDeps {
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
}

function formatResponse(kind: QueryKind, content: string, deps: FormatterDeps, options: HandleQueryOptions): string {
  switch (kind) {
    case "progress":
      return formatProgressResponse(deps.taskEngine, extractIssueNumber(content));
    case "cost":
      return formatCostResponse(deps.safetyLayer);
    case "status":
      return formatStatusResponse(deps.taskEngine);
    case "help":
      return formatHelpResponse();
    default:
      return formatUnrecognizedResponse(options);
  }
}

function extractIssueNumber(content: string): string {
  const match = PROGRESS_RE.exec(content.toLowerCase());
  return (match?.[1] ?? match?.[2]) as string;
}

/**
 * Active and blocked tasks by id + title (the two states the owner acts on), plus a one-line count of the
 * rest. Blocked tasks carry their block reason so the owner sees why without opening the dashboard.
 */
function formatStatusResponse(taskEngine: ITaskEngine): string {
  const active = taskEngine.getTasksByState(TaskStates.active);
  const blocked = taskEngine.getTasksByState(TaskStates.blocked);

  const lines: string[] = [];
  for (const task of active) {
    lines.push(`active ${shortId(task.id)}: ${task.title}`);
  }
  for (const task of blocked) {
    const reason = task.blocked?.reason ? ` (${task.blocked.reason})` : "";
    lines.push(`blocked ${shortId(task.id)}: ${task.title}${reason}`);
  }

  const otherCounts = countOtherStates(taskEngine);
  if (lines.length === 0 && otherCounts.length === 0) {
    return "No tasks.";
  }

  const header = lines.length > 0 ? `Active and blocked tasks:\n${lines.join("\n")}` : "No active or blocked tasks.";
  return otherCounts.length > 0 ? `${header}\nOther: ${otherCounts.join(", ")}` : header;
}

/** Count tasks in every state other than active/blocked (already enumerated in full above). */
function countOtherStates(taskEngine: ITaskEngine): string[] {
  const counts: string[] = [];
  for (const state of TaskStateSchema.options) {
    if (state === TaskStates.active || state === TaskStates.blocked) {
      continue;
    }
    const tasks = taskEngine.getTasksByState(state);
    if (tasks.length > 0) {
      counts.push(`${state}: ${String(tasks.length)}`);
    }
  }
  return counts;
}

/**
 * Resolve a "progress #N" query, where N is the external issue number (e.g. issue 42), not the internal
 * task id (a ULID). Tasks carry the issue number on `external_ref.id`, so match against that across states.
 */
function formatProgressResponse(taskEngine: ITaskEngine, issueNumber: string): string {
  const task = findTaskByIssueNumber(taskEngine, issueNumber);
  if (!task) {
    return `Issue #${issueNumber} not found.`;
  }
  return [
    `Issue #${issueNumber}: ${task.title}`,
    `State: ${task.state}${task.sub_state ? ` (${task.sub_state})` : ""}`,
    `Priority: ${String(task.priority)}`,
    task.phase ? `Phase: ${task.phase}` : null,
    task.blocked?.reason ? `Blocked: ${task.blocked.reason}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Find the task whose external reference matches the given issue number, scanning all states. */
function findTaskByIssueNumber(taskEngine: ITaskEngine, issueNumber: string): Task | null {
  for (const state of TaskStateSchema.options) {
    for (const task of taskEngine.getTasksByState(state)) {
      if (task.external_ref?.id === issueNumber) {
        return task;
      }
    }
  }
  return null;
}

/**
 * Surface the cost verdict plus the per-window percent-of-limit warnings the safety layer raises near a
 * ceiling (e.g. "daily spend at 85% of limit"), so a `cost` query carries real spend-vs-limit signal.
 */
function formatCostResponse(safetyLayer: ISafetyLayer): string {
  const verdict = safetyLayer.consultJudgment({
    type: "cost_check",
    context: { task_id: "", repo: "", details: {} },
  });
  const headline = verdict.allowed ? "within limits" : "limit reached";
  const detail = verdict.reason ? ` — ${verdict.reason}` : "";
  const warnings = verdict.warnings && verdict.warnings.length > 0 ? `\n${verdict.warnings.join("\n")}` : "";
  return `Cost: ${headline}${detail}${warnings}`;
}

function formatHelpResponse(): string {
  return [
    "I understand:",
    "- status — active and blocked tasks",
    "- progress #N — detail for issue N",
    "- cost — spending vs limits",
    "- help — this message",
  ].join("\n");
}

/**
 * Unrecognized content. When 2+ tasks were blocked, the owner likely meant a reply we could not match to one
 * task — say so, name the count, and point at the unambiguous reply form. Otherwise fall back to help.
 */
function formatUnrecognizedResponse(options: HandleQueryOptions): string {
  if (options.reason === "unmatched_multi_blocked" && (options.blockedCount ?? 0) >= 2) {
    return `I couldn't match this to a blocked task — ${String(options.blockedCount)} are blocked. Reply on the task's ticket, or send "status" to see them.`;
  }
  return `I didn't understand that. ${formatHelpResponse()}`;
}

/** Short, scannable form of a task ULID for the owner's channel (the dashboard shows the full id). */
function shortId(id: string): string {
  return id.slice(0, 8);
}
