import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";
import type { OrchestratorContext } from "./types.js";

// ── OrchestratorNotifier Interface ─────────────────────────────────────────

/** Orchestrator-tier notifications — milestone alerts and issue comments. */
export interface OrchestratorNotifier {
  /** Send a milestone notification via PeopleDirectory + comm plugins (D152). */
  notifyMilestone(dispatch: Dispatch, message: string): void;
  /** Post a comment on the source GitHub issue/PR. */
  commentOnSourceIssue(dispatch: Dispatch, message: string): void;
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
        const plugin = commPlugins.find(
          (p) => p.manifest.id === `${contact.channel}-comm` || p.manifest.id === contact.channel,
        );
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

  function commentOnSourceIssue(dispatch: Dispatch, message: string): void {
    try {
      const externalRef = dispatch.task.external_ref;
      if (
        !externalRef ||
        (externalRef.type !== "github_issue" && externalRef.type !== "github_pr")
      ) {
        return;
      }

      const commPlugins = ctx.registry.getPluginsByType<CommunicationAdapter>(
        AdapterTypes.communication,
      );
      const plugin = commPlugins.find((p) => p.hasCapability("issue_management"));
      if (!plugin) {
        return;
      }

      plugin
        .commentOnIssue(externalRef.repo, externalRef.number, sanitizeSecrets(message))
        .catch((err: unknown) => {
          // Non-blocking — issue comment failures must never interrupt the pipeline.
          ctx.observer.warn("Issue comment failed", {
            repo: externalRef.repo,
            number: externalRef.number,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      // Unexpected error in the comment helper itself (not a send failure).
      ctx.observer.warn("Unexpected error in commentOnSourceIssue", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { notifyMilestone, commentOnSourceIssue };
}
