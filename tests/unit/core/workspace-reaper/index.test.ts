import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceRecord } from "../../../../src/core/interfaces/workspace-manager.interface.js";
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
    consecutive_blocker_reentries: 0,
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
  const getTask = vi.fn((id: string) => tasks.find((t) => t.id === id) ?? null);
  const updateTaskField = vi.fn();
  const cleanupWorkspace = vi.fn();
  const deleteRemoteBranch = vi.fn();
  const isInFlight = vi.fn(() => false);
  const publish = vi.fn();
  const notify = vi.fn();
  const syncStateToCommPlugin = vi.fn();
  const record: WorkspaceRecord = {
    taskId: "t1",
    repo: "acme/app",
    branch: "feat/x",
    worktreePath: "/w",
    baseBranch: "main",
    thoughtsDir: null,
  };
  const getWorkspaceRecord = vi.fn((): WorkspaceRecord | null => record);
  // The cancelled arm reaches the hosting plugin (status → comment → close); the merged arm only checks that
  // a plugin exists. One mock serves both — present unless the test opts out via `hostingPresent: false`.
  const getPRStatus = vi.fn(() => Promise.resolve({ state: "open" }));
  const commentOnPR = vi.fn(() => Promise.resolve({ comment_id: "c1", url: "https://h/pr#c1" }));
  const closePR = vi.fn(() => Promise.resolve());
  const hosting = { getPRStatus, commentOnPR, closePR };
  const getPrimaryPlugin = vi.fn(() => (opts.hostingPresent === false ? null : hosting));

  const reaper = createWorkspaceReaper({
    config: { enabled: opts.enabled ?? true, interval_ms: 3_600_000 },
    // Distinguish an explicit null (keep forever) from "not provided" — `?? 0` would swallow the null.
    branchRetentionDays: opts.branchRetentionDays === undefined ? 0 : opts.branchRetentionDays,
    taskEngine: {
      getUnreapedTerminalTasks: getUnreaped,
      getTask,
      updateTaskField,
    } as unknown as WorkspaceReaperDeps["taskEngine"],
    workspaceManager: {
      getWorkspaceRecord,
      cleanupWorkspace,
      deleteRemoteBranch,
    } as unknown as WorkspaceReaperDeps["workspaceManager"],
    registry: { getPrimaryPlugin } as unknown as WorkspaceReaperDeps["registry"],
    dispatchTracker: { isInFlight },
    eventBus: { publish } as unknown as WorkspaceReaperDeps["eventBus"],
    notifications: { notify, syncStateToCommPlugin } as unknown as WorkspaceReaperDeps["notifications"],
    clock,
    observer: createTestObserverFacade("workspace-reaper"),
  });

  // Every sweep now publishes a `system.reap_completed` summary, so "the remote was not touched" is asserted
  // against the specific git.branch_deleted event rather than "publish was never called".
  function branchDeletedPublished(): boolean {
    return publish.mock.calls.some((call) => (call[0] as { type: string }).type === "git.branch_deleted");
  }

  return {
    reaper,
    clock,
    getUnreaped,
    getTask,
    updateTaskField,
    cleanupWorkspace,
    deleteRemoteBranch,
    getWorkspaceRecord,
    isInFlight,
    publish,
    branchDeletedPublished,
    notify,
    syncStateToCommPlugin,
    getPRStatus,
    commentOnPR,
    closePR,
  };
}

/** Whether the reaper posted the cancel courtesy comment on the source ticket (any number of times). */
function cancelComments(notify: ReturnType<typeof vi.fn>): unknown[] {
  return notify.mock.calls
    .map((call) => call[0] as { kind: string; message?: string })
    .filter((n) => n.kind === "ticket_comment" && n.message === "Task cancelled by the owner.");
}

/** A cancelled task, optionally with an open PR (its review.pr_number drives the close-PR arm). */
function cancelledTask(prNumber: number | null = null): Task {
  const review: ReviewState | null =
    prNumber === null
      ? null
      : {
          pr_number: prNumber,
          merged_at: null,
          feedback_rounds: [],
          accommodated_comment_ids: [],
          accommodated_review_state: null,
          consecutive_blocker_reentries: 0,
        };
  return makeTask({ state: TaskStates.cancelled, review });
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
    expect(h.branchDeletedPublished()).toBe(false); // no git.branch_deleted — the remote was not touched
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

describe("workspace reaper — cancelled arm", () => {
  it("closes an open PR (comment then close), then reaps the worktree + branch", async () => {
    const h = makeReaper({ tasks: [cancelledTask(7)] });

    await h.reaper.runOnce();

    expect(h.getPRStatus).toHaveBeenCalledWith("acme/app", 7);
    expect(h.commentOnPR).toHaveBeenCalledWith("acme/app", 7, expect.stringContaining("cancelled"));
    expect(h.closePR).toHaveBeenCalledWith("acme/app", 7);
    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "git.branch_deleted" }));
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
  });

  it("reaps a cancelled task that never opened a PR — no PR calls", async () => {
    const h = makeReaper({ tasks: [cancelledTask(null)] });

    await h.reaper.runOnce();

    expect(h.getPRStatus).not.toHaveBeenCalled();
    expect(h.closePR).not.toHaveBeenCalled();
    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("skips the comment + close when the PR is no longer open, but still reaps", async () => {
    const h = makeReaper({ tasks: [cancelledTask(7)] });
    h.getPRStatus.mockResolvedValue({ state: "merged" });

    await h.reaper.runOnce();

    expect(h.commentOnPR).not.toHaveBeenCalled();
    expect(h.closePR).not.toHaveBeenCalled();
    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("reaps locally and skips the PR + remote when the hosting plugin is absent", async () => {
    const h = makeReaper({ hostingPresent: false, tasks: [cancelledTask(7)] });

    await h.reaper.runOnce();

    expect(h.getPRStatus).not.toHaveBeenCalled();
    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.branchDeletedPublished()).toBe(false); // no git.branch_deleted — the remote was not touched
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
  });

  it("marks a cancelled task reaped with nothing to clean when it has no workspace", async () => {
    const h = makeReaper({ tasks: [cancelledTask(null)] });
    h.getWorkspaceRecord.mockReturnValue(null);

    await h.reaper.runOnce();

    expect(h.cleanupWorkspace).not.toHaveBeenCalled();
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
  });

  it("leaves a cancelled task unreaped when a reap step throws, then completes next sweep (all-or-nothing)", async () => {
    const h = makeReaper({ tasks: [cancelledTask(7)] });
    // Sweep 1: PR closes and the worktree is cleaned, but the remote delete throws (network down).
    h.deleteRemoteBranch.mockImplementationOnce(() => {
      throw new Error("network down");
    });

    await h.reaper.runOnce();
    expect(h.closePR).toHaveBeenCalledWith("acme/app", 7);
    expect(h.updateTaskField).not.toHaveBeenCalled(); // all-or-nothing: not marked reaped
    expect(h.reaper.getLastRun()?.failed).toBe(1);

    // Sweep 2: the remote delete now succeeds, so the reap completes.
    await h.reaper.runOnce();
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
  });
});

describe("workspace reaper — cancel announcement (source-ticket comment + label sync)", () => {
  it("comments on the source ticket and syncs the cancelled label for a queued-cancel (no workspace)", async () => {
    // A task cancelled while still queued never had a workspace — the reaper still announces the cancel.
    const h = makeReaper({ tasks: [cancelledTask(null)] });
    h.getWorkspaceRecord.mockReturnValue(null);

    await h.reaper.runOnce();

    expect(cancelComments(h.notify)).toHaveLength(1);
    expect(h.syncStateToCommPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "t1", to_state: "cancelled" }),
    );
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("comments on the source ticket and syncs the cancelled label for a blocked-cancel (with workspace)", async () => {
    // A task cancelled while blocked has a workspace; the reap reclaims it and the cancel is announced once.
    const h = makeReaper({ tasks: [cancelledTask(7)] });

    await h.reaper.runOnce();

    expect(cancelComments(h.notify)).toHaveLength(1);
    expect(h.syncStateToCommPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "t1", to_state: "cancelled" }),
    );
    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("does not re-comment across sweeps when the reap retries (idempotent first-visit announcement)", async () => {
    // Sweep 1: the remote delete throws, so the task is left unreaped and revisited next sweep — but the
    // courtesy comment must not post again (the comment is not idempotent; the guard fires it exactly once).
    const h = makeReaper({ tasks: [cancelledTask(7)] });
    h.deleteRemoteBranch.mockImplementationOnce(() => {
      throw new Error("network down");
    });

    await h.reaper.runOnce(); // failed reap — announced once
    await h.reaper.runOnce(); // retry succeeds — must not re-announce

    expect(cancelComments(h.notify)).toHaveLength(1);
    expect(h.syncStateToCommPlugin).toHaveBeenCalledTimes(1);
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("isolates the comment from the label sync — a sync that throws still posts the comment and reaps", async () => {
    const h = makeReaper({ tasks: [cancelledTask(null)] });
    h.getWorkspaceRecord.mockReturnValue(null);
    h.syncStateToCommPlugin.mockImplementation(() => {
      throw new Error("comm plugin down");
    });

    await h.reaper.runOnce();

    expect(cancelComments(h.notify)).toHaveLength(1); // the comment still went out
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String)); // the reap still completed
    expect(h.reaper.getLastRun()?.reaped).toBe(1);
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

  it("publishes a durable system.reap_completed summary at the end of every sweep", async () => {
    const h = makeReaper({
      branchRetentionDays: 0,
      tasks: [mergedTask(MERGED_AT), makeTask({ id: "t2", review: null })],
    });

    await h.reaper.runOnce();

    // The cross-process record the dashboard reads — getLastRun() lives in the daemon process only.
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system.reap_completed",
        source: "workspace-reaper",
        task_id: null,
        payload: {
          scanned: 2,
          reaped: 2,
          skipped_in_flight: 0,
          deferred: 0,
          failed: 0,
          duration_ms: expect.any(Number),
        },
      }),
    );
  });

  it("still publishes the sweep summary when a per-task reap failed", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    h.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("network down");
    });

    await h.reaper.runOnce();

    const reapEvent = h.publish.mock.calls
      .map((call) => call[0] as { type: string; payload: Record<string, number> })
      .find((evt) => evt.type === "system.reap_completed");
    expect(reapEvent?.payload).toMatchObject({ scanned: 1, reaped: 0, failed: 1 });
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

describe("workspace reaper — eager reapNow", () => {
  it("deletes a merged branch immediately when retention is 0 (front-running the sweep)", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });

    await h.reaper.reapNow("t1");

    expect(h.cleanupWorkspace).toHaveBeenCalledWith("t1", false);
    expect(h.deleteRemoteBranch).toHaveBeenCalledWith("t1");
    expect(h.branchDeletedPublished()).toBe(true);
    expect(h.updateTaskField).toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("respects retention — defers without deleting when the window has not elapsed", async () => {
    const h = makeReaper({ branchRetentionDays: 7, tasks: [mergedTask(MERGED_AT)] });
    h.clock.set(Date.parse(MERGED_AT) + 7 * MS_PER_DAY - 1);

    await h.reaper.reapNow("t1");

    // The eager path must not bypass a non-zero retention window; the interval sweep deletes it later.
    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).not.toHaveBeenCalled(); // reaped_at stays NULL
  });

  it("no-ops when the task is not found", async () => {
    const h = makeReaper({ tasks: [] });

    await expect(h.reaper.reapNow("missing")).resolves.toBeUndefined();

    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).not.toHaveBeenCalled();
  });

  it("skips a task whose dispatch is still in flight", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    h.isInFlight.mockReturnValue(true);

    await h.reaper.reapNow("t1");

    expect(h.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(h.updateTaskField).not.toHaveBeenCalled();
  });

  it("never throws and leaves the task unreaped when the remote delete fails", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    h.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("remote delete failed (network)");
    });

    await expect(h.reaper.reapNow("t1")).resolves.toBeUndefined();

    // All-or-nothing: reaped_at is not stamped, so the interval sweep retries.
    expect(h.updateTaskField).not.toHaveBeenCalledWith("t1", "reaped_at", expect.any(String));
  });

  it("escalates to an owner alert after repeated eager-reap failures (shared failure streak)", async () => {
    const h = makeReaper({ branchRetentionDays: 0, tasks: [mergedTask(MERGED_AT)] });
    h.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("remote delete failed (network)");
    });

    await h.reaper.reapNow("t1");
    await h.reaper.reapNow("t1");
    await h.reaper.reapNow("t1");

    const alerts = h.notify.mock.calls.map((call) => call[0] as { kind: string }).filter((n) => n.kind === "alert");
    expect(alerts).toHaveLength(1);
  });
});
