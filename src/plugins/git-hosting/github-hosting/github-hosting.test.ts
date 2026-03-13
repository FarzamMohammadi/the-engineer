import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGitHostingContractSuite } from "../../../../test/helpers/contract-suites/git-hosting-contract.js";
import type { PROptions, PluginManifest } from "../../../schemas/adapters.js";
import { GitHubHostingPlugin } from "./github-hosting.js";

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
        data: { state: "success" },
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
  enabled: true,
  entry: "index.ts",
  adapter_meta: {},
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
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Updated title" }),
      );
    });

    it("marks PR ready (draft: false)", async () => {
      await plugin.updatePR("acme/webapp", 51, {
        title: null,
        body: null,
        draft: false,
        labels_add: null,
        labels_remove: null,
      });
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ draft: false }),
      );
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
      expect(result.merge_sha).toBe("abc123def456");
      expect(mockOctokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({ merge_method: "squash" }),
      );
    });

    it("returns error on merge conflict (409)", async () => {
      mockOctokit.pulls.merge.mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), { status: 409 }),
      );
      const result = await plugin.mergePR("acme/webapp", 51, "squash");
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("merge_conflict");
    });

    it("returns error when PR not mergeable (405)", async () => {
      mockOctokit.pulls.merge.mockRejectedValueOnce(
        Object.assign(new Error("Not mergeable"), { status: 405 }),
      );
      const result = await plugin.mergePR("acme/webapp", 51, "squash");
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("pr_not_mergeable");
    });
  });

  describe("closePR()", () => {
    it("closes PR via update", async () => {
      await plugin.closePR("acme/webapp", 51);
      expect(mockOctokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" }),
      );
    });
  });

  describe("getPRStatus()", () => {
    it("returns PR status with checks", async () => {
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.number).toBe(51);
      expect(status.state).toBe("open");
      expect(status.draft).toBe(true);
      expect(status.mergeable).toBe(true);
      expect(status.checks_passing).toBe(true);
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

    it("reports failing checks", async () => {
      mockOctokit.repos.getCombinedStatusForRef.mockResolvedValueOnce({
        data: { state: "failure" },
      });
      const status = await plugin.getPRStatus("acme/webapp", 51);
      expect(status.checks_passing).toBe(false);
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

  describe("config validation", () => {
    it("rejects missing github_token", async () => {
      const p = new GitHubHostingPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({});
      expect(result.success).toBe(false);
    });

    it("applies default merge strategy", async () => {
      const p = new GitHubHostingPlugin();
      p.manifest = MANIFEST;
      await p.initialize(VALID_CONFIG);
      expect(
        (p as unknown as { config: { default_merge_strategy: string } }).config
          .default_merge_strategy,
      ).toBe("squash");
    });
  });

  describe("error handling", () => {
    it("throws on invalid repo format", async () => {
      try {
        await plugin.createPR({ ...PR_OPTIONS, repo: "invalid" });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string } }).adapterError.code).toBe(
          "invalid_input",
        );
      }
    });
  });
});
