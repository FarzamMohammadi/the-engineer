import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";
import type { OrchestratorContext } from "./types.js";

// ── OrchestratorNotifier Interface ─────────────────────────────────────────

/** Orchestrator-tier notifications — milestone alerts and ticket comments. */
export interface OrchestratorNotifier {
  /** Send a milestone notification via PeopleDirectory + comm plugins (D152). */
  notifyMilestone(dispatch: Dispatch, message: string): void;
  /** Post a comment on the source trigger ticket. */
  commentOnSourceTicket(dispatch: Dispatch, message: string): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create an OrchestratorNotifier bound to the given context. */
export function createOrchestratorNotifier(ctx: OrchestratorContext): OrchestratorNotifier {
  function notifyMilestone(dispatch: Dispatch, message: string): void {
    try {
      const owner = ctx.peopleDirectory.getOwner();
      if (!owner || owner.contacts.length === 0) {
        return;
      }

      const commPlugins = ctx.registry.getPluginsByType<CommunicationAdapter>(
        AdapterTypes.communication,
      );
      if (commPlugins.length === 0) {
        return;
      }

      const taskId = dispatch.task.id;

      for (const contact of owner.contacts) {
        const plugin = commPlugins.find((p) => p.hasCapability("send"));
        if (!plugin) {
          continue;
        }

        const target = {
          user_id: contact.handle,
          channel: contact.channel,
        };

        const formatted = {
          content: plugin.formatMessage(sanitizeSecrets(message), "milestone"),
          metadata: { task_id: taskId, type: "milestone" as const },
        };

        plugin.sendMessage(target, formatted).catch((err: unknown) => {
          // Non-blocking — notification failures must never interrupt the pipeline.
          ctx.observer.warn("Milestone notification send failed", {
            taskId,
            channel: contact.channel,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      // Unexpected error in the notification helper itself (not a send failure).
      // Send failures are caught above; this catch guards against bugs in the routing logic.
      ctx.observer.warn("Unexpected error in notifyMilestone", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function commentOnSourceTicket(dispatch: Dispatch, message: string): void {
    try {
      const externalRef = dispatch.task.external_ref;
      if (!externalRef) {
        return;
      }

      const commPlugins = ctx.registry.getPluginsByType<CommunicationAdapter>(
        AdapterTypes.communication,
      );
      const plugin = commPlugins.find((p) => p.hasCapability("ticket_management"));
      if (!plugin) {
        return;
      }

      plugin.commentOnTicket(externalRef, sanitizeSecrets(message)).catch((err: unknown) => {
        // Non-blocking — ticket comment failures must never interrupt the pipeline.
        ctx.observer.warn("Ticket comment failed", {
          taskId: dispatch.task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      // Unexpected error in the comment helper itself (not a send failure).
      ctx.observer.warn("Unexpected error in commentOnSourceTicket", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { notifyMilestone, commentOnSourceTicket };
}
