import { Octokit } from "@octokit/rest";
import { AdapterMethodError } from "../../../adapters/errors.js";
import {
  type BranchProtection,
  type CommentResult,
  GitHostingAdapter,
  type HealthStatus,
  type InitResult,
  type MergeResult,
  type MergeStrategy,
  type PROptions,
  type PRResult,
  type PRStatus,
  type PRUpdates,
  type ReviewStatus,
  createAdapterError,
} from "../../../adapters/index.js";
import { type GitHubHostingConfig, GitHubHostingConfigSchema } from "./config.js";

/**
 * GitHubHostingPlugin — PR lifecycle management via GitHub API.
 *
 * Implements all 9 GitHostingAdapter methods via Octokit.
 * Never force-merges — returns error if branch protection not met.
 */
export class GitHubHostingPlugin extends GitHostingAdapter {
  private config!: GitHubHostingConfig;
  protected octokit!: Octokit;

  protected async doCreatePR(options: PROptions): Promise<PRResult> {
    const [owner, repo] = splitRepo(options.repo);
    const { data } = await this.octokit.pulls.create({
      owner,
      repo,
      head: options.branch,
      base: options.base,
      title: options.title,
      body: options.body,
      draft: options.draft,
    });

    // Add labels if provided
    if (options.labels && options.labels.length > 0) {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: data.number,
        labels: options.labels,
      });
    }

    // Request reviewers if provided
    if (options.reviewers && options.reviewers.length > 0) {
      await this.octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: data.number,
        reviewers: options.reviewers,
      });
    }

    return { pr_number: data.number, url: data.html_url };
  }

  protected async doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> {
    const [owner, repoName] = splitRepo(repo);
    const params: Record<string, unknown> = {
      owner,
      repo: repoName,
      pull_number: prNumber,
    };
    if (updates.title !== null) {
      params["title"] = updates.title;
    }
    if (updates.body !== null) {
      params["body"] = updates.body;
    }
    if (updates.draft !== null) {
      params["draft"] = updates.draft;
    }

    if (updates.title !== null || updates.body !== null || updates.draft !== null) {
      await this.octokit.pulls.update(params as Parameters<typeof this.octokit.pulls.update>[0]);
    }

    // Label management
    if (updates.labels_add && updates.labels_add.length > 0) {
      await this.octokit.issues.addLabels({
        owner,
        repo: repoName,
        issue_number: prNumber,
        labels: updates.labels_add,
      });
    }
    if (updates.labels_remove) {
      for (const label of updates.labels_remove) {
        try {
          await this.octokit.issues.removeLabel({
            owner,
            repo: repoName,
            issue_number: prNumber,
            name: label,
          });
        } catch {
          // Label may already be gone
        }
      }
    }
  }

  protected async doMergePR(
    repo: string,
    prNumber: number,
    strategy: MergeStrategy,
  ): Promise<MergeResult> {
    const [owner, repoName] = splitRepo(repo);

    try {
      const { data } = await this.octokit.pulls.merge({
        owner,
        repo: repoName,
        pull_number: prNumber,
        merge_method: strategy,
      });
      return {
        merge_sha: data.sha,
        success: true,
        error: null,
      };
    } catch (error) {
      return {
        merge_sha: "",
        success: false,
        error: createAdapterError(
          classifyMergeError(error),
          error instanceof Error ? error.message : String(error),
          { retryable: false },
        ),
      };
    }
  }

  protected async doClosePR(repo: string, prNumber: number): Promise<void> {
    const [owner, repoName] = splitRepo(repo);
    await this.octokit.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      state: "closed",
    });
  }

  protected async doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus> {
    const [owner, repoName] = splitRepo(repo);
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    const checksPassing = await getChecksPassing(this.octokit, owner, repoName, pr.head.sha);

    return {
      number: pr.number,
      state: mapPRState(pr.state, pr.merged),
      draft: pr.draft ?? false,
      mergeable: pr.mergeable ?? false,
      checks_passing: checksPassing,
      url: pr.html_url,
    };
  }

  protected async doGetReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus> {
    const [owner, repoName] = splitRepo(repo);
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    return aggregateReviews(reviews);
  }

  protected async doCommentOnPR(
    repo: string,
    prNumber: number,
    comment: string,
    replyTo: string | undefined,
  ): Promise<CommentResult> {
    const [owner, repoName] = splitRepo(repo);

    if (replyTo) {
      const { data } = await this.octokit.pulls.createReplyForReviewComment({
        owner,
        repo: repoName,
        pull_number: prNumber,
        comment_id: Number.parseInt(replyTo, 10),
        body: comment,
      });
      return { comment_id: String(data.id), url: data.html_url };
    }

    // Regular issue comment (PRs are issues in GitHub)
    const { data } = await this.octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: comment,
    });
    return { comment_id: String(data.id), url: data.html_url };
  }

  protected async doGetBranchProtection(repo: string, branch: string): Promise<BranchProtection> {
    const [owner, repoName] = splitRepo(repo);

    try {
      const { data } = await this.octokit.repos.getBranchProtection({
        owner,
        repo: repoName,
        branch,
      });
      return {
        protected: true,
        required_reviews: data.required_pull_request_reviews?.required_approving_review_count ?? 0,
        required_checks: data.required_status_checks?.contexts ?? [],
        restrictions: data.restrictions
          ? { users: data.restrictions.users, teams: data.restrictions.teams }
          : null,
      };
    } catch (error) {
      // 404 means no protection rules set
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 404
      ) {
        return {
          protected: false,
          required_reviews: 0,
          required_checks: [],
          restrictions: null,
        };
      }
      throw error;
    }
  }

  protected async doGetDefaultBranch(repo: string): Promise<string> {
    const [owner, repoName] = splitRepo(repo);
    const { data } = await this.octokit.repos.get({ owner, repo: repoName });
    return data.default_branch;
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = GitHubHostingConfigSchema.safeParse(config);
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

function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  if (!(owner && name)) {
    throw new AdapterMethodError(
      createAdapterError(
        "invalid_input",
        `Invalid repo format: expected "owner/repo", got "${repo}"`,
      ),
    );
  }
  return [owner, name];
}

function mapPRState(state: string, merged: boolean): "open" | "closed" | "merged" {
  if (merged) {
    return "merged";
  }
  if (state === "closed") {
    return "closed";
  }
  return "open";
}

async function getChecksPassing(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha,
    });
    return data.state === "success";
  } catch {
    return false;
  }
}

interface GitHubReview {
  user?: { login: string } | null;
  state: string;
}

function aggregateReviews(reviews: GitHubReview[]): ReviewStatus {
  // GitHub returns reviews chronologically; we want the latest per reviewer
  const latestByUser = new Map<string, string>();
  for (const review of reviews) {
    const user = review.user?.login ?? "unknown";
    const state = review.state.toUpperCase();
    // Only track meaningful states
    if (["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(state)) {
      latestByUser.set(user, state);
    }
  }

  const reviewers = [...latestByUser.entries()].map(([username, state]) => ({
    username,
    state: mapReviewState(state),
  }));

  const approvals = reviewers.filter((r) => r.state === "approved").length;
  const changesRequested = reviewers.some((r) => r.state === "changes_requested");

  return {
    approved: approvals > 0 && !changesRequested,
    approvals,
    changes_requested: changesRequested,
    reviewers,
  };
}

function mapReviewState(state: string): "approved" | "changes_requested" | "commented" | "pending" {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    default:
      return "pending";
  }
}

function classifyMergeError(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    if (status === 405) {
      return "pr_not_mergeable";
    }
    if (status === 409) {
      return "merge_conflict";
    }
  }
  return "network_error";
}
