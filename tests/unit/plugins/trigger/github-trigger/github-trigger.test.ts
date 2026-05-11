import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubTriggerPlugin } from "../../../../../src/plugins/trigger/github-trigger/github-trigger.js";
import type { PluginManifest } from "../../../../../src/schemas/adapters.js";
import { runTriggerContractSuite } from "../../../../helpers/contract-suites/trigger-contract.js";

// ── Mock Octokit ────────────────────────────────────────────────────────────

function createMockOctokit() {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [
          {
            number: 42,
            title: "Fix login bug",
            body: "Users cannot log in",
            html_url: "https://github.com/acme/webapp/issues/42",
            updated_at: "2026-03-11T10:00:00Z",
            labels: [{ name: "bug" }],
            assignees: [{ login: "farzam" }],
          },
        ],
      }),
    },
    rateLimit: {
      get: vi.fn().mockResolvedValue({
        data: {
          resources: {
            core: { remaining: 4500, limit: 5000, reset: 1741700000 },
          },
        },
      }),
    },
  };
}

const MANIFEST: PluginManifest = {
  id: "github-trigger",
  type: "trigger",
  version: "1.0.0",
  name: "GitHub Trigger",
  description: "Polls GitHub for assigned issues",
  config_schema: {},
  critical: true,
  entry: "index.ts",
  adapter_meta: {},
  requirements: [],
  combined_with: [],
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  startup_hints: [],
};

const VALID_CONFIG = {
  github_token: "ghp_testtoken123",
  repos: [{ owner: "acme", name: "webapp" }],
  labels: [],
};

const INVALID_CONFIG = {
  // Missing github_token and repos
};

// ── Contract Suite ──────────────────────────────────────────────────────────

runTriggerContractSuite(
  () => {
    const plugin = new GitHubTriggerPlugin();
    // Pre-wire mock Octokit — doInitialize will overwrite, so we override after
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
  { validConfig: VALID_CONFIG, invalidConfig: INVALID_CONFIG, manifest: MANIFEST },
);

// ── Plugin-Specific Tests ───────────────────────────────────────────────────

describe("GitHubTriggerPlugin", () => {
  let plugin: GitHubTriggerPlugin;
  let mockOctokit: ReturnType<typeof createMockOctokit>;

  beforeEach(async () => {
    plugin = new GitHubTriggerPlugin();
    plugin.manifest = MANIFEST;
    mockOctokit = createMockOctokit();

    await plugin.initialize(VALID_CONFIG);
    (plugin as unknown as { octokit: unknown }).octokit = mockOctokit;
  });

  describe("doPoll()", () => {
    it("generates correct idempotency key for issues", async () => {
      const events = await plugin.poll();
      expect(events).toHaveLength(1);
      expect(events[0]?.idempotency_key).toBe("github:issue:acme/webapp:42");
    });

    it("sets correct event_type for issues", async () => {
      const events = await plugin.poll();
      expect(events[0]?.event_type).toBe("issue_assigned");
    });

    it("sets correct source from manifest id", async () => {
      const events = await plugin.poll();
      expect(events[0]?.source).toBe("github-trigger");
    });

    it("includes external_ref as structured ExternalRef object", async () => {
      const events = await plugin.poll();
      expect(events[0]?.external_ref).toEqual({
        type: "github_issue",
        repo: "acme/webapp",
        id: "42",
        url: "https://github.com/acme/webapp/issues/42",
        pr_decorations: {
          title_prefix: "#42:",
          description_suffix: "Closes #42",
        },
      });
    });

    it("extracts metadata with labels and assignees", async () => {
      const events = await plugin.poll();
      const meta = events[0]?.metadata as Record<string, unknown>;
      expect(meta["labels"]).toEqual(["bug"]);
      expect(meta["assignees"]).toEqual(["farzam"]);
      expect(meta["issue_number"]).toBe(42);
    });

    it("handles null body", async () => {
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [
          {
            number: 1,
            title: "No body",
            body: null,
            html_url: "https://github.com/acme/webapp/issues/1",
            updated_at: "2026-03-11T10:00:00Z",
            labels: [],
            assignees: [],
          },
        ],
      });
      const events = await plugin.poll();
      expect(events[0]?.body).toBeNull();
    });

    it("filters out pull requests from issues list", async () => {
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [
          {
            number: 10,
            title: "PR",
            html_url: "https://github.com/acme/webapp/pull/10",
            updated_at: "2026-03-11T10:00:00Z",
            labels: [],
            assignees: [],
            pull_request: { url: "..." },
          },
          {
            number: 11,
            title: "Issue",
            html_url: "https://github.com/acme/webapp/issues/11",
            updated_at: "2026-03-11T10:00:00Z",
            labels: [],
            assignees: [],
          },
        ],
      });
      const events = await plugin.poll();
      expect(events).toHaveLength(1);
      expect(events[0]?.title).toBe("Issue");
    });

    it("passes labels filter to API", async () => {
      const configWithLabels = { ...VALID_CONFIG, labels: ["bug", "urgent"] };
      const labelPlugin = new GitHubTriggerPlugin();
      labelPlugin.manifest = MANIFEST;
      await labelPlugin.initialize(configWithLabels);
      (labelPlugin as unknown as { octokit: unknown }).octokit = mockOctokit;

      await labelPlugin.poll();

      const callArgs = mockOctokit.issues.listForRepo.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs["labels"]).toBe("bug,urgent");
    });

    it("polls multiple repos", async () => {
      const multiConfig = {
        ...VALID_CONFIG,
        repos: [
          { owner: "acme", name: "webapp" },
          { owner: "acme", name: "api" },
        ],
      };
      const multiPlugin = new GitHubTriggerPlugin();
      multiPlugin.manifest = MANIFEST;
      await multiPlugin.initialize(multiConfig);
      (multiPlugin as unknown as { octokit: unknown }).octokit = mockOctokit;

      mockOctokit.issues.listForRepo
        .mockResolvedValueOnce({
          status: 200,
          headers: { etag: '"mock-etag"' },
          data: [
            {
              number: 1,
              title: "Issue A",
              html_url: "https://github.com/acme/webapp/issues/1",
              updated_at: "2026-03-11T10:00:00Z",
              labels: [],
              assignees: [],
            },
          ],
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: { etag: '"mock-etag"' },
          data: [
            {
              number: 2,
              title: "Issue B",
              html_url: "https://github.com/acme/api/issues/2",
              updated_at: "2026-03-11T10:00:00Z",
              labels: [],
              assignees: [],
            },
          ],
        });

      const events = await multiPlugin.poll();
      expect(events).toHaveLength(2);
      expect(events[0]?.repo).toBe("acme/webapp");
      expect(events[1]?.repo).toBe("acme/api");
    });

    it("advances watermark after poll", async () => {
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [
          {
            number: 1,
            title: "Issue",
            html_url: "https://github.com/acme/webapp/issues/1",
            updated_at: "2026-03-11T12:00:00Z",
            labels: [],
            assignees: [],
          },
        ],
      });

      await plugin.poll();

      // Second poll should pass the watermark as `since` parameter
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [],
      });
      await plugin.poll();

      const secondCallArgs = mockOctokit.issues.listForRepo.mock.calls[1]?.[0] as Record<string, unknown>;
      expect(secondCallArgs["since"]).toBe("2026-03-11T12:00:00Z");
    });

    it("returns empty array when no issues", async () => {
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [],
      });
      const events = await plugin.poll();
      expect(events).toEqual([]);
    });
  });

  describe("doHealthCheck()", () => {
    it("reports healthy when rate limit is sufficient", async () => {
      const status = await plugin.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.message).toContain("4500");
    });

    it("reports unhealthy when rate limit is low", async () => {
      mockOctokit.rateLimit.get.mockResolvedValueOnce({
        data: {
          resources: { core: { remaining: 50, limit: 5000, reset: 1741700000 } },
        },
      });
      const status = await plugin.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.message).toContain("low");
    });

    it("reports unhealthy on API error", async () => {
      mockOctokit.rateLimit.get.mockRejectedValueOnce(new Error("Network error"));
      const status = await plugin.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.message).toContain("Network error");
    });
  });

  describe("error handling", () => {
    it("throws AdapterMethodError with auth_failed code on 401", async () => {
      mockOctokit.issues.listForRepo.mockRejectedValueOnce(
        Object.assign(new Error("Bad credentials"), { status: 401 }),
      );
      try {
        await plugin.poll();
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string } }).adapterError.code).toBe("auth_failed");
      }
    });

    it("throws AdapterMethodError with rate_limited code on 429", async () => {
      mockOctokit.issues.listForRepo.mockRejectedValueOnce(Object.assign(new Error("Rate limited"), { status: 429 }));
      try {
        await plugin.poll();
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string; retryable: boolean } }).adapterError.code).toBe(
          "rate_limited",
        );
        expect((error as { adapterError: { retryable: boolean } }).adapterError.retryable).toBe(true);
      }
    });

    it("throws AdapterMethodError with network_error code on ECONNREFUSED", async () => {
      mockOctokit.issues.listForRepo.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      try {
        await plugin.poll();
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as { adapterError: { code: string; retryable: boolean } }).adapterError.code).toBe(
          "network_error",
        );
        expect((error as { adapterError: { retryable: boolean } }).adapterError.retryable).toBe(true);
      }
    });
  });

  describe("config validation", () => {
    it("rejects missing github_token", async () => {
      const p = new GitHubTriggerPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({ repos: [{ owner: "a", name: "b" }] });
      expect(result.success).toBe(false);
    });

    it("rejects empty repos array", async () => {
      const p = new GitHubTriggerPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({ github_token: "ghp_xxx", repos: [] });
      expect(result.success).toBe(false);
    });

    it("applies default poll_interval_ms", async () => {
      const p = new GitHubTriggerPlugin();
      p.manifest = MANIFEST;
      const mock = createMockOctokit();
      await p.initialize(VALID_CONFIG);
      (p as unknown as { octokit: unknown }).octokit = mock;
      // If it initialized, the config was parsed with defaults
      expect((p as unknown as { config: { poll_interval_ms: number } }).config.poll_interval_ms).toBe(30_000);
    });
  });

  describe("ETag handling", () => {
    it("returns empty array on 304 Not Modified", async () => {
      // First poll succeeds and caches the ETag
      await plugin.poll();

      // Second poll: Octokit throws 304 (cache hit)
      mockOctokit.issues.listForRepo.mockRejectedValueOnce({ status: 304 });

      const events = await plugin.poll();
      expect(events).toHaveLength(0);
    });

    it("sends If-None-Match header on subsequent polls", async () => {
      // First poll caches ETag
      await plugin.poll();

      // Second poll should include the cached ETag
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"updated-etag"' },
        data: [],
      });
      await plugin.poll();

      const calls = mockOctokit.issues.listForRepo.mock.calls;
      const secondCallArgs = calls[1]?.[0] as Record<string, unknown>;
      const headers = secondCallArgs["headers"] as Record<string, string> | undefined;
      expect(headers?.["if-none-match"]).toBe('"mock-etag"');
    });
  });

  describe("rate limit backoff", () => {
    it("skips API call when within Retry-After window", async () => {
      // Trigger a 429 with Retry-After: 60
      mockOctokit.issues.listForRepo.mockRejectedValueOnce({
        status: 429,
        response: { headers: { "retry-after": "60" } },
      });

      // First poll hits 429 — error propagates through adapter
      await expect(plugin.poll()).rejects.toThrow();

      // Reset mock for second call
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [
          {
            number: 99,
            title: "Should be suppressed",
            html_url: "https://github.com/acme/webapp/issues/99",
            updated_at: "2026-03-11T12:00:00Z",
            labels: [],
            assignees: [],
          },
        ],
      });

      // Second poll immediately — should be suppressed by retryAfterUntil
      const events = await plugin.poll();
      expect(events).toHaveLength(0);
      // listForRepo should NOT have been called again (still within retry window)
      expect(mockOctokit.issues.listForRepo).toHaveBeenCalledTimes(1);
    });
  });

  describe("shutdown()", () => {
    it("persists watermarks across shutdown/init cycle", async () => {
      // Poll once to set watermarks
      await plugin.poll();
      await plugin.shutdown();

      // Re-init and poll — watermarks should be restored from disk
      await plugin.initialize(VALID_CONFIG);
      (plugin as unknown as { octokit: unknown }).octokit = mockOctokit;
      mockOctokit.issues.listForRepo.mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"mock-etag"' },
        data: [],
      });
      await plugin.poll();

      const calls = mockOctokit.issues.listForRepo.mock.calls;
      const lastCallArgs = calls[calls.length - 1]?.[0] as Record<string, unknown>;
      // Watermark persisted — since param should be the watermark value
      expect(lastCallArgs["since"]).toBe("2026-03-11T10:00:00Z");
    });
  });
});
