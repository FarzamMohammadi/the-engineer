import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { WorkspaceReaperConfig } from "../../schemas/config.js";
import { EventTypes, GitBranchDeletedPayloadSchema } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { type Task, TaskStates } from "../../schemas/task.js";
import type { Clock } from "../../utils/clock.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { DispatchTracker } from "../dispatch-tracker/index.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { INotificationRouter } from "../interfaces/notification-router.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager, WorkspaceRecord } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Event Declarations ────────────────────────────────────────────────────────

/** Events published by the workspace reaper. (Moved from the orchestrator: the reaper is the sole branch deleter.) */
export const EVENTS: EventDeclaration[] = [
  {
    type: EventTypes["git.branch_deleted"],
    description: "Emitted when the reaper deletes a merged task's branch after its retention window elapses",
    payloadSchema: GitBranchDeletedPayloadSchema,
    publishers: ["workspace-reaper"],
    subscribers: [],
  },
];

// ── Constants ──────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Consecutive per-task reap failures before escalating to an owner alert (mirrors the plugin failure threshold). */
const REAP_FAILURE_ALERT_THRESHOLD = 3;

// ── Types ────────────────────────────────────────────────────────────────────

/** How a single task's reconciliation resolved. */
type ReapOutcome =
  | "reaped" // fully reconciled — reaped_at stamped
  | "deferred" // intentionally not reaped this sweep (merged but inside retention, or an arm not yet built) — no error
  | "failed"; // a reap step threw — reaped_at left NULL, retried next sweep

/** Summary of one reconciliation sweep — the owner-inspectable record (mirrors data-lifecycle's CleanupStats). */
export interface ReapStats {
  timestamp: string;
  /** Unreaped terminal tasks examined this sweep. */
  scanned: number;
  /** Fully reconciled (reaped_at stamped). */
  reaped: number;
  /** Not reaped — a dispatch is in flight (never reap a workspace out from under a running agent). */
  skippedInFlight: number;
  /** Not reaped this sweep for a non-error reason (inside the retention window, or an arm not yet built). */
  deferred: number;
  /** Reap attempted and threw — reaped_at left NULL, retried next sweep. */
  failed: number;
  durationMs: number;
}

export interface WorkspaceReaper {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
  getLastRun(): ReapStats | null;
}

export interface WorkspaceReaperDeps {
  config: WorkspaceReaperConfig;
  /** Merged-branch retention: null = keep forever, 0 = delete next sweep, N = delete N days after merge. */
  branchRetentionDays: number | null;
  taskEngine: ITaskEngine;
  workspaceManager: IWorkspaceManager;
  registry: IPluginLookup;
  /** The reaper never reaps a workspace while its dispatch is in flight. */
  dispatchTracker: Pick<DispatchTracker, "isInFlight">;
  eventBus: IEventBus;
  notifications: INotificationRouter;
  clock: Clock;
  observer: IObserver;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * The workspace reaper — a daemon-resident reconciliation service that owns the terminal-task cleanup
 * that cannot happen inline: deleting merged branches once their retention window elapses. It mirrors
 * data-lifecycle's shape ({ start, stop, runOnce, getLastRun }, injected clock, a setInterval loop), but
 * does fallible git + plugin (network) work rather than pure local DB cleanup, so it owns a real failure
 * envelope: a re-entrancy guard, per-task isolation, all-or-nothing `reaped_at`, and a consecutive-failure
 * counter that escalates to an alert.
 *
 * Built inside `createDaemon` because it needs the dispatch-tracker. The cancelled-task arm (close the open
 * PR, then reap) lands in a later session; this builds the completed (merged + push-only) arms.
 */
export function createWorkspaceReaper(deps: WorkspaceReaperDeps): WorkspaceReaper {
  const { config, branchRetentionDays, taskEngine, workspaceManager, registry, dispatchTracker } = deps;
  const { eventBus, notifications, clock, observer } = deps;

  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastRun: ReapStats | null = null;
  /** Per-task consecutive reap-failure counts (in-memory; resets on restart, where the task is simply re-attempted). */
  const consecutiveFailures = new Map<string, number>();

  // ── Reconciliation Sweep ──────────────────────────────────────────────────

  async function runOnce(): Promise<void> {
    if (running) {
      // The reaper's per-task network ops make overlap likelier than data-lifecycle's DB deletes, so guard it.
      observer.debug("Reaper sweep already in progress — skipping this tick");
      return;
    }
    running = true;
    const startMs = clock.now();
    const stats: ReapStats = {
      timestamp: "",
      scanned: 0,
      reaped: 0,
      skippedInFlight: 0,
      deferred: 0,
      failed: 0,
      durationMs: 0,
    };

    try {
      const tasks = taskEngine.getUnreapedTerminalTasks();
      for (const task of tasks) {
        stats.scanned++;
        if (dispatchTracker.isInFlight(task.id)) {
          stats.skippedInFlight++;
          continue;
        }
        applyOutcome(task.id, await reapTask(task), stats);
      }
    } finally {
      stats.durationMs = clock.now() - startMs;
      stats.timestamp = new Date(clock.now()).toISOString();
      lastRun = stats;
      running = false;
      observer.info("Reaper sweep complete", {
        scanned: stats.scanned,
        reaped: stats.reaped,
        skippedInFlight: stats.skippedInFlight,
        deferred: stats.deferred,
        failed: stats.failed,
        durationMs: stats.durationMs,
      });
    }
  }

  /** Fold one task's outcome into the running stats, updating the failure counter and escalating at the threshold. */
  function applyOutcome(taskId: string, outcome: ReapOutcome, stats: ReapStats): void {
    if (outcome === "reaped") {
      stats.reaped++;
      consecutiveFailures.delete(taskId);
      return;
    }
    if (outcome === "deferred") {
      stats.deferred++;
      return;
    }
    stats.failed++;
    const count = (consecutiveFailures.get(taskId) ?? 0) + 1;
    consecutiveFailures.set(taskId, count);
    // Escalate exactly once at the crossing (not every sweep) — the absence of git.branch_deleted is not an alert,
    // but a persistently-failing reap (revoked token, branch protection) is the silent-rot scenario the alert closes.
    if (count === REAP_FAILURE_ALERT_THRESHOLD) {
      notifications.notify({
        kind: NotificationKinds.alert,
        taskId,
        message: `The workspace reaper has failed to clean up task ${taskId} ${String(count)} times in a row. Its branch may be orphaned — check the git hosting plugin (token, branch protection).`,
      });
    }
  }

  // ── Per-Task Reconciliation ────────────────────────────────────────────────

  // biome-ignore lint/suspicious/useAwait: the async boundary is the contract — the cancelled arm added in a later session awaits hosting.closePR. Synchronous today.
  async function reapTask(task: Task): Promise<ReapOutcome> {
    if (task.state === TaskStates.cancelled) {
      // The cancelled arm (comment + close the open PR, then reap) lands in a later session. No cancelled
      // tasks exist until cancel is user-reachable, so this seam is dormant; leave a stray one for later.
      observer.debug("Cancelled-task reaping is built in a later session — deferring", { taskId: task.id });
      return "deferred";
    }

    // Completed task. Push-only when no merge was recorded: the pushed branch IS the deliverable, so keep it.
    // The worktree was already removed inline at completion, so there is nothing to reap — just mark it.
    const mergedAt = task.review?.merged_at ?? null;
    if (mergedAt === null) {
      markReaped(task.id);
      observer.debug("Push-only task — branch preserved, marked reaped", { taskId: task.id });
      return "reaped";
    }

    return reapMergedBranch(task, mergedAt);
  }

  /** A merged task: delete the branch once retention elapses; null retention keeps it forever (still marked reaped). */
  function reapMergedBranch(task: Task, mergedAt: string): ReapOutcome {
    if (branchRetentionDays === null) {
      // Keep the branch forever — no branch work to do, so mark reaped to stop reconsidering it each sweep.
      markReaped(task.id);
      observer.debug("Merged branch kept (retention=null) — marked reaped", { taskId: task.id });
      return "reaped";
    }

    const mergedMs = Date.parse(mergedAt);
    if (Number.isNaN(mergedMs)) {
      // A corrupt merged_at would otherwise read as "infinitely old" and delete the branch — fail loud instead.
      observer.warn("Merged task has an unparseable merged_at — leaving unreaped", { taskId: task.id, mergedAt });
      return "failed";
    }

    // Boundary is inclusive: at exactly N days the branch reaps (>=). 0 → always due (delete this sweep).
    const elapsedMs = clock.now() - mergedMs;
    if (elapsedMs < branchRetentionDays * MS_PER_DAY) {
      observer.debug("Merged branch still within its retention window — deferring", {
        taskId: task.id,
        elapsedMs,
        retentionDays: branchRetentionDays,
      });
      return "deferred";
    }

    return deleteMergedBranch(task);
  }

  /**
   * Delete a due merged branch — local (worktree backstop + local branch) then remote — all-or-nothing:
   * `reaped_at` is stamped only after every applicable step succeeds. A partial failure (the local delete
   * lands, the remote throws) leaves reaped_at NULL so the next sweep retries; the branch is never orphaned.
   */
  function deleteMergedBranch(task: Task): ReapOutcome {
    const record = workspaceManager.getWorkspaceRecord(task.id);
    if (!record) {
      // No workspace on record — nothing to delete. Mark reconciled.
      markReaped(task.id);
      return "reaped";
    }

    try {
      // Local first (cheap, reliable, idempotent), then the remote (network, fallible).
      workspaceManager.cleanupWorkspace(task.id, false);

      const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
      if (hosting) {
        workspaceManager.deleteRemoteBranch(task.id);
        emitBranchDeleted(task.id, record);
      } else {
        // Graceful degradation (§15): no plugin to reach the remote — reap locally, log the reduced capability.
        observer.warn("Git hosting plugin absent — deleted the local branch only; the remote branch remains", {
          taskId: task.id,
          branch: record.branch,
        });
      }

      markReaped(task.id);
      return "reaped";
    } catch (error) {
      // Per-task isolation: one task's failure is non-fatal to the sweep, and reaped_at stays NULL so it retries.
      observer.warn("Reap failed — leaving the task unreaped to retry next sweep", {
        taskId: task.id,
        branch: record.branch,
        error: sanitizeErrorMessage(error),
      });
      return "failed";
    }
  }

  /** Stamp the all-or-nothing reconciliation marker using the injected clock (testable retention math). */
  function markReaped(taskId: string): void {
    taskEngine.updateTaskField(taskId, "reaped_at", new Date(clock.now()).toISOString());
  }

  function emitBranchDeleted(taskId: string, record: WorkspaceRecord): void {
    eventBus.publish({
      type: EventTypes["git.branch_deleted"],
      source: "workspace-reaper",
      task_id: taskId,
      payload: { task_id: taskId, repo: record.repo, branch: record.branch },
    } satisfies PublishInput<"git.branch_deleted">);
    observer.info("Reaped merged branch", { taskId, branch: record.branch });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function start(): void {
    if (!config.enabled || interval) {
      return;
    }
    observer.info("Workspace reaper started", { intervalMs: config.interval_ms });
    interval = setInterval(() => {
      runOnce().catch((err: unknown) => {
        observer.error("Reaper sweep failed", { error: sanitizeErrorMessage(err) });
      });
    }, config.interval_ms);
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
      observer.debug("Workspace reaper stopped");
    }
  }

  function getLastRun(): ReapStats | null {
    return lastRun;
  }

  return { start, stop, runOnce, getLastRun };
}
