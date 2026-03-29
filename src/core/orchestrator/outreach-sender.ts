import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BlockedDetails, ExternalRef } from "../../schemas/task.js";
import type { NotificationRouter } from "../daemon/notification-router.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type OutreachResult =
  | { delivered: true; contacted: BlockedDetails["contacted"] }
  | { delivered: false; reason: "no_files" | "no_contacts" };

export interface OutreachDeps {
  peopleDirectory: IPeopleDirectory;
  notifications: NotificationRouter;
  eventBus: IEventBus;
  observer: IObserver;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TXT_SUFFIX_RE = /\.txt$/;

// ── Main Function ──────────────────────────────────────────────────────────

/**
 * Send outreach messages from files written by the LLM.
 *
 * Reads `.txt` files from `outreachDir`, validates person IDs against
 * People Directory, routes through the centralized NotificationRouter,
 * and optionally posts a summary comment on the source trigger ticket.
 *
 * Returns an OutreachResult indicating whether outreach was delivered.
 * The caller uses this to decide whether blocking is safe.
 */
export async function sendOutreach(
  taskId: string,
  outreachDir: string,
  externalRef: ExternalRef | null,
  deps: OutreachDeps,
): Promise<OutreachResult> {
  const { peopleDirectory, notifications, observer } = deps;

  if (!existsSync(outreachDir)) {
    return { delivered: false, reason: "no_files" };
  }

  const files = readdirSync(outreachDir).filter((f) => f.endsWith(".txt"));
  if (files.length === 0) {
    return { delivered: false, reason: "no_files" };
  }

  const contacted: BlockedDetails["contacted"] = [];

  for (const file of files) {
    // path.basename prevents path traversal from LLM output
    const safeFile = path.basename(file);
    const personId = safeFile.replace(TXT_SUFFIX_RE, "");
    const message = readFileSync(path.join(outreachDir, safeFile), "utf-8").trim();
    if (!message) {
      continue;
    }

    // Append task reference for response correlation
    const messageWithRef = `${message}\n\n[Task: ${taskId.slice(0, 8)}]`;

    // Validate person against People Directory, fall back to owner
    const person = peopleDirectory.getPerson(personId);
    const contact = person ?? peopleDirectory.getOwner();
    if (!contact) {
      observer.warn("Outreach: no contact found and no owner configured", { taskId, personId });
      continue;
    }

    if (!person) {
      observer.warn("Outreach: person not found, falling back to owner", { taskId, personId });
    }

    // Route through centralized notification router
    notifications.notify({
      kind: "question",
      taskId,
      personId: contact.id,
      message: messageWithRef,
    });

    // Record contacted for blocked details
    const resolvedContact = contact.contacts[0];
    if (resolvedContact) {
      contacted.push({
        person: contact.id,
        channel: resolvedContact.channel,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Post outreach summary as a comment on the source trigger ticket
  if (externalRef && files.length > 0) {
    const summary = files.map((f) => `- ${f.replace(TXT_SUFFIX_RE, "")}`).join("\n");
    notifications.notify({
      kind: "ticket_comment",
      taskId,
      message: `Blocked — reaching out for answers:\n\n${summary}`,
    });
  }

  if (contacted.length > 0) {
    return { delivered: true, contacted };
  }
  return { delivered: false, reason: "no_contacts" };
}
