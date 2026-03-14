import { GitHostingAdapter } from "../../../../src/adapters/git-hosting.js";
import type {
  BranchProtection,
  CommentResult,
  HealthStatus,
  InitResult,
  MergeResult,
  MergeStrategy,
  PRComment,
  PROptions,
  PRResult,
  PRStatus,
  PRUpdates,
  ReviewStatus,
} from "../../../../src/schemas/adapters.js";

interface StoredPR {
  options: PROptions;
  status: PRStatus;
  reviews: ReviewStatus;
  comments: CommentResult[];
}

/**
 * Fake git hosting plugin for testing.
 *
 * Test control surface:
 * - `getPRs()` — all tracked PRs (in-memory)
 * - `setUnhealthy(fail)` — make healthCheck return unhealthy
 * - `getInitConfig()` — what config was passed to initialize
 * - `wasShutdownCalled()` — whether shutdown was called
 */
export class FakeGitHostingPlugin extends GitHostingAdapter {
  private prs = new Map<string, StoredPR>();
  private nextPrNumber = 1;
  private nextCommentId = 1;
  private shouldFailHealthCheck = false;
  private initConfig: Record<string, unknown> | null = null;
  private shutdownCalled = false;

  // ── Test Control Surface ────────────────────────────────────────────────

  getPRs(): Map<string, StoredPR> {
    return new Map(this.prs);
  }

  setUnhealthy(fail: boolean): void {
    this.shouldFailHealthCheck = fail;
  }

  getInitConfig(): Record<string, unknown> | null {
    return this.initConfig;
  }

  wasShutdownCalled(): boolean {
    return this.shutdownCalled;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private prKey(repo: string, prNumber: number): string {
    return `${repo}#${String(prNumber)}`;
  }

  private getPR(repo: string, prNumber: number): StoredPR {
    const pr = this.prs.get(this.prKey(repo, prNumber));
    if (!pr) {
      throw new Error(`PR ${repo}#${String(prNumber)} not found`);
    }
    return pr;
  }

  // ── Adapter Implementation ──────────────────────────────────────────────

  protected doCreatePR(options: PROptions): Promise<PRResult> {
    const prNumber = this.nextPrNumber++;
    const key = this.prKey(options.repo, prNumber);
    this.prs.set(key, {
      options,
      status: {
        number: prNumber,
        state: "open",
        draft: options.draft,
        mergeable: true,
        checks_passing: true,
        url: `https://fake.git/${options.repo}/pull/${String(prNumber)}`,
      },
      reviews: {
        approved: false,
        approvals: 0,
        changes_requested: false,
        reviewers: [],
        comments: [],
      },
      comments: [],
    });
    return Promise.resolve({
      pr_number: prNumber,
      url: `https://fake.git/${options.repo}/pull/${String(prNumber)}`,
    });
  }

  protected doUpdatePR(repo: string, prNumber: number, updates: PRUpdates): Promise<void> {
    const pr = this.getPR(repo, prNumber);
    if (updates.title !== null && updates.title !== undefined) {
      pr.options = { ...pr.options, title: updates.title };
    }
    if (updates.body !== null && updates.body !== undefined) {
      pr.options = { ...pr.options, body: updates.body };
    }
    if (updates.draft !== null && updates.draft !== undefined) {
      pr.status = { ...pr.status, draft: updates.draft };
    }
    return Promise.resolve();
  }

  protected doMergePR(
    repo: string,
    prNumber: number,
    _strategy: MergeStrategy,
  ): Promise<MergeResult> {
    const pr = this.getPR(repo, prNumber);
    pr.status = { ...pr.status, state: "merged" };
    return Promise.resolve({
      merge_sha: "abc123fake",
      success: true,
      error: null,
    });
  }

  protected doClosePR(repo: string, prNumber: number): Promise<void> {
    const pr = this.getPR(repo, prNumber);
    pr.status = { ...pr.status, state: "closed" };
    return Promise.resolve();
  }

  protected doGetPRStatus(repo: string, prNumber: number): Promise<PRStatus> {
    return Promise.resolve({ ...this.getPR(repo, prNumber).status });
  }

  protected doGetReviewStatus(repo: string, prNumber: number): Promise<ReviewStatus> {
    return Promise.resolve({ ...this.getPR(repo, prNumber).reviews });
  }

  protected doCommentOnPR(
    repo: string,
    prNumber: number,
    _comment: string,
    _replyTo: string | undefined,
  ): Promise<CommentResult> {
    const pr = this.getPR(repo, prNumber);
    const commentId = String(this.nextCommentId++);
    const result: CommentResult = {
      comment_id: commentId,
      url: `https://fake.git/${repo}/pull/${String(prNumber)}#comment-${commentId}`,
    };
    pr.comments.push(result);
    return Promise.resolve(result);
  }

  protected doGetPRComments(_repo: string, _prNumber: number): Promise<PRComment[]> {
    return Promise.resolve([]);
  }

  protected doGetBranchProtection(_repo: string, _branch: string): Promise<BranchProtection> {
    return Promise.resolve({
      protected: false,
      required_reviews: 0,
      required_checks: [],
      restrictions: null,
    });
  }

  protected doGetDefaultBranch(_repo: string): Promise<string> {
    return Promise.resolve("main");
  }

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    this.initConfig = config;
    if (config["_force_fail"] === true) {
      return Promise.resolve({ success: false, message: "Forced failure for testing" });
    }
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    this.shutdownCalled = true;
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: !this.shouldFailHealthCheck,
      message: this.shouldFailHealthCheck ? "Fake git hosting unhealthy" : null,
      details: null,
    });
  }
}

export function createPlugin(): GitHostingAdapter {
  return new FakeGitHostingPlugin();
}
