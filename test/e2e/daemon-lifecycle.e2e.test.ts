import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TriggerEvent } from "../../src/schemas/adapters.js";
import {
  type IntegrationContext,
  createIntegrationContext,
} from "../helpers/integration-context.js";

describe("E2E: Daemon lifecycle", () => {
  let ctx: IntegrationContext;

  function setup(options?: Parameters<typeof createIntegrationContext>[0]): IntegrationContext {
    ctx = createIntegrationContext(options);
    return ctx;
  }

  afterEach(async () => {
    if (ctx) {
      try {
        await ctx.daemon.stop();
      } catch {
        // May not be started or already stopped
      }
      ctx.cleanup();
    }
  });

  function pidFilePath(): string {
    return join(ctx.engineerHome, "run", "engineer.pid");
  }

  function makeTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
    return {
      idempotency_key: `test:issue:repo:${String(Date.now())}:${String(Math.random()).slice(2, 8)}`,
      source: "fake-trigger",
      event_type: "issue_opened",
      external_ref: { type: "test_issue", repo: "test/repo", number: 1 },
      title: "Test issue",
      body: "Test body",
      repo: "test/repo",
      clone_url: "https://github.com/test/repo.git",
      metadata: null,
      thoughts_id: "test-1",
      ...overrides,
    };
  }

  it("starts and creates PID file", async () => {
    setup();
    await ctx.daemon.start();

    expect(ctx.daemon.getState().running).toBe(true);

    const pidPath = pidFilePath();
    expect(existsSync(pidPath)).toBe(true);

    const pidContent = readFileSync(pidPath, "utf-8").trim();
    expect(Number.parseInt(pidContent, 10)).toBe(process.pid);
  });

  it("rejects double start", async () => {
    setup();
    await ctx.daemon.start();
    await expect(ctx.daemon.start()).rejects.toThrow();
  });

  it("overwrites stale PID from dead process", async () => {
    setup();

    // Write a fake PID for a process that doesn't exist
    writeFileSync(pidFilePath(), "999999999", "utf-8");

    // Should succeed — detects stale PID
    await ctx.daemon.start();
    expect(ctx.daemon.getState().running).toBe(true);

    const pidContent = readFileSync(pidFilePath(), "utf-8").trim();
    expect(Number.parseInt(pidContent, 10)).toBe(process.pid);
  });

  it("tick processes empty cycle without error", async () => {
    setup();
    await ctx.daemon.start();

    // Tick with no triggers, no tasks — should complete cleanly
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    const state = ctx.daemon.getState();
    expect(state.running).toBe(true);
    expect(state.activeTaskIds).toHaveLength(0);
    expect(state.tasksCompleted).toBe(0);
  });

  it("stop cleans up PID file and state", async () => {
    setup();
    await ctx.daemon.start();

    expect(existsSync(pidFilePath())).toBe(true);

    await ctx.daemon.stop();

    expect(ctx.daemon.getState().running).toBe(false);
    expect(existsSync(pidFilePath())).toBe(false);
  });

  it("stop is idempotent on unstarted daemon", async () => {
    setup();

    // Stop without starting — should not throw
    await ctx.daemon.stop();
    expect(ctx.daemon.getState().running).toBe(false);
  });

  it("shutdown drains active dispatches gracefully", async () => {
    setup();

    const event = makeTriggerEvent({ title: "Drain test" });
    ctx.fakes.trigger.setEvents([event]);

    // Initialize plugins so dispatch works
    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.registry.initializePlugin("fake-llm", {});

    await ctx.daemon.start();

    // Tick to poll trigger and create task
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    // Second tick to schedule + dispatch
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    // Stop — should drain active dispatches
    await ctx.daemon.stop();

    expect(ctx.daemon.getState().running).toBe(false);

    // Task should not be stuck in active — either completed or moved to queued
    const activeTasks = ctx.taskEngine.getTasksByState("active");
    const workingActive = activeTasks.filter((t) => t.sub_state === "working");
    expect(workingActive).toHaveLength(0);
  });
});
