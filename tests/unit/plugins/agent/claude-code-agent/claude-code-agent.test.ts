import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AdapterError,
  AdapterMethodError,
  type AgentActivityEvent,
  createAdapterError,
} from "../../../../../src/adapters/index.js";
import {
  ClaudeCodeAgentPlugin,
  activityEventsFromLine,
  classifyResultEvent,
  dominantModelId,
  isTransientRunError,
} from "../../../../../src/plugins/agent/claude-code-agent/claude-code-agent.js";
import { buildAgentEnv } from "../../../../../src/plugins/agent/subprocess.js";
import { PluginManifestSchema } from "../../../../../src/schemas/adapters.js";
import { runAgentContractSuite } from "../../../../helpers/contract-suites/agent-contract.js";
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

// The observed issue-49 failure: the API dropped the connection mid-response, so the CLI exits CLEANLY
// (code 0) and reports `is_error: true` on a result event whose subtype still says "success".
const DROPPED_CONNECTION_EVENT =
  '{"type":"result","subtype":"success","is_error":true,"cost_usd":2.28,"result":"API Error: Connection closed mid-response. The response above may be incomplete."}';

const mockCliResultErrorPath = join(mockCliDir, "claude-result-error");
writeFileSync(
  mockCliResultErrorPath,
  `#!/bin/bash
echo '${DROPPED_CONNECTION_EVENT}'
`,
);
chmodSync(mockCliResultErrorPath, 0o755);

// The same errored result event, but on the non-zero-exit salvage path — it must NOT be salvaged.
const mockCliExitOneResultErrorPath = join(mockCliDir, "claude-exit1-result-error");
writeFileSync(
  mockCliExitOneResultErrorPath,
  `#!/bin/bash
echo '${DROPPED_CONNECTION_EVENT}'
exit 1
`,
);
chmodSync(mockCliExitOneResultErrorPath, 0o755);

// A terminal (non-transient) run error: retrying an invalid API key just burns money.
const mockCliAuthErrorPath = join(mockCliDir, "claude-auth-error");
writeFileSync(
  mockCliAuthErrorPath,
  `#!/bin/bash
echo '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}'
`,
);
chmodSync(mockCliAuthErrorPath, 0o755);

// A connection dropped BEFORE the CLI printed its result line: clean exit, truncated stream, no result event.
const mockCliTruncatedPath = join(mockCliDir, "claude-truncated");
writeFileSync(
  mockCliTruncatedPath,
  `#!/bin/bash
echo '{"type":"assistant","message":"partial work"}'
`,
);
chmodSync(mockCliTruncatedPath, 0o755);

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

runAgentContractSuite(() => new ClaudeCodeAgentPlugin(), {
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

  // ── Run-outcome Tests (issue #49) ─────────────────────────────────────────

  /**
   * Run the plugin against a mock CLI and return the AdapterError its run rejected with.
   * A run that resolves is itself the failure under test, so it surfaces as an unmistakable sentinel.
   */
  async function runAndCatchError(cliPath: string): Promise<AdapterError> {
    const plugin = new ClaudeCodeAgentPlugin();
    plugin.manifest = manifest;
    plugin.context = createTestPluginContext();
    await plugin.initialize({ cli_path: cliPath });
    return plugin.run(createMockAgentRunRequest()).then(
      () => createAdapterError("run_unexpectedly_succeeded", "the run resolved instead of rejecting"),
      (err: unknown) => (err as AdapterMethodError).adapterError,
    );
  }

  it("fails a run whose result event is_error, even when the subtype says success (the dropped connection)", async () => {
    const error = await runAndCatchError(mockCliResultErrorPath);

    expect(error.code).toBe("cli_error");
    // Retryable — otherwise agent-step's retry loop never fires and the phase burns on no_result.
    expect(error.retryable).toBe(true);
    // The message must name the real cause; "CLI returned error: unknown" is what made this undiagnosable.
    expect(error.message).toContain("Connection closed mid-response");
  });

  it("does not salvage an errored result event on the non-zero-exit path", async () => {
    const error = await runAndCatchError(mockCliExitOneResultErrorPath);

    expect(error.code).toBe("cli_error");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Connection closed mid-response");
  });

  it("classifies a non-transient run error as terminal so it is never retried", async () => {
    const error = await runAndCatchError(mockCliAuthErrorPath);

    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Invalid API key");
  });

  it("fails retryably when the stream is cut off before the result event", async () => {
    const error = await runAndCatchError(mockCliTruncatedPath);

    expect(error.retryable).toBe(true);
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

// ── classifyResultEvent / isTransientRunError (run-outcome classification) ─────

describe("classifyResultEvent", () => {
  it("fails the observed dropped-connection event: is_error true despite subtype success", () => {
    expect(
      classifyResultEvent({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: Connection closed mid-response. The response above may be incomplete.",
      }),
    ).toEqual({
      kind: "failed",
      message: "API Error: Connection closed mid-response. The response above may be incomplete.",
      retryable: true,
    });
  });

  it("fails an event whose subtype is error", () => {
    expect(classifyResultEvent({ subtype: "error", result: "something broke" })).toMatchObject({ kind: "failed" });
  });

  it("sources the message from a {type,text} result block, not [object Object]", () => {
    const verdict = classifyResultEvent({
      subtype: "success",
      is_error: true,
      result: { type: "text", text: "API Error: Connection closed" },
    });

    expect(verdict).toEqual({ kind: "failed", message: "API Error: Connection closed", retryable: true });
  });

  it("falls back to a stable message when the event carries no cause at all", () => {
    expect(classifyResultEvent({ subtype: "error" })).toEqual({
      kind: "failed",
      message: "unknown error",
      retryable: false,
    });
  });

  it("passes a successful run: is_error false, and is_error absent (the salvage path's event)", () => {
    expect(classifyResultEvent({ subtype: "success", is_error: false, result: "done" })).toEqual({ kind: "ok" });
    expect(classifyResultEvent({ subtype: "success", result: { type: "text", text: "Salvaged output" } })).toEqual({
      kind: "ok",
    });
  });
});

describe("isTransientRunError", () => {
  it.each([
    "API Error: Connection closed mid-response. The response above may be incomplete.",
    "read ECONNRESET",
    "socket hang up",
    "Request timed out",
    "rate limit exceeded",
    "529 Overloaded",
    "503 Service Unavailable",
    "Internal server error",
    // The real shape Claude's CLI reports a status code in — the code only counts in an error context.
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
    // Bare status codes an intervening "code"/"HTTP" word separates from the error context. These are the
    // shapes the numeric branch previously missed — every case above it either matches a *word* branch
    // (overloaded, service unavailable) or the tight "API Error: NNN" shape, so nothing covered these.
    "Request failed with status code 502",
    "Error code: 529",
    "HTTP 502 Bad Gateway",
  ])("retries the transient failure: %s", (message) => {
    expect(isTransientRunError(message)).toBe(true);
  });

  it.each([
    "Invalid API key · Please run /login",
    "authentication failed",
    "Agent run rejected: the owner denied the action",
    "Something nobody has seen before",
    // Word-bounded status codes: prose about counts must never read as a 500. A status code is transient
    // only in an error context — these guard the widened numeric branch against matching plain counts.
    "processed 500 files",
    "migrated 502 records",
    "Wrote 429 lines to output",
  ])("treats as terminal (fail safe — an unknown error escalates rather than looping): %s", (message) => {
    expect(isTransientRunError(message)).toBe(false);
  });
});

// ── activityEventsFromLine (live activity mapping) ──────────────────────────────

describe("activityEventsFromLine", () => {
  // A real captured claude stream-json run: init, assistant text/thinking/tool_use, ok + errored
  // tool_results, then the lines we deliberately ignore (status, thinking_tokens, stream_event,
  // rate_limit_event, result). One fixture, every mapped and unmapped case.
  const fixtureLines = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-stream.ndjson"),
    "utf-8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0);

  function eventsAt(index: number): AgentActivityEvent[] {
    return activityEventsFromLine(fixtureLines[index] ?? "");
  }

  it("maps a system init line to one session event with model, tool count, and cwd", () => {
    const [event, ...rest] = eventsAt(0);
    expect(rest).toHaveLength(0);
    expect(event).toEqual({
      kind: "session",
      model: "claude-haiku-4-5-20251001",
      tools: 41,
      cwd: "/private/tmp/claude-501/live-agent-mirror-VqRpGS",
    });
  });

  it("maps an assistant text block to assistant_text", () => {
    expect(eventsAt(1)).toEqual([
      { kind: "assistant_text", text: "I'll create the file, verify its contents, and list the directory." },
    ]);
  });

  it("maps an assistant thinking block to thinking", () => {
    const [event] = eventsAt(2);
    expect(event?.kind).toBe("thinking");
    expect(event && "text" in event ? event.text : "").toContain("The user wants me to");
  });

  it("maps an assistant tool_use block to tool_use with id, name, and input", () => {
    expect(eventsAt(3)).toEqual([
      {
        kind: "tool_use",
        tool_call_id: "toolu_012fpoUjANVACngah9HNj7oD",
        name: "Write",
        input: {
          file_path: "/private/tmp/claude-501/live-agent-mirror-VqRpGS/hello.txt",
          content: "hello from the engineer",
        },
      },
    ]);
  });

  it("maps a tool_result with is_error null to status ok", () => {
    const [event] = eventsAt(4);
    expect(event).toMatchObject({
      kind: "tool_result",
      tool_call_id: "toolu_012fpoUjANVACngah9HNj7oD",
      status: "ok",
    });
  });

  it("maps a tool_result with is_error true to status error", () => {
    expect(eventsAt(5)).toEqual([
      {
        kind: "tool_result",
        tool_call_id: "toolu_01KivN29uc2gr46MKA2ud9AA",
        status: "error",
        output: "bash: command not found",
      },
    ]);
  });

  it("emits nothing for status, thinking_tokens, stream_event, rate_limit, and result lines", () => {
    expect(eventsAt(6)).toEqual([]); // system:status
    expect(eventsAt(7)).toEqual([]); // system:thinking_tokens
    expect(eventsAt(8)).toEqual([]); // stream_event
    expect(eventsAt(9)).toEqual([]); // rate_limit_event
    expect(eventsAt(10)).toEqual([]); // result
  });

  it("returns no events for an empty, malformed, or contentless line", () => {
    expect(activityEventsFromLine("")).toEqual([]);
    expect(activityEventsFromLine("not json at all")).toEqual([]);
    expect(activityEventsFromLine('{"type":"assistant"}')).toEqual([]);
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

describe("dominantModelId", () => {
  it("returns null when no modelUsage is present", () => {
    expect(dominantModelId(undefined)).toBeNull();
  });

  it("returns the only model when modelUsage has one key", () => {
    expect(dominantModelId({ "claude-sonnet-4-6": { costUSD: 0.5, outputTokens: 1000 } })).toBe("claude-sonnet-4-6");
  });

  it("picks the highest-spend model, not whichever key sorts first (the auxiliary-haiku case)", () => {
    // Real Claude Code shape: a few-cent haiku helper listed first, the configured sonnet doing the work.
    const modelUsage = {
      "claude-haiku-4-5-20251001": { inputTokens: 2135, outputTokens: 16, costUSD: 0.002215 },
      "claude-sonnet-4-6": { inputTokens: 23, outputTokens: 12636, costUSD: 0.68811045 },
    };
    expect(dominantModelId(modelUsage)).toBe("claude-sonnet-4-6");
  });

  it("falls back to output tokens when costs tie", () => {
    const modelUsage = {
      "model-a": { costUSD: 0, outputTokens: 10 },
      "model-b": { costUSD: 0, outputTokens: 999 },
    };
    expect(dominantModelId(modelUsage)).toBe("model-b");
  });

  it("tolerates malformed per-model entries", () => {
    const modelUsage = { "model-a": null, "model-b": { costUSD: 0.1 } };
    expect(dominantModelId(modelUsage as Record<string, unknown>)).toBe("model-b");
  });
});
