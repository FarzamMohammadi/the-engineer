import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  it("names where a valid result landed when the agent wrote to the wrong directory", async () => {
    // Canonical path the orchestrator reads; the agent will write a real result one dir up instead.
    const stepDir = path.join(dir, "thoughts", "issue-1", "research");
    const strayDir = path.join(dir, "research");
    const agent = fakeAgent(() => {
      mkdirSync(strayDir, { recursive: true });
      const strayResult = path.join(strayDir, "session-result.json");
      writeFileSync(strayResult, JSON.stringify({ status: "ok", summary: "did the work, wrong place" }), "utf-8");
      // A real agent run spans seconds, so its result lands well after the step's template reset. This fake
      // writes back-to-back with the reset, so on a coarse-grained filesystem (e.g. the Linux CI runner) the
      // two writes can share one timestamp tick and the stray reads as pre-existing. Stamp it forward to model
      // the real elapsed time and clear the reset floor deterministically on every filesystem.
      const afterReset = new Date(Date.now() + 60_000);
      utimesSync(strayResult, afterReset, afterReset);
      return Promise.resolve(AGENT_RESULT);
    });
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });
    const run = agentStep({ stepName: "investigate", directory: () => stepDir, prompt: () => "do the work" });

    const result = await run(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "no_result" });
    expect(result).toHaveProperty("detail", expect.stringContaining(path.join("research", "session-result.json")));
    expect((result as { detail: string }).detail).toContain("wrong directory");
  });

  it("does not flag a prior step's result as a stray (only results written this run count)", async () => {
    // A real result from an earlier phase predates this step's reset; it must not be reported as a stray.
    const stepDir = path.join(dir, "thoughts", "issue-1", "research");
    const earlierDir = path.join(dir, "thoughts", "issue-1", "requirements");
    mkdirSync(earlierDir, { recursive: true });
    writeFileSync(
      path.join(earlierDir, "session-result.json"),
      JSON.stringify({ status: "ok", summary: "earlier phase, already done" }),
      "utf-8",
    );
    const agent = fakeAgent(() => Promise.resolve(AGENT_RESULT));
    const { ctx } = createMockPipeline({ agent, worktreePath: dir });
    const run = agentStep({ stepName: "investigate", directory: () => stepDir, prompt: () => "do the work" });

    const result = await run(ctx);

    expect(result).toMatchObject({ outcome: "failed", category: "no_result" });
    expect((result as { detail: string }).detail).not.toContain("wrong directory");
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

  describe("surfaced decisions", () => {
    it("passes a valid decisions array through into the result data", async () => {
      const decisions = [
        { category: "code_style", summary: "renamed a helper", chosen: "fetchUser", reasoning: "verb convention" },
      ];
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "done", details: { decisions } });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });

      const result = await step()(ctx);

      expect(result).toEqual({ outcome: "ok", summary: "done", data: { decisions } });
    });

    it("fails with details_invalid when a surfaced decision is missing required fields", async () => {
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "done", details: { decisions: [{ category: "code_style" }] } });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });

      const result = await step()(ctx);

      expect(result).toMatchObject({ outcome: "failed", category: "details_invalid" });
    });

    it("fails with details_invalid when decisions is not an array", async () => {
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "done", details: { decisions: "nope" } });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });

      const result = await step()(ctx);

      expect(result).toMatchObject({ outcome: "failed", category: "details_invalid" });
    });

    it("validates decisions alongside the sub-phase's own details schema", async () => {
      const schema = z.object({ verdict: z.enum(["ship"]) });
      const decisions = [
        { category: "doc_wording", summary: "tweaked a comment", chosen: "clearer", reasoning: "why" },
      ];
      const agent = fakeAgent(() => {
        writeResult({ status: "ok", summary: "done", details: { verdict: "ship", decisions } });
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });

      const result = await step(schema)(ctx);

      expect(result).toEqual({ outcome: "ok", summary: "done", data: { verdict: "ship", decisions } });
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

  describe("live activity feed", () => {
    it("passes on_activity and turns emitted events into agent_activity child observations", async () => {
      const agent = fakeAgent(
        (request) => {
          request.on_activity?.({ kind: "thinking", text: "reading the file" });
          request.on_activity?.({ kind: "tool_use", tool_call_id: "c1", name: "bash", input: { command: "ls" } });
          writeResult({ status: "ok", summary: "did it" });
          return Promise.resolve(AGENT_RESULT);
        },
        { supports_activity_streaming: true },
      );
      const { ctx, observer } = createMockPipeline({ agent, worktreePath: dir });

      await step()(ctx);

      const activities = observer.observations.filter((o) => o.type === "agent_activity");
      expect(activities.map((a) => a.name)).toEqual(["thinking", "bash"]);
      expect(activities[0]?.data).toMatchObject({ kind: "thinking", text: "reading the file" });
    });

    it("does not pass on_activity when the agent does not stream (graceful degradation)", async () => {
      let received: unknown = "unset";
      const agent = fakeAgent((request) => {
        received = request.on_activity;
        writeResult({ status: "ok", summary: "did it" });
        return Promise.resolve(AGENT_RESULT);
      }); // default capabilities: supports_activity_streaming is false
      const { ctx, observer } = createMockPipeline({ agent, worktreePath: dir });

      await step()(ctx);

      expect(received).toBeUndefined();
      expect(observer.observations.some((o) => o.type === "agent_activity")).toBe(false);
    });

    it("does not pass on_activity when the live_activity toggle is off", async () => {
      let received: unknown = "unset";
      const agent = fakeAgent(
        (request) => {
          received = request.on_activity;
          writeResult({ status: "ok", summary: "did it" });
          return Promise.resolve(AGENT_RESULT);
        },
        { supports_activity_streaming: true },
      );
      const { ctx } = createMockPipeline({ agent, worktreePath: dir });
      ctx.config.observability.live_activity = false;

      await step()(ctx);

      expect(received).toBeUndefined();
    });
  });
});
