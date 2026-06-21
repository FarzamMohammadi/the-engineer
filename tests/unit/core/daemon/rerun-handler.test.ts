import { describe, expect, it, vi } from "vitest";

import { handleRerunRequest } from "../../../../src/core/daemon/rerun-handler.js";
import type { ITaskEngine } from "../../../../src/core/interfaces/task-engine.interface.js";
import { type Task, TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

type TaskState = Task["state"];

// ── Helpers ──────────────────────────────────────────────────────────────────────

function makeCancelledTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "old-1",
    state: TaskStates.cancelled,
    idempotency_key: "github:issue-42",
    title: "Fix the bug",
    description: "desc",
    source_text: "issue body",
    acceptance_criteria: ["works"],
    repo: "acme/app",
    clone_url: "https://github.com/acme/app.git",
    thoughts_id: "issue-42",
    external_ref: { type: "github_issue", repo: "acme/app", id: "42" },
    priority: 50,
    related: [],
    ...overrides,
  } as Task;
}

function makeDeps(task: Task | null, keyHolder: { id: string; state: TaskState } | null = null) {
  const taskEngine = {
    getTask: vi.fn(() => task),
    findKeyHolder: vi.fn(() => keyHolder),
    createTask: vi.fn(() => ({ id: "new-1" }) as Task),
    updateTaskField: vi.fn(),
  };
  return {
    deps: { taskEngine: taskEngine as unknown as ITaskEngine, observer: createTestObserverFacade("daemon") },
    taskEngine,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("handleRerunRequest", () => {
  it("clones a cancelled task as a fresh task reusing its source identity, and links provenance", () => {
    const { deps, taskEngine } = makeDeps(makeCancelledTask());

    handleRerunRequest(deps, "old-1");

    expect(taskEngine.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix the bug",
        repo: "acme/app",
        source: "rerun",
        idempotency_key: "github:issue-42",
        external_ref: expect.objectContaining({ id: "42" }),
        acceptance_criteria: ["works"],
      }),
    );
    expect(taskEngine.updateTaskField).toHaveBeenCalledWith("new-1", "related", [
      expect.objectContaining({ type: "previous_attempt", ref: "old-1" }),
    ]);
  });

  it("skips the clone when a live task already holds the idempotency key", () => {
    const { deps, taskEngine } = makeDeps(makeCancelledTask(), { id: "live-2", state: TaskStates.queued });

    handleRerunRequest(deps, "old-1");

    expect(taskEngine.createTask).not.toHaveBeenCalled();
  });

  it("skips when the source task is not cancelled", () => {
    const { deps, taskEngine } = makeDeps(makeCancelledTask({ state: TaskStates.completed }));

    handleRerunRequest(deps, "old-1");

    expect(taskEngine.createTask).not.toHaveBeenCalled();
  });

  it("skips when the source task is missing", () => {
    const { deps, taskEngine } = makeDeps(null);

    handleRerunRequest(deps, "ghost");

    expect(taskEngine.createTask).not.toHaveBeenCalled();
  });

  it("skips when the source task has no repo to clone into", () => {
    const { deps, taskEngine } = makeDeps(makeCancelledTask({ repo: null }));

    handleRerunRequest(deps, "old-1");

    expect(taskEngine.createTask).not.toHaveBeenCalled();
  });

  it("does not throw when createTask loses a key race — degrades gracefully", () => {
    const { deps, taskEngine } = makeDeps(makeCancelledTask());
    taskEngine.createTask.mockImplementation(() => {
      throw new Error("UNIQUE constraint failed: tasks.idempotency_key");
    });

    expect(() => handleRerunRequest(deps, "old-1")).not.toThrow();
  });
});
