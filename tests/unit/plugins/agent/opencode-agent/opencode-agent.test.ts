import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterMethodError } from "../../../../../src/adapters/index.js";
import { OpenCodeAgentPlugin } from "../../../../../src/plugins/agent/opencode-agent/opencode-agent.js";
import { PluginManifestSchema } from "../../../../../src/schemas/adapters.js";
import { runContractSuite } from "../../../../helpers/contract-suites/agent-contract.js";
import { createMockAgentRunRequest } from "../../../../helpers/mock-factories.js";
import { createTestPluginContext } from "../../../../helpers/test-plugin-context.js";

// ── Mock CLI Scripts ─────────────────────────────────────────────────────────

const mockCliDir = mkdtempSync(join(tmpdir(), "opencode-mock-cli-"));

const mockCliPath = join(mockCliDir, "opencode-mock");
writeFileSync(
  mockCliPath,
  `#!/bin/bash
echo '{"type":"step_start","timestamp":1774214324210,"sessionID":"ses_mock","part":{"type":"step-start","snapshot":"abc123"}}'
echo '{"type":"text","timestamp":1774214324311,"sessionID":"ses_mock","part":{"type":"text","text":"Mock OpenCode response"}}'
echo '{"type":"step_finish","timestamp":1774214324354,"sessionID":"ses_mock","part":{"type":"step-finish","reason":"stop","cost":0.026,"tokens":{"total":12864,"input":12783,"output":1,"reasoning":80,"cache":{"read":0,"write":0}}}}'
`,
);
chmodSync(mockCliPath, 0o755);

const mockCliErrorPath = join(mockCliDir, "opencode-error");
writeFileSync(
  mockCliErrorPath,
  `#!/bin/bash
echo "Error: something went wrong" >&2
exit 1
`,
);
chmodSync(mockCliErrorPath, 0o755);

const mockCliVersionPath = join(mockCliDir, "opencode-version");
writeFileSync(
  mockCliVersionPath,
  `#!/bin/bash
echo "1.2.16"
`,
);
chmodSync(mockCliVersionPath, 0o755);

// ── Shared Setup ─────────────────────────────────────────────────────────────

const manifest = PluginManifestSchema.parse({
  id: "opencode-agent",
  type: "agent",
  version: "1.0.0",
  name: "OpenCode CLI",
  description: "Autonomous coding agent via OpenCode CLI process",
  critical: true,
  adapter_meta: { provider_type: "cli" },
});

// ── Contract Suite ───────────────────────────────────────────────────────────

runContractSuite(() => new OpenCodeAgentPlugin(), {
  validConfig: { cli_path: mockCliPath },
  invalidConfig: { command_timeout_ms: -1 },
  manifest,
  request: createMockAgentRunRequest(),
});

// ── Plugin-Specific Tests ────────────────────────────────────────────────────

describe("OpenCodeAgentPlugin", () => {
  it("parses NDJSON output with cost and tokens", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliPath });
    const result = await plugin.run({
      prompt: "Hello",
      system_prompt: null,
      cwd: null,
      trace_output_path: null,
    });
    expect(result.content).toBe("Mock OpenCode response");
    expect(result.cost_usd).toBe(0.026);
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.usage).not.toBeNull();
    expect(result.usage?.tokens.input_tokens).toBe(12783);
    expect(result.usage?.tokens.output_tokens).toBe(1);
    expect(result.usage?.tokens.total_tokens).toBe(12864);
  });

  it("throws AdapterMethodError on CLI error", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliErrorPath });
    await expect(
      plugin.run({ prompt: "Hello", system_prompt: null, cwd: null, trace_output_path: null }),
    ).rejects.toThrow(AdapterMethodError);
  });

  it("throws AdapterMethodError when CLI not found", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: "/nonexistent/opencode" });
    await expect(
      plugin.run({ prompt: "Hello", system_prompt: null, cwd: null, trace_output_path: null }),
    ).rejects.toThrow(AdapterMethodError);
  });

  it("healthCheck succeeds with mock version", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliVersionPath });
    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain("1.2.16");
  });

  it("healthCheck fails with bad path", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: "/nonexistent/opencode" });
    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(false);
  });

  it("getCapabilities returns model from config", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ model: "openai/gpt-4o" });
    const caps = plugin.getCapabilities();
    expect(caps.model_id).toBe("openai/gpt-4o");
    expect(caps.supports_usage_reporting).toBe(true);
    expect(caps.supports_quota_reporting).toBe(false);
  });

  it("getQuotaStatus returns null (no quota API)", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliPath });
    const quota = await plugin.getQuotaStatus();
    expect(quota).toBeNull();
  });

  it("invalid config returns success: false", async () => {
    const plugin = new OpenCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    const result = await plugin.initialize({ command_timeout_ms: -1 });
    expect(result.success).toBe(false);
  });
});
