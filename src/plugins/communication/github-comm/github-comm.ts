import { Octokit } from "@octokit/rest";
import { AdapterMethodError } from "../../../adapters/errors.js";
import {
  CommunicationAdapter,
  type FormattedMessage,
  type HealthStatus,
  type InitResult,
  type IssueOptions,
  type IssueResult,
  type IssueUpdates,
  type MessageType,
  type ReconciliationResult,
  type SendResult,
  type SyncMetadata,
  type Target,
  type TaskReconciliationInput,
  createAdapterError,
} from "../../../adapters/index.js";
import { type GitHubCommConfig, GitHubCommConfigSchema } from "./config.js";
import { diffStateLabels, parseGitHubUrl, parseTargetChannel } from "./github-utils.js";

/** Message type → GitHub markdown prefix. */
const TYPE_PREFIXES: Record<MessageType, string> = {
  notification: "> **Info**",
  question: "> **Question**",
  status_response: "> **Status**",
  milestone: "> **Milestone**",
  alert: "> **Alert**",
};

/**
 * GitHubCommPlugin — communicates via GitHub issue/PR comments and labels.
 *
 * Capabilities: send, sync, issue_management.
 * "receive" deferred — see future-considerations.md.
 *
 * Communication plugins are dumb transport (Decision #40).
 * Orchestrator owns all intelligence.
 */
export class GitHubCommPlugin extends CommunicationAdapter {
  private config!: GitHubCommConfig;
  protected octokit!: Octokit;

  override hasCapability(capability: string): boolean {
    return ["send", "sync", "issue_management"].includes(capability);
  }

  formatMessage(content: string, type: MessageType): string {
    const prefix = TYPE_PREFIXES[type] ?? "";
    return prefix ? `${prefix}\n\n${content}` : content;
  }

  protected async doSendMessage(target: Target, message: FormattedMessage): Promise<SendResult> {
    const parsed = target.channel ? parseTargetChannel(target.channel) : null;
    if (!parsed) {
      return {
        success: false,
        message_id: null,
        error: createAdapterError(
          "invalid_input",
          `Invalid target channel: expected "owner/repo#number", got "${target.channel ?? "null"}"`,
        ),
      };
    }

    try {
      const { data } = await this.octokit.issues.createComment({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.issueNumber,
        body: message.content,
      });
      return {
        success: true,
        message_id: String(data.id),
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        message_id: null,
        error: createAdapterError(
          classifyGitHubError(error),
          error instanceof Error ? error.message : String(error),
          { retryable: isRetryable(error) },
        ),
      };
    }
  }

  protected async doSyncTaskState(
    _taskId: string,
    _oldState: string,
    newState: string,
    metadata: SyncMetadata,
  ): Promise<void> {
    if (!metadata.external_ref) {
      return;
    }
    const parsed = parseGitHubUrl(metadata.external_ref);
    if (!parsed) {
      return;
    }

    try {
      // Get current labels
      const { data: labels } = await this.octokit.issues.listLabelsOnIssue({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.number,
      });
      const currentLabels = labels.map((l) => l.name);
      const diff = diffStateLabels(currentLabels, newState, this.config.label_prefix);

      // Add new label
      if (diff.add.length > 0) {
        await this.octokit.issues.addLabels({
          owner: parsed.owner,
          repo: parsed.repo,
          issue_number: parsed.number,
          labels: diff.add,
        });
      }

      // Remove old labels
      for (const label of diff.remove) {
        try {
          await this.octokit.issues.removeLabel({
            owner: parsed.owner,
            repo: parsed.repo,
            issue_number: parsed.number,
            name: label,
          });
        } catch {
          // Label may already be gone — ignore 404s
        }
      }
    } catch (error) {
      throw new AdapterMethodError(
        createAdapterError(
          classifyGitHubError(error),
          `Failed to sync state for ${metadata.external_ref}: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: isRetryable(error), severity: "error" },
        ),
      );
    }
  }

  protected async doReconcileState(
    tasks: TaskReconciliationInput[],
  ): Promise<ReconciliationResult> {
    let reconciled = 0;
    const errors: Array<{ task_id: string; reason: string }> = [];

    for (const task of tasks) {
      const result = await this.reconcileOneTask(task);
      if (result === "reconciled") {
        reconciled++;
      } else if (result !== "ok") {
        errors.push({ task_id: task.task_id, reason: result });
      }
    }

    return { reconciled, errors };
  }

  private async reconcileOneTask(
    task: TaskReconciliationInput,
  ): Promise<"ok" | "reconciled" | string> {
    try {
      const parsed = parseGitHubUrl(task.external_ref);
      if (!parsed) {
        return "invalid_external_ref";
      }

      const { data: labels } = await this.octokit.issues.listLabelsOnIssue({
        owner: parsed.owner,
        repo: parsed.repo,
        issue_number: parsed.number,
      });

      const currentLabels = labels.map((l) => l.name);
      if (currentLabels.includes(task.expected_label)) {
        return "ok";
      }

      await this.applyLabelDiff(
        parsed.owner,
        parsed.repo,
        parsed.number,
        currentLabels,
        task.expected_state,
      );
      return "reconciled";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async applyLabelDiff(
    owner: string,
    repo: string,
    issueNumber: number,
    currentLabels: string[],
    newState: string,
  ): Promise<void> {
    const diff = diffStateLabels(currentLabels, newState, this.config.label_prefix);
    if (diff.add.length > 0) {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: diff.add,
      });
    }
    for (const label of diff.remove) {
      try {
        await this.octokit.issues.removeLabel({
          owner,
          repo,
          issue_number: issueNumber,
          name: label,
        });
      } catch {
        // Ignore — label may already be gone
      }
    }
  }

  protected async doCommentOnIssue(
    repo: string,
    issueNumber: number,
    comment: string,
  ): Promise<void> {
    const [owner, repoName] = repo.split("/");
    if (!(owner && repoName)) {
      throw new AdapterMethodError(
        createAdapterError(
          "invalid_input",
          `Invalid repo format: expected "owner/repo", got "${repo}"`,
        ),
      );
    }
    await this.octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      body: comment,
    });
  }

  protected async doCreateIssue(repo: string, options: IssueOptions): Promise<IssueResult> {
    const [owner, repoName] = repo.split("/");
    if (!(owner && repoName)) {
      throw new AdapterMethodError(
        createAdapterError(
          "invalid_input",
          `Invalid repo format: expected "owner/repo", got "${repo}"`,
        ),
      );
    }
    const params: Record<string, unknown> = {
      owner,
      repo: repoName,
      title: options.title,
      body: options.body,
    };
    if (options.labels) {
      params["labels"] = options.labels;
    }
    if (options.assignees) {
      params["assignees"] = options.assignees;
    }
    const { data } = await this.octokit.issues.create(
      params as Parameters<typeof this.octokit.issues.create>[0],
    );
    return { number: data.number, url: data.html_url };
  }

  protected async doUpdateIssue(
    repo: string,
    issueNumber: number,
    updates: IssueUpdates,
  ): Promise<void> {
    const [owner, repoName] = repo.split("/");
    if (!(owner && repoName)) {
      throw new AdapterMethodError(
        createAdapterError(
          "invalid_input",
          `Invalid repo format: expected "owner/repo", got "${repo}"`,
        ),
      );
    }

    // Update state/body
    const updateParams: Record<string, unknown> = {
      owner,
      repo: repoName,
      issue_number: issueNumber,
    };
    if (updates.state !== null) {
      updateParams["state"] = updates.state;
    }
    if (updates.body !== null) {
      updateParams["body"] = updates.body;
    }

    if (updates.state !== null || updates.body !== null) {
      await this.octokit.issues.update(
        updateParams as Parameters<typeof this.octokit.issues.update>[0],
      );
    }

    // Add labels
    if (updates.labels_add && updates.labels_add.length > 0) {
      await this.octokit.issues.addLabels({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        labels: updates.labels_add,
      });
    }

    // Remove labels
    if (updates.labels_remove) {
      for (const label of updates.labels_remove) {
        try {
          await this.octokit.issues.removeLabel({
            owner,
            repo: repoName,
            issue_number: issueNumber,
            name: label,
          });
        } catch {
          // Label may already be gone
        }
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = GitHubCommConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    this.config = parsed.data;
    this.octokit = new Octokit({ auth: this.config.github_token });
    return Promise.resolve({ success: true, message: null });
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    try {
      const { data } = await this.octokit.rateLimit.get();
      const remaining = data.resources.core.remaining;
      const limit = data.resources.core.limit;
      return {
        healthy: remaining > 100,
        message:
          remaining > 100
            ? `GitHub API: ${String(remaining)}/${String(limit)} remaining`
            : `GitHub API rate limit low: ${String(remaining)}/${String(limit)}`,
        details: { remaining, limit },
      };
    } catch (error) {
      return {
        healthy: false,
        message: `GitHub API error: ${error instanceof Error ? error.message : String(error)}`,
        details: null,
      };
    }
  }

  protected doShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Module-level helpers ────────────────────────────────────────────────────

function classifyGitHubError(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    if (status === 401 || status === 403) {
      return "auth_failed";
    }
    if (status === 404) {
      return "not_found";
    }
    if (status === 429) {
      return "rate_limited";
    }
  }
  return "network_error";
}

function isRetryable(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    return status === 429 || status >= 500;
  }
  return true;
}
