import { Octokit } from "@octokit/rest";
import { AdapterMethodError } from "../../../adapters/errors.js";
import {
  type HealthStatus,
  type InitResult,
  TriggerAdapter,
  type TriggerEvent,
  createAdapterError,
} from "../../../adapters/index.js";
import { AdapterErrorSeverities } from "../../../schemas/adapters.js";
import { type GitHubTriggerConfig, GitHubTriggerConfigSchema } from "./config.js";

/** StateStore key under which per-repo watermarks are persisted. */
const WATERMARKS_KEY = "watermarks";

/**
 * GitHubTriggerPlugin — polls GitHub for open issues.
 *
 * Produces a stable idempotency key per issue for deduplication:
 * `github:issue:{owner}/{repo}:{number}`.
 *
 * Tracks per-repo watermarks (ISO timestamp) to return only new events.
 * Decision #74: polling-only, no webhooks, ~30s intervals.
 */
export class GitHubTriggerPlugin extends TriggerAdapter {
  private config!: GitHubTriggerConfig;
  protected octokit!: Octokit;
  private watermarks = new Map<string, string>();
  private etags = new Map<string, string>();
  private retryAfterUntil = 0;

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
    this.loadWatermarks();

    return Promise.resolve({ success: true, message: null });
  }

  /** Restore per-repo watermarks from the state store. Malformed state starts fresh, loudly. */
  private loadWatermarks(): void {
    this.watermarks.clear();
    const stored = this.context.stateStore.get(WATERMARKS_KEY);
    if (stored === null) {
      return; // first run
    }
    if (!isStringRecord(stored)) {
      this.context.logger.warn("Persisted watermarks are malformed — starting fresh");
      return;
    }
    for (const [key, value] of Object.entries(stored)) {
      this.watermarks.set(key, value);
    }
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
    // Persist watermarks BEFORE clearing — save state after processing.
    this.context.stateStore.set(WATERMARKS_KEY, Object.fromEntries(this.watermarks));
    this.watermarks.clear();
    this.etags.clear();
    return Promise.resolve();
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private async pollIssues(owner: string, name: string, since: string | undefined): Promise<TriggerEvent[]> {
    // Respect Retry-After from previous 429
    if (Date.now() < this.retryAfterUntil) {
      return [];
    }

    try {
      const repoKey = `${owner}/${name}`;
      const params: Record<string, unknown> = {
        owner,
        repo: name,
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

      // ETag conditional request — skip if no changes since last poll
      const headers: Record<string, string> = {};
      const cachedEtag = this.etags.get(repoKey);
      if (cachedEtag) {
        headers["if-none-match"] = cachedEtag;
      }
      params["headers"] = headers;

      const response = await this.octokit.issues.listForRepo(
        params as Parameters<typeof this.octokit.issues.listForRepo>[0],
      );

      // Cache ETag for next request
      const responseEtag = response.headers.etag;
      if (responseEtag) {
        this.etags.set(repoKey, responseEtag);
      }

      return response.data
        .filter((issue) => !issue.pull_request)
        .map((issue) => mapIssueToEvent(owner, name, issue, this.manifest.id));
    } catch (error) {
      return this.handlePollError(error, owner, name);
    }
  }

  private handlePollError(error: unknown, owner: string, name: string): TriggerEvent[] {
    // Handle 304 Not Modified (ETag cache hit — Octokit throws this)
    if (getErrorStatus(error) === 304) {
      return [];
    }

    // Handle 429 with Retry-After
    if (getErrorStatus(error) === 429) {
      const retryAfter = Number(
        (error as { response?: { headers?: Record<string, string> } }).response?.headers?.["retry-after"] ?? 60,
      );
      this.retryAfterUntil = Date.now() + retryAfter * 1000;
    }

    throw new AdapterMethodError(
      createAdapterError(
        classifyGitHubError(error),
        `Failed to poll ${owner}/${name}: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: isRetryable(error), severity: AdapterErrorSeverities.error },
      ),
    );
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

function mapIssueToEvent(owner: string, repo: string, issue: GitHubIssue, pluginId: string): TriggerEvent {
  return {
    idempotency_key: `github:issue:${owner}/${repo}:${String(issue.number)}`,
    source: pluginId,
    event_type: "issue_assigned",
    external_ref: {
      type: "github_issue",
      repo: `${owner}/${repo}`,
      id: String(issue.number),
      url: issue.html_url,
      pr_decorations: {
        title_prefix: `#${String(issue.number)}:`,
        description_suffix: `Closes #${String(issue.number)}`,
      },
    },
    title: issue.title,
    body: issue.body ?? null,
    repo: `${owner}/${repo}`,
    clone_url: `https://github.com/${owner}/${repo}.git`,
    thoughts_id: `issue-${String(issue.number)}`,
    metadata: {
      issue_number: issue.number,
      updated_at: issue.updated_at,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
      assignees: (issue.assignees ?? []).map((a) => a.login),
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function getErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    return (error as { status: number }).status;
  }
  return null;
}

function classifyGitHubError(error: unknown): string {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "network_error";
}

function isRetryable(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 429 || status >= 500;
  }
  return true;
}
