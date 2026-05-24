import type { OrchestratorConfig, WorkspaceConfig } from "../../schemas/config.js";
import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import type { IActionPipeline } from "../interfaces/action-pipeline.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { INotificationRouter } from "../interfaces/notification-router.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import type { IObservationStore } from "../observer/types.js";
import type { RepoContext } from "./prompts/index.js";

// ── Shared Dependencies ────────────────────────────────────────────────────

/** Shared dependencies available to all Orchestrator subsystems. */
export interface OrchestratorContext {
  config: OrchestratorConfig;
  workspaceConfig: WorkspaceConfig;
  eventBus: IEventBus;
  registry: IPluginLookup;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  sessionMemory: ISessionMemory;
  workspaceManager: IWorkspaceManager;
  peopleDirectory: IPeopleDirectory;
  observationStore: IObservationStore | null;
  observer: IObserver;
  notifications: INotificationRouter;
  /** Absolute path to the traces directory (~/.engineer/traces/).
   *  Used by llm-caller to write structured session trace files. Null disables tracing. */
  tracesDir: string | null;
}

// ── Preemption Gate ──────────────────────────────────────────────────────

/** Cooperative preemption state container (Protocol P8). Read-only view for the phase runner. */
export interface PreemptionGate {
  /** Check if preemption has been requested for a specific task. */
  isRequested(taskId: string): boolean;
  /** Get the preemption payload for a specific task, or null. */
  getPayload(taskId: string): { target_task_id: string; preempting_task_id: string } | null;
  /** Reset preemption state for a specific task after handling. */
  reset(taskId: string): void;
}

/** Writable preemption gate — extends PreemptionGate with the ability to request preemption. */
export interface WritablePreemptionGate extends PreemptionGate {
  /** Signal that a preemption has been requested (called from EventBus subscription). */
  request(payload: { target_task_id: string; preempting_task_id: string }): void;
}

// ── Per-Execution State ────────────────────────────────────────────────────

/** Per-execution state — scoped to a single executeTask() call, not the class. */
export interface PipelineState {
  traceId: string;
  sessionId: string;
  loopbackCount: number;
  /** How many times we've looped between requirements ↔ research. */
  requirementsLoopCount: number;
  /** Path to the task's thoughts directory (e.g., "thoughts/2026-03-22-issue-42"). */
  thoughtsDir: string | null;
  /** Cached repo context — gathered once at task start, refreshed after execution phase. */
  repoContext: RepoContext | null;
  /** Phase that invoked requirements_gathering fallback — return here after requirements complete. */
  returnToPhase: Phase | null;
  /** Monotonically increasing counter for phase execution order (including loopbacks).
   *  Used to generate structured session trace directory names (e.g. "01-requirements-gathering/"). */
  phaseSequence: number;
}

// ── Phase Completion Outcome ──────────────────────────────────────────────

/** Constant enum for executeTask outcome values. */
export const Outcomes = {
  completed: "completed",
  review_pending: "review_pending",
  preempted: "preempted",
  blocked: "blocked",
  error: "error",
} as const;

export type Outcome = (typeof Outcomes)[keyof typeof Outcomes];

/** Discriminated union of executeTask outcomes. */
export type ExecuteTaskResult =
  | { outcome: typeof Outcomes.completed; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: typeof Outcomes.review_pending; phase: Phase; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: typeof Outcomes.preempted; lastPhase: Phase; checkpointId: string }
  | { outcome: typeof Outcomes.blocked; phase: Phase; reason: string }
  | { outcome: typeof Outcomes.error; phase: Phase; reason: string };

// ── Pipeline Constants ───────────────────────────────────────────────────

/** The standard 7-phase pipeline sequence. */
export const PHASE_SEQUENCE: Phase[] = [
  Phases.requirements_gathering,
  Phases.research,
  Phases.planning,
  Phases.execution,
  Phases.self_review,
  Phases.demo_prep,
  Phases.integration,
];

/** Build the phase sequence, optionally skipping research for trivial tasks. */
export function buildPhaseSequence(skipResearch: boolean): Phase[] {
  return skipResearch ? PHASE_SEQUENCE.filter((p) => p !== Phases.research) : [...PHASE_SEQUENCE];
}
