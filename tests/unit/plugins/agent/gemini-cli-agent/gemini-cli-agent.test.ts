import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterMethodError, type AgentActivityEvent } from "../../../../../src/adapters/index.js";
import {
  GeminiCliAgentPlugin,
  activityEventsFromLine,
} from "../../../../../src/plugins/agent/gemini-cli-agent/gemini-cli-agent.js";
import { PluginManifestSchema } from "../../../../../src/schemas/adapters.js";
import { runContractSuite } from "../../../../helpers/contract-suites/agent-contract.js";
import { createMockAgentRunRequest } from "../../../../helpers/mock-factories.js";
import { createTestPluginContext } from "../../../../helpers/test-plugin-context.js";

// ── Mock CLI Scripts ─────────────────────────────────────────────────────────

const mockCliDir = mkdtempSync(join(tmpdir(), "gemini-mock-cli-"));

const mockCliPath = join(mockCliDir, "gemini-mock");
writeFileSync(
  mockCliPath,
  `#!/bin/bash
echo '{"type":"init","timestamp":"2026-03-22T21:00:00Z","session_id":"mock-session","model":"gemini-2.5-pro"}'
echo '{"type":"message","timestamp":"2026-03-22T21:00:00Z","role":"user","content":"Hello"}'
echo '{"type":"message","timestamp":"2026-03-22T21:00:01Z","role":"assistant","content":"Mock Gemini response","delta":true}'
echo '{"type":"result","timestamp":"2026-03-22T21:00:01Z","status":"success","stats":{"total_tokens":11852,"input_tokens":11479,"output_tokens":37,"cached":2874,"input":8605,"duration_ms":4844,"tool_calls":0}}'
`,
);
chmodSync(mockCliPath, 0o755);

const mockCliErrorPath = join(mockCliDir, "gemini-error");
writeFileSync(
  mockCliErrorPath,
  `#!/bin/bash
echo "Error: something went wrong" >&2
exit 1
`,
);
chmodSync(mockCliErrorPath, 0o755);

const mockCliVersionPath = join(mockCliDir, "gemini-version");
writeFileSync(
  mockCliVersionPath,
  `#!/bin/bash
echo "0.34.0"
`,
);
chmodSync(mockCliVersionPath, 0o755);

// ── Shared Setup ─────────────────────────────────────────────────────────────

const manifest = PluginManifestSchema.parse({
  id: "gemini-cli-agent",
  type: "agent",
  version: "1.0.0",
  name: "Gemini CLI",
  description: "Autonomous coding agent via Google Gemini CLI process",
  critical: true,
  adapter_meta: { provider_type: "cli" },
});

// ── Contract Suite ───────────────────────────────────────────────────────────

runContractSuite(() => new GeminiCliAgentPlugin(), {
  validConfig: { cli_path: mockCliPath },
  invalidConfig: { command_timeout_ms: -1 },
  manifest,
  request: createMockAgentRunRequest(),
});

// ── Plugin-Specific Tests ────────────────────────────────────────────────────

describe("GeminiCliAgentPlugin", () => {
  it("parses stream-json output with tokens", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliPath });
    const result = await plugin.run({
      prompt: "Hello",
      system_prompt: null,
      cwd: null,
      trace_output_path: null,
    });
    expect(result.content).toBe("Mock Gemini response");
    expect(result.cost_usd).toBeNull(); // Gemini CLI never reports cost
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.usage).not.toBeNull();
    expect(result.usage?.tokens.input_tokens).toBe(11479);
    expect(result.usage?.tokens.output_tokens).toBe(37);
    expect(result.usage?.tokens.total_tokens).toBe(11852);
    expect(result.usage?.tokens.cache_read_tokens).toBe(2874);
    expect(result.usage?.model_id).toBe("gemini-2.5-pro");
  });

  it("throws AdapterMethodError on CLI error", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliErrorPath });
    await expect(
      plugin.run({ prompt: "Hello", system_prompt: null, cwd: null, trace_output_path: null }),
    ).rejects.toThrow(AdapterMethodError);
  });

  it("throws AdapterMethodError when CLI not found", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: "/nonexistent/gemini" });
    await expect(
      plugin.run({ prompt: "Hello", system_prompt: null, cwd: null, trace_output_path: null }),
    ).rejects.toThrow(AdapterMethodError);
  });

  it("healthCheck succeeds with mock version", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliVersionPath });
    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain("0.34.0");
  });

  it("healthCheck fails with bad path", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: "/nonexistent/gemini" });
    const health = await plugin.healthCheck();
    expect(health.healthy).toBe(false);
  });

  it("getCapabilities returns model from config", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ model: "gemini-2.5-flash" });
    const caps = plugin.getCapabilities();
    expect(caps.model_id).toBe("gemini-2.5-flash");
    expect(caps.supports_usage_reporting).toBe(true);
    expect(caps.supports_quota_reporting).toBe(true);
    expect(caps.supports_activity_streaming).toBe(true);
  });

  it("getQuotaStatus returns null (no quota API)", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: mockCliPath });
    const quota = await plugin.getQuotaStatus();
    expect(quota).toBeNull();
  });

  it("invalid config returns success: false", async () => {
    const plugin = new GeminiCliAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    const result = await plugin.initialize({ command_timeout_ms: -1 });
    expect(result.success).toBe(false);
  });
});

// ── activityEventsFromLine (live activity mapping) ──────────────────────────────

describe("activityEventsFromLine", () => {
  // A real captured gemini -o stream-json --yolo run (init, echoed user message, write/read tool
  // calls + results, assistant message, result), plus one representative errored tool_result. The
  // tool_use/tool_result field shapes are otherwise undocumented — this fixture is the verification.
  const fixtureLines = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gemini-stream.ndjson"),
    "utf-8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0);

  function eventsAt(index: number): AgentActivityEvent[] {
    return activityEventsFromLine(fixtureLines[index] ?? "");
  }

  it("maps an init line to one session event with model only", () => {
    expect(eventsAt(0)).toEqual([{ kind: "session", model: "gemini-2.5-flash", tools: null, cwd: null }]);
  });

  it("maps a tool_use to tool_use with tool_id, tool_name, and parameters", () => {
    expect(eventsAt(2)).toEqual([
      {
        kind: "tool_use",
        tool_call_id: "write_file_1780549705185_0",
        name: "write_file",
        input: { file_path: "hello.txt", content: "hi" },
      },
    ]);
  });

  it("maps a successful tool_result to status ok", () => {
    expect(eventsAt(3)).toEqual([
      { kind: "tool_result", tool_call_id: "write_file_1780549705185_0", status: "ok", output: undefined },
    ]);
  });

  it("maps a non-success tool_result to status error", () => {
    expect(eventsAt(6)).toEqual([
      {
        kind: "tool_result",
        tool_call_id: "run_shell_command_1780549720099_0",
        status: "error",
        output: "Command failed: bash: definitely-not-a-command: command not found",
      },
    ]);
  });

  it("maps an assistant message to assistant_text", () => {
    expect(eventsAt(7)).toEqual([{ kind: "assistant_text", text: "The task is complete." }]);
  });

  it("emits nothing for the echoed user message and the result line", () => {
    expect(eventsAt(1)).toEqual([]); // message role=user (echoed prompt)
    expect(eventsAt(8)).toEqual([]); // result
  });

  it("returns no events for an empty, malformed, or id-less line", () => {
    expect(activityEventsFromLine("")).toEqual([]);
    expect(activityEventsFromLine("not json at all")).toEqual([]);
    expect(activityEventsFromLine('{"type":"tool_use","tool_name":"write_file"}')).toEqual([]);
  });
});
