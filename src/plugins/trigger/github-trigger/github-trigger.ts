import { Octokit } from "@octokit/rest";
import { AdapterMethodError } from "../../../adapters/errors.js";
import {
  type HealthStatus,
  type InitResult,
  TriggerAdapter,
  type TriggerEvent,
  createAdapterError,
} from "../../../adapters/index.js";
import { type GitHubTriggerConfig, GitHubTriggerConfigSchema } from "./config.js";

/**
 * GitHubTriggerPlugin — polls GitHub for assigned issues and PR reviews.
 *
 * Produces stable idempotency keys for deduplication:
 * - Issues: `github:issue:{owner}/{repo}:{number}`
 * - Reviews: `github:review:{owner}/{repo}:{pr}:{review_id}`
 *
 * Tracks per-repo watermarks (ISO timestamp) to return only new events.
 * Decision #74: polling-only, no webhooks, ~30s intervals.
 */
export class GitHubTriggerPlugin extends TriggerAdapter {
  private config!: GitHubTriggerConfig;
  protected octokit!: Octokit;
  private watermarks = new Map<string, string>();

  protected async doPoll(): Promise<TriggerEvent[]> {
    const events: TriggerEvent[] = [];

    for (const repo of this.config.repos) {
      const repoKey = `${repo.owner}/${repo.name}`;
      const since = this.watermarks.get(repoKey);

      const issueEvents = await this.pollIssues(repo.owner, repo.name, since);
      events.push(...issueEvents);

      if (issueEvents.length > 0) {
        this.updateWatermark(repoKey, issueEvents);
      }
    }

    return events;
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = GitHubTriggerConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    this.config = parsed.data;
    this.octokit = new Octokit({ auth: this.config.github_token });
    this.watermarks.clear();
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
        details: { remaining, limit, reset: data.resources.core.reset },
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
    this.watermarks.clear();
    return Promise.resolve();
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private async pollIssues(
    owner: string,
    name: string,
    since: string | undefined,
  ): Promise<TriggerEvent[]> {
    try {
      const params: Record<string, unknown> = {
        owner,
        repo: name,
        assignee: "*",
        state: "open" as const,
        sort: "updated" as const,
        direction: "asc" as const,
        per_page: 30,
      };
      if (since) {
        params["since"] = since;
      }
      if (this.config.labels.length > 0) {
        params["labels"] = this.config.labels.join(",");
      }

      const { data: issues } = await this.octokit.issues.listForRepo(
        params as Parameters<typeof this.octokit.issues.listForRepo>[0],
      );

      return issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => mapIssueToEvent(owner, name, issue, this.manifest.id));
    } catch (error) {
      throw new AdapterMethodError(
        createAdapterError(
          classifyGitHubError(error),
          `Failed to poll ${owner}/${name}: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: isRetryable(error), severity: "error" },
        ),
      );
    }
  }

  private updateWatermark(repoKey: string, events: TriggerEvent[]): void {
    // Find latest updated_at from metadata
    let latest = this.watermarks.get(repoKey);
    for (const event of events) {
      const updatedAt = (event.metadata as Record<string, unknown> | null)?.["updated_at"];
      if (typeof updatedAt === "string" && (!latest || updatedAt > latest)) {
        latest = updatedAt;
      }
    }
    if (latest) {
      this.watermarks.set(repoKey, latest);
    }
  }
}

// ── Module-level helpers ────────────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  updated_at: string;
  labels: Array<{ name?: string } | string>;
  assignees?: Array<{ login: string }> | null;
}

function mapIssueToEvent(
  owner: string,
  repo: string,
  issue: GitHubIssue,
  pluginId: string,
): TriggerEvent {
  return {
    idempotency_key: `github:issue:${owner}/${repo}:${String(issue.number)}`,
    source: pluginId,
    event_type: "issue_assigned",
    external_ref: issue.html_url,
    title: issue.title,
    body: issue.body ?? null,
    repo: `${owner}/${repo}`,
    metadata: {
      issue_number: issue.number,
      updated_at: issue.updated_at,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
      assignees: (issue.assignees ?? []).map((a) => a.login),
    },
  };
}

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
