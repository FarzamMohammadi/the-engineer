import { describe, expect, it, vi } from "vitest";
import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { CompletionResult } from "../../schemas/adapters.js";
import type { ActionResult, PhaseToolConfig } from "../../schemas/orchestrator.js";
import { type AgentLoopConfig, extractJson, parseAction, runAgentLoop } from "./agent-loop.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    tool_calls: null,
    finish_reason: "stop",
    usage: { tokens_in: 10, tokens_out: 5, spend_usd: 0.001, remaining: null, resets_at: null },
  };
}

const baseToolConfig: PhaseToolConfig = {
  allowed_actions: ["read_file", "write_file", "done"],
  max_iterations: 10,
  action_classes: ["read", "write"],
};

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    phase: "execution",
    taskId: "task-001",
    systemPrompt: "You are a test agent.",
    initialPrompt: "Do the thing.",
    toolConfig: baseToolConfig,
    worktreePath: "/tmp/test",
    observer: createTestObserverFacade("orchestrator"),
    ...overrides,
  };
}

// ── extractJson ──────────────────────────────────────────────────────────────

describe("extractJson", () => {
  it("parses plain JSON string", () => {
    expect(extractJson('{"action": "done", "result": {}}')).toEqual({
      action: "done",
      result: {},
    });
  });

  it("extracts JSON from markdown code block", () => {
    const input =
      'Here is the result:\n```json\n{"action": "done", "result": {"key": 1}}\n```\nDone.';
    expect(extractJson(input)).toEqual({ action: "done", result: { key: 1 } });
  });

  it("extracts first balanced JSON object from surrounding text", () => {
    const input =
      'I think we should {"action": "read_file", "params": {"path": "a.ts"}} and continue';
    const result = extractJson(input);
    expect(result).toEqual({ action: "read_file", params: { path: "a.ts" } });
  });

  it("returns null for non-JSON content", () => {
    expect(extractJson("just some text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  it("handles escaped quotes in strings", () => {
    const input = '{"action": "done", "result": {"msg": "he said \\"hello\\""}}';
    const result = extractJson(input);
    expect(result).toEqual({ action: "done", result: { msg: 'he said "hello"' } });
  });

  it("handles nested objects", () => {
    const input = '{"action": "done", "result": {"nested": {"deep": true}}}';
    expect(extractJson(input)).toEqual({ action: "done", result: { nested: { deep: true } } });
  });
});

// ── parseAction ──────────────────────────────────────────────────────────────

describe("parseAction", () => {
  it("parses read_file action", () => {
    const action = parseAction('{"action": "read_file", "params": {"path": "src/index.ts"}}');
    expect(action).toEqual({ action: "read_file", params: { path: "src/index.ts" } });
  });

  it("parses write_file action", () => {
    const action = parseAction(
      '{"action": "write_file", "params": {"path": "a.ts", "content": "hello"}}',
    );
    expect(action).toEqual({ action: "write_file", params: { path: "a.ts", content: "hello" } });
  });

  it("parses edit_file action", () => {
    const action = parseAction(
      '{"action": "edit_file", "params": {"path": "a.ts", "old_string": "old", "new_string": "new"}}',
    );
    expect(action).toEqual({
      action: "edit_file",
      params: { path: "a.ts", old_string: "old", new_string: "new" },
    });
  });

  it("parses done action with result", () => {
    const action = parseAction('{"action": "done", "result": {"files_changed": ["a.ts"]}}');
    expect(action).toEqual({ action: "done", result: { files_changed: ["a.ts"] } });
  });

  it("normalizes done action with params.result (common LLM mistake)", () => {
    const action = parseAction(
      '{"action": "done", "params": {"result": {"complexity": "trivial"}}}',
    );
    expect(action).toEqual({ action: "done", result: { complexity: "trivial" } });
  });

  it("preserves optional thinking field", () => {
    const action = parseAction(
      '{"action": "read_file", "params": {"path": "a.ts"}, "thinking": "Need to check this file"}',
    );
    expect(action?.thinking).toBe("Need to check this file");
  });

  it("returns null for invalid action name", () => {
    expect(parseAction('{"action": "delete_file", "params": {}}')).toBeNull();
  });

  it("returns null for missing required params", () => {
    expect(parseAction('{"action": "read_file", "params": {}}')).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(parseAction("I don't know what to do")).toBeNull();
  });
});

// ── runAgentLoop ─────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  it("single-iteration happy path: LLM returns done immediately", async () => {
    const callLlm = vi
      .fn()
      .mockResolvedValue(makeCompletion('{"action": "done", "result": {"status": "ok"}}'));
    const execAction = vi.fn();

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.phaseData).toEqual({ status: "ok" });
    expect(result.iterations).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.action.action).toBe("done");
    expect(execAction).not.toHaveBeenCalled();
  });

  it("multi-step: read_file then done", async () => {
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce(
        makeCompletion('{"action": "read_file", "params": {"path": "src/a.ts"}}'),
      )
      .mockResolvedValueOnce(makeCompletion('{"action": "done", "result": {"found": true}}'));
    const execAction = vi.fn().mockResolvedValue({
      success: true,
      output: "file contents here",
    });

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.iterations).toBe(2);
    expect(result.actions).toHaveLength(2);
    expect(execAction).toHaveBeenCalledOnce();
    expect(result.phaseData).toEqual({ found: true });
  });

  it("rejects disallowed actions with error in history", async () => {
    const config = makeConfig({
      toolConfig: {
        allowed_actions: ["read_file", "done"],
        max_iterations: 5,
        action_classes: ["read"],
      },
    });
    const callLlm = vi
      .fn()
      // First: try write_file (not allowed)
      .mockResolvedValueOnce(
        makeCompletion('{"action": "write_file", "params": {"path": "a.ts", "content": "x"}}'),
      )
      // Second: done
      .mockResolvedValueOnce(makeCompletion('{"action": "done", "result": {"rejected": true}}'));
    const execAction = vi.fn();

    const result = await runAgentLoop(config, callLlm, execAction);

    expect(result.iterations).toBe(2);
    expect(execAction).not.toHaveBeenCalled();
    // First action was rejected (not executed), second was done
    expect(result.actions[0]?.result?.success).toBe(false);
    expect(result.actions[0]?.result?.error).toContain("not allowed");
  });

  it("retries on unparseable response and recovers", async () => {
    const callLlm = vi
      .fn()
      // First: garbage
      .mockResolvedValueOnce(makeCompletion("I'm confused, let me think..."))
      // Retry: valid done
      .mockResolvedValueOnce(makeCompletion('{"action": "done", "result": {"recovered": true}}'));
    const execAction = vi.fn();

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.phaseData).toEqual({ recovered: true });
    // 1 iteration for garbage + 1 for retry (counted as iterations++)
    expect(result.iterations).toBe(2);
  });

  it("forced termination at iteration limit", async () => {
    const config = makeConfig({
      toolConfig: { allowed_actions: ["read_file", "done"], max_iterations: 2, action_classes: [] },
    });
    const callLlm = vi
      .fn()
      .mockResolvedValue(makeCompletion('{"action": "read_file", "params": {"path": "a.ts"}}'));
    const execAction = vi.fn().mockResolvedValue({ success: true, output: "content" });

    const result = await runAgentLoop(config, callLlm, execAction);

    expect(result.iterations).toBe(2);
    // Forced done — phaseData is empty
    expect(result.phaseData).toEqual({});
  });

  it("accumulates cost across iterations", async () => {
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce(makeCompletion('{"action": "read_file", "params": {"path": "a.ts"}}'))
      .mockResolvedValueOnce(makeCompletion('{"action": "done", "result": {}}'));
    const execAction = vi.fn().mockResolvedValue({ success: true, output: "" });

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.totalCost.tokens_in).toBe(20); // 10 + 10
    expect(result.totalCost.tokens_out).toBe(10); // 5 + 5
    expect(result.totalCost.spend_usd).toBe(0.002); // 0.001 + 0.001
  });

  it("handles null spend_usd without accumulation error", async () => {
    const nullSpendCompletion: CompletionResult = {
      content: '{"action": "done", "result": {}}',
      tool_calls: null,
      finish_reason: "stop",
      usage: { tokens_in: 10, tokens_out: 5, spend_usd: null, remaining: null, resets_at: null },
    };
    const callLlm = vi.fn().mockResolvedValue(nullSpendCompletion);
    const execAction = vi.fn();

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.totalCost.spend_usd).toBeNull();
  });

  it("builds conversation history with action-result pairs", async () => {
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce(makeCompletion('{"action": "read_file", "params": {"path": "a.ts"}}'))
      .mockResolvedValueOnce(makeCompletion('{"action": "read_file", "params": {"path": "b.ts"}}'))
      .mockResolvedValueOnce(makeCompletion('{"action": "done", "result": {"count": 2}}'));
    const execAction = vi
      .fn()
      .mockResolvedValueOnce({ success: true, output: "content-a" } satisfies ActionResult)
      .mockResolvedValueOnce({ success: true, output: "content-b" } satisfies ActionResult);

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.actions).toHaveLength(3);
    expect(result.actions[0]?.action.action).toBe("read_file");
    expect(result.actions[0]?.result?.output).toBe("content-a");
    expect(result.actions[1]?.action.action).toBe("read_file");
    expect(result.actions[1]?.result?.output).toBe("content-b");
    expect(result.actions[2]?.action.action).toBe("done");
    expect(result.actions[2]?.result).toBeNull();
  });

  it("double parse failure forces done with empty phaseData", async () => {
    const callLlm = vi.fn().mockResolvedValue(makeCompletion("totally not json"));
    const execAction = vi.fn();

    const result = await runAgentLoop(makeConfig(), callLlm, execAction);

    expect(result.phaseData).toEqual({});
    expect(execAction).not.toHaveBeenCalled();
  });

  it("sanitizes secrets in LLM response content passed to onLlmComplete", async () => {
    const tokenValue = "ghp_TestToken1234567890abcdefghijklmnopqrst";
    const callLlm = vi
      .fn()
      .mockResolvedValue(
        makeCompletion(`{"action": "done", "result": {"note": "found token ${tokenValue}"}}`),
      );
    const execAction = vi.fn();
    const llmTraces: Array<{ response_content: string | undefined }> = [];
    const config = makeConfig({
      callbacks: {
        onLlmComplete: (trace) => {
          llmTraces.push({ response_content: trace.response_content });
        },
      },
    });

    await runAgentLoop(config, callLlm, execAction);

    expect(llmTraces).toHaveLength(1);
    expect(llmTraces[0]?.response_content).not.toContain(tokenValue);
    expect(llmTraces[0]?.response_content).toContain("[REDACTED:github_token]");
  });

  it("sanitizes secrets in action trace output passed to onActionComplete", async () => {
    const tokenValue = "ghp_ActionSecretToken123456789012345678901";
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce(makeCompletion('{"action": "read_file", "params": {"path": "a.ts"}}'))
      .mockResolvedValueOnce(makeCompletion('{"action": "done", "result": {}}'));
    const execAction = vi.fn().mockResolvedValue({
      success: true,
      output: `env dump: GITHUB_TOKEN=${tokenValue}`,
    });
    const actionTraces: Array<{ result_output: string | null }> = [];
    const config = makeConfig({
      callbacks: {
        onActionComplete: (trace) => {
          actionTraces.push({ result_output: trace.result_output });
        },
      },
    });

    await runAgentLoop(config, callLlm, execAction);

    expect(actionTraces).toHaveLength(1);
    expect(actionTraces[0]?.result_output).not.toContain(tokenValue);
    expect(actionTraces[0]?.result_output).toContain("[REDACTED:github_token]");
  });
});
