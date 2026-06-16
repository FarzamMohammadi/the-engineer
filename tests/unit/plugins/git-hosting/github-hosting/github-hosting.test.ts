import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubHostingPlugin,
  derivePrEvents,
} from "../../../../../src/plugins/git-hosting/github-hosting/github-hosting.js";
import type {
  PRComment,
  PROptions,
  PRStatus,
  PluginManifest,
  ReviewStatus,
} from "../../../../../src/schemas/adapters.js";
import { PrEventTypes } from "../../../../../src/schemas/git-hosting-events.js";
import { runGitHostingContractSuite } from "../../../../helpers/contract-suites/git-hosting-contract.js";
import { createTestPluginContext } from "../../../../helpers/test-plugin-context.js";

// ── Mock Octokit ────────────────────────────────────────────────────────────

function createMockOctokit() {
  return {
    pulls: {
      create: vi.fn().mockResolvedValue({
        data: { number: 51, html_url: "https://github.com/acme/webapp/pull/51" },
      }),
      update: vi.fn().mockResolvedValue({}),
      merge: vi.fn().mockResolvedValue({
        data: { sha: "abc123def456", merged: true },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          number: 51,
          state: "open",
          draft: true,
          mergeable: true,
          merged: false,
          html_url: "https://github.com/acme/webapp/pull/51",
          head: { sha: "abc123" },
        },
      }),
      listReviews: vi.fn().mockResolvedValue({
        data: [{ user: { login: "farzam" }, state: "APPROVED" }],
      }),
      requestReviewers: vi.fn().mockResolvedValue({}),
      createReplyForReviewComment: vi.fn().mockResolvedValue({
        data: { id: 789, html_url: "https://github.com/acme/webapp/pull/51#discussion_r789" },
      }),
      listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
      dismissReview: vi.fn().mockResolvedValue({}),
    },
    issues: {
      addLabels: vi.fn().mockResolvedValue({}),
      removeLabel: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({
        data: { id: 456, html_url: "https://github.com/acme/webapp/pull/51#issuecomment-456" },
      }),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
    },
    repos: {
      get: vi.fn().mockResolvedValue({ data: { default_branch: "main" } }),
      getBranchProtection: vi.fn().mockResolvedValue({
        data: {
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { contexts: ["ci/test"] },
          restrictions: null,
        },
      }),
      getCombinedStatusForRef: vi.fn().mockResolvedValue({
        data: { state: "success", total_count: 1 },
      }),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue({
        data: { check_runs: [] },
      }),
    },
    rateLimit: {
      get: vi.fn().mockResolvedValue({
        data: { resources: { core: { remaining: 4500, limit: 5000 } } },
      }),
    },
  };
}

const MANIFEST: PluginManifest = {
  id: "github-hosting",
  type: "git_hosting",
  version: "1.0.0",
  name: "GitHub Hosting",
  description: "PR lifecycle management via GitHub API",
  config_schema: {},
  critical: true,
  entry: "index.ts",
  adapter_meta: {},
  requirements: [],
  combined_with: [],
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  startup_hints: [],
};

const VALID_CONFIG = { github_token: "ghp_testtoken123" };
const INVALID_CONFIG = {};

const PR_OPTIONS: PROptions = {
  repo: "acme/webapp",
  branch: "engineer/task-47",
  base: "main",
  title: "Fix login bug",
  body: "Resolves #42",
  draft: true,
  labels: null,
  reviewers: null,
};

// ── Contract Suite ──────────────────────────────────────────────────────────

runGitHostingContractSuite(
  () => {
    const plugin = new GitHubHostingPlugin();
    const mock = createMockOctokit();
    const origInit = plugin["doInitialize"].bind(plugin);
    plugin["doInitialize"] = async (config: Record<string, unknown>) => {
      const result = await origInit(config);
      if (result.success) {
        (plugin as unknown as { octokit: unknown }).octokit = mock;
      }
      return result;
    };
    return plugin;
  },
  {
    validConfig: VALID_CONFIG,
    invalidConfig: INVALID_CONFIG,
    manifest: MANIFEST,
    prOptions: PR_OPTIONS,
  },
);

// ── Plugin-Specific Tests ───────────────────────────────────────────────────

describe("GitHubHostingPlugin", () => {
  let plugin: GitHubHostingPlugin;
  let mockOctokit: ReturnType<typeof createMockOctokit>;

  beforeEach(async () => {
    plugin = new GitHubHostingPlugin();
    plugin.manifest = MANIFEST;
    plugin.context = createTestPluginContext();
    mockOctokit = createMockOctokit();
    await plugin.initialize(VALID_CONFIG);
    (plugin as unknown as { octokit: unknown }).octokit = mockOctokit;
  });

  describe("createPR()", () => {
    it("creates a draft PR via Octokit", async () => {
      const result = await plugin.createPR(PR_OPTIONS);
      expect(result.pr_number).toBe(51);
      expect(result.url).toContain("pull/51");
      expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true, head: "engineer/task-47", base: "main" }),
      );
    });

    it("adds labels when provided", async () => {
      await plugin.createPR({ ...PR_OPTIONS, labels: ["engineer:active"] });
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["engineer:active"] }),
      );
    });

    it("requests reviewers when provided", async () => {
      await plugin.createPR({ ...PR_OPTIONS, reviewers: ["farzam"] });
      expect(mockOctokit.pulls.requestReviewers).toHaveBeenCalledWith(
        expect.objectContaining({ reviewers: ["farzam"] }),
      );
    });

    it("skips labels and reviewers when null", async () => {
      await plugin.createPR(PR_OPTIONS);
      expect(mockOctokit.issues.addLabels).not.toHaveBeenCalled();
      expect(mockOctokit.pulls.requestReviewers).not.toHaveBeenCalled();
    });
  });

  describe("updatePR()", () => {
    it("updates title", async () => {
      await plugin.updatePR("acme/webapp", 51, {
        title: "Updated title",
        body: null,
        draft: null,
        labels_add: null,
        labels_remove: null,
      });
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated title" }));
    });

    it("marks PR ready (draft: false)", async () => {
      await plugin.updatePR("acme/webapp", 51, {
        title: null,
        body: null,
        draft: false,
        labels_add: null,
        labels_remove: null,
      });
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ draft: false }));
    });

    it("manages labels", async () => {
      await plugin.updatePR("acme/webapp", 51, {
        title: null,
        body: null,
        draft: null,
        labels_add: ["ready"],
        labels_remove: ["draft"],
      });
      expect(mockOctokit.issues.addLabels).toHaveBeenCalled();
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalled();
    });
  });

  describe("mergePR()", () => {
    it("merges with squash strategy", async () => {
      const result = await plugin.mergePR("acme/webapp", 51, "squash");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.merge_sha).toBe("abc123def456");
      }
      expect(mockOctokit.pulls.merge).toHaveBeenCalledWith(expect.objectContaining({ merge_method: "squash" }));
    });

    it("maps a 409 conflict to the conflict reason", async () => {
      mockOctokit.pulls.merge.mockRejectedValueOnce(Object.assign(new Error("Conflict"), { status: 409 }));
      const result = await plugin.mergePR("acme/webapp", 51, "squash");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("conflict");
      }
    });

    it("maps a 405 (branch protection unsatisfied) to the not_mergeable reason", async () => {
      mockOctokit.pulls.merge.mockRejectedValueOnce(Object.assign(new Error("Not mergeable"), { status: 405 }));
      const result = await plugin.mergePR("acme/webapp", 51, "squash");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("not_mergeable");
      }
    });

    it("maps any other merge error to the transient reason", async () => {
      mockOctokit.pulls.merge.mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 500 }));
      const result = await plugin.mergePR("acme/webapp", 51, "squash");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("transient");
      }
    });
  });

  describe("closePR()", () => {
    it("closes PR via update", async () => {
      await plugin.closePR("acme/webapp", 51);
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ state: "closed" }));
    });
  });

  describe("getPRStatus()", () => {
    it("returns PR status with checks", async () => {
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.number).toBe(51);
      expect(status.state).toBe("open");
      expect(status.draft).toBe(true);
      expect(status.merge_state).toBe("mergeable");
      expect(status.checks_state).toBe("passing");
    });

    it("maps GitHub's not-yet-computed mergeable (null) to merge_state unknown, not conflicting", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          number: 51,
          state: "open",
          draft: false,
          mergeable: null,
          merged: false,
          html_url: "https://github.com/acme/webapp/pull/51",
          head: { sha: "abc123" },
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.merge_state).toBe("unknown");
    });

    it("maps GitHub's mergeable=false to merge_state conflicting", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          number: 51,
          state: "open",
          draft: false,
          mergeable: false,
          merged: false,
          html_url: "https://github.com/acme/webapp/pull/51",
          head: { sha: "abc123" },
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.merge_state).toBe("conflicting");
    });

    it("reports merged state", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          number: 51,
          state: "closed",
          draft: false,
          mergeable: false,
          merged: true,
          html_url: "https://github.com/acme/webapp/pull/51",
          head: { sha: "abc123" },
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.state).toBe("merged");
    });

    // ── Status API (legacy commit statuses) ──

    it("reports failing from status API", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "failure", total_count: 2 },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("failing");
    });

    it("reports pending from status API", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "pending", total_count: 1 },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("pending");
    });

    it("reports none when neither API has checks", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "pending", total_count: 0 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: { check_runs: [] },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("none");
    });

    // ── Checks API (GitHub Actions) ──

    it("reports passing from GitHub Actions check runs", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "pending", total_count: 0 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [{ status: "completed", conclusion: "success" }],
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("passing");
    });

    it("reports pending from in-progress GitHub Actions", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "pending", total_count: 0 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [{ status: "in_progress", conclusion: null }],
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("pending");
    });

    it("reports failing from failed GitHub Actions", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "pending", total_count: 0 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [{ status: "completed", conclusion: "failure" }],
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("failing");
    });

    // ── Combined: worst state wins ──

    it("failing from checks API overrides passing from status API", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "success", total_count: 1 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [{ status: "completed", conclusion: "failure" }],
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("failing");
    });

    it("pending from checks API overrides passing from status API", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "success", total_count: 1 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [{ status: "queued", conclusion: null }],
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("pending");
    });

    it("treats skipped and neutral conclusions as passing", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "pending", total_count: 0 },
      });
      mockOctokit.checks.listForRef.mockResolvedValueOnce({
        data: {
          check_runs: [
            { status: "completed", conclusion: "skipped" },
            { status: "completed", conclusion: "neutral" },
          ],
        },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_state).toBe("passing");
    });
  });

  describe("getReviewStatus()", () => {
    it("aggregates reviews correctly", async () => {
      const status = await plugin.getReviewStatus("acme/webapp", 51);
      expect(status.approved).toBe(true);
      expect(status.approvals).toBe(1);
      expect(status.changes_requested).toBe(false);
      expect(status.reviewers).toHaveLength(1);
    });

    it("detects changes_requested", async () => {
      mockOctokit.pulls.listReviews.mockResolvedValueOnce({
        data: [{ user: { login: "farzam" }, state: "CHANGES_REQUESTED" }],
      });
      const status = await plugin.getReviewStatus("acme/webapp", 51);
      expect(status.approved).toBe(false);
      expect(status.changes_requested).toBe(true);
    });

    it("takes latest review per user", async () => {
      mockOctokit.pulls.listReviews.mockResolvedValueOnce({
        data: [
          { user: { login: "farzam" }, state: "CHANGES_REQUESTED" },
          { user: { login: "farzam" }, state: "APPROVED" },
        ],
      });
      const status = await plugin.getReviewStatus("acme/webapp", 51);
      expect(status.approved).toBe(true);
      expect(status.reviewers).toHaveLength(1);
      expect(status.reviewers[0]?.state).toBe("approved");
    });
  });

  describe("commentOnPR()", () => {
    it("posts a regular comment", async () => {
      const result = await plugin.commentOnPR("acme/webapp", 51, "Looks good!");
      expect(result.comment_id).toBe("456");
      expect(mockOctokit.issues.createComment).toHaveBeenCalled();
    });

    it("posts a reply to a review comment", async () => {
      const result = await plugin.commentOnPR("acme/webapp", 51, "Fixed!", "789");
      expect(result.comment_id).toBe("789");
      expect(mockOctokit.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 789, body: "Fixed!" }),
      );
    });
  });

  describe("getBranchProtection()", () => {
    it("returns protection rules", async () => {
      const protection = await plugin.getBranchProtection("acme/webapp", "main");
      expect(protection.protected).toBe(true);
      expect(protection.required_reviews).toBe(1);
      expect(protection.required_checks).toEqual(["ci/test"]);
    });

    it("returns unprotected for 404", async () => {
      mockOctokit.repos.getBranchProtection.mockRejectedValueOnce(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
      const protection = await plugin.getBranchProtection("acme/webapp", "dev");
      expect(protection.protected).toBe(false);
      expect(protection.required_reviews).toBe(0);
    });
  });

  describe("getDefaultBranch()", () => {
    it("returns the default branch", async () => {
      const branch = await plugin.getDefaultBranch("acme/webapp");
      expect(branch).toBe("main");
    });
  });

  describe("dismissApprovals()", () => {
    it("dismisses all approved reviews", async () => {
      mockOctokit.pulls.listReviews.mockResolvedValue({
        data: [
          { id: 100, user: { login: "alice" }, state: "APPROVED" },
          { id: 200, user: { login: "bob" }, state: "CHANGES_REQUESTED" },
          { id: 300, user: { login: "carol" }, state: "APPROVED" },
        ],
      });

      await plugin.dismissApprovals("acme/webapp", 51, "Stale approval");

      expect(mockOctokit.pulls.dismissReview).toHaveBeenCalledTimes(2);
      expect(mockOctokit.pulls.dismissReview).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "acme",
          repo: "webapp",
          pull_number: 51,
          review_id: 100,
          message: "Stale approval",
        }),
      );
      expect(mockOctokit.pulls.dismissReview).toHaveBeenCalledWith(
        expect.objectContaining({
          review_id: 300,
        }),
      );
    });

    it("no-ops when no approvals exist", async () => {
      mockOctokit.pulls.listReviews.mockResolvedValue({
        data: [{ id: 200, user: { login: "bob" }, state: "CHANGES_REQUESTED" }],
      });

      await plugin.dismissApprovals("acme/webapp", 51, "Stale approval");

      expect(mockOctokit.pulls.dismissReview).not.toHaveBeenCalled();
    });
  });

  describe("config validation", () => {
    it("rejects missing github_token", async () => {
      const p = new GitHubHostingPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      const result = await p.initialize({});
      expect(result.success).toBe(false);
    });

    it("applies default merge strategy", async () => {
      const p = new GitHubHostingPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      await p.initialize(VALID_CONFIG);
      expect((p as unknown as { config: { default_merge_strategy: string } }).config.default_merge_strategy).toBe(
        "squash",
      );
    });
  });

  describe("error handling", () => {
    it("throws on invalid repo format", async () => {
      try {
        await plugin.createPR({ ...PR_OPTIONS, repo: "invalid" });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string } }).adapterError.code).toBe("invalid_input");
      }
    });
  });

  describe("detectPrEvents()", () => {
    it("aggregates an approved, green, mergeable PR into pr_ready_to_merge", async () => {
      const events = await plugin.detectPrEvents("acme/webapp", 51);
      expect(events.map((event) => event.type)).toEqual([PrEventTypes.pr_ready_to_merge]);
    });

    it("reports a merge as the single terminal event", async () => {
      mockOctokit.pulls.get.mockResolvedValueOnce({
        data: {
          number: 51,
          state: "closed",
          merged: true,
          draft: false,
          mergeable: true,
          html_url: "u",
          head: { sha: "s" },
        },
      });
      const events = await plugin.detectPrEvents("acme/webapp", 51);
      expect(events.map((event) => event.type)).toEqual([PrEventTypes.pr_merged]);
    });
  });
});

// ── derivePrEvents (the stateless aggregation policy, pure) ───────────────────

describe("derivePrEvents", () => {
  const status = (over: Partial<PRStatus> = {}): PRStatus => ({
    number: 51,
    state: "open",
    draft: false,
    merge_state: "mergeable",
    checks_state: "passing",
    url: "https://fake.git/acme/webapp/pull/51",
    ...over,
  });
  const review = (over: Partial<ReviewStatus> = {}): ReviewStatus => ({
    approved: false,
    approvals: 0,
    changes_requested: false,
    reviewers: [],
    comments: [],
    ...over,
  });
  const approved = review({ approved: true, approvals: 1 });
  const comment = (id: string): PRComment => ({
    id,
    author: "alice",
    body: "please fix",
    created_at: "2026-05-31T00:00:00Z",
  });

  it("reports a merge as the single terminal event", () => {
    expect(derivePrEvents(status({ state: "merged" }), approved, [])).toEqual([{ type: PrEventTypes.pr_merged }]);
  });

  it("reports nothing for a PR closed without merging", () => {
    expect(derivePrEvents(status({ state: "closed" }), review(), [])).toEqual([]);
  });

  it("emits pr_ready_to_merge only when approved, CI green, and mergeable hold together", () => {
    expect(derivePrEvents(status(), approved, [])).toEqual([{ type: PrEventTypes.pr_ready_to_merge }]);
  });

  it("withholds readiness while CI is still pending — the stateless wait", () => {
    expect(derivePrEvents(status({ checks_state: "pending" }), approved, [])).toEqual([]);
  });

  it("reports a CI failure and withholds readiness", () => {
    const events = derivePrEvents(status({ checks_state: "failing" }), approved, []);
    expect(events.map((event) => event.type)).toEqual([PrEventTypes.pr_ci_failure]);
  });

  it("reports a merge conflict and withholds readiness", () => {
    const events = derivePrEvents(status({ merge_state: "conflicting" }), approved, []);
    expect(events.map((event) => event.type)).toEqual([PrEventTypes.pr_merge_conflict]);
  });

  it("treats unknown mergeability as no conflict — withholds the event while the host computes it", () => {
    // Regression: a host returns `unknown` (mergeability not yet computed) for a few seconds after every
    // push. Reading that as a conflict re-enters the pipeline to resolve a conflict that does not exist,
    // looping on every poll. `unknown` must emit no merge-conflict event and no readiness.
    expect(derivePrEvents(status({ merge_state: "unknown" }), approved, [])).toEqual([]);
  });

  it("surfaces changes-requested as feedback", () => {
    const events = derivePrEvents(status(), review({ changes_requested: true }), []);
    expect(events.map((event) => event.type)).toEqual([PrEventTypes.pr_comments]);
  });

  it("surfaces unaddressed comments on an unapproved PR, carrying them for Core", () => {
    const comments = [comment("c1")];
    expect(derivePrEvents(status(), review(), comments)).toEqual([{ type: PrEventTypes.pr_comments, comments }]);
  });

  it("lets an approval suppress non-blocking comments so readiness wins", () => {
    const events = derivePrEvents(status(), approved, [comment("c1")]);
    expect(events.map((event) => event.type)).toEqual([PrEventTypes.pr_ready_to_merge]);
  });
});
