import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommunicationContractSuite } from "../../../../test/helpers/contract-suites/communication-contract.js";
import type { FormattedMessage, PluginManifest, Target } from "../../../schemas/adapters.js";
import { GitHubCommPlugin } from "./github-comm.js";

// ── Mock Octokit ────────────────────────────────────────────────────────────

function createMockOctokit() {
  return {
    issues: {
      createComment: vi.fn().mockResolvedValue({
        data: {
          id: 12345,
          html_url: "https://github.com/acme/webapp/issues/42#issuecomment-12345",
        },
      }),
      create: vi.fn().mockResolvedValue({
        data: { number: 99, html_url: "https://github.com/acme/webapp/issues/99" },
      }),
      update: vi.fn().mockResolvedValue({}),
      addLabels: vi.fn().mockResolvedValue({}),
      removeLabel: vi.fn().mockResolvedValue({}),
      listLabelsOnIssue: vi
        .fn()
        .mockResolvedValue({ data: [{ name: "engineer:queued" }, { name: "bug" }] }),
    },
    rateLimit: {
      get: vi.fn().mockResolvedValue({
        data: { resources: { core: { remaining: 4500, limit: 5000 } } },
      }),
    },
  };
}

const MANIFEST: PluginManifest = {
  id: "github-comm",
  type: "communication",
  version: "1.0.0",
  name: "GitHub Communication",
  description: "Posts comments and manages labels on GitHub issues/PRs",
  config_schema: {},
  critical: false,
  enabled: true,
  entry: "index.ts",
  adapter_meta: { capabilities: ["send", "sync", "issue_management"] },
};

const VALID_CONFIG = { github_token: "ghp_testtoken123" };
const INVALID_CONFIG = {};

const TARGET: Target = { user_id: "farzam", channel: "acme/webapp#42" };
const MESSAGE: FormattedMessage = {
  content: "Task picked up",
  metadata: { task_id: "task-1", type: "notification" },
};

// ── Contract Suite ──────────────────────────────────────────────────────────

runCommunicationContractSuite(
  () => {
    const plugin = new GitHubCommPlugin();
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
    target: TARGET,
    message: MESSAGE,
  },
);

// ── Plugin-Specific Tests ───────────────────────────────────────────────────

describe("GitHubCommPlugin", () => {
  let plugin: GitHubCommPlugin;
  let mockOctokit: ReturnType<typeof createMockOctokit>;

  beforeEach(async () => {
    plugin = new GitHubCommPlugin();
    plugin.manifest = MANIFEST;
    mockOctokit = createMockOctokit();
    await plugin.initialize(VALID_CONFIG);
    (plugin as unknown as { octokit: unknown }).octokit = mockOctokit;
  });

  describe("hasCapability()", () => {
    it("reports send capability", () => {
      expect(plugin.hasCapability("send")).toBe(true);
    });

    it("reports sync capability", () => {
      expect(plugin.hasCapability("sync")).toBe(true);
    });

    it("reports issue_management capability", () => {
      expect(plugin.hasCapability("issue_management")).toBe(true);
    });

    it("does not report receive capability", () => {
      expect(plugin.hasCapability("receive")).toBe(false);
    });
  });

  describe("formatMessage()", () => {
    it("formats notification with Info prefix", () => {
      const result = plugin.formatMessage("Test", "notification");
      expect(result).toContain("> **Info**");
      expect(result).toContain("Test");
    });

    it("formats question with Question prefix", () => {
      const result = plugin.formatMessage("What?", "question");
      expect(result).toContain("> **Question**");
    });

    it("formats status_response with Status prefix", () => {
      const result = plugin.formatMessage("All good", "status_response");
      expect(result).toContain("> **Status**");
    });

    it("formats milestone with Milestone prefix", () => {
      const result = plugin.formatMessage("Done!", "milestone");
      expect(result).toContain("> **Milestone**");
    });

    it("formats alert with Alert prefix", () => {
      const result = plugin.formatMessage("Warning!", "alert");
      expect(result).toContain("> **Alert**");
    });
  });

  describe("sendMessage()", () => {
    it("posts a comment via Octokit", async () => {
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(true);
      expect(result.message_id).toBe("12345");
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "webapp",
        issue_number: 42,
        body: MESSAGE.content,
      });
    });

    it("returns error for invalid target channel", async () => {
      const badTarget: Target = { user_id: "farzam", channel: "invalid" };
      const result = await plugin.sendMessage(badTarget, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("invalid_input");
    });

    it("returns error for null channel", async () => {
      const result = await plugin.sendMessage({ user_id: "farzam", channel: null }, MESSAGE);
      expect(result.success).toBe(false);
    });

    it("returns error on API failure", async () => {
      mockOctokit.issues.createComment.mockRejectedValueOnce(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("not_found");
    });
  });

  describe("syncTaskState()", () => {
    it("adds new label and removes old one", async () => {
      await plugin.syncTaskState("task-1", "queued", "active", {
        task_title: "Fix bug",
        external_ref: "https://github.com/acme/webapp/issues/42",
        sub_state: null,
        reason: null,
      });

      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: "acme",
        repo: "webapp",
        issue_number: 42,
        labels: ["engineer:active"],
      });
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith({
        owner: "acme",
        repo: "webapp",
        issue_number: 42,
        name: "engineer:queued",
      });
    });

    it("no-ops when external_ref is null", async () => {
      await plugin.syncTaskState("task-1", "queued", "active", {
        task_title: "Fix bug",
        external_ref: null,
        sub_state: null,
        reason: null,
      });
      expect(mockOctokit.issues.listLabelsOnIssue).not.toHaveBeenCalled();
    });

    it("no-ops when external_ref is not a GitHub URL", async () => {
      await plugin.syncTaskState("task-1", "queued", "active", {
        task_title: "Fix bug",
        external_ref: "https://jira.example.com/browse/FOO-1",
        sub_state: null,
        reason: null,
      });
      expect(mockOctokit.issues.listLabelsOnIssue).not.toHaveBeenCalled();
    });
  });

  describe("reconcileState()", () => {
    it("reconciles mismatched labels", async () => {
      const result = await plugin.reconcileState([
        {
          task_id: "task-1",
          external_ref: "https://github.com/acme/webapp/issues/42",
          expected_state: "active",
          expected_label: "engineer:active",
        },
      ]);
      expect(result.reconciled).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("skips tasks with already correct labels", async () => {
      mockOctokit.issues.listLabelsOnIssue.mockResolvedValueOnce({
        data: [{ name: "engineer:active" }],
      });
      const result = await plugin.reconcileState([
        {
          task_id: "task-1",
          external_ref: "https://github.com/acme/webapp/issues/42",
          expected_state: "active",
          expected_label: "engineer:active",
        },
      ]);
      expect(result.reconciled).toBe(0);
    });

    it("reports errors for invalid refs", async () => {
      const result = await plugin.reconcileState([
        {
          task_id: "task-1",
          external_ref: "not-a-url",
          expected_state: "active",
          expected_label: "engineer:active",
        },
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.reason).toBe("invalid_external_ref");
    });
  });

  describe("issue management", () => {
    it("commentOnIssue() posts a comment", async () => {
      await plugin.commentOnIssue("acme/webapp", 42, "Hello!");
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "webapp",
        issue_number: 42,
        body: "Hello!",
      });
    });

    it("createIssue() creates and returns result", async () => {
      const result = await plugin.createIssue("acme/webapp", {
        title: "New issue",
        body: "Description",
        labels: ["bug"],
        assignees: null,
        parent_issue: null,
      });
      expect(result.number).toBe(99);
      expect(result.url).toBe("https://github.com/acme/webapp/issues/99");
    });

    it("updateIssue() updates state and labels", async () => {
      await plugin.updateIssue("acme/webapp", 42, {
        state: "closed",
        labels_add: ["done"],
        labels_remove: ["in-progress"],
        body: null,
      });
      expect(mockOctokit.issues.update).toHaveBeenCalled();
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["done"] }),
      );
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "in-progress" }),
      );
    });

    it("commentOnIssue() throws on invalid repo format", async () => {
      try {
        await plugin.commentOnIssue("invalid", 42, "Hi");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string } }).adapterError.code).toBe(
          "invalid_input",
        );
      }
    });
  });

  describe("config validation", () => {
    it("rejects missing github_token", async () => {
      const p = new GitHubCommPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({});
      expect(result.success).toBe(false);
    });

    it("applies default label_prefix", async () => {
      const p = new GitHubCommPlugin();
      p.manifest = MANIFEST;
      await p.initialize(VALID_CONFIG);
      expect((p as unknown as { config: { label_prefix: string } }).config.label_prefix).toBe(
        "engineer:",
      );
    });
  });
});
