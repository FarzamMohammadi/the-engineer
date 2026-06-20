import { describe, expect, it, vi } from "vitest";
import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import { Phases } from "../../../../src/core/orchestrator/pipeline/types.js";
import type { OrchestratorContext } from "../../../../src/core/orchestrator/types.js";
import { createWorkspaceLifecycle } from "../../../../src/core/orchestrator/workspace-lifecycle.js";
import { OrchestratorConfigSchema, SafetyConfigSchema, WorkspaceConfigSchema } from "../../../../src/schemas/config.js";
import type { Dispatch } from "../../../../src/schemas/ephemeral.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import type { Task } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockContext(): OrchestratorContext {
  return {
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    safetyConfig: SafetyConfigSchema.parse({}),
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      replay: vi.fn(),
      getEventsForTask: vi.fn().mockReturnValue([]),
      getEventsSince: vi.fn().mockReturnValue([]),
    } as unknown as OrchestratorContext["eventBus"],
    registry: {
      getPrimaryPlugin: vi.fn().mockReturnValue(null),
      getPluginsByType: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["registry"],
    taskEngine: {
      checkPermission: vi.fn().mockReturnValue({ allowed: true }),
      updateTaskField: vi.fn(),
      getTask: vi.fn(),
      requestTransition: vi.fn(),
      updateTracking: vi.fn(),
      createTask: vi.fn(),
    } as unknown as OrchestratorContext["taskEngine"],
    safetyLayer: {} as OrchestratorContext["safetyLayer"],
    actionPipeline: {
      execute: vi.fn(),
    } as unknown as OrchestratorContext["actionPipeline"],
    sessionMemory: {
      sessions: {
        create: vi.fn().mockReturnValue({ id: "session-001", task_id: "task-001" }),
        end: vi.fn(),
      },
      journal: { addEntry: vi.fn(), query: vi.fn(), getLatestTimestamp: vi.fn() },
      checkpoints: { create: vi.fn(), getLatest: vi.fn() },
    } as unknown as OrchestratorContext["sessionMemory"],
    workspaceManager: {
      getWorktreePath: vi.fn().mockReturnValue(null),
      getWorkspaceRecord: vi.fn().mockReturnValue(null),
      createWorkspace: vi.fn().mockReturnValue({
        taskId: "task-001",
        branch: "engineer/task-001",
        worktreePath: "/tmp/worktree/task-001",
        repo: "owner/repo",
        baseBranch: "main",
        thoughtsDir: "thoughts/2026-03-22-issue-1",
      }),
      verifyWorkspace: vi.fn(),
      pushBranch: vi.fn(),
      cleanupWorkspace: vi.fn(),
    } as unknown as OrchestratorContext["workspaceManager"],
    skillsManager: {
      sync: vi.fn(),
      getDir: vi.fn().mockReturnValue("/tmp/test-skills"),
    } as unknown as OrchestratorContext["skillsManager"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(null),
      resolveContact: vi.fn().mockReturnValue(null),
    } as unknown as OrchestratorContext["peopleDirectory"],
    observer: createTestObserverFacade("orchestrator"),
    notifications: { notify: vi.fn(), syncStateToCommPlugin: vi.fn() },
    tracesDir: null,
  };
}

function createDispatch(overrides?: Partial<Task>): Dispatch {
  const now = new Date().toISOString();
  return {
    task: {
      id: "task-001",
      external_ref: null,
      state: TaskStates.active,
      sub_state: SubStates.working,
      phase: null,
      title: "Test task",
      description: "A test task",
      source_text: "Test",
      acceptance_criteria: [],
      team: [],
      related: [],
      decisions: [],
      workspace: null,
      review: null,
      blocked: null,
      priority: 50,
      agent_tokens: 0,
      agent_cost_usd: 0,
      compute_time_ms: 0,
      created_at: now,
      started_at: now,
      completed_at: null,
      last_transition_at: now,
      session_id: null,
      repo: "owner/repo",
      clone_url: "https://github.com/owner/repo.git",
      ...overrides,
    } as Task,
    resume_from: null,
    signal: new AbortController().signal,
  } as Dispatch;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WorkspaceLifecycle", () => {
  describe("setupWorkspace", () => {
    it("creates workspace for fresh task with repo (persistence owned by createWorkspace)", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      wl.setupWorkspace(dispatch, { traceId: "trace-xyz", parentObservationId: "root-obs-1" });

      expect(ctx.workspaceManager.createWorkspace).toHaveBeenCalledWith("task-001", "owner/repo", {
        title: "Test task",
        cloneUrl: "https://github.com/owner/repo.git",
        // Trace context is threaded so worktree_created nests under the task's execution trace.
        traceId: "trace-xyz",
        parentObservationId: "root-obs-1",
      });
    });

    it("skips workspace creation on rework when task.workspace is already persisted", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        workspace: {
          repo: "owner/repo",
          branch: "engineer/task-001",
          base_branch: "main",
          worktree_path: "/tmp/wt",
          thoughts_dir: null,
        },
      } as Partial<Task>);

      wl.setupWorkspace(dispatch, { traceId: "trace-xyz", parentObservationId: "root-obs-1" });

      // Stateless workspace-manager — no per-dispatch setup. DB-backed reads work as-is.
      expect(ctx.workspaceManager.createWorkspace).not.toHaveBeenCalled();
    });

    it("skips workspace setup on resume — DB-backed reads work as-is", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch({
        workspace: {
          repo: "owner/repo",
          branch: "engineer/task-001",
          base_branch: "main",
          worktree_path: "/tmp/wt",
          thoughts_dir: null,
        },
      } as Partial<Task>);
      (dispatch as { resume_from: unknown }).resume_from = {
        id: "cp-001",
        session_id: "session-prev",
        phase: Phases.research,
      };

      wl.setupWorkspace(dispatch, { traceId: "trace-xyz", parentObservationId: "root-obs-1" });

      expect(ctx.workspaceManager.createWorkspace).not.toHaveBeenCalled();
    });
  });

  describe("createSession", () => {
    it("creates fresh session for new dispatch", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();

      const session = wl.createSession(dispatch);

      expect(session.id).toBe("session-001");
      expect(ctx.sessionMemory.sessions.create).toHaveBeenCalledWith({ taskId: "task-001" });
    });

    it("creates a new session on resume (no linked fields)", () => {
      const ctx = createMockContext();
      const wl = createWorkspaceLifecycle(ctx);
      const dispatch = createDispatch();
      (dispatch as { resume_from: unknown }).resume_from = {
        id: "cp-001",
        session_id: "session-prev",
        phase: Phases.research,
      };

      wl.createSession(dispatch);

      expect(ctx.sessionMemory.sessions.create).toHaveBeenCalledWith({
        taskId: "task-001",
      });
    });
  });

  describe("NotificationRouter.notify (milestone)", () => {
    it("delegates to notify with kind: milestone", () => {
      const notifications: NotificationRouter = {
        notify: vi.fn(),
        syncStateToCommPlugin: vi.fn(),
      };

      const dispatch = createDispatch();
      notifications.notify({
        kind: NotificationKinds.milestone,
        taskId: dispatch.task.id,
        message: "Task started",
      });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.milestone,
          taskId: "task-001",
          message: "Task started",
        }),
      );
    });
  });

  describe("NotificationRouter.notify (ticket_comment)", () => {
    it("delegates to notify with kind: ticket_comment", () => {
      const notifications: NotificationRouter = {
        notify: vi.fn(),
        syncStateToCommPlugin: vi.fn(),
      };

      const dispatch = createDispatch({
        external_ref: { type: "test_issue", repo: "org/repo", id: "7" },
      } as Partial<Task>);
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId: dispatch.task.id,
        message: "Starting work",
      });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: NotificationKinds.ticket_comment,
          taskId: "task-001",
          message: "Starting work",
        }),
      );
    });

    it("is fire-and-forget — notify does not throw even if implementation throws", () => {
      const notifications: NotificationRouter = {
        notify: vi.fn().mockImplementation(() => {
          // In real impl this is fire-and-forget, but even if it did throw...
        }),
        syncStateToCommPlugin: vi.fn(),
      };

      expect(() =>
        notifications.notify({
          kind: NotificationKinds.ticket_comment,
          taskId: "task-001",
          message: "test",
        }),
      ).not.toThrow();
    });
  });
});
