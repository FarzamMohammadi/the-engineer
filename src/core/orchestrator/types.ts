import { z } from "zod";
import type { OrchestratorConfig, SafetyConfig, WorkspaceConfig } from "../../schemas/config.js";
import type { IActionPipeline } from "../interfaces/action-pipeline.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { INotificationRouter } from "../interfaces/notification-router.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import type { SessionMemory } from "../session-memory/index.js";
import type { SkillsManager } from "../skills/index.js";

// ── Shared Dependencies ────────────────────────────────────────────────────

/** Shared dependencies available to the Orchestrator and every pipeline sub-phase. */
export interface OrchestratorContext {
  config: OrchestratorConfig;
  workspaceConfig: WorkspaceConfig;
  /** The owner's live safety policy (autonomy, scope, cost limits, merge, response timeouts). Rendered into
   *  the agent's "how I am actually set up" brief so every phase carries the real settings, not placeholders. */
  safetyConfig: SafetyConfig;
  eventBus: IEventBus;
  registry: IPluginLookup;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  sessionMemory: SessionMemory;
  workspaceManager: IWorkspaceManager;
  skillsManager: SkillsManager;
  peopleDirectory: IPeopleDirectory;
  observer: IObserver;
  notifications: INotificationRouter;
  /** Absolute path to the traces directory (~/.engineer/traces/). Null disables tracing. */
  tracesDir: string | null;
}

// ── Termination ──────────────────────────────────────────────────────────

/** Why a dispatch was forcibly ended, routed by the scheduler to the right terminal/recovery state. */
export const TerminationReasonSchema = z.enum([
  "cooperative_preemption",
  "preemption_timeout",
  "hard_cap_exceeded",
  "cost_limit_reached",
  "graceful_shutdown",
  // The owner cancelled a running task (cross-process flip the daemon detects on its tick). Unlike the
  // others this does NOT route to a recovery state — the DB is already `cancelled`; the handler observes
  // the abort and the reaper does the cleanup.
  "user_cancelled",
]);
export type TerminationReason = z.infer<typeof TerminationReasonSchema>;

/** Constant enum values for TerminationReason. Use instead of raw strings. */
export const TerminationReasons = TerminationReasonSchema.enum;

// ── Execute Outcome ────────────────────────────────────────────────────────

/** Constant enum for executeTask outcome values. */
export const Outcomes = {
  completed: "completed",
  terminated: "terminated",
  blocked: "blocked",
} as const;

export type Outcome = (typeof Outcomes)[keyof typeof Outcomes];

/**
 * The result the daemon's dispatch path consumes. `executeTask` produces `completed` or `blocked`;
 * `terminated` is synthesized by the dispatch-tracker when a run is force-ended. Phases are plain
 * strings — the pipeline owns the phase vocabulary.
 */
export type ExecuteTaskResult =
  | { outcome: typeof Outcomes.completed }
  | {
      outcome: typeof Outcomes.terminated;
      reason: TerminationReason;
      lastPhase: string | null;
      checkpointId: string | null;
    }
  | { outcome: typeof Outcomes.blocked; phase: string; reason: string };
