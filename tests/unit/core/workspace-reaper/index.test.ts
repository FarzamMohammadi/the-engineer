import { afterEach, describe, expect, it, vi } from "vitest";

import { type WorkspaceReaperDeps, createWorkspaceReaper } from "../../../../src/core/workspace-reaper/index.js";
import { type ReviewState, type Task, TaskStates } from "../../../../src/schemas/task.js";
import { FakeClock } from "../../../helpers/fake-clock.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const MERGED_AT = "2026-01-01T00:00:00.000Z"; // == FakeClock's default "now"

// The reaper reads only id, state, and review.merged_at off a task — keep fixtures minimal.
function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: "t1", state: TaskStates.completed, review: null, ...overrides } as Task;
}

function mergedTask(mergedAt: string): Task {
  const review: ReviewState = {
    pr_number: 1,
    merged_at: mergedAt,
    feedback_rounds: [],
    accommodated_comment_ids: [],
    accommodated_review_state: null,
  };
  return makeTask({ review });
}

interface MakeReaperOptions {
  readonly tasks?: Task[];
  readonly branchRetentionDays?: number | null;
  readonly hostingPresent?: boolean;
  readonly enabled?: boolean;
}

function makeReaper(opts: MakeReaperOptions = {}) {
  const tasks = opts.tasks ?? [];
  const clock = new FakeClock();
  const getUnreaped = vi.fn(() => tasks);
  const updateTaskField = vi.fn();
  const cleanupWorkspace = vi.fn();
  const deleteRemoteBranch = vi.fn();
  const isInFlight = vi.fn(() => false);
  const publish = vi.fn();
  const notify = vi.fn();
  const record = {
    taskId: "t1",
    repo: "acme/app",
    branch: "feat/x",
    worktreePath: "/w",
    baseBranch: "main",
    thoughtsDir: null,
  };
  const getPrimaryPlugin = vi.fn(() => (opts.hostingPresent === false ? null : {}));

  const reaper = createWorkspaceReaper({
    config: { enabled: opts.enabled ?? true, interval_ms: 3_600_000 },
    // Distinguish an explicit null (keep forever) from "not provided" — `?? 0` would swallow the null.
    branchRetentionDays: opts.branchRetentionDays === undefined ? 0 : opts.branchRetentionDays,
    taskEngine: {
      getUnreapedTerminalTasks: getUnreaped,
      updateTaskField,
    } as unknown as WorkspaceReaperDeps["taskEngine"],
    workspaceManager: {
      getWorkspaceRecord: () => record,
      cleanupWorkspace,
      deleteRemoteBranch,
    } as unknown as WorkspaceReaperDeps["workspaceManager"],
    registry: { getPrimaryPlugin } as unknown as WorkspaceReaperDeps["registry"],
    dispatchTracker: { isInFlight },
    eventBus: { publish } as unknown as WorkspaceReaperDeps["eventBus"],
    notifications: { notify } as unknown as WorkspaceReaperDeps["notifications"],
    clock,
    observer: createTestObserverFacade("workspace-reaper"),
  });

  return {
    reaper,
    clock,
    getUnreaped,
    updateTaskField,
    cleanupWorkspace,
    deleteRemoteBranch,
    isInFlight,
    publish,
    notify,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workspace reaper — retention", () => {
  it("reaps a merged branch at exactly N days (the boundary is inclusive)", async () => {
    const h = makeReaper({ branchRetentionDays: 7, tasks: [mergedTask(MERGED_AT)] });
    h.clock.set(Date.parse(MERGED_AT) + 7 * MS_PER_DAY);

    await h.reaper.runOnce();

    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("does not reap one millisecond before N days", async () => {
    const h = makeReaper({ branchRetentionDays: 7, tasks: [mergedTask(MERGED_AT)] });
    h.clock.set(Date.parse(MERGED_AT) + 7 * MS_PER_DAY - 1);

    await h.reaper.runOnce();

    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).not.toHaveBeenCalled(); // deferred — reaped_at stays NULL, reconsidered next sweep
    expect(h.reaper.getLastRun()?.deferred).toBe(1);
  });

  it("reaps a merged branch on the next sweep when retention is 0", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "git.branch_deleted",
        source: "workspace-reaper",
        payload: { task_id: "t1", repo: "acme/app", branch: "feat/x" },
      }),
    );
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("keeps a merged branch forever when retention is null, but still marks it reaped", async () => {
    const h = makeReaper({ branchRetentionDays: null, tasks: [mergedTask(MERGED_AT)] });

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).not.toHaveBeenCalled();
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("preserves a push-only branch (no merge recorded) and marks it reaped", async () => {
    const h = makeReaper({ tasks: [makeTask({ review: null })] });

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).not.toHaveBeenCalled();
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });
});

describe("workspace reaper — failure envelope", () => {
  it("never reaps a task whose dispatch is in flight", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    h.isInFlight.mockReturnValue(true);

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).not.toHaveBeenCalled();
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).not.toHaveBeenCalled();
    expect(h.reaper.getLastRun()?.skippedInFlight).toBe(1);
  });

  it("leaves reaped_at NULL on a partial reap, then completes on the next sweep", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    // Sweep 1: the local cleanup lands, but the remote delete throws (network down).
    h.deleteRemoteBranch.mockImplementationOnce(() => {
      throw new Error("network down");
    });

    await h.reaper.runOnce();
    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.updateTaskField).not.toHaveBeenCalled(); // all-or-nothing: not marked reaped
    expect(h.reaper.getLastRun()?.failed).toBe(1);

    // Sweep 2: the remote delete now succeeds, so the reap completes.
    await h.reaper.runOnce();
    expect(h.deleteRemoteBranch).toHaveBeenCalledTimes(2);
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
  });

  it("reaps locally and skips the remote when the hosting plugin is absent", async () => {
    const h = makeReaper({ branchRetentionDays: 0, hostingPresent: false, tasks: [mergedTask(MERGED_AT)] });

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled(); // no git.branch_deleted — the remote was not touched
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
  });

  it("escalates to an alert once consecutive reap failures cross the threshold", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    h.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("revoked token");
    });

    await h.reaper.runOnce(); // failure 1
    await h.reaper.runOnce(); // failure 2
    expect(h.notify).not.toHaveBeenCalled();

    await h.reaper.runOnce(); // failure 3 — crosses the threshold
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "alert", taskId: "t1" }));

    await h.reaper.runOnce(); // failure 4 — no re-alert (escalates once at the crossing)
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("skips a sweep that overlaps one already in progress (re-entrancy guard)", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });

    const first = h.reaper.runOnce();
    const second = h.reaper.runOnce(); // running === true → no-ops before it queries
    await Promise.all([first, second]);

    expect(h.getUnreaped).toHaveBeenCalledTimes(1);
    expect(h.deleteRemoteBranch).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-task failure — one bad task does not abort the others in the sweep", async () => {
    const h = makeReaper({
      branchRetentionDays: 0,
      tasks: [mergedTask(MERGED_AT), makeTask({ id: "t2", review: null })],
    });
    // The first task's remote delete throws; the second (push-only) must still be reaped.
    h.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("boom");
    });

    await h.reaper.runOnce();

    expect(h.updateTaskField).toHaveBeenCalledWith("t2", "reaped_at", expect.any(String));
    const stats = h.reaper.getLastRun();
    expect(stats?.scanned).toBe(2);
    expect(stats?.failed).toBe(1);
    expect(stats?.reaped).toBe(1);
  });
});

describe("workspace reaper — cancelled arm (later session)", () => {
  it("defers a cancelled task without reaping it (its arm lands in a later session)", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [makeTask({ state: TaskStates.cancelled })] });

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).not.toHaveBeenCalled();
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).not.toHaveBeenCalled();
    expect(h.reaper.getLastRun()?.deferred).toBe(1);
  });
});

describe("workspace reaper — lifecycle", () => {
  it("exposes the last sweep summary via getLastRun", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    expect(h.reaper.getLastRun()).toBeNull();

    await h.reaper.runOnce();

    expect(h.reaper.getLastRun()).toMatchObject({
      scanned: 1,
      reaped: 1,
      skippedInFlight: 0,
      deferred: 0,
      failed: 0,
      timestamp: expect.any(String),
    });
  });

  it("sweeps on its interval when enabled, and stop() halts further sweeps", async () => {
    vi.useFakeTimers();
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });

    h.reaper.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.deleteRemoteBranch).toHaveBeenCalledTimes(1);

    h.reaper.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.deleteRemoteBranch).toHaveBeenCalledTimes(1);
  });

  it("does not schedule sweeps when disabled", async () => {
    vi.useFakeTimers();
    const h = makeReaper({ enabled: false, branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });

    h.reaper.start();
    await vi.advanceTimersByTimeAsync(3_600_000 * 2);

    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
  });
});
