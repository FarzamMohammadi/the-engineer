import { z } from "zod";

// ── Notification Kinds ──────────────────────────────────────────────────────

export const NotificationKindSchema = z.enum([
  // Daemon lifecycle
  "completion",
  "review_pending",
  "task_error",
  "cost_limit",
  "blocked_reminder",
  "escalation_alert",
  "review_reminder",
  "plugin_recovered",
  // Orchestrator + direct
  "question",
  "milestone",
  "alert",
  "status_response",
  "ticket_comment",
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** Constant enum values for NotificationKind. Use instead of raw strings. */
export const NotificationKinds = NotificationKindSchema.enum;

// ── Notification Discriminated Union ────────────────────────────────────────

/**
 * Typed notification payload. Each kind carries exactly the fields it needs.
 *
 * This union is a purely in-process message contract — built and consumed inside the daemon, never parsed
 * from YAML, an API, or a plugin return — so it never crosses a parse boundary. A hand-typed (compiler
 * enforced) union is deliberate here, not a Schema-First violation: Parse-Don't-Validate puts Zod at the
 * edges, and there is no edge for these. `NotificationKindSchema` above stays a Zod enum because the kind
 * string does reach durable storage and config-facing surfaces.
 */
export type Notification =
  // Daemon lifecycle — resolved from taskId (title looked up internally)
  | { kind: "completion"; taskId: string }
  | { kind: "review_pending"; taskId: string }
  | { kind: "task_error"; taskId: string; reason: string }
  | { kind: "cost_limit"; taskId: string }
  | { kind: "blocked_reminder"; taskId: string }
  | { kind: "escalation_alert"; taskId: string }
  | { kind: "review_reminder"; taskId: string; elapsedMs: number }
  // Plugin recovery — a previously failed plugin passed its health check again. Non-alert (the outage is
  // over, so this is good news, not an alarm). `taskId` is null — plugin health is not task-scoped — so the
  // dedup window keys on `source` (a stable "plugin:<plugin_id>" per the origin plugin), the same way alerts
  // do: one flapping plugin does not re-DM within the window, and two distinct plugins recovering do not
  // collapse to one key. `dedupKeyFor` reads `source` for this kind for exactly that reason.
  | { kind: "plugin_recovered"; taskId: null; message: string; source: string }
  // Orchestrator + direct — custom message or person-targeted
  | { kind: "question"; taskId: string; personId: string; message: string }
  | { kind: "milestone"; taskId: string; message: string }
  // `source` is the dedup key for null-task alerts (trigger/plugin/stuck health alerts): a stable
  // per-origin identifier (e.g. "trigger:github-trigger") so the suppress window dedups repeated
  // alerts from the same origin even when they carry no taskId. Task-scoped alerts dedup on taskId.
  | { kind: "alert"; taskId: string | null; message: string; source?: string }
  | { kind: "status_response"; taskId: string | null; personId: string; message: string }
  | { kind: "ticket_comment"; taskId: string; message: string };

// ── Recipients Mapping ──────────────────────────────────────────────────────

export type Recipients = "owner" | "reviewers" | "owner_and_reviewers" | "person";

/**
 * Map notification kind → who receives it.
 *
 * Single-user (`docs/constraints.md`): the owner is the whole team, so `review_reminder` resolves to the
 * owner — there is no separate reviewer to remind. `escalation_alert` keeps `owner_and_reviewers` so a
 * future multi-person edition fans out without a code change (the owner is included today either way).
 */
export function recipientsForKind(kind: NotificationKind): Recipients {
  switch (kind) {
    case "escalation_alert":
      return "owner_and_reviewers";
    case "review_reminder":
      return "owner";
    case "question":
    case "status_response":
      return "person";
    default:
      return "owner";
  }
}
