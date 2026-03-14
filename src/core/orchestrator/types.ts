import type { Phase, PhaseOutput } from "../../schemas/orchestrator.js";
import type { ActionPipeline } from "../action-pipeline/index.js";
import type { EventBus } from "../event-bus/index.js";
import type { ObservabilityStore } from "../observability/index.js";
import type { IObserver } from "../observer/types.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { SessionMemory } from "../session-memory/index.js";
import type { TaskEngine } from "../task-engine/index.js";
import type { WorkspaceManager } from "../workspace-manager/index.js";

// ── Shared Dependencies ────────────────────────────────────────────────────

/** Shared dependencies available to all Orchestrator subsystems. */
export interface OrchestratorContext {
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  actionPipeline: ActionPipeline;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
  peopleDirectory: PeopleDirectory;
  observability: ObservabilityStore | null;
  observer: IObserver | null;
}

// ── Per-Execution State ────────────────────────────────────────────────────

/** Per-execution state — scoped to a single executeTask() call, not the class. */
export interface PipelineState {
  traceId: string;
  sessionId: string;
  loopbackCount: number;
}

// ── Process Phase Result ───────────────────────────────────────────────────

/** Discriminated union of executeTask outcomes. */
export type ExecuteTaskResult =
  | { outcome: "completed"; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "review_pending"; phase: Phase; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "decomposed"; childTaskIds: string[]; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "preempted"; lastPhase: Phase; checkpointId: string }
  | { outcome: "error"; phase: Phase; reason: string };

/** Return type of processPhaseCompletion. */
export interface ProcessPhaseResult {
  phases: Phase[];
  loopbackIndex: number | null;
  preemptionResult: ExecuteTaskResult | null;
  decompositionResult: ExecuteTaskResult | null;
  reviewPendingResult: ExecuteTaskResult | null;
}
