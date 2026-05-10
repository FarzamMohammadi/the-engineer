import { describe, expect, it } from "vitest";

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
  PluginManifest,
  ReviewStatus,
} from "../schemas/adapters.js";
import { AdapterErrorSeverities, MergeStrategies } from "../schemas/adapters.js";
import { SecureValue } from "../utils/secure-value.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";
import { GitHostingAdapter } from "./git-hosting.js";

class TestGitHostingAdapter extends GitHostingAdapter {
  throwOnMethod: string | null = null;
  throwError: Error = new Error("Test error");

  protected doCreatePR(_options: PROptions): Promise<PRResult> {
    this.maybeThrow("createPR");
    return Promise.resolve({ pr_number: 42, url: "https://github.com/test/repo/pull/42" });
  }

  protected doUpdatePR(_repo: string, _prNumber: number, _updates: PRUpdates): Promise<void> {
    this.maybeThrow("updatePR");
    return Promise.resolve();
  }

  protected doMergePR(
    _repo: string,
    _prNumber: number,
    _strategy: MergeStrategy,
  ): Promise<MergeResult> {
    this.maybeThrow("mergePR");
    return Promise.resolve({ merge_sha: "abc123", success: true, error: null });
  }

  protected doClosePR(_repo: string, _prNumber: number): Promise<void> {
    this.maybeThrow("closePR");
    return Promise.resolve();
  }

  protected doGetPRStatus(_repo: string, _prNumber: number): Promise<PRStatus> {
    this.maybeThrow("getPRStatus");
    return Promise.resolve({
      number: 42,
      state: "open",
      draft: false,
      mergeable: true,
      checks_state: "passing",
      url: "https://github.com/test/repo/pull/42",
    });
  }

  protected doGetReviewStatus(_repo: string, _prNumber: number): Promise<ReviewStatus> {
    this.maybeThrow("getReviewStatus");
    return Promise.resolve({
      approved: true,
      approvals: 1,
      changes_requested: false,
      reviewers: [],
      comments: [],
    });
  }

  protected doCommentOnPR(
    _repo: string,
    _prNumber: number,
    _comment: string,
    _replyTo: string | undefined,
  ): Promise<CommentResult> {
    this.maybeThrow("commentOnPR");
    return Promise.resolve({
      comment_id: "c-1",
      url: "https://github.com/test/repo/pull/42#comment-1",
    });
  }

  protected doGetBranchProtection(_repo: string, _branch: string): Promise<BranchProtection> {
    this.maybeThrow("getBranchProtection");
    return Promise.resolve({
      protected: true,
      required_reviews: 1,
      required_checks: ["ci"],
      restrictions: null,
    });
  }

  protected doGetPRComments(_repo: string, _prNumber: number): Promise<PRComment[]> {
    this.maybeThrow("getPRComments");
    return Promise.resolve([]);
  }

  protected doDismissApprovals(_repo: string, _prNumber: number, _message: string): Promise<void> {
    this.maybeThrow("dismissApprovals");
    return Promise.resolve();
  }

  protected doGetDefaultBranch(_repo: string): Promise<string> {
    this.maybeThrow("getDefaultBranch");
    return Promise.resolve("main");
  }

  protected doGetAuthenticatedRemoteUrl(remoteUrl: string): SecureValue {
    this.maybeThrow("getAuthenticatedRemoteUrl");
    return new SecureValue(remoteUrl.replace("https://", "https://test-token@"));
  }

  protected doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    // No-op for test double
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, message: null, details: null });
  }

  private maybeThrow(method: string): void {
    if (this.throwOnMethod === method) {
      throw this.throwError;
    }
  }
}

function createManifest(): PluginManifest {
  return {
    id: "test-git-hosting",
    type: "git_hosting",
    version: "1.0.0",
    name: "Test Git Hosting",
    description: "A test hosting plugin",
    config_schema: {},
    critical: true,
    entry: "index.ts",
    adapter_meta: { action_classes: ["git-remote", "merge"] },
    requirements: [],
    combined_with: [],
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
    startup_hints: [],
  };
}

describe("GitHostingAdapter", () => {
  it("extends BaseAdapter", () => {
    const adapter = new TestGitHostingAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter).toBeInstanceOf(GitHostingAdapter);
  });

  describe("all methods delegate to do* counterparts", () => {
    it("createPR", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.createPR({
        repo: "test/repo",
        branch: "feature",
        base: "main",
        title: "Test PR",
        body: "Description",
        draft: false,
        labels: null,
        reviewers: null,
      });
      expect(result.pr_number).toBe(42);
    });

    it("updatePR", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      await expect(
        adapter.updatePR("test/repo", 42, {
          title: null,
          body: null,
          draft: null,
          labels_add: null,
          labels_remove: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("mergePR", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.mergePR("test/repo", 42, MergeStrategies.squash);
      expect(result.success).toBe(true);
      expect(result.merge_sha).toBe("abc123");
    });

    it("closePR", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      await expect(adapter.closePR("test/repo", 42)).resolves.toBeUndefined();
    });

    it("getPRStatus", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const status = await adapter.getPRStatus("test/repo", 42);
      expect(status.state).toBe("open");
      expect(status.mergeable).toBe(true);
    });

    it("getReviewStatus", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const review = await adapter.getReviewStatus("test/repo", 42);
      expect(review.approved).toBe(true);
    });

    it("commentOnPR", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.commentOnPR("test/repo", 42, "LGTM");
      expect(result.comment_id).toBe("c-1");
    });

    it("commentOnPR with replyTo", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const result = await adapter.commentOnPR("test/repo", 42, "Thanks", "c-0");
      expect(result.comment_id).toBe("c-1");
    });

    it("getBranchProtection", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const protection = await adapter.getBranchProtection("test/repo", "main");
      expect(protection.protected).toBe(true);
      expect(protection.required_reviews).toBe(1);
    });

    it("getDefaultBranch", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      const branch = await adapter.getDefaultBranch("test/repo");
      expect(branch).toBe("main");
    });
  });

  describe("error wrapping", () => {
    it("wraps unknown errors as internal_error", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      adapter.throwOnMethod = "createPR";
      adapter.throwError = new Error("API down");

      try {
        await adapter.createPR({
          repo: "test/repo",
          branch: "feature",
          base: "main",
          title: "PR",
          body: "",
          draft: false,
          labels: null,
          reviewers: null,
        });
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("internal_error");
          expect(error.adapterError.severity).toBe(AdapterErrorSeverities.fatal);
        }
      }
    });

    it("rethrows AdapterMethodError as-is", async () => {
      const adapter = new TestGitHostingAdapter();
      adapter.manifest = createManifest();
      adapter.throwOnMethod = "mergePR";
      adapter.throwError = new AdapterMethodError(
        createAdapterError("merge_conflict", "Conflicts detected"),
      );

      try {
        await adapter.mergePR("test/repo", 42, MergeStrategies.merge);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("merge_conflict");
        }
      }
    });

    it("wraps errors consistently across all methods", async () => {
      const methods: Array<{ name: string; call: (a: TestGitHostingAdapter) => Promise<unknown> }> =
        [
          {
            name: "updatePR",
            call: (a) =>
              a.updatePR("r", 1, {
                title: null,
                body: null,
                draft: null,
                labels_add: null,
                labels_remove: null,
              }),
          },
          { name: "closePR", call: (a) => a.closePR("r", 1) },
          { name: "getPRStatus", call: (a) => a.getPRStatus("r", 1) },
          { name: "getReviewStatus", call: (a) => a.getReviewStatus("r", 1) },
          { name: "commentOnPR", call: (a) => a.commentOnPR("r", 1, "c") },
          { name: "getBranchProtection", call: (a) => a.getBranchProtection("r", "main") },
          { name: "getDefaultBranch", call: (a) => a.getDefaultBranch("r") },
        ];

      for (const { name, call } of methods) {
        const adapter = new TestGitHostingAdapter();
        adapter.manifest = createManifest();
        adapter.throwOnMethod = name;
        adapter.throwError = new Error(`${name} failed`);

        try {
          await call(adapter);
          expect.unreachable(`${name} should have thrown`);
        } catch (error) {
          expect(error).toBeInstanceOf(AdapterMethodError);
          if (error instanceof AdapterMethodError) {
            expect(error.adapterError.code).toBe("internal_error");
          }
        }
      }
    });
  });
});
