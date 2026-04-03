import { Octokit } from "@octokit/rest";
import { AdapterMethodError } from "../../../adapters/errors.js";
import {
  type AdapterObserver,
  type BranchProtection,
  type CommentResult,
  GitHostingAdapter,
  type HealthStatus,
  type InitResult,
  type MergeResult,
  type MergeStrategy,
  type PRComment,
  type PROptions,
  type PRResult,
  type PRStatus,
  type PRUpdates,
  type ReviewStatus,
  createAdapterError,
} from "../../../adapters/index.js";
import { type GitHubHostingConfig, GitHubHostingConfigSchema } from "./config.js";

/** No-op observer for when the real observer is not injected. */
const SILENT: AdapterObserver = {
  debug() {
    /* no-op */
  },
  info() {
    /* no-op */
  },
  warn() {
    /* no-op */
  },
  error() {
    /* no-op */
  },
};

/**
 * GitHubHostingPlugin — PR lifecycle management via GitHub API.
 *
 * Implements all 9 GitHostingAdapter methods via Octokit.
 * Never force-merges — returns error if branch protection not met.
 */
export class GitHubHostingPlugin extends GitHostingAdapter {
  private config!: GitHubHostingConfig;
  protected octokit!: Octokit;

  /** Typed observer accessor — safe even when observer is not injected. */
  private get obs(): AdapterObserver {
    return (this.observer as AdapterObserver | undefined) ?? SILENT;
  }

  protected async doCreatePR(options: PROptions): Promise<PRResult> {
    const [owner, repo] = splitRepo(options.repo);
    this.obs.info("Creating PR", {
      repo: options.repo,
      branch: options.branch,
      base: options.base,
      draft: options.draft,
    });

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

    this.obs.info("PR created", {
      repo: options.repo,
      prNumber: data.number,
      url: data.html_url,
      draft: options.draft,
      labels: options.labels?.length ?? 0,
      reviewers: options.reviewers?.length ?? 0,
    });
    return { pr_number: data.number, url: data.html_url };
  }

  protected async doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> {
    const [owner, repoName] = splitRepo(repo);
    this.obs.info("Updating PR", {
      repo,
      prNumber,
      hasTitle: updates.title !== null,
      hasDraft: updates.draft !== null,
      labelsAdd: updates.labels_add?.length ?? 0,
      labelsRemove: updates.labels_remove?.length ?? 0,
    });

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
    this.obs.info("Merging PR", { repo, prNumber, strategy });

    try {
      const { data } = await this.octokit.pulls.merge({
        owner,
        repo: repoName,
        pull_number: prNumber,
        merge_method: strategy,
      });
      this.obs.info("PR merged", { repo, prNumber, sha: data.sha });
      return {
        merge_sha: data.sha,
        success: true,
        error: null,
      };
    } catch (error) {
      const code = classifyMergeError(error);
      this.obs.warn("PR merge failed", {
        repo,
        prNumber,
        errorCode: code,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        merge_sha: "",
        success: false,
        error: createAdapterError(code, error instanceof Error ? error.message : String(error), {
          retryable: false,
        }),
      };
    }
  }

  protected async doClosePR(repo: string, prNumber: number): Promise<void> {
    const [owner, repoName] = splitRepo(repo);
    this.obs.info("Closing PR", { repo, prNumber });
    await this.octokit.pulls.update({
      owner,
      repo: repoName,
      pull_number: prNumber,
      state: "closed",
    });
    this.obs.info("PR closed", { repo, prNumber });
  }

  protected async doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus> {
    const [owner, repoName] = splitRepo(repo);
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    const checksState = await getChecksState(this.octokit, owner, repoName, pr.head.sha);
    const state = mapPRState(pr.state, pr.merged);

    this.obs.debug("PR status fetched", {
      repo,
      prNumber,
      state,
      checksState,
      mergeable: pr.mergeable ?? false,
      draft: pr.draft ?? false,
    });

    return {
      number: pr.number,
      state,
      draft: pr.draft ?? false,
      mergeable: pr.mergeable ?? false,
      checks_state: checksState,
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

    const status = aggregateReviews(reviews);
    this.obs.debug("Review status fetched", {
      repo,
      prNumber,
      approved: status.approved,
      approvals: status.approvals,
      changesRequested: status.changes_requested,
      reviewerCount: status.reviewers.length,
    });
    return status;
  }

  protected async doCommentOnPR(
    repo: string,
    prNumber: number,
    comment: string,
    replyTo: string | undefined,
  ): Promise<CommentResult> {
    const [owner, repoName] = splitRepo(repo);
    const isReply = replyTo !== undefined;

    if (isReply) {
      const { data } = await this.octokit.pulls.createReplyForReviewComment({
        owner,
        repo: repoName,
        pull_number: prNumber,
        comment_id: Number.parseInt(replyTo, 10),
        body: comment,
      });
      this.obs.debug("Review reply posted", { repo, prNumber, commentId: data.id, replyTo });
      return { comment_id: String(data.id), url: data.html_url };
    }

    // Regular issue comment (PRs are issues in GitHub)
    const { data } = await this.octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: comment,
    });
    this.obs.debug("PR comment posted", { repo, prNumber, commentId: data.id });
    return { comment_id: String(data.id), url: data.html_url };
  }

  protected async doGetPRComments(repo: string, prNumber: number): Promise<PRComment[]> {
    const [owner, repoName] = splitRepo(repo);

    // Fetch both conversation-level comments AND inline review comments
    const [issueComments, reviewComments] = await Promise.all([
      this.octokit.issues.listComments({
        owner,
        repo: repoName,
        issue_number: prNumber,
      }),
      this.octokit.pulls.listReviewComments({
        owner,
        repo: repoName,
        pull_number: prNumber,
      }),
    ]);

    const conversation = issueComments.data
      .filter((c) => c.user?.login !== "github-actions[bot]")
      .map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        created_at: c.created_at,
      }));

    const inline = reviewComments.data
      .filter((c) => c.user?.login !== "github-actions[bot]")
      .map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? "unknown",
        body: c.body,
        created_at: c.created_at,
      }));

    const total = conversation.length + inline.length;
    this.obs.debug("PR comments fetched", {
      repo,
      prNumber,
      conversation: conversation.length,
      inline: inline.length,
      total,
    });
    return [...conversation, ...inline];
  }

  protected async doGetBranchProtection(repo: string, branch: string): Promise<BranchProtection> {
    const [owner, repoName] = splitRepo(repo);

    try {
      const { data } = await this.octokit.repos.getBranchProtection({
        owner,
        repo: repoName,
        branch,
      });
      const protection: BranchProtection = {
        protected: true,
        required_reviews: data.required_pull_request_reviews?.required_approving_review_count ?? 0,
        required_checks: data.required_status_checks?.contexts ?? [],
        restrictions: data.restrictions
          ? { users: data.restrictions.users, teams: data.restrictions.teams }
          : null,
      };
      this.obs.debug("Branch protection fetched", {
        repo,
        branch,
        isProtected: true,
        requiredReviews: protection.required_reviews,
        requiredChecks: protection.required_checks.length,
      });
      return protection;
    } catch (error) {
      // 404 means no protection rules set
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 404
      ) {
        this.obs.debug("Branch protection fetched", { repo, branch, isProtected: false });
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
    this.obs.debug("Default branch resolved", { repo, branch: data.default_branch });
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

type ChecksState = "passing" | "failing" | "pending" | "none";

/**
 * Resolve CI status by querying BOTH the Status API (legacy commit statuses)
 * and the Checks API (GitHub Actions, third-party check runs). Either source
 * can report CI results depending on the repo's setup.
 *
 * Combining logic: worst state wins (failing > pending > passing > none).
 */
async function getChecksState(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<ChecksState> {
  try {
    const [statusResult, checksResult] = await Promise.all([
      octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
      octokit.checks.listForRef({ owner, repo, ref: sha }),
    ]);

    // Status API (legacy): "success" | "failure" | "error" | "pending"
    const statusState = resolveStatusApiState(
      statusResult.data.state,
      statusResult.data.total_count,
    );

    // Checks API (GitHub Actions): each run has status + conclusion
    const checksState = resolveChecksApiState(checksResult.data.check_runs);

    return combineCheckStates(statusState, checksState);
  } catch {
    return "failing";
  }
}

function resolveStatusApiState(state: string, totalCount: number): ChecksState {
  if (totalCount === 0) {
    return "none";
  }
  switch (state) {
    case "success":
      return "passing";
    case "pending":
      return "pending";
    default:
      return "failing";
  }
}

function resolveChecksApiState(
  checkRuns: Array<{ status: string; conclusion: string | null }>,
): ChecksState {
  if (checkRuns.length === 0) {
    return "none";
  }

  let hasFailure = false;
  let hasPending = false;

  for (const run of checkRuns) {
    if (run.status !== "completed") {
      hasPending = true;
      continue;
    }
    // completed: check conclusion
    if (
      run.conclusion !== "success" &&
      run.conclusion !== "skipped" &&
      run.conclusion !== "neutral"
    ) {
      hasFailure = true;
    }
  }

  if (hasFailure) {
    return "failing";
  }
  if (hasPending) {
    return "pending";
  }
  return "passing";
}

/** Worst state wins: failing > pending > passing > none. */
function combineCheckStates(a: ChecksState, b: ChecksState): ChecksState {
  const priority: Record<ChecksState, number> = { failing: 3, pending: 2, passing: 1, none: 0 };
  return priority[a] >= priority[b] ? a : b;
}

interface GitHubReview {
  user?: { login: string } | null;
  state: string;
  body?: string | null;
}

function aggregateReviews(reviews: GitHubReview[]): ReviewStatus {
  // GitHub returns reviews chronologically; we want the latest per reviewer
  const latestByUser = new Map<string, string>();
  const comments: string[] = [];
  for (const review of reviews) {
    const user = review.user?.login ?? "unknown";
    const state = review.state.toUpperCase();
    // Only track meaningful states
    if (["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(state)) {
      latestByUser.set(user, state);
    }
    // Collect non-empty review bodies as feedback comments
    if (review.body?.trim()) {
      comments.push(`@${user}: ${review.body.trim()}`);
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
    comments,
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
