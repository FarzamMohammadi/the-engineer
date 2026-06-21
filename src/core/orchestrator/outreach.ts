import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { type NotificationCorrelation, NotificationKinds } from "../../schemas/notifications.js";
import type { NotificationRouter } from "../daemon/notification-router.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IObserver } from "../observer/index.js";

// This module owns "turn a blocked task's ask into a delivered question". A human block resolves to ONE
// canonical question — the asking sub-phase's outreach file(s), or its synthesized `needed` when it wrote
// none — and that one question is delivered to every surface the owner watches: their chat channel and the
// source ticket. The orchestrator persists the same text as `blocked.needed`, so the dashboard, the chat,
// and the ticket never show a different (or stale) question.

export interface QuestionDelivery {
  peopleDirectory: IPeopleDirectory;
  notifications: NotificationRouter;
  observer: IObserver;
}

/**
 * Resolve a blocked task's canonical question and deliver it uniformly to the owner's chat and the source
 * ticket; returns the question so the caller persists the same text as `blocked.needed` for the dashboard.
 *
 * The question is the asking sub-phase's outreach file(s) when it wrote any (`outreachDir`), else the
 * block's `needed` — the autonomy escalation synthesizes its question and writes no file, so it always
 * takes the latter path. Resolving from files consumes them, so a later block in the same sub-phase can
 * never re-send a prior block's stale ask.
 *
 * The ticket comment is posted first and unconditionally (it no-ops without an external ref), so a missing
 * owner is a WARN, not a lost question (`docs/constraints.md`: owner assumed, not required): the question
 * still lands on the dashboard and the ticket — we just cannot reach the owner on chat to say so.
 */
export function deliverBlockedQuestion(
  deps: QuestionDelivery,
  input: {
    taskId: string;
    subPhase: string;
    outreachDir: string | null;
    needed: string;
    correlation?: NotificationCorrelation;
  },
): string {
  const { peopleDirectory, notifications, observer } = deps;
  const { taskId, subPhase, outreachDir, needed, correlation } = input;

  const question = (outreachDir ? consumeOutreach(outreachDir) : null) ?? needed;
  const message = `${question}\n\n[Task: ${taskId.slice(0, 8)}]`;
  const trace = correlation ? { correlation } : {};

  notifications.notify({ kind: NotificationKinds.ticket_comment, taskId, message, ...trace });

  const owner = peopleDirectory.getOwner();
  if (!owner) {
    observer.warn("Task blocked on a human, but no owner is configured to receive the question on chat", {
      taskId,
      subPhase,
    });
    return question;
  }
  notifications.notify({ kind: NotificationKinds.question, taskId, personId: owner.id, message, ...trace });
  return question;
}

// ── Outreach Files ───────────────────────────────────────────────────────────

/**
 * Read the asking sub-phase's outreach files into one question, then DELETE them. The agent writes its
 * questions to `<resultDir>/outreach/<person-id>.txt` (gather's prompt — one file per person it needs).
 * Single-user (`docs/constraints.md`): the one human is the owner, so every file is the owner's, joined
 * into one canonical question.
 *
 * Files are CONSUMED as they are read: an outreach file is a pending ask for THIS block only. Consuming it
 * means a later block in the same sub-phase — a resumed run that surfaces an autonomy decision
 * (synthesized, no file) — can never re-send a prior block's stale ask. The question survives in the
 * persisted block payload and the ticket comment, so deleting the transient file loses nothing.
 *
 * Returns null when the sub-phase wrote no outreach file, so the caller falls back to the block's `needed`.
 */
function consumeOutreach(outreachDir: string): string | null {
  if (!existsSync(outreachDir)) {
    return null;
  }
  // Deterministic order so a multi-file join reads the same way every run.
  const files = readdirSync(outreachDir)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  if (files.length === 0) {
    return null;
  }

  const parts: string[] = [];
  for (const file of files) {
    // path.basename prevents path traversal from agent-written names.
    const full = path.join(outreachDir, path.basename(file));
    const content = readFileSync(full, "utf-8").trim();
    rmSync(full, { force: true });
    if (content) {
      parts.push(content);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
