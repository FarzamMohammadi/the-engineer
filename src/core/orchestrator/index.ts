import type { ZodType } from "zod";
import type { LLMAdapter } from "../../adapters/llm.js";
import type { ToolAdapter } from "../../adapters/tool.js";
import type { CompletionResult } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Event } from "../../schemas/events.js";
import {
  DemoPrepOutputSchema,
  ExecutionOutputSchema,
  IntakeAnalysisOutputSchema,
  IntegrationOutputSchema,
  type Phase,
  type PhaseOutput,
  PlanningOutputSchema,
  ResearchOutputSchema,
  SelfReviewOutputSchema,
} from "../../schemas/orchestrator.js";
import type { ActionPipeline } from "../action-pipeline/index.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";
import type { Registry } from "../registry/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { SessionMemory } from "../session-memory/index.js";
import type { TaskEngine } from "../task-engine/index.js";
import type { WorkspaceManager } from "../workspace-manager/index.js";
import { executeAction as executeAgentAction } from "./action-executor.js";
import { type AgentLoopResult, runAgentLoop } from "./agent-loop.js";
import { getPhaseToolConfig } from "./phase-tools.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** The standard 7-phase pipeline sequence. */
export const PHASE_SEQUENCE: Phase[] = [
  "intake_analysis",
  "research",
  "planning",
  "execution",
  "self_review",
  "demo_prep",
  "integration",
];

/** Fast-path phases: skip research, planning, demo_prep, integration. */
const FAST_PATH_PHASES: Phase[] = ["execution", "self_review"];

/** Phase-specific Zod schemas for output validation. */
const PHASE_SCHEMAS: Record<Phase, ZodType> = {
  intake_analysis: IntakeAnalysisOutputSchema,
  research: ResearchOutputSchema,
  planning: PlanningOutputSchema,
  execution: ExecutionOutputSchema,
  self_review: SelfReviewOutputSchema,
  demo_prep: DemoPrepOutputSchema,
  integration: IntegrationOutputSchema,
};

// ── Types ───────────────────────────────────────────────────────────────────

/** Constructor dependencies for the Orchestrator. */
export interface OrchestratorDependencies {
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  actionPipeline: ActionPipeline;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
}

/** Discriminated union of executeTask outcomes. */
export type ExecuteTaskResult =
  | { outcome: "completed"; phaseOutputs: Map<Phase, PhaseOutput> }
  | { outcome: "preempted"; lastPhase: Phase; checkpointId: string }
  | { outcome: "error"; phase: Phase; reason: string };

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * The brain of the system — a 7-phase pipeline that takes a task from intake
 * to integration.
 *
 * Derives from compiler front-end (multi-pass pipeline) + flight director
 * (coordination and communication). This is the skeleton: thin phase handlers
 * that call the LLM adapter, parse responses with `.safeParse()`, and produce
 * PhaseOutputs. Full phase sophistication comes in later refinement.
 *
 * Protocols implemented:
 * - P4 (Phase Transition): checkpoint → journal → update task.phase → next phase
 * - P8 (Preemption): cooperative yield via flag check between phases
 * - P9 (Task Resume): reconstruct from checkpoint, skip completed phases
 */
export class Orchestrator {
  private readonly eventBus: EventBus;
  private readonly registry: Registry;
  private readonly taskEngine: TaskEngine;
  // Stored for future use: Orchestrator will call consultJudgment() directly
  // for should_i_ask queries and cost_check pre-flight. Currently Gate 2 runs
  // through ActionPipeline, so no direct calls in the skeleton.
  private readonly safetyLayer: SafetyLayer;
  private readonly actionPipeline: ActionPipeline;
  private readonly sessionMemory: SessionMemory;
  private readonly workspaceManager: WorkspaceManager;

  private preemptionRequested = false;
  private preemptionPayload: {
    target_task_id: string;
    preempting_task_id: string;
  } | null = null;

  /** Phase handler dispatch map — one method per phase. */
  private readonly phaseHandlers: Record<
    Phase,
    (
      taskId: string,
      dispatch: Dispatch,
      priorOutputs: Map<Phase, PhaseOutput>,
    ) => Promise<PhaseOutput>
  >;

  constructor(deps: OrchestratorDependencies) {
    this.eventBus = deps.eventBus;
    this.registry = deps.registry;
    this.taskEngine = deps.taskEngine;
    this.safetyLayer = deps.safetyLayer;
    this.actionPipeline = deps.actionPipeline;
    this.sessionMemory = deps.sessionMemory;
    this.workspaceManager = deps.workspaceManager;

    // Subscribe to preemption requests (Protocol P8)
    this.eventBus.subscribe("orchestrator", "preemption.requested", (event: Event) => {
      this.preemptionRequested = true;
      const payload = event.payload as {
        target_task_id: string;
        preempting_task_id: string;
      };
      this.preemptionPayload = {
        target_task_id: payload.target_task_id,
        preempting_task_id: payload.preempting_task_id,
      };
    });

    // Bind phase handlers
    this.phaseHandlers = {
      intake_analysis: this.handleIntakeAnalysis.bind(this),
      research: this.handleResearch.bind(this),
      planning: this.handlePlanning.bind(this),
      execution: this.handleExecution.bind(this),
      self_review: this.handleSelfReview.bind(this),
      demo_prep: this.handleDemoPrep.bind(this),
      integration: this.handleIntegration.bind(this),
    };
  }

  /**
   * Execute a task through the phase pipeline.
   *
   * Entry point called by the Daemon. Handles new tasks and resumed tasks.
   * Returns when the pipeline completes, is preempted, or encounters an error.
   */
  async executeTask(dispatch: Dispatch): Promise<ExecuteTaskResult> {
    const taskId = dispatch.task.id;

    // ── Session setup ──────────────────────────────────────────────────────
    const session = this.createSession(dispatch);
    const sessionId = session.id;
    this.taskEngine.updateTaskField(taskId, "session_id", sessionId);

    // ── Determine phase sequence ───────────────────────────────────────────
    const { phases: initialPhases, startIndex } = this.resolveStartState(
      dispatch,
      sessionId,
      taskId,
    );
    let phases = initialPhases;

    // Set initial task.phase so Daemon can see what phase we're in
    // biome-ignore lint/style/noNonNullAssertion: startIndex is within bounds (resolveStartState guarantees it)
    const initialPhase = phases[startIndex]!;
    this.taskEngine.updateTaskField(taskId, "phase", initialPhase);

    // ── Phase loop ─────────────────────────────────────────────────────────
    const priorOutputs = new Map<Phase, PhaseOutput>();

    for (let i = startIndex; i < phases.length; i++) {
      if (this.preemptionRequested) {
        // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
        return this.handlePreemption(sessionId, taskId, phases[i]!, priorOutputs);
      }

      // biome-ignore lint/style/noNonNullAssertion: phases[i] is guaranteed valid within loop bounds
      const phase = phases[i]!;

      // Execute the phase handler
      let output: PhaseOutput;
      try {
        output = await this.phaseHandlers[phase](taskId, dispatch, priorOutputs);
      } catch (error: unknown) {
        return this.handlePhaseError(sessionId, taskId, phase, error);
      }

      priorOutputs.set(phase, output);

      // Fast-path: after intake_analysis, check if we should skip phases
      if (phase === "intake_analysis") {
        phases = this.applyFastPathIfNeeded(output, phases);
      }

      // Protocol P4: Phase transition
      const isLastPhase = i === phases.length - 1;
      // biome-ignore lint/style/noNonNullAssertion: next phase exists when not last
      const nextPhase = isLastPhase ? null : phases[i + 1]!;
      this.recordPhaseTransition(sessionId, taskId, phase, nextPhase, priorOutputs);

      // Check preemption again after phase completion
      if (this.preemptionRequested && nextPhase) {
        return this.handlePreemption(sessionId, taskId, nextPhase, priorOutputs);
      }
    }

    // ── Pipeline complete ──────────────────────────────────────────────────
    this.sessionMemory.endSession(sessionId, "completed");
    return { outcome: "completed", phaseOutputs: priorOutputs };
  }

  // ── Phase Handlers ──────────────────────────────────────────────────────────

  private handleIntakeAnalysis(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Analyze tasks with the eye of a senior engineer.";
    const prompt = [
      "Analyze this task and assess its complexity.",
      `Task title: ${dispatch.task.title}`,
      `Task description: ${dispatch.task.description ?? "None provided"}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      "",
      "You may read files and search the codebase to understand the task better.",
      'When done, respond with {"action": "done", "result": {your analysis}}.',
      "",
      "Required result fields:",
      "- complexity: one of 'trivial', 'simple', 'moderate', 'complex', 'epic'",
      "- estimated_phases: array of phase names this task needs",
      "- ambiguities: array of unclear requirements",
      "- fast_path: boolean, true if this is a trivial task",
      "- decomposition_likely: boolean, true if task should be split",
    ].join("\n");

    return this.runPhaseWithAgentLoop("intake_analysis", taskId, systemPrompt, prompt);
  }

  private handleResearch(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const intakeData = priorOutputs.get("intake_analysis")?.data as
      | Record<string, unknown>
      | undefined;
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Research codebases thoroughly before making changes.";
    const prompt = [
      "Research the codebase for this task.",
      `Task: ${dispatch.task.title}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      intakeData ? `Intake analysis: ${JSON.stringify(intakeData)}` : "",
      "",
      "Use read_file, search_files, and search_content to explore the codebase.",
      'When done, respond with {"action": "done", "result": {your findings}}.',
      "",
      "Required result fields:",
      "- relevant_files: array of file paths",
      "- relevant_modules: array of module names",
      "- conventions: array of convention objects found",
      "- existing_patterns: array of pattern descriptions",
      "- dependencies: array of dependency names",
    ].join("\n");

    return this.runPhaseWithAgentLoop("research", taskId, systemPrompt, prompt);
  }

  private handlePlanning(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const researchData = priorOutputs.get("research")?.data as Record<string, unknown> | undefined;
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Create thorough, actionable technical plans.";
    const prompt = [
      "Create a technical plan for this task.",
      `Task: ${dispatch.task.title}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      researchData ? `Research findings: ${JSON.stringify(researchData)}` : "",
      "",
      "You may read files to verify your plan is sound.",
      'When done, respond with {"action": "done", "result": {your plan}}.',
      "",
      "Required result fields:",
      "- approach: string describing the technical approach",
      "- file_changes: array of {file, change_type, description}",
      "- risks: array of {risk, mitigation}",
      "- decomposition_plan: null or a decomposition plan object",
    ].join("\n");

    return this.runPhaseWithAgentLoop("planning", taskId, systemPrompt, prompt);
  }

  private handleExecution(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const planData = priorOutputs.get("planning")?.data as Record<string, unknown> | undefined;
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Write clean, tested code. Iterate until tests pass.";
    const prompt = [
      "Execute the implementation for this task.",
      `Task: ${dispatch.task.title}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      planData ? `Plan: ${JSON.stringify(planData)}` : "",
      "",
      "Use write_file, edit_file, and run_command to implement the changes.",
      "Run tests after making changes. Fix any failures.",
      'When done, respond with {"action": "done", "result": {your summary}}.',
      "",
      "Required result fields:",
      "- files_changed: array of file paths modified",
      "- tests_written: array of test file paths",
      "- test_results: {passed: number, failed: number, skipped: number}",
      "- build_status: 'passing' or 'failing'",
    ].join("\n");

    return this.runPhaseWithAgentLoop("execution", taskId, systemPrompt, prompt);
  }

  private handleSelfReview(
    taskId: string,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const execData = priorOutputs.get("execution")?.data as Record<string, unknown> | undefined;
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Review code with a critical eye. Ship quality matters.";
    const prompt = [
      "Review the code changes for this task.",
      `Task: ${dispatch.task.title}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      execData ? `Execution summary: ${JSON.stringify(execData)}` : "",
      "",
      "Read the changed files and run tests to verify quality.",
      'When done, respond with {"action": "done", "result": {your review}}.',
      "",
      "Required result fields:",
      "- findings: array of {type, file, description, fixed}",
      "- refactoring_applied: array of refactoring descriptions",
      "- quality_assessment: 'ship_it', 'needs_work', or 'fundamental_issues'",
    ].join("\n");

    return this.runPhaseWithAgentLoop("self_review", taskId, systemPrompt, prompt);
  }

  private handleDemoPrep(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Prepare clear, comprehensive demo artifacts.";
    const prompt = [
      "Prepare demo artifacts and a PR description for this task.",
      `Task: ${dispatch.task.title}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      "",
      'When done, respond with {"action": "done", "result": {your artifacts}}.',
      "",
      "Required result fields:",
      "- artifacts: array of {type, location, permanent}",
      "- pr_number: positive integer",
      "- pr_description: string",
    ].join("\n");

    return this.runPhaseWithAgentLoop("demo_prep", taskId, systemPrompt, prompt);
  }

  private handleIntegration(
    taskId: string,
    dispatch: Dispatch,
    _priorOutputs: Map<Phase, PhaseOutput>,
  ): Promise<PhaseOutput> {
    const systemPrompt =
      "You are The Engineer, an autonomous software engineering agent. Verify integration thoroughly.";
    const prompt = [
      "Verify integration of all changes for this task.",
      `Task: ${dispatch.task.title}`,
      `Repository: ${this.getTaskRepo(dispatch)}`,
      "",
      'When done, respond with {"action": "done", "result": {your verification}}.',
      "",
      "Required result fields:",
      "- children_verified: array of child task IDs checked",
      "- integration_tests: {passed: number, failed: number}",
      "- conflicts_found: array of conflict descriptions",
      "- resolution_actions: array of resolution descriptions",
    ].join("\n");

    return this.runPhaseWithAgentLoop("integration", taskId, systemPrompt, prompt);
  }

  // ── Extracted Helpers (for cognitive complexity) ─────────────────────────────

  /** Determine start index and log resume context (Protocol P9). */
  private resolveStartState(
    dispatch: Dispatch,
    sessionId: string,
    taskId: string,
  ): { phases: Phase[]; startIndex: number } {
    const phases = [...PHASE_SEQUENCE];

    if (!dispatch.resume_from) {
      return { phases, startIndex: 0 };
    }

    const checkpoint = dispatch.resume_from;
    const checkpointPhaseIndex = phases.indexOf(checkpoint.phase as Phase);
    const startIndex = checkpointPhaseIndex >= 0 ? checkpointPhaseIndex + 1 : 0;

    // Verify workspace integrity before resuming (Plan step 2)
    this.workspaceManager.verifyWorkspace(taskId);

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: checkpoint.phase,
      type: "phase_change",
      summary: `Resumed from checkpoint in ${checkpoint.phase} phase. Reason: ${checkpoint.reason}.`,
      detail: checkpoint.next_action,
      tags: ["resume"],
    });

    return { phases, startIndex };
  }

  /** Log error and build error result for a failed phase. */
  private handlePhaseError(
    sessionId: string,
    taskId: string,
    phase: Phase,
    error: unknown,
  ): ExecuteTaskResult {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase,
      type: "error",
      summary: `Phase ${phase} failed: ${message}`,
      errorDetail: stack,
      tags: ["phase_error"],
    });

    return { outcome: "error", phase, reason: message };
  }

  /** Record a phase transition: checkpoint + journal + update task.phase (Protocol P4). */
  private recordPhaseTransition(
    sessionId: string,
    taskId: string,
    completedPhase: Phase,
    nextPhase: Phase | null,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): void {
    this.createPhaseCheckpoint(sessionId, taskId, completedPhase, priorOutputs, nextPhase);

    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: completedPhase,
      type: "phase_change",
      summary: nextPhase
        ? `Completed ${completedPhase}, entering ${nextPhase}`
        : `Completed ${completedPhase} (final phase)`,
      tags: ["phase_transition"],
    });

    if (nextPhase) {
      this.taskEngine.updateTaskField(taskId, "phase", nextPhase);
    }
  }

  /** Check if intake output enables fast-path, return updated phases array. */
  private applyFastPathIfNeeded(intakeOutput: PhaseOutput, currentPhases: Phase[]): Phase[] {
    const intakeData = intakeOutput.data as { fast_path?: boolean };
    if (intakeData.fast_path === true) {
      return ["intake_analysis", ...FAST_PATH_PHASES];
    }
    return currentPhases;
  }

  /** Extract repository identifier from task (workspace or external_ref). */
  private getTaskRepo(dispatch: Dispatch): string {
    return dispatch.task.workspace?.repo ?? dispatch.task.external_ref?.repo ?? "";
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Call the LLM adapter through the Action Pipeline, parse the response,
   * and validate with the phase-specific schema.
   *
   * Emits a `cost.incurred` event after each successful call.
   * On safeParse failure, returns a fallback PhaseOutput (Decision #85).
   */
  private async callLlmAndParse(
    phase: Phase,
    taskId: string,
    prompt: string,
  ): Promise<PhaseOutput> {
    const completion = await this.callLlm(prompt, taskId);

    // Emit cost.incurred event
    this.emitCostIncurred(taskId, completion);

    // Parse JSON from LLM response
    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.content);
    } catch {
      return this.buildFallbackOutput(
        phase,
        taskId,
        `Invalid JSON from LLM: ${completion.content.slice(0, 200)}`,
      );
    }

    // Validate against phase schema
    const schema = PHASE_SCHEMAS[phase];
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return this.buildFallbackOutput(
        phase,
        taskId,
        `Schema validation failed: ${result.error.message}`,
      );
    }

    return this.buildPhaseOutput(phase, taskId, result.data as Record<string, unknown>, "high", []);
  }

  /**
   * Call the LLM adapter through the Action Pipeline.
   * Throws if no LLM plugin is registered or if the pipeline rejects.
   */
  private async callLlm(
    prompt: string,
    taskId: string,
    systemPrompt?: string | null,
  ): Promise<CompletionResult> {
    const llm = this.registry.getPrimaryPlugin<LLMAdapter>("llm");
    if (!llm) {
      throw new Error("Orchestrator: no LLM plugin registered");
    }

    const pipelineResult = await this.actionPipeline.execute<CompletionResult>({
      taskId,
      actionClass: "read",
      details: { operation: "llm_complete" },
      requestedBy: "orchestrator",
      executeFn: () =>
        llm.complete({
          prompt,
          system_prompt: systemPrompt ?? null,
          options: { max_tokens: null, temperature: null, stop: null, tools: null },
        }),
    });

    if (pipelineResult.outcome !== "executed") {
      const reason = "reason" in pipelineResult ? pipelineResult.reason : "unknown";
      throw new Error(`LLM call rejected: ${pipelineResult.outcome} - ${reason}`);
    }

    return pipelineResult.result;
  }

  /**
   * Run a phase using the agent loop (multi-turn LLM + tool execution).
   *
   * The Engineer IS the agent: call LLM → parse action → execute tool → repeat.
   * Falls back to callLlmAndParse if no worktree is available.
   */
  private async runPhaseWithAgentLoop(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    initialPrompt: string,
  ): Promise<PhaseOutput> {
    const toolConfig = getPhaseToolConfig(phase);
    const worktreePath = this.workspaceManager.getWorktreePath(taskId);

    const toolAdapter = this.registry.getPrimaryPlugin<ToolAdapter>("tool") ?? null;

    const loopResult = await runAgentLoop(
      {
        phase,
        taskId,
        systemPrompt,
        initialPrompt,
        toolConfig,
        worktreePath,
      },
      // Inject LLM call through ActionPipeline
      (prompt, sysPrompt) => this.callLlm(prompt, taskId, sysPrompt),
      // Inject action execution
      (action, wPath) =>
        executeAgentAction(action, wPath, {
          actionPipeline: this.actionPipeline,
          toolAdapter,
          taskId,
        }),
    );

    // Emit cost for the entire loop
    this.emitAgentLoopCost(taskId, loopResult);

    // Validate output against phase schema
    return this.validateLoopResult(phase, taskId, loopResult);
  }

  /** Emit cost.incurred event for an agent loop's accumulated cost. */
  private emitAgentLoopCost(taskId: string, loopResult: AgentLoopResult): void {
    this.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: "",
        provider_id: "llm",
        provider_type: "api",
        operation: "agent_loop",
        tokens_in: loopResult.totalCost.tokens_in,
        tokens_out: loopResult.totalCost.tokens_out,
        spend_usd: loopResult.totalCost.spend_usd,
        usage_units: null,
        remaining: null,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  /** Validate agent loop result against phase schema, build PhaseOutput. */
  private validateLoopResult(
    phase: Phase,
    taskId: string,
    loopResult: AgentLoopResult,
  ): PhaseOutput {
    const schema = PHASE_SCHEMAS[phase];
    const result = schema.safeParse(loopResult.phaseData);

    if (!result.success) {
      return this.buildFallbackOutput(
        phase,
        taskId,
        `Agent loop output invalid: ${result.error.message} (after ${String(loopResult.iterations)} iterations)`,
      );
    }

    return this.buildPhaseOutput(phase, taskId, result.data as Record<string, unknown>, "high", []);
  }

  /** Emit a cost.incurred event from LLM completion usage data. */
  private emitCostIncurred(taskId: string, completion: CompletionResult): void {
    this.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: "",
        provider_id: "llm",
        provider_type: "api",
        operation: "phase_completion",
        tokens_in: completion.usage.tokens_in,
        tokens_out: completion.usage.tokens_out,
        spend_usd: completion.usage.spend_usd,
        usage_units: null,
        remaining: completion.usage.remaining,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  /** Build a PhaseOutput envelope. */
  private buildPhaseOutput(
    phase: Phase,
    taskId: string,
    data: Record<string, unknown>,
    confidence: "high" | "medium" | "low",
    openQuestions: string[],
  ): PhaseOutput {
    return {
      phase,
      task_id: taskId,
      timestamp: new Date().toISOString(),
      data,
      confidence,
      open_questions: openQuestions,
    };
  }

  /** Build a fallback PhaseOutput when safeParse fails (Decision #85). */
  private buildFallbackOutput(phase: Phase, taskId: string, errorMessage: string): PhaseOutput {
    return this.buildPhaseOutput(phase, taskId, this.getDefaultData(phase), "low", [errorMessage]);
  }

  /** Get default/empty data for a phase when LLM output is invalid. */
  private getDefaultData(phase: Phase): Record<string, unknown> {
    const defaults: Record<Phase, Record<string, unknown>> = {
      intake_analysis: {
        complexity: "moderate",
        estimated_phases: [...PHASE_SEQUENCE],
        ambiguities: [],
        fast_path: false,
        decomposition_likely: false,
      },
      research: {
        relevant_files: [],
        relevant_modules: [],
        conventions: [],
        existing_patterns: [],
        dependencies: [],
      },
      planning: {
        approach: "Unable to generate plan from LLM output",
        file_changes: [],
        risks: [],
        decomposition_plan: null,
      },
      execution: {
        files_changed: [],
        tests_written: [],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        build_status: "failing",
      },
      self_review: {
        findings: [],
        refactoring_applied: [],
        quality_assessment: "needs_work",
      },
      demo_prep: {
        artifacts: [],
        pr_number: 1,
        pr_description: "Unable to generate PR description from LLM output",
      },
      integration: {
        children_verified: [],
        integration_tests: { passed: 0, failed: 0 },
        conflicts_found: [],
        resolution_actions: [],
      },
    };
    return defaults[phase];
  }

  /** Create a checkpoint at a phase transition (Protocol P4). */
  private createPhaseCheckpoint(
    sessionId: string,
    taskId: string,
    completedPhase: Phase,
    priorOutputs: Map<Phase, PhaseOutput>,
    nextPhase: Phase | null,
  ): string {
    const output = priorOutputs.get(completedPhase);
    const checkpoint = this.sessionMemory.createCheckpoint({
      sessionId,
      taskId,
      phase: completedPhase,
      phaseProgress: `Completed ${completedPhase}`,
      contextSummary: `Phase ${completedPhase} complete. ${output ? `Confidence: ${output.confidence}` : ""}`,
      keyFindings: output?.open_questions ?? [],
      openQuestions: output?.open_questions ?? [],
      nextAction: nextPhase ? `Begin ${nextPhase} phase` : "Pipeline complete",
      lastEventId: "",
      workspaceRef: null,
      reason: "phase_transition",
      journalOffset: 0,
    });
    return checkpoint.id;
  }

  /** Handle preemption: checkpoint, end session, emit ready (Protocol P8). */
  private handlePreemption(
    sessionId: string,
    taskId: string,
    currentPhase: Phase,
    _priorOutputs: Map<Phase, PhaseOutput>,
  ): ExecuteTaskResult {
    const preemptingId = this.preemptionPayload?.preempting_task_id ?? "unknown";

    // Create preemption checkpoint
    const checkpoint = this.sessionMemory.createCheckpoint({
      sessionId,
      taskId,
      phase: currentPhase,
      phaseProgress: `Preempted during ${currentPhase}`,
      contextSummary: `Task preempted by ${preemptingId} before completing ${currentPhase}`,
      keyFindings: [],
      openQuestions: [],
      nextAction: `Resume at ${currentPhase}`,
      lastEventId: "",
      workspaceRef: null,
      reason: "preemption",
      journalOffset: 0,
    });

    // Log journal entry
    this.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: currentPhase,
      type: "checkpoint_marker",
      summary: `Preempted by ${preemptingId}`,
      tags: ["preemption"],
    });

    // End session
    this.sessionMemory.endSession(sessionId, "preempted");

    // Emit preemption.ready
    this.eventBus.publish({
      type: "preemption.ready",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        checkpoint_id: checkpoint.id,
        phase: currentPhase,
        atomic_op: "phase_complete",
      },
    } satisfies PublishInput<"preemption.ready">);

    // Reset flag
    this.preemptionRequested = false;
    this.preemptionPayload = null;

    return { outcome: "preempted", lastPhase: currentPhase, checkpointId: checkpoint.id };
  }

  /**
   * Attempt to self-diagnose and resolve a blocked task.
   *
   * Called by the Daemon during Stage 2 of blocked timeout escalation.
   * Makes a lightweight LLM call to assess whether the block can be
   * automatically resolved. Thin for v1 — Phase 16 adds real prompt
   * engineering.
   *
   * Returns `true` if the block was resolved, `false` otherwise.
   */
  async attemptSelfUnblock(taskId: string): Promise<boolean> {
    const task = this.taskEngine.getTask(taskId);
    if (!task || task.state !== "blocked") {
      return false;
    }

    const llm = this.registry.getPrimaryPlugin<LLMAdapter>("llm");
    if (!llm) {
      return false;
    }

    // Gather recent journal context
    const entries = this.sessionMemory.queryJournal(taskId);
    const recentEntries = entries.slice(-5);
    const blockedReason = task.blocked?.reason ?? "unknown";

    const prompt = [
      "A task is blocked and needs diagnosis.",
      `Task: "${task.title}"`,
      `Blocked reason: ${blockedReason}`,
      `Recent activity: ${JSON.stringify(recentEntries.map((e) => ({ type: e.type, summary: e.summary })))}`,
      "",
      "Can this be automatically resolved? Respond with JSON:",
      '{ "can_resolve": boolean, "action": "description of resolution or why not" }',
    ].join("\n");

    try {
      const pipelineResult = await this.actionPipeline.execute<CompletionResult>({
        taskId,
        actionClass: "read",
        details: { operation: "self_unblock_diagnosis" },
        requestedBy: "orchestrator",
        executeFn: () =>
          llm.complete({
            prompt,
            system_prompt: null,
            options: { max_tokens: 200, temperature: null, stop: null, tools: null },
          }),
      });

      if (pipelineResult.outcome !== "executed") {
        return false;
      }

      this.emitCostIncurred(taskId, pipelineResult.result);

      const parsed = JSON.parse(pipelineResult.result.content) as { can_resolve?: boolean };
      return parsed.can_resolve === true;
    } catch {
      return false;
    }
  }

  /** Create a session — new for fresh tasks, linked for resumed tasks. */
  private createSession(dispatch: Dispatch) {
    if (dispatch.resume_from) {
      return this.sessionMemory.createSession({
        taskId: dispatch.task.id,
        previousSessionId: dispatch.resume_from.session_id,
        resumedFromCheckpoint: dispatch.resume_from.id,
      });
    }
    return this.sessionMemory.createSession({
      taskId: dispatch.task.id,
    });
  }
}
