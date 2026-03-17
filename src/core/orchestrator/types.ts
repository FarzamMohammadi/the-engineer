import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import type { IActionPipeline } from "../interfaces/action-pipeline.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import type { IObservationStore } from "../observer/types.js";

// ── Shared Dependencies ────────────────────────────────────────────────────

/** Shared dependencies available to all Orchestrator subsystems. */
export interface OrchestratorContext {
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
}

// ── Per-Execution State ────────────────────────────────────────────────────

/** Per-execution state — scoped to a single executeTask() call, not the class. */
export interface PipelineState {
  traceId: string;
  sessionId: string;
  loopbackCount: number;
}

// ── Process Phase Result ───────────────────────────────────────────────────

/** Constant enum for executeTask outcome values. */
export const Outcomes = {
  completed: "completed",
  review_pending: "review_pending",
  decomposed: "decomposed",
  preempted: "preempted",
  error: "error",
} as const;

export type Outcome = (typeof Outcomes)[keyof typeof Outcomes];

/** Discriminated union of executeTask outcomes. */
export type ExecuteTaskResult =
  | { outcome: typeof Outcomes.completed; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: typeof Outcomes.review_pending; phase: Phase; phaseOutputs: Map<Phase, PhaseOutput> }
  | {
      outcome: typeof Outcomes.decomposed;
      childTaskIds: string[];
      phaseOutputs: Map<Phase, PhaseOutput>;
    }
  | { outcome: typeof Outcomes.preempted; lastPhase: Phase; checkpointId: string }
  | { outcome: typeof Outcomes.error; phase: Phase; reason: string };

/** Return type of processPhaseCompletion. */
export interface ProcessPhaseResult {
  phases: Phase[];
  loopbackIndex: number | null;
  preemptionResult: ExecuteTaskResult | null;
  decompositionResult: ExecuteTaskResult | null;
  reviewPendingResult: ExecuteTaskResult | null;
}
