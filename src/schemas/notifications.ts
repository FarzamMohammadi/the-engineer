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

/** Typed notification payload. Each kind carries exactly the fields it needs. */
export type Notification =
  // Daemon lifecycle — resolved from taskId (title looked up internally)
  | { kind: "completion"; taskId: string }
  | { kind: "review_pending"; taskId: string }
  | { kind: "task_error"; taskId: string; reason: string }
  | { kind: "cost_limit"; taskId: string }
  | { kind: "blocked_reminder"; taskId: string }
  | { kind: "escalation_alert"; taskId: string }
  | { kind: "review_reminder"; taskId: string; elapsedMs: number }
  // Orchestrator + direct — custom message or person-targeted
  | { kind: "question"; taskId: string; personId: string; message: string }
  | { kind: "milestone"; taskId: string; message: string }
  | { kind: "alert"; taskId: string; message: string }
  | { kind: "status_response"; taskId: string | null; personId: string; message: string }
  | { kind: "ticket_comment"; taskId: string; message: string };

// ── Recipients Mapping ──────────────────────────────────────────────────────

export type Recipients = "owner" | "reviewers" | "owner_and_reviewers" | "person";

/** Map notification kind → who receives it. */
export function recipientsForKind(kind: NotificationKind): Recipients {
  switch (kind) {
    case "escalation_alert":
      return "owner_and_reviewers";
    case "review_reminder":
      return "reviewers";
    case "question":
    case "status_response":
      return "person";
    default:
      return "owner";
  }
}
