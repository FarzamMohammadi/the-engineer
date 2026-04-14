import type { DaemonConfig } from "../../schemas/config.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import type { Registry } from "../registry/index.js";

// ── Evaluation Snapshot ─────────────────────────────────────��─────────────────

/** All data captured from a completed task, frozen before worktree cleanup. */
export interface EvaluationSnapshot {
  taskId: string;
  taskTitle: string;
  taskDescription: string | null;
  repo: string;
  branch: string;
  baseBranch: string;
  gitDiff: string;
  commitLog: string;
  /** Map of relative path → file content for all thoughts .md files. */
  thoughtsFiles: Map<string, string>;
  evaluationDir: string;
  /** Bare clone dir path (survives worktree cleanup). */
  bareCloneDir: string;
  snapshotTimestamp: string;
}

// ── Evaluation Manager Context ────────────────────────────────────────────────

/** Narrowed daemon context for the evaluation subsystem. */
export interface EvaluationManagerContext {
  config: DaemonConfig;
  registry: Registry;
  taskEngine: ITaskEngine;
  workspaceManager: IWorkspaceManager;
  eventBus: IEventBus;
  observer: IObserver;
  engineerHome: string;
}

// ── Evaluation Manager Interface ──────────────────────────────────────────────

export interface EvaluationManager {
  /** Trigger evaluation for a completed task. Fire-and-forget. */
  triggerEvaluation(taskId: string, worktreePath: string, thoughtsDir: string): void;
  /** Wait for all active evaluations to finish (with timeout). Called during shutdown. */
  drainForShutdown(timeoutMs: number): Promise<void>;
  /** Number of active evaluations. */
  getActiveCount(): number;
}
