import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterMethodError } from "../../../../../src/adapters/index.js";
import {
  ClaudeCodeAgentPlugin,
  parseCliOutput,
} from "../../../../../src/plugins/agent/claude-code-agent/claude-code-agent.js";
import { buildAgentEnv } from "../../../../../src/plugins/agent/subprocess.js";
import { PluginManifestSchema } from "../../../../../src/schemas/adapters.js";
import { runContractSuite } from "../../../../helpers/contract-suites/agent-contract.js";
import { createMockAgentRunRequest } from "../../../../helpers/mock-factories.js";
import { createTestPluginContext } from "../../../../helpers/test-plugin-context.js";

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

// Mock CLI that produces valid NDJSON output but exits with code 1
const mockCliExitOneWithOutputPath = join(mockCliDir, "claude-exit1-output");
writeFileSync(
  mockCliExitOneWithOutputPath,
  `#!/bin/bash
echo '{"type":"result","subtype":"success","cost_usd":0.01,"result":{"type":"text","text":"Salvaged output"}}'
exit 1
`,
);
chmodSync(mockCliExitOneWithOutputPath, 0o755);

// Mock CLI that exits with code 1 and produces no valid output (only stderr)
const mockCliExitOneNoOutputPath = join(mockCliDir, "claude-exit1-nooutput");
writeFileSync(
  mockCliExitOneNoOutputPath,
  `#!/bin/bash
echo "some error" >&2
exit 1
`,
);
chmodSync(mockCliExitOneNoOutputPath, 0o755);

// Mock CLI that produces huge stderr and exits with code 1
const mockCliHugeStderrPath = join(mockCliDir, "claude-huge-stderr");
writeFileSync(
  mockCliHugeStderrPath,
  `#!/bin/bash
python3 -c "print('x' * 50000)" >&2
exit 1
`,
);
chmodSync(mockCliHugeStderrPath, 0o755);

const mockCliVersionPath = join(mockCliDir, "claude-version");
writeFileSync(
  mockCliVersionPath,
  `#!/bin/bash
echo "1.0.42"
`,
);
chmodSync(mockCliVersionPath, 0o755);

// Mock CLI that captures args so we can verify --system-prompt is passed
const mockCliArgsPath = join(mockCliDir, "claude-args");
writeFileSync(
  mockCliArgsPath,
  `#!/bin/bash
# Echo all args as a JSON array for inspection, then output a valid result
echo '{"type":"result","subtype":"success","cost_usd":0.001,"result":{"type":"text","text":"'"$*"'"}}'
`,
);
chmodSync(mockCliArgsPath, 0o755);

// ── Shared Setup ────────────────────────────────────────────────────────────

const manifest = PluginManifestSchema.parse({
  id: "claude-code-agent",
  type: "agent",
  version: "1.0.0",
  name: "Claude Code CLI",
  description: "Autonomous coding agent via Claude Code CLI process",
  critical: true,
  adapter_meta: { provider_type: "cli" },
});

// ── Contract Suite ──────────────────────────────────────────────────────────

runContractSuite(() => new ClaudeCodeAgentPlugin(), {
  validConfig: { cli_path: mockCliPath },
  invalidConfig: { command_timeout_ms: -1 },
  manifest,
  request: createMockAgentRunRequest(),
});

// ── Plugin-Specific Tests ───────────────────────────────────────────────────

describe("ClaudeCodeAgentPlugin", () => {
  it("parses NDJSON output with cost data correctly", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliPath });
    const result = await plugin.run(createMockAgentRunRequest());
    expect(result.content).toBe("Mock LLM response");
    expect(result.cost_usd).toBe(0.005);
  });

  it("handles missing cost data gracefully (null, not crash)", () => {
    const raw = '{"type":"result","subtype":"success","result":{"type":"text","text":"hello"}}\n';
    const result = parseCliOutput(raw);
    expect(result.content).toBe("hello");
    expect(result.cost_usd).toBeNull();
  });

  it("CLI exit code non-zero throws AdapterMethodError with cli_error", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliErrorPath });
    try {
      await plugin.run(createMockAgentRunRequest());
      expect.fail("Expected AdapterMethodError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterMethodError);
      expect((err as AdapterMethodError).adapterError.code).toBe("cli_error");
    }
  });

  it("CLI not found (bad path) throws AdapterMethodError with spawn_error", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: "/nonexistent/claude" });
    try {
      await plugin.run(createMockAgentRunRequest());
      expect.fail("Expected AdapterMethodError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterMethodError);
      expect((err as AdapterMethodError).adapterError.code).toBe("spawn_error");
    }
  });

  it("getCapabilities returns model from config", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliPath, model: "claude-opus-4-20250514" });
    const caps = plugin.getCapabilities();
    expect(caps.model_id).toBe("claude-opus-4-20250514");
  });

  it("healthCheck with mock --version succeeds", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliVersionPath });
    const status = await plugin.healthCheck();
    expect(status.healthy).toBe(true);
    expect(status.message).toContain("1.0.42");
  });

  it("healthCheck with bad path returns unhealthy", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: "/nonexistent/claude" });
    const status = await plugin.healthCheck();
    expect(status.healthy).toBe(false);
  });

  it("invalid config returns success: false from initialize", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    const result = await plugin.initialize({ command_timeout_ms: -1 });
    expect(result.success).toBe(false);
    expect(result.message).not.toBeNull();
  });

  it("passes --system-prompt flag when system_prompt is provided", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliArgsPath });
    const result = await plugin.run({
      prompt: "test prompt",
      system_prompt: "You are a helpful assistant.",
      cwd: null,
      trace_output_path: null,
    });
    // The mock CLI echoes all args as the result text
    expect(result.content).toContain("--system-prompt");
    expect(result.content).toContain("You are a helpful assistant.");
  });

  it("omits --system-prompt flag when system_prompt is null", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliArgsPath });
    const result = await plugin.run({
      prompt: "test prompt",
      system_prompt: null,
      cwd: null,
      trace_output_path: null,
    });
    expect(result.content).not.toContain("--system-prompt");
  });

  // ── Output Salvage Tests ──────────────────────────────────────────────────

  it("salvages valid output when CLI exits with non-zero code", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliExitOneWithOutputPath });
    const result = await plugin.run(createMockAgentRunRequest());
    expect(result.content).toBe("Salvaged output");
    expect(result.cost_usd).toBe(0.01);
  });

  it("rejects with retryable=true when CLI exits 1 with no valid output", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliExitOneNoOutputPath });
    try {
      await plugin.run(createMockAgentRunRequest());
      expect.fail("Expected AdapterMethodError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterMethodError);
      const adapterErr = err as AdapterMethodError;
      expect(adapterErr.adapterError.code).toBe("cli_error");
      expect(adapterErr.adapterError.retryable).toBe(true);
    }
  });

  it("truncates error message to 2000 chars when stderr is huge", async () => {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliHugeStderrPath });
    try {
      await plugin.run(createMockAgentRunRequest());
      expect.fail("Expected AdapterMethodError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterMethodError);
      const adapterErr = err as AdapterMethodError;
      // Error message should be bounded — code prefix + truncated stderr ≤ ~2050 chars
      expect(adapterErr.adapterError.message.length).toBeLessThan(2100);
    }
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
    expect(result.cost_usd).toBe(0.01);
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

  it("extracts content when result is a string (--print mode)", () => {
    const raw = '{"type":"result","subtype":"success","cost_usd":0.05,"result":"{\\"action\\":\\"done\\"}"}\n';
    const result = parseCliOutput(raw);
    expect(result.content).toBe('{"action":"done"}');
    expect(result.cost_usd).toBe(0.05);
  });

  it("extracts content when result is a plain string without JSON", () => {
    const raw = '{"type":"result","subtype":"success","result":"Hello world"}\n';
    const result = parseCliOutput(raw);
    expect(result.content).toBe("Hello world");
  });
});

// ── buildAgentEnv (env isolation) ──────────────────────────────────────────────

describe("buildAgentEnv", () => {
  it("includes standard shell vars", () => {
    const env = buildAgentEnv({ HOME: "/home/test", PATH: "/usr/bin", USER: "test" });
    expect(env["HOME"]).toBe("/home/test");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["USER"]).toBe("test");
  });

  it("excludes secret env vars", () => {
    const env = buildAgentEnv({
      HOME: "/home/test",
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_secret123456",
      TELEGRAM_BOT_TOKEN: "bot_secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      CLAUDECODE: "nested-session",
    });
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
    // But standard vars are still present
    expect(env["HOME"]).toBe("/home/test");
  });

  it("includes LC_* locale vars via prefix match", () => {
    const env = buildAgentEnv({
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      LANG: "en_US.UTF-8",
    });
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("UTF-8");
    expect(env["LANG"]).toBe("en_US.UTF-8");
  });

  it("includes proxy vars (both cases)", () => {
    const env = buildAgentEnv({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8443",
      NO_PROXY: "localhost",
      http_proxy: "http://proxy:8080",
      https_proxy: "http://proxy:8443",
      no_proxy: "localhost",
    });
    expect(env["HTTP_PROXY"]).toBe("http://proxy:8080");
    expect(env["http_proxy"]).toBe("http://proxy:8080");
    expect(env["NO_PROXY"]).toBe("localhost");
  });

  it("skips undefined values", () => {
    const env = buildAgentEnv({ HOME: undefined, PATH: "/usr/bin" });
    expect(env["HOME"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });
});
