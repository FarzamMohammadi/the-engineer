/**
 * Integration harness for the new sub-phase pipeline.
 *
 * Wires the runner against REAL collaborators — a real WorkspaceManager (over a real git
 * worktree) and a real SessionMemory (over SQLite) — with only the agent CLI faked. This is
 * the setup the cutover (Session 5) will reproduce, so exercising it here means the cutover
 * only swaps the entry point, not the wiring.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import type { AgentAdapter } from "../../src/adapters/agent.js";
import type { Ctx } from "../../src/core/orchestrator/pipeline/types.js";
import type { SessionMemory } from "../../src/core/session-memory/index.js";
import type { AgentRunRequest, AgentRunResult } from "../../src/schemas/adapters.js";
import { OrchestratorConfigSchema, SafetyConfigSchema, WorkspaceConfigSchema } from "../../src/schemas/config.js";
import { createMockTask } from "./mock-factories.js";
import { type RecordingObserver, createRecordingObserver, fakeAgent } from "./test-mock-pipeline.js";
import { createTestSessionMemory } from "./test-session-memory.js";
import { createTestWorkspaceManager } from "./test-workspace-manager.js";

const AGENT_RESULT: AgentRunResult = { content: "", cost_usd: 0, duration_ms: 1, usage: null };

// ── Fake Agent ───────────────────────────────────────────────────────────────

/** The session-result an agent step writes, in the new handoff shape. */
export interface FakeResult {
  readonly status: "ok" | "needs_human" | "failed";
  readonly summary: string;
  readonly details?: Record<string, unknown>;
}

/**
 * A fake agent that, for each sub-phase, writes the result `respond` returns into the step's
 * `session-result.json`. `respond` receives the phase directory (`requirements`, `execution`,
 * …) and the request, whose `cwd` is the worktree — use it to make real changes a gate sees.
 */
export function newShapeAgent(respond: (phaseDir: string, request: AgentRunRequest) => FakeResult): AgentAdapter {
  return fakeAgent((request) => {
    const target = lastSessionResultPath(request.prompt);
    if (target) {
      const phaseDir = path.basename(path.dirname(target));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(respond(phaseDir, request)), "utf-8");
    }
    return Promise.resolve(AGENT_RESULT);
  });
}

/** The last absolute `…/session-result.json` path mentioned in a prompt — where this step reports. */
function lastSessionResultPath(prompt: string): string | null {
  let last: string | null = null;
  for (const match of prompt.matchAll(/(\/[^\s`'"]+\/session-result\.json)/g)) {
    last = match[1] ?? last;
  }
  return last;
}

// ── Harness ──────────────────────────────────────────────────────────────────

export interface PipelineHarness {
  /** The assembled context to hand to `runPipeline`. */
  readonly ctx: Ctx;
  /** Absolute worktree path the agent and gates operate in. */
  readonly worktreePath: string;
  /** Recording observer — assert the decisions, observations, and logs the runner emitted. */
  readonly observer: RecordingObserver;
  /** Real session memory — its journal and checkpoints are written to a real database. */
  readonly sessionMemory: SessionMemory;
  /** Journal entry summaries persisted by the runner, in order — read from the real database. */
  journalSummaries(): string[];
  /** How many checkpoints the runner persisted. */
  checkpointCount(): number;
  cleanup(): void;
}

/** Options for the pipeline harness. */
export interface PipelineHarnessOptions {
  /** Drive delivery in push-only mode (skip_pr_creation): only `push` runs, the PR sub-phases skip. */
  readonly pushOnly?: boolean;
}

/** Stand up the pipeline over a real worktree and a real session database, driven by `agent`. */
export function createPipelineHarness(agent: AgentAdapter, options: PipelineHarnessOptions = {}): PipelineHarness {
  const workspace = createTestWorkspaceManager();
  const memory = createTestSessionMemory();

  // One task id across session memory and the workspace, so getWorkspaceRecord(ctx.task.id) resolves —
  // create-pr and push read the record by the task's own id.
  const taskId = ulid();
  workspace.setupTask(taskId, { title: "Pipeline integration task" });
  const record = workspace.workspaceManager.createWorkspace(taskId, workspace.repoName, {
    title: "Pipeline integration task",
    thoughtsId: "integration",
  });

  memory.insertTask("Pipeline integration task", taskId);
  const session = memory.sessionMemory.sessions.create({ taskId });
  const observer = createRecordingObserver();

  // Minimal git-hosting stub: in PR mode, create-pr opens a PR through it so the runner can advance
  // past create-pr to await-review. The create-pr unit tests assert its body (composition, rework) in detail.
  const hostingStub = {
    createPR: () => Promise.resolve({ pr_number: 101, url: "https://example.test/pr/101" }),
    dismissApprovals: () => Promise.resolve(undefined),
  };

  const ctx = {
    observer,
    sessionMemory: memory.sessionMemory,
    workspaceManager: workspace.workspaceManager,
    registry: {
      getPrimaryPlugin: (type: string) => (type === "agent" ? agent : type === "git_hosting" ? hostingStub : null),
      getPluginsByType: () => [],
      getPlugin: () => null,
    },
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig: WorkspaceConfigSchema.parse(
      options.pushOnly ? { pr: { skip_pr_creation: { default: true } } } : {},
    ),
    safetyConfig: SafetyConfigSchema.parse({}),
    tracesDir: null,
    // Live-context collaborators the runner and agentStep touch: gate the agent run, record cost, mirror position.
    eventBus: { publish: () => undefined },
    safetyLayer: {},
    actionPipeline: {
      execute: async (input: { executeFn: () => unknown }) => ({
        outcome: "executed",
        result: await input.executeFn(),
      }),
    },
    taskEngine: { updateTaskField: () => undefined, updateTracking: () => undefined },
    skillsManager: { getDir: () => path.join(workspace.workspaceRoot, "skills") },
    peopleDirectory: {
      getAll: () => [],
      getPerson: () => null,
      getByRole: () => [],
      getOwner: () => null,
      getReviewers: () => [],
      resolveContact: () => null,
    },
    notifications: { notify: () => undefined },
    task: createMockTask({ id: taskId, title: "Pipeline integration task", description: "Integration test task" }),
    sessionId: session.id,
    traceId: "trace-integration",
    worktreePath: record.worktreePath,
    thoughtsDir: record.thoughtsDir,
  } as unknown as Ctx;

  const journalStmt = memory.db.prepare("SELECT summary FROM journal_entries ORDER BY rowid");
  const checkpointStmt = memory.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE task_id = ?");

  return {
    ctx,
    worktreePath: record.worktreePath,
    observer,
    sessionMemory: memory.sessionMemory,
    journalSummaries: () => (journalStmt.all() as { summary: string }[]).map((row) => row.summary),
    checkpointCount: () => (checkpointStmt.get(taskId) as { n: number }).n,
    cleanup: () => {
      workspace.cleanup();
      memory.cleanup();
    },
  };
}
