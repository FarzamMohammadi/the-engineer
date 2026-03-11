import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLLMContractSuite } from "../../../../test/helpers/contract-suites/llm-contract.js";
import { createMockCompletionRequest } from "../../../../test/helpers/mock-factories.js";
import { AdapterMethodError } from "../../../adapters/index.js";
import { PluginManifestSchema } from "../../../schemas/adapters.js";
import { ClaudeCodeLLMPlugin, parseCliOutput } from "./claude-code-llm.js";

// ── Mock CLI Scripts (created synchronously at module level) ────────────────

const mockCliDir = mkdtempSync(join(tmpdir(), "claude-mock-cli-"));

const mockCliPath = join(mockCliDir, "claude-mock");
writeFileSync(
  mockCliPath,
  `#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"mock-session-123"}'
echo '{"type":"assistant","message":"mock response text"}'
echo '{"type":"result","subtype":"success","cost_usd":0.005,"num_turns":1,"result":{"type":"text","text":"Mock LLM response"},"session_id":"mock-session-123"}'
`,
);
chmodSync(mockCliPath, 0o755);

const mockCliErrorPath = join(mockCliDir, "claude-error");
writeFileSync(
  mockCliErrorPath,
  `#!/bin/bash
echo "Error: something went wrong" >&2
exit 1
`,
);
chmodSync(mockCliErrorPath, 0o755);

const mockCliVersionPath = join(mockCliDir, "claude-version");
writeFileSync(
  mockCliVersionPath,
  `#!/bin/bash
echo "1.0.42"
`,
);
chmodSync(mockCliVersionPath, 0o755);

// ── Shared Setup ────────────────────────────────────────────────────────────

const manifest = PluginManifestSchema.parse({
  id: "claude-code-llm",
  type: "llm",
  version: "1.0.0",
  name: "Claude Code CLI",
  description: "LLM reasoning via Claude Code CLI process",
  critical: true,
  adapter_meta: { provider_type: "cli" },
});

// ── Contract Suite ──────────────────────────────────────────────────────────

runLLMContractSuite(() => new ClaudeCodeLLMPlugin(), {
  validConfig: { cli_path: mockCliPath },
  invalidConfig: { max_tokens: -1 },
  manifest,
  request: createMockCompletionRequest(),
});

// ── Plugin-Specific Tests ───────────────────────────────────────────────────

describe("ClaudeCodeLLMPlugin", () => {
  it("parses NDJSON output with usage data correctly", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliPath });
    const result = await plugin.complete(createMockCompletionRequest());
    expect(result.content).toBe("Mock LLM response");
    expect(result.usage.spend_usd).toBe(0.005);
    expect(result.finish_reason).toBe("stop");
  });

  it("handles missing usage data gracefully (zeros, not crash)", () => {
    const raw = '{"type":"result","subtype":"success","result":{"type":"text","text":"hello"}}\n';
    const result = parseCliOutput(raw);
    expect(result.content).toBe("hello");
    expect(result.usage.tokens_in).toBe(0);
    expect(result.usage.tokens_out).toBe(0);
    expect(result.usage.spend_usd).toBeNull();
  });

  it("CLI exit code non-zero throws AdapterMethodError with cli_error", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliErrorPath });
    try {
      await plugin.complete(createMockCompletionRequest());
      expect.fail("Expected AdapterMethodError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterMethodError);
      expect((err as AdapterMethodError).adapterError.code).toBe("cli_error");
    }
  });

  it("CLI not found (bad path) throws AdapterMethodError with spawn_error", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: "/nonexistent/claude" });
    try {
      await plugin.complete(createMockCompletionRequest());
      expect.fail("Expected AdapterMethodError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterMethodError);
      expect((err as AdapterMethodError).adapterError.code).toBe("spawn_error");
    }
  });

  it("getCapabilities returns model from config", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliPath, model: "claude-opus-4-20250514" });
    const caps = plugin.getCapabilities();
    expect(caps.model_id).toBe("claude-opus-4-20250514");
    expect(caps.max_context).toBe(200_000);
    expect(caps.supports_tools).toBe(true);
  });

  it("healthCheck with mock --version succeeds", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: mockCliVersionPath });
    const status = await plugin.healthCheck();
    expect(status.healthy).toBe(true);
    expect(status.message).toContain("1.0.42");
  });

  it("healthCheck with bad path returns unhealthy", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    await plugin.initialize({ cli_path: "/nonexistent/claude" });
    const status = await plugin.healthCheck();
    expect(status.healthy).toBe(false);
  });

  it("invalid config returns success: false from initialize", async () => {
    const plugin = new ClaudeCodeLLMPlugin();
    plugin.manifest = manifest;
    const result = await plugin.initialize({ max_tokens: -1 });
    expect(result.success).toBe(false);
    expect(result.message).not.toBeNull();
  });
});

describe("parseCliOutput", () => {
  it("extracts result from multi-line NDJSON", () => {
    const raw = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":"thinking..."}',
      '{"type":"result","subtype":"success","cost_usd":0.01,"result":{"type":"text","text":"Answer"}}',
    ].join("\n");
    const result = parseCliOutput(raw);
    expect(result.content).toBe("Answer");
    expect(result.usage.spend_usd).toBe(0.01);
  });

  it("throws when no result event found", () => {
    const raw = '{"type":"system","subtype":"init"}\n';
    expect(() => parseCliOutput(raw)).toThrow("No result event found");
  });

  it("throws when result event has error subtype", () => {
    const raw = '{"type":"result","subtype":"error","error":"rate limited"}\n';
    expect(() => parseCliOutput(raw)).toThrow("rate limited");
  });

  it("handles empty content gracefully", () => {
    const raw = '{"type":"result","subtype":"success","result":{"type":"text","text":""}}\n';
    const result = parseCliOutput(raw);
    expect(result.content).toBe("");
  });

  it("skips non-JSON lines without crashing", () => {
    const raw = [
      "Some debug output",
      '{"type":"result","subtype":"success","cost_usd":0.0,"result":{"type":"text","text":"ok"}}',
    ].join("\n");
    const result = parseCliOutput(raw);
    expect(result.content).toBe("ok");
  });
});
