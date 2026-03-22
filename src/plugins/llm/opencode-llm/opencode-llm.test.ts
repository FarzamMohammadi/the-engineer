import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLLMContractSuite } from "../../../../test/helpers/contract-suites/llm-contract.js";
import { createMockInferenceRequest } from "../../../../test/helpers/mock-factories.js";
import { AdapterMethodError } from "../../../adapters/index.js";
import { PluginManifestSchema } from "../../../schemas/adapters.js";
import { OpenCodeLLMPlugin, parseOpenCodeOutput } from "./opencode-llm.js";

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
  id: "opencode-llm",
  type: "llm",
  version: "1.0.0",
  name: "OpenCode CLI",
  description: "LLM reasoning via OpenCode CLI process",
  critical: true,
  adapter_meta: { provider_type: "cli" },
});

// ── Contract Suite ───────────────────────────────────────────────────────────

runLLMContractSuite(() => new OpenCodeLLMPlugin(), {
  validConfig: { cli_path: mockCliPath },
  invalidConfig: { command_timeout_ms: -1 },
  manifest,
  request: createMockInferenceRequest(),
});

// ── Plugin-Specific Tests ────────────────────────────────────────────────────

describe("OpenCodeLLMPlugin", () => {
  it("parses NDJSON output with cost and tokens", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliPath });
    const result = await plugin.infer({ prompt: "Hello", system_prompt: null, cwd: null });
    expect(result.content).toBe("Mock OpenCode response");
    expect(result.cost_usd).toBe(0.026);
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.usage).not.toBeNull();
    expect(result.usage?.tokens.input_tokens).toBe(12783);
    expect(result.usage?.tokens.output_tokens).toBe(1);
    expect(result.usage?.tokens.total_tokens).toBe(12864);
  });

  it("throws AdapterMethodError on CLI error", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliErrorPath });
    await expect(plugin.infer({ prompt: "Hello", system_prompt: null, cwd: null })).rejects.toThrow(
      AdapterMethodError,
    );
  });

  it("throws AdapterMethodError when CLI not found", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: "/nonexistent/opencode" });
    await expect(plugin.infer({ prompt: "Hello", system_prompt: null, cwd: null })).rejects.toThrow(
      AdapterMethodError,
    );
  });

  it("healthCheck succeeds with mock version", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliVersionPath });
    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain("1.2.16");
  });

  it("healthCheck fails with bad path", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: "/nonexistent/opencode" });
    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(false);
  });

  it("getCapabilities returns model from config", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ model: "openai/gpt-4o" });
    const caps = plugin.getCapabilities();
    expect(caps.model_id).toBe("openai/gpt-4o");
    expect(caps.supports_usage_reporting).toBe(true);
    expect(caps.supports_quota_reporting).toBe(false);
  });

  it("getQuotaStatus returns null (no quota API)", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliPath });
    const quota = await plugin.getQuotaStatus();
    expect(quota).toBeNull();
  });

  it("invalid config returns success: false", async () => {
    const plugin = new OpenCodeLLMPlugin();
    plugin.manifest = manifest;
    const result = await plugin.initialize({ command_timeout_ms: -1 });
    expect(result.success).toBe(false);
  });
});

// ── parseOpenCodeOutput unit tests ───────────────────────────────────────────

describe("parseOpenCodeOutput", () => {
  it("parses multi-event NDJSON", () => {
    const raw = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"Hello "}}',
      '{"type":"text","part":{"type":"text","text":"world"}}',
      '{"type":"step_finish","part":{"type":"step-finish","cost":0.05,"tokens":{"total":100,"input":80,"output":20,"reasoning":0,"cache":{"read":10,"write":5}}}}',
    ].join("\n");
    const result = parseOpenCodeOutput(raw);
    expect(result.content).toBe("Hello world");
    expect(result.cost_usd).toBe(0.05);
    expect(result.usage?.tokens.input_tokens).toBe(80);
    expect(result.usage?.tokens.output_tokens).toBe(20);
    expect(result.usage?.tokens.total_tokens).toBe(100);
    expect(result.usage?.tokens.cache_read_tokens).toBe(10);
    expect(result.usage?.tokens.cache_creation_tokens).toBe(5);
  });

  it("throws on empty output", () => {
    expect(() => parseOpenCodeOutput("")).toThrow(AdapterMethodError);
  });

  it("handles missing cost gracefully", () => {
    const raw = [
      '{"type":"text","part":{"type":"text","text":"response"}}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}}',
    ].join("\n");
    const result = parseOpenCodeOutput(raw);
    expect(result.content).toBe("response");
    expect(result.cost_usd).toBeNull();
  });

  it("skips non-JSON lines", () => {
    const raw = [
      "some log message",
      '{"type":"text","part":{"type":"text","text":"ok"}}',
      '{"type":"step_finish","part":{"type":"step-finish","cost":0.01,"tokens":{"total":5,"input":4,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}',
    ].join("\n");
    const result = parseOpenCodeOutput(raw);
    expect(result.content).toBe("ok");
  });
});
