import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubCommPlugin } from "../../../../../src/plugins/communication/github-comm/github-comm.js";
import {
  diffStateLabels,
  parseGitHubUrl,
  parseTargetChannel,
  stateLabelName,
} from "../../../../../src/plugins/communication/github-comm/github-utils.js";
import type { FormattedMessage, PluginManifest, Target } from "../../../../../src/schemas/adapters.js";
import { MessageTypes } from "../../../../../src/schemas/adapters.js";
import { TaskStates } from "../../../../../src/schemas/task.js";
import { runCommunicationContractSuite } from "../../../../helpers/contract-suites/communication-contract.js";

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
      listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [{ name: "engineer:queued" }, { name: "bug" }] }),
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
  entry: "index.ts",
  adapter_meta: { capabilities: ["send", "sync", "ticket_management"] },
  requirements: [],
  combined_with: [],
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  startup_hints: [],
};

const VALID_CONFIG = { github_token: "ghp_testtoken123" };
const INVALID_CONFIG = {};

const TARGET: Target = { user_id: "farzam", channel: "acme/webapp#42" };
const MESSAGE: FormattedMessage = {
  content: "Task picked up",
  metadata: { task_id: "task-1", type: MessageTypes.notification },
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

    it("reports ticket_management capability", () => {
      expect(plugin.hasCapability("ticket_management")).toBe(true);
    });

    it("does not report receive capability", () => {
      expect(plugin.hasCapability("receive")).toBe(false);
    });
  });

  describe("formatMessage()", () => {
    it("formats notification with Info prefix", () => {
      const result = plugin.formatMessage("Test", MessageTypes.notification);
      expect(result).toContain("> **Info**");
      expect(result).toContain("Test");
    });

    it("formats question with Question prefix", () => {
      const result = plugin.formatMessage("What?", MessageTypes.question);
      expect(result).toContain("> **Question**");
    });

    it("formats status_response with Status prefix", () => {
      const result = plugin.formatMessage("All good", MessageTypes.status_response);
      expect(result).toContain("> **Status**");
    });

    it("formats milestone with Milestone prefix", () => {
      const result = plugin.formatMessage("Done!", MessageTypes.milestone);
      expect(result).toContain("> **Milestone**");
    });

    it("formats alert with Alert prefix", () => {
      const result = plugin.formatMessage("Warning!", MessageTypes.alert);
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
      mockOctokit.issues.createComment.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("not_found");
    });
  });

  describe("syncTaskState()", () => {
    it("adds new label and removes old one", async () => {
      await plugin.syncTaskState("task-1", TaskStates.queued, TaskStates.active, {
        task_title: "Fix bug",
        external_ref: { type: "github_issue", repo: "acme/webapp", id: "42" },
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
      await plugin.syncTaskState("task-1", TaskStates.queued, TaskStates.active, {
        task_title: "Fix bug",
        external_ref: null,
        sub_state: null,
        reason: null,
      });
      expect(mockOctokit.issues.listLabelsOnIssue).not.toHaveBeenCalled();
    });

    it("no-ops when external_ref repo lacks owner/name format", async () => {
      await plugin.syncTaskState("task-1", TaskStates.queued, TaskStates.active, {
        task_title: "Fix bug",
        external_ref: { type: "jira_ticket", repo: "no-slash", id: "1" },
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
          external_ref: { type: "github_issue", repo: "acme/webapp", id: "42" },
          expected_state: TaskStates.active,
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
          external_ref: { type: "github_issue", repo: "acme/webapp", id: "42" },
          expected_state: TaskStates.active,
          expected_label: "engineer:active",
        },
      ]);
      expect(result.reconciled).toBe(0);
    });

    it("reports errors for invalid refs", async () => {
      const result = await plugin.reconcileState([
        {
          task_id: "task-1",
          external_ref: null,
          expected_state: TaskStates.active,
          expected_label: "engineer:active",
        },
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.reason).toBe("invalid_external_ref");
    });
  });

  describe("ticket management", () => {
    it("commentOnTicket() posts a comment", async () => {
      await plugin.commentOnTicket({ type: "github_issue", repo: "acme/webapp", id: "42" }, "Hello!");
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "webapp",
        issue_number: 42,
        body: "Hello!",
      });
    });

    it("createTicket() creates and returns result", async () => {
      const result = await plugin.createTicket("acme/webapp", {
        title: "New issue",
        body: "Description",
        labels: ["bug"],
        assignees: null,
        parent_issue: null,
      });
      expect(result.number).toBe(99);
      expect(result.url).toBe("https://github.com/acme/webapp/issues/99");
    });

    it("updateTicket() updates state and labels", async () => {
      await plugin.updateTicket("acme/webapp", 42, {
        state: "closed",
        labels_add: ["done"],
        labels_remove: ["in-progress"],
        body: null,
      });
      expect(mockOctokit.issues.update).toHaveBeenCalled();
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["done"] }));
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "in-progress" }));
    });

    it("commentOnTicket() throws on invalid repo format", async () => {
      try {
        await plugin.commentOnTicket({ type: "github_issue", repo: "invalid", id: "42" }, "Hi");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string } }).adapterError.code).toBe("invalid_input");
      }
    });

    it("commentOnTicket() wraps API errors as AdapterMethodError", async () => {
      mockOctokit.issues.createComment.mockRejectedValueOnce(new Error("API rate limited"));
      try {
        await plugin.commentOnTicket({ type: "github_issue", repo: "acme/webapp", id: "42" }, "Test comment");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toHaveProperty("adapterError");
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
      expect((p as unknown as { config: { label_prefix: string } }).config.label_prefix).toBe("engineer:");
    });
  });
});

// ── GitHub Utility Tests (from github-shared) ─────────────────────────────

describe("parseGitHubUrl", () => {
  it("parses an issue URL", () => {
    const result = parseGitHubUrl("https://github.com/acme/webapp/issues/42");
    expect(result).toEqual({ owner: "acme", repo: "webapp", number: 42, type: "issue" });
  });

  it("parses a PR URL", () => {
    const result = parseGitHubUrl("https://github.com/acme/webapp/pull/7");
    expect(result).toEqual({ owner: "acme", repo: "webapp", number: 7, type: "pull" });
  });

  it("handles http (not https)", () => {
    const result = parseGitHubUrl("http://github.com/acme/webapp/issues/1");
    expect(result).not.toBeNull();
    expect(result?.owner).toBe("acme");
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseGitHubUrl("https://gitlab.com/acme/webapp/issues/1")).toBeNull();
  });

  it("returns null for malformed paths", () => {
    expect(parseGitHubUrl("https://github.com/acme/webapp")).toBeNull();
    expect(parseGitHubUrl("https://github.com/acme")).toBeNull();
    expect(parseGitHubUrl("")).toBeNull();
  });

  it("returns null for non-numeric issue number", () => {
    expect(parseGitHubUrl("https://github.com/acme/webapp/issues/abc")).toBeNull();
  });

  it("handles URLs with trailing paths", () => {
    const result = parseGitHubUrl("https://github.com/acme/webapp/issues/42/comments");
    expect(result).not.toBeNull();
    expect(result?.number).toBe(42);
  });
});

describe("stateLabelName", () => {
  it("generates label with prefix", () => {
    expect(stateLabelName(TaskStates.active, "engineer:")).toBe("engineer:active");
  });

  it("lowercases the state", () => {
    expect(stateLabelName("Review_Pending", "engineer:")).toBe("engineer:review_pending");
  });

  it("works with custom prefix", () => {
    expect(stateLabelName(TaskStates.queued, "bot-")).toBe("bot-queued");
  });
});

describe("diffStateLabels", () => {
  const prefix = "engineer:";

  it("adds new label and removes old one", () => {
    const result = diffStateLabels(["engineer:queued", "bug"], TaskStates.active, prefix);
    expect(result.add).toEqual(["engineer:active"]);
    expect(result.remove).toEqual(["engineer:queued"]);
  });

  it("no-ops when label already present", () => {
    const result = diffStateLabels(["engineer:active", "bug"], TaskStates.active, prefix);
    expect(result.add).toEqual([]);
    expect(result.remove).toEqual([]);
  });

  it("removes multiple old state labels", () => {
    const result = diffStateLabels(["engineer:queued", "engineer:blocked"], TaskStates.active, prefix);
    expect(result.add).toEqual(["engineer:active"]);
    expect(result.remove).toEqual(["engineer:queued", "engineer:blocked"]);
  });

  it("preserves non-prefixed labels", () => {
    const result = diffStateLabels(["bug", "priority:high", "engineer:queued"], TaskStates.active, prefix);
    expect(result.remove).toEqual(["engineer:queued"]);
  });

  it("handles empty current labels", () => {
    const result = diffStateLabels([], TaskStates.active, prefix);
    expect(result.add).toEqual(["engineer:active"]);
    expect(result.remove).toEqual([]);
  });
});

describe("parseTargetChannel", () => {
  it("parses owner/repo#number", () => {
    const result = parseTargetChannel("acme/webapp#42");
    expect(result).toEqual({ owner: "acme", repo: "webapp", issueNumber: 42 });
  });

  it("returns null for invalid format", () => {
    expect(parseTargetChannel("acme/webapp")).toBeNull();
    expect(parseTargetChannel("acme#42")).toBeNull();
    expect(parseTargetChannel("")).toBeNull();
  });

  it("returns null for non-numeric issue number", () => {
    expect(parseTargetChannel("acme/webapp#abc")).toBeNull();
  });
});
