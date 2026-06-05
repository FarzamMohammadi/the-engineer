import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { WorkspaceReaperConfig } from "../../schemas/config.js";
import { EventTypes, GitBranchDeletedPayloadSchema, SystemReapCompletedPayloadSchema } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { ObservationTypes } from "../../schemas/observer.js";
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
    description:
      "Emitted when the reaper deletes a task's branch — a merged task's once its retention window elapses, or a cancelled task's on reap",
    payloadSchema: GitBranchDeletedPayloadSchema,
    publishers: ["workspace-reaper"],
    subscribers: [],
  },
  {
    type: EventTypes["system.reap_completed"],
    description:
      "Emitted at the end of each reconciliation sweep — the durable, cross-process record the dashboard reads to surface recent cleanup (the in-memory getLastRun() is unreachable from the dashboard's separate process)",
    payloadSchema: SystemReapCompletedPayloadSchema,
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
  | "deferred" // intentionally not reaped this sweep (a merged branch still inside its retention window) — no error
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
  /** Not reaped this sweep for a non-error reason (a merged branch still inside its retention window). */
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
 * Built inside `createDaemon` because it needs the dispatch-tracker. It reconciles every terminal arm:
 * completed (merged branch deleted per retention, push-only branch kept) and cancelled (close an open PR,
 * then reap the abandoned branch).
 */
export function createWorkspaceReaper(deps: WorkspaceReaperDeps): WorkspaceReaper {
  const { config, branchRetentionDays, taskEngine, workspaceManager, registry, dispatchTracker } = deps;
  const { eventBus, notifications, clock, observer } = deps;

  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastRun: ReapStats | null = null;
  /** Per-task consecutive reap-failure counts (in-memory; resets on restart, where the task is simply re-attempted). */
  const consecutiveFailures = new Map<string, number>();
  /**
   * Task IDs whose cancel has already been announced (source-ticket comment + label sync). The cancel reap
   * is all-or-nothing: a failed PR-close leaves `reaped_at` NULL and the task is revisited next sweep, but the
   * comment is NOT idempotent (it would post again every sweep). This first-visit guard fires the announcement
   * exactly once per task while it remains unreaped; the entry is cleared on a successful reap. In-memory like
   * `consecutiveFailures` — a restart can re-announce once, which is acceptable for a best-effort, single-user
   * courtesy comment.
   */
  const cancelAnnounced = new Set<string>();

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
      publishSweepCompleted(stats);
    }
  }

  /**
   * Publish the durable per-sweep record (mirrors data-lifecycle's `system.cleanup_completed`). The reaper's
   * in-memory `getLastRun()` is unreachable from the dashboard's separate process, so this event is the only
   * cross-process path to the sweep summary. Fire-and-forget: the sweep already completed, so a publish
   * failure is logged and swallowed rather than allowed to surface as a sweep failure.
   */
  function publishSweepCompleted(stats: ReapStats): void {
    try {
      eventBus.publish({
        type: EventTypes["system.reap_completed"],
        source: "workspace-reaper",
        task_id: null,
        payload: {
          scanned: stats.scanned,
          reaped: stats.reaped,
          skipped_in_flight: stats.skippedInFlight,
          deferred: stats.deferred,
          failed: stats.failed,
          duration_ms: stats.durationMs,
        },
      } satisfies PublishInput<"system.reap_completed">);
    } catch (err) {
      observer.warn("Failed to publish reap-completed event", { error: sanitizeErrorMessage(err) });
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

  async function reapTask(task: Task): Promise<ReapOutcome> {
    if (task.state === TaskStates.cancelled) {
      return await reapCancelledTask(task);
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

  /**
   * A cancelled task: abandon the work. If an open PR exists, comment on it and close it (no orphaned PR left
   * pointing at a deleted branch); then reap the worktree + local branch and the remote — all-or-nothing, so
   * `reaped_at` is stamped only after every applicable step succeeds (a partial failure retries next sweep).
   * Cancel always reaps the branch (abandoned work), unlike a merged branch's retention or a push-only deliverable.
   */
  async function reapCancelledTask(task: Task): Promise<ReapOutcome> {
    // The reaper is the single emitter for the cancel courtesy comment + label, covering EVERY cancel path —
    // including the queued/blocked cancels that are raw DB writes emitting no `task.state_changed`, so the
    // daemon's state-sync subscription never fires for them and `engineer:cancelled` would otherwise never be
    // applied (cancelled is terminal, so it never self-corrects). Announce before any reap step or early
    // return, gated to fire once per task.
    announceCancel(task);

    const record = workspaceManager.getWorkspaceRecord(task.id);
    if (!record) {
      // Cancelled before a workspace ever existed (e.g. while still queued) — nothing to reap.
      cancelAnnounced.delete(task.id);
      markReaped(task.id);
      observer.debug("Cancelled task has no workspace — nothing to reap, marked reaped", { taskId: task.id });
      return "reaped";
    }

    try {
      const hosting = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
      const prNumber = task.review?.pr_number ?? null;
      if (hosting && prNumber !== null) {
        await closeOpenPr(hosting, record.repo, prNumber, task.id);
      }

      // Local first (cheap, reliable, idempotent), then the remote (network, fallible).
      workspaceManager.cleanupWorkspace(task.id, false);
      if (hosting) {
        workspaceManager.deleteRemoteBranch(task.id);
        emitBranchDeleted(task.id, record);
      } else {
        // Graceful degradation (§15): no plugin to reach the remote — reaped locally, log the reduced capability.
        observer.warn("Git hosting plugin absent — deleted the local branch only; the remote branch remains", {
          taskId: task.id,
          branch: record.branch,
        });
      }

      cancelAnnounced.delete(task.id);
      markReaped(task.id);
      observer.info("Reaped cancelled task", { taskId: task.id, branch: record.branch });
      return "reaped";
    } catch (error) {
      // Per-task isolation: one task's failure is non-fatal to the sweep, and reaped_at stays NULL so it retries.
      observer.warn("Cancelled-task reap failed — leaving unreaped to retry next sweep", {
        taskId: task.id,
        branch: record.branch,
        error: sanitizeErrorMessage(error),
      });
      return "failed";
    }
  }

  /**
   * Announce a cancel on the source ticket exactly once: a courtesy comment plus the `engineer:cancelled`
   * label sync. Both are best-effort and isolated — each runs in its own try/catch so one failing does not
   * skip the other, and neither blocks the reap (a thrown failure here must never leave `reaped_at` NULL).
   * Called for every cancel path, the reaper being the single emitter (the active-cancel comment was removed
   * from the task-scheduler). The label sync is a direct call, not a synthetic `task.state_changed`, so it
   * does not wake the daemon's other state-change subscribers (e.g. the cost-tracker); `diffStateLabels` is
   * dynamic, so `engineer:cancelled` applies with no label-set change. Idempotent via `cancelAnnounced`.
   */
  function announceCancel(task: Task): void {
    if (cancelAnnounced.has(task.id)) {
      return;
    }
    cancelAnnounced.add(task.id);

    let commented = false;
    try {
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId: task.id,
        message: "Task cancelled by the owner.",
      });
      commented = true;
    } catch (error) {
      observer.warn("Failed to comment the cancel on the source ticket — continuing the reap", {
        taskId: task.id,
        error: sanitizeErrorMessage(error),
      });
    }

    let syncedLabel = false;
    try {
      // The task is already `cancelled` in the DB; the prior state is not on the task row, and the label diff
      // ignores `from_state` anyway (it derives the target label from `to_state`), so reconcile from cancelled.
      notifications.syncStateToCommPlugin({
        task_id: task.id,
        from_state: TaskStates.cancelled,
        from_sub: null,
        to_state: TaskStates.cancelled,
        to_sub: null,
        reason: "reaper_cancel_reconciliation",
        triggered_by: "workspace-reaper",
      });
      syncedLabel = true;
    } catch (error) {
      observer.warn("Failed to sync the cancelled label to the comm plugin — continuing the reap", {
        taskId: task.id,
        error: sanitizeErrorMessage(error),
      });
    }

    // Make the cross-process cancel visible to the dashboard: this label + comment appeared because the reaper
    // reconciled a cancel that bypassed the state machine (a raw DB write, so no `task.state_changed` fired).
    // `commented`/`synced_label` record whether each dispatch was issued — actual delivery is observable on the
    // notification-router's own `notification_delivered`/`notification_send_failed` observations.
    try {
      observer.observe(
        ObservationTypes.state_transition,
        "cancel_reconciled",
        {
          to_state: TaskStates.cancelled,
          reason: "reaper_cancel_reconciliation",
          // Why this fired: a cross-process cancel (raw DB write) emitted no task.state_changed, so the comm
          // plugin's state label is stale; the reaper reconciles it and posts the courtesy comment.
          trigger: "cross_process_cancel",
          synced_label: syncedLabel,
          commented,
        },
        { task_id: task.id, level: "info" },
      );
    } catch (error) {
      observer.warn("Failed to record the cancel-reconciliation observation", {
        taskId: task.id,
        error: sanitizeErrorMessage(error),
      });
    }
  }

  /** Comment on and close a cancelled task's PR if it is still open — skip an already-closed/merged PR (idempotent). */
  async function closeOpenPr(
    hosting: GitHostingAdapter,
    repo: string,
    prNumber: number,
    taskId: string,
  ): Promise<void> {
    const status = await hosting.getPRStatus(repo, prNumber);
    if (status.state !== "open") {
      observer.debug("Cancelled task's PR is not open — skipping the close", { taskId, prNumber, state: status.state });
      return;
    }
    await hosting.commentOnPR(repo, prNumber, "This task was cancelled by the owner; closing the pull request.");
    await hosting.closePR(repo, prNumber);
    observer.info("Closed the PR of a cancelled task", { taskId, prNumber });
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
    // Neutral wording — both the merged arm and the cancelled arm publish through here.
    observer.info("Deleted branch", { taskId, branch: record.branch });
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
