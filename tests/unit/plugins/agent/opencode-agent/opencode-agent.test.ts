import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterMethodError, type AgentActivityEvent } from "../../../../../src/adapters/index.js";
import {
  OpenCodeAgentPlugin,
  activityEventsFromLine,
} from "../../../../../src/plugins/agent/opencode-agent/opencode-agent.js";
import { PluginManifestSchema } from "../../../../../src/schemas/adapters.js";
import { runAgentContractSuite } from "../../../../helpers/contract-suites/agent-contract.js";
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

runAgentContractSuite(() => new OpenCodeAgentPlugin(), {
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
    expect(caps.supports_activity_streaming).toBe(true);
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

// ── activityEventsFromLine (live activity mapping) ──────────────────────────────

describe("activityEventsFromLine", () => {
  // A real captured opencode run (write tool then text), plus a representative reasoning line and a
  // representative errored tool — the free model used in capture emitted neither. One fixture, every
  // mapped and unmapped case.
  const fixtureLines = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-stream.ndjson"),
    "utf-8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0);

  function eventsAt(index: number): AgentActivityEvent[] {
    return activityEventsFromLine(fixtureLines[index] ?? "");
  }

  it("maps a completed tool_use to ordered tool_use then ok tool_result", () => {
    expect(eventsAt(1)).toEqual([
      {
        kind: "tool_use",
        tool_call_id: "call_6bbcb458b69248519ad1245a",
        name: "write",
        input: {
          content: "hi",
          filePath: "/private/var/folders/5t/1mknv_bn4dd4lq9yn12qfrf00000gn/T/tmp.EuxB3UaEDr/hello.txt",
        },
      },
      {
        kind: "tool_result",
        tool_call_id: "call_6bbcb458b69248519ad1245a",
        status: "ok",
        output: "Wrote file successfully.",
      },
    ]);
  });

  it("maps a reasoning part to thinking", () => {
    expect(eventsAt(3)).toEqual([
      { kind: "thinking", text: "I created the file, now I should confirm it back to the user." },
    ]);
  });

  it("maps a non-completed tool state to an error tool_result", () => {
    expect(eventsAt(4)).toEqual([
      {
        kind: "tool_use",
        tool_call_id: "call_a1b2c3d4e5f60718293a4b5c",
        name: "bash",
        input: { command: "definitely-not-a-command" },
      },
      {
        kind: "tool_result",
        tool_call_id: "call_a1b2c3d4e5f60718293a4b5c",
        status: "error",
        output: "bash: command not found",
      },
    ]);
  });

  it("maps a text part to assistant_text", () => {
    expect(eventsAt(6)).toEqual([{ kind: "assistant_text", text: 'Done. `hello.txt` created with content "hi".' }]);
  });

  it("emits nothing for step_start and step_finish lines", () => {
    expect(eventsAt(0)).toEqual([]); // step_start
    expect(eventsAt(2)).toEqual([]); // step_finish
    expect(eventsAt(5)).toEqual([]); // step_start
    expect(eventsAt(7)).toEqual([]); // step_finish
  });

  it("returns no events for an empty, malformed, partless, or contentless line", () => {
    expect(activityEventsFromLine("")).toEqual([]);
    expect(activityEventsFromLine("not json at all")).toEqual([]);
    expect(activityEventsFromLine('{"type":"text"}')).toEqual([]);
    expect(activityEventsFromLine('{"type":"tool_use","part":{"type":"tool"}}')).toEqual([]);
  });
});
