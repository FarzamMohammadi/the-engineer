import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { CommunicationAdapter } from "../../adapters/communication.js";
import type { SendResult } from "../../schemas/adapters.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { BlockedDetails, ExternalRef } from "../../schemas/task.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type OutreachResult =
  | { delivered: true; contacted: BlockedDetails["contacted"] }
  | { delivered: false; reason: "no_send_adapters" | "all_delivery_failed" | "no_files" };

export interface OutreachDeps {
  peopleDirectory: IPeopleDirectory;
  registry: IPluginLookup;
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
 * People Directory, routes through preferred channel, and optionally
 * posts a summary comment on the source trigger ticket.
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
  const { peopleDirectory, registry, observer, eventBus } = deps;

  if (!existsSync(outreachDir)) {
    return { delivered: false, reason: "no_files" };
  }

  const files = readdirSync(outreachDir).filter((f) => f.endsWith(".txt"));
  if (files.length === 0) {
    return { delivered: false, reason: "no_files" };
  }

  const commPlugins = registry.getPluginsByType<CommunicationAdapter>(AdapterTypes.communication);
  const sendPlugins = commPlugins.filter((p: CommunicationAdapter) => p.hasCapability("send"));
  if (sendPlugins.length === 0) {
    observer.warn("No comm plugins with send capability — outreach not delivered", {
      taskId,
      fileCount: files.length,
    });
    return { delivered: false, reason: "no_send_adapters" };
  }

  const contacted: BlockedDetails["contacted"] = [];
  const sendPromises: Promise<void>[] = [];

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

    // Route to preferred channel via resolveContact
    const resolvedContact = contact.contacts[0];
    if (!resolvedContact) {
      observer.warn("Outreach: contact has no channels configured", {
        taskId,
        personId: contact.id,
      });
      continue;
    }

    // Find a send-capable plugin (preferred channel routing)
    const plugin = sendPlugins[0];
    if (!plugin) {
      continue;
    }

    const formatted = plugin.formatMessage(messageWithRef, "question");
    sendPromises.push(
      plugin
        .sendMessage(
          { user_id: resolvedContact.handle, channel: resolvedContact.channel },
          { content: formatted, metadata: { task_id: taskId, type: "question" } },
        )
        .then((result: SendResult) => {
          if (result.success) {
            observer.info("Outreach delivered", {
              taskId,
              personId: contact.id,
              channel: resolvedContact.channel,
            });
            contacted.push({
              person: contact.id,
              channel: resolvedContact.channel,
              timestamp: new Date().toISOString(),
            });
            eventBus.publish({
              type: "comm.message_sent",
              source: "orchestrator",
              task_id: taskId,
              payload: {
                task_id: taskId,
                target: contact.id,
                message_type: "question" as const,
                content_summary: message,
                channel: resolvedContact.channel,
              },
            } satisfies PublishInput<"comm.message_sent">);
          } else {
            observer.warn("Outreach delivery failed", {
              taskId,
              personId: contact.id,
              error: result.error?.message ?? "unknown",
            });
          }
        })
        .catch((err: unknown) => {
          observer.warn("Outreach send error", {
            taskId,
            personId: contact.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  // Post outreach summary as a comment on the source trigger ticket
  commentOnSourceTicket(taskId, files, commPlugins, sendPromises, externalRef, observer);

  await Promise.allSettled(sendPromises);

  if (contacted.length > 0) {
    return { delivered: true, contacted };
  }
  return { delivered: false, reason: "all_delivery_failed" };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Post outreach summary as a comment on the originating trigger ticket. */
function commentOnSourceTicket(
  taskId: string,
  files: string[],
  commPlugins: CommunicationAdapter[],
  sendPromises: Promise<void>[],
  externalRef: ExternalRef | null,
  observer: IObserver,
): void {
  const ticketPlugin = commPlugins.find((p) => p.hasCapability("ticket_management"));
  if (!ticketPlugin || !externalRef) {
    return;
  }
  const summary = files.map((f) => `- ${f.replace(TXT_SUFFIX_RE, "")}`).join("\n");
  sendPromises.push(
    ticketPlugin
      .commentOnTicket(externalRef, `Blocked — reaching out for answers:\n\n${summary}`)
      .then(() => {
        observer.info("Outreach ticket comment posted", { taskId });
      })
      .catch((err: unknown) => {
        observer.warn("Ticket comment for outreach failed", {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
  );
}
