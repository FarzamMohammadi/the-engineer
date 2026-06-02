import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentStep } from "../../../../../src/core/orchestrator/pipeline/agent-step.js";
import type { AgentRunResult } from "../../../../../src/schemas/adapters.js";
import { createMockPipeline, fakeAgent } from "../../../../helpers/test-mock-pipeline.js";

const AGENT_RESULT: AgentRunResult = { content: "", cost_usd: 0, duration_ms: 1, usage: null };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "engineer-agent-step-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a session-result.json into the step directory. */
function writeResult(result: unknown): void {
  writeFileSync(path.join(dir, "session-result.json"), JSON.stringify(result), "utf-8");
}

/** Build the agentStep run for a step whose result file lives in the temp dir. */
function step(detailsSchema?: z.ZodType<unknown>) {
  return agentStep({
    stepName: "implement",
    directory: () => dir,
    prompt: () => "do the work",
    ...(detailsSchema ? { detailsSchema } : {}),
  });
}

describe("agentStep", () => {
  it("returns ok when the agent writes a valid result", async () => {
    const agent = fakeAgent(() => {
      writeResult({ status: "ok", summary: "implemented the feature" });
      return Promise.resolve(AGENT_RESULT);
    });
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toEqual({ outcome: "ok", summary: "implemented the feature" });
  });

  it("fails with no_result when the agent leaves the template untouched", async () => {
    const agent = fakeAgent(() => Promise.resolve(AGENT_RESULT));
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "no_result" });
  });

  it("fails with no_result when the result file is malformed", async () => {
    const agent = fakeAgent(() => {
      writeFileSync(path.join(dir, "session-result.json"), "{ not json", "utf-8");
      return Promise.resolve(AGENT_RESULT);
    });
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "no_result" });
  });

  it("recovers the result the agent wrote before dying (partial write)", async () => {
    const agent = fakeAgent(() => {
      writeResult({ status: "ok", summary: "wrote then crashed" });
      return Promise.reject(new Error("killed mid-write"));
    });
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toEqual({ outcome: "ok", summary: "wrote then crashed" });
  });

  it("re-throws when the run is aborted with no usable result (preemption)", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = fakeAgent(() => Promise.reject(new Error("SIGTERM")));
    const { ctx } = createMockPipeline({ agent, worktreePath: dir, signal: controller.signal });

    await expect(step()(ctx)).rejects.toThrow("SIGTERM");
  });

  it("fails with agent_unavailable when the agent errors and writes nothing", async () => {
    const agent = fakeAgent(() => Promise.reject(new Error("spawn ENOENT")));
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "agent_unavailable" });
  });

  it("fails with agent_unavailable when no agent plugin is registered", async () => {
    const { ctx } = createMockPipeline({ agent: null, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "agent_unavailable" });
  });

  it("maps a needs_human status to a needs_human outcome", async () => {
    const agent = fakeAgent(() => {
      writeResult({ status: "needs_human", summary: "which auth provider?" });
      return Promise.resolve(AGENT_RESULT);
    });
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toEqual({ outcome: "needs_human", summary: "which auth provider?" });
  });

  it("maps an agent-reported failure to failed(agent_failed)", async () => {
    const agent = fakeAgent(() => {
      writeResult({ status: "failed", summary: "could not build" });
      return Promise.resolve(AGENT_RESULT);
    });
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });

    const result = await step()(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "agent_failed" });
  });

  describe("details validation", () => {
    const schema = z.object({ files_changed: z.number() });

    it("returns ok with data when details satisfy the schema", async () => {
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "done", details: { files_changed: 3 } });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });

      const result = await step(schema)(ctx);

      expect(result).toEqual({ outcome: "ok", summary: "done", data: { files_changed: 3 } });
    });

    it("fails with details_invalid when details violate the schema", async () => {
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "done", details: { files_changed: "lots" } });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });

      const result = await step(schema)(ctx);

      expect(result).toMatchObject({ outcome: "failed", category: "details_invalid" });
    });
  });

  describe("observability", () => {
    it("emits an agent_call span carrying the prompt blob and ending with the outcome", async () => {
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "did it" });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx, observer } = createMockPipeline({ agent, worktreePath: dir });

      await step()(ctx);

      const span = observer.spans.find((s) => s.type === "agent_call");
      expect(span?.name).toBe("implement");
      expect(span?.input?.["prompt_blob"]).toBeTruthy();
      expect(span?.output?.["outcome"]).toBe("ok");
      expect(observer.blobs.some((blob) => blob.includes("do the work"))).toBe(true);
    });

    it("ends the agent_call span carrying the run's cost and token spend for the metrics page", async () => {
      const result: AgentRunResult = {
        content: "",
        cost_usd: 0.42,
        duration_ms: 1,
        usage: {
          tokens: {
            input_tokens: 1500,
            output_tokens: 300,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_tokens: 1800,
          },
          model_id: "claude",
          service_tier: null,
        },
      };
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "did it" });
        return Promise.resolve(result);
      });
      const { ctx, observer } = createMockPipeline({ agent, worktreePath: dir });

      await step()(ctx);

      const span = observer.spans.find((s) => s.type === "agent_call");
      expect(span?.output).toMatchObject({ cost_usd: 0.42, tokens_in: 1500, tokens_out: 300 });
    });

    it("ends the agent_call span with null spend when the run reports no usage", async () => {
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "did it" });
        return Promise.resolve({ content: "", cost_usd: null, duration_ms: 1, usage: null });
      });
      const { ctx, observer } = createMockPipeline({ agent, worktreePath: dir });

      await step()(ctx);

      const span = observer.spans.find((s) => s.type === "agent_call");
      expect(span?.output).toMatchObject({ cost_usd: null, tokens_in: null, tokens_out: null });
    });
  });
});
