import type {
  BranchProtection,
  CommentResult,
  MergeResult,
  MergeStrategy,
  PRComment,
  PROptions,
  PRResult,
  PRStatus,
  PRUpdates,
  ReviewStatus,
} from "../schemas/adapters.js";
import type { SecureValue } from "../utils/secure-value.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Wrap an async `do*` method: rethrow `AdapterMethodError` as-is,
 * wrap unknown errors as `internal_error`.
 */
async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AdapterMethodError) {
      throw error;
    }
    throw new AdapterMethodError(
      createAdapterError("internal_error", error instanceof Error ? error.message : String(error), {
        severity: "fatal",
      }),
    );
  }
}

/**
 * Abstract base for git hosting adapters.
 *
 * Git hosting adapters abstract the code hosting platform's API for PR
 * lifecycle, branch protection queries, and merge operations. The Workspace
 * Manager is the primary consumer of this contract.
 *
 * Fully separate from communication adapters — different capability domain.
 * Local git operations are handled by the Workspace Manager directly.
 */
export abstract class GitHostingAdapter extends BaseAdapter {
  // ── PR Lifecycle ──────────────────────────────────────────────────────────

  async createPR(options: PROptions): Promise<PRResult> {
    return wrapAsync(() => this.doCreatePR(options));
  }

  async updatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> {
    return wrapAsync(() => this.doUpdatePR(repo, prNumber, updates));
  }

  async mergePR(repo: string, prNumber: number, strategy: MergeStrategy): Promise<MergeResult> {
    return wrapAsync(() => this.doMergePR(repo, prNumber, strategy));
  }

  async closePR(repo: string, prNumber: number): Promise<void> {
    return wrapAsync(() => this.doClosePR(repo, prNumber));
  }

  // ── PR Queries ────────────────────────────────────────────────────────────

  async getPRStatus(repo: string, prNumber: number): Promise<PRStatus> {
    return wrapAsync(() => this.doGetPRStatus(repo, prNumber));
  }

  async getReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus> {
    return wrapAsync(() => this.doGetReviewStatus(repo, prNumber));
  }

  /** Fetch all comments on a PR (conversation-level + inline review comments). */
  async getPRComments(repo: string, prNumber: number): Promise<PRComment[]> {
    return wrapAsync(() => this.doGetPRComments(repo, prNumber));
  }

  // ── PR Comments ───────────────────────────────────────────────────────────

  async commentOnPR(
    repo: string,
    prNumber: number,
    comment: string,
    replyTo?: string,
  ): Promise<CommentResult> {
    return wrapAsync(() => this.doCommentOnPR(repo, prNumber, comment, replyTo));
  }

  // ── Review Actions ────────────────────────────────────────────────────────

  /** Dismiss all current approvals on a PR. No-op if none exist. */
  async dismissApprovals(repo: string, prNumber: number, message: string): Promise<void> {
    return wrapAsync(() => this.doDismissApprovals(repo, prNumber, message));
  }

  // ── Branch Queries ────────────────────────────────────────────────────────

  async getBranchProtection(repo: string, branch: string): Promise<BranchProtection> {
    return wrapAsync(() => this.doGetBranchProtection(repo, branch));
  }

  async getDefaultBranch(repo: string): Promise<string> {
    return wrapAsync(() => this.doGetDefaultBranch(repo));
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Transform a plain remote URL into an authenticated one.
   *
   * Returns a SecureValue so the token never leaks through toString/toJSON.
   * Synchronous — no I/O, just URL string manipulation with an
   * already-available token.
   */
  getAuthenticatedRemoteUrl(remoteUrl: string): SecureValue {
    return this.doGetAuthenticatedRemoteUrl(remoteUrl);
  }

  // ── Protected Abstract (plugin authors implement) ──────────────────────────

  protected abstract doCreatePR(options: PROptions): Promise<PRResult>;
  protected abstract doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void>;
  protected abstract doMergePR(
    repo: string,
    prNumber: number,
    strategy: MergeStrategy,
  ): Promise<MergeResult>;
  protected abstract doClosePR(repo: string, prNumber: number): Promise<void>;
  protected abstract doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus>;
  protected abstract doGetReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus>;
  protected abstract doCommentOnPR(
    repo: string,
    prNumber: number,
    comment: string,
    replyTo: string | undefined,
  ): Promise<CommentResult>;
  protected abstract doGetPRComments(repo: string, prNumber: number): Promise<PRComment[]>;
  protected abstract doDismissApprovals(
    repo: string,
    prNumber: number,
    message: string,
  ): Promise<void>;
  protected abstract doGetBranchProtection(repo: string, branch: string): Promise<BranchProtection>;
  protected abstract doGetDefaultBranch(repo: string): Promise<string>;
  protected abstract doGetAuthenticatedRemoteUrl(remoteUrl: string): SecureValue;
}
