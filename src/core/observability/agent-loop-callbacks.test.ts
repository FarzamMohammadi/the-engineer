import { describe, expect, it } from "vitest";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { CompletionResult } from "../../schemas/adapters.js";
import type { ActionTraceRecord, LlmTraceRecord } from "../../schemas/observability.js";
import { runAgentLoop } from "../orchestrator/agent-loop.js";

function mockCompletion(
  content: string,
  usage: { tokens_in: number; tokens_out: number; spend_usd: number | null },
): CompletionResult {
  return {
    content,
    tool_calls: null,
    finish_reason: "stop",
    usage: { ...usage, remaining: null, resets_at: null },
  };
}

describe("Agent Loop Observability Callbacks", () => {
  const baseConfig = {
    phase: "research",
    taskId: "TASK_01",
    systemPrompt: "You are an engineer.",
    initialPrompt: "Read the codebase.",
    toolConfig: {
      allowed_actions: ["read_file", "done"] as string[],
      max_iterations: 10,
      action_classes: [] as string[],
    },
    worktreePath: "/tmp/test-worktree",
    observer: createTestObserverFacade("orchestrator"),
  };

  it("calls onLlmComplete for each LLM call", async () => {
    const llmTraces: LlmTraceRecord[] = [];

    const result = await runAgentLoop(
      {
        ...baseConfig,
        callbacks: {
          onLlmComplete: (trace) => llmTraces.push(trace),
        },
      },
      // LLM returns done immediately
      () =>
        Promise.resolve(
          mockCompletion(JSON.stringify({ action: "done", result: { summary: "done" } }), {
            tokens_in: 100,
            tokens_out: 50,
            spend_usd: 0.01,
          }),
        ),
      () => Promise.resolve({ success: true, output: "ok" }),
    );

    expect(result.iterations).toBe(1);
    expect(llmTraces).toHaveLength(1);
    expect(llmTraces[0]?.tokens_in).toBe(100);
    expect(llmTraces[0]?.tokens_out).toBe(50);
    expect(llmTraces[0]?.spend_usd).toBe(0.01);
    expect(llmTraces[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(llmTraces[0]?.iteration).toBe(1);
    expect(llmTraces[0]?.prompt_content).toContain(baseConfig.initialPrompt);
  });

  it("calls onActionComplete for each action execution", async () => {
    const actionTraces: ActionTraceRecord[] = [];
    let callCount = 0;

    const result = await runAgentLoop(
      {
        ...baseConfig,
        callbacks: {
          onActionComplete: (trace) => actionTraces.push(trace),
        },
      },
      () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            mockCompletion(
              JSON.stringify({ action: "read_file", params: { path: "src/index.ts" } }),
              { tokens_in: 50, tokens_out: 30, spend_usd: null },
            ),
          );
        }
        return Promise.resolve(
          mockCompletion(JSON.stringify({ action: "done", result: { summary: "done" } }), {
            tokens_in: 50,
            tokens_out: 30,
            spend_usd: null,
          }),
        );
      },
      () => Promise.resolve({ success: true, output: "file contents" }),
    );

    expect(result.iterations).toBe(2);
    expect(actionTraces).toHaveLength(1); // done doesn't trigger onActionComplete
    expect(actionTraces[0]?.action_type).toBe("read_file");
    expect(actionTraces[0]?.result_success).toBe(true);
    expect(actionTraces[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(actionTraces[0]?.iteration).toBe(1);
  });

  it("captures failed action results", async () => {
    const actionTraces: ActionTraceRecord[] = [];
    let callCount = 0;

    await runAgentLoop(
      {
        ...baseConfig,
        callbacks: {
          onActionComplete: (trace) => actionTraces.push(trace),
        },
      },
      () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            mockCompletion(
              JSON.stringify({ action: "read_file", params: { path: "missing.ts" } }),
              { tokens_in: 50, tokens_out: 30, spend_usd: null },
            ),
          );
        }
        return Promise.resolve(
          mockCompletion(JSON.stringify({ action: "done", result: {} }), {
            tokens_in: 50,
            tokens_out: 30,
            spend_usd: null,
          }),
        );
      },
      () => Promise.resolve({ success: false, output: "", error: "File not found" }),
    );

    expect(actionTraces).toHaveLength(1);
    expect(actionTraces[0]?.result_success).toBe(false);
    expect(actionTraces[0]?.result_error).toBe("File not found");
  });

  it("works without callbacks (undefined)", async () => {
    const result = await runAgentLoop(
      { ...baseConfig },
      () =>
        Promise.resolve(
          mockCompletion(JSON.stringify({ action: "done", result: { summary: "test" } }), {
            tokens_in: 10,
            tokens_out: 5,
            spend_usd: null,
          }),
        ),
      () => Promise.resolve({ success: true, output: "ok" }),
    );

    expect(result.iterations).toBe(1);
  });

  it("includes prompt and response content in LLM trace", async () => {
    const llmTraces: LlmTraceRecord[] = [];
    const responseContent = JSON.stringify({ action: "done", result: { summary: "done" } });

    await runAgentLoop(
      {
        ...baseConfig,
        callbacks: {
          onLlmComplete: (trace) => llmTraces.push(trace),
        },
      },
      () =>
        Promise.resolve(
          mockCompletion(responseContent, { tokens_in: 10, tokens_out: 5, spend_usd: null }),
        ),
      () => Promise.resolve({ success: true, output: "ok" }),
    );

    expect(llmTraces[0]?.prompt_content).toContain(baseConfig.initialPrompt);
    expect(llmTraces[0]?.response_content).toBe(responseContent);
  });

  it("tracks multiple iterations with both callbacks", async () => {
    const actionTraces: ActionTraceRecord[] = [];
    const llmTraces: LlmTraceRecord[] = [];
    let callCount = 0;

    await runAgentLoop(
      {
        ...baseConfig,
        callbacks: {
          onActionComplete: (trace) => actionTraces.push(trace),
          onLlmComplete: (trace) => llmTraces.push(trace),
        },
      },
      () => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(
            mockCompletion(
              JSON.stringify({
                action: "read_file",
                params: { path: `file${String(callCount)}.ts` },
              }),
              { tokens_in: 50, tokens_out: 30, spend_usd: 0.005 },
            ),
          );
        }
        return Promise.resolve(
          mockCompletion(JSON.stringify({ action: "done", result: { summary: "all done" } }), {
            tokens_in: 50,
            tokens_out: 30,
            spend_usd: 0.005,
          }),
        );
      },
      () => Promise.resolve({ success: true, output: "file contents" }),
    );

    expect(llmTraces).toHaveLength(3); // 2 actions + 1 done
    expect(actionTraces).toHaveLength(2); // 2 actions, done doesn't count
    expect(llmTraces[0]?.iteration).toBe(1);
    expect(llmTraces[1]?.iteration).toBe(2);
    expect(llmTraces[2]?.iteration).toBe(3);
  });
});
