/**
 * Test harness for the dark pipeline core (runner + agentStep).
 *
 * Provides a recording observer (so tests can assert the observability triple the runner
 * emits), a spying session memory, a configurable fake agent, and small builders for mock
 * sub-phases and phases. The Ctx is assembled with real collaborators where the runner and
 * agentStep touch them and harmless stubs everywhere else.
 */
import { type Mock, vi } from "vitest";

import type { AgentAdapter } from "../../src/adapters/agent.js";
import type { IObserver } from "../../src/core/observer/index.js";
import type { ObservationSpan } from "../../src/core/observer/types.js";
import type {
  Ctx,
  PhaseDefinition,
  Route,
  SubPhase,
  SubPhaseResult,
} from "../../src/core/orchestrator/pipeline/types.js";
import type { AgentRunRequest, AgentRunResult } from "../../src/schemas/adapters.js";
import { OrchestratorConfigSchema, WorkspaceConfigSchema } from "../../src/schemas/config.js";
import type { Task } from "../../src/schemas/task.js";
import { createMockTask } from "./mock-factories.js";

// ── Recording Observer ───────────────────────────────────────────────────────

/** A captured `recordDecision` call. */
export interface RecordedDecision {
  readonly name: string;
  readonly chosen: string;
  readonly reasoning: string;
}

/** A captured `observe` call. */
export interface RecordedObservation {
  readonly type: string;
  readonly name: string;
  readonly data: Record<string, unknown>;
}

/** A captured log call. */
export interface RecordedLog {
  readonly level: "info" | "warn" | "error" | "debug";
  readonly msg: string;
}

/** An IObserver that records every emission so tests can assert what the runner produced. */
export interface RecordingObserver extends IObserver {
  readonly decisions: RecordedDecision[];
  readonly observations: RecordedObservation[];
  readonly logs: RecordedLog[];
}

const NO_OP_SPAN: ObservationSpan = {
  id: "",
  end() {
    /* no-op */
  },
  startChild() {
    return NO_OP_SPAN;
  },
  addEvent() {
    /* no-op */
  },
  setError() {
    /* no-op */
  },
};

/** Build a recording observer with capture arrays for decisions, observations, and logs. */
export function createRecordingObserver(): RecordingObserver {
  const decisions: RecordedDecision[] = [];
  const observations: RecordedObservation[] = [];
  const logs: RecordedLog[] = [];

  const log = (level: RecordedLog["level"]) => (msg: string) => {
    logs.push({ level, msg });
  };

  const observer: RecordingObserver = {
    decisions,
    observations,
    logs,
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
    startSpan: () => NO_OP_SPAN,
    observe: (type, name, data) => {
      observations.push({ type, name, data });
      return "";
    },
    recordDecision: (name, _context, _options, chosen, reasoning) => {
      decisions.push({ name, chosen, reasoning });
      return "";
    },
    recordError: () => "",
    child: () => observer,
    childPlugin: () => observer,
    withTrace: () => observer,
    pino: {} as IObserver["pino"],
  };
  return observer;
}

// ── Spying Session Memory ────────────────────────────────────────────────────

/** A session memory whose journal and checkpoint writes are vi spies. */
export interface SpyingSessionMemory {
  readonly journal: { readonly addEntry: Mock };
  readonly checkpoints: { readonly create: Mock };
  readonly sessions: { readonly create: Mock; readonly end: Mock };
}

function createSpyingSessionMemory(): SpyingSessionMemory {
  return {
    journal: { addEntry: vi.fn() },
    checkpoints: { create: vi.fn() },
    sessions: { create: vi.fn(), end: vi.fn() },
  };
}

// ── Fake Agent ───────────────────────────────────────────────────────────────

/** Build an AgentAdapter whose `run` is the given behavior (write a result, throw, honor the signal). */
export function fakeAgent(run: (request: AgentRunRequest) => Promise<AgentRunResult>): AgentAdapter {
  return { run: vi.fn(run) } as unknown as AgentAdapter;
}

// ── Ctx Factory ──────────────────────────────────────────────────────────────

/** Overrides for the mock context. */
export interface MockCtxOptions {
  readonly task?: Partial<Task>;
  readonly worktreePath?: string | null;
  readonly thoughtsDir?: string | null;
  readonly tracesDir?: string | null;
  readonly signal?: AbortSignal;
  readonly agent?: AgentAdapter | null;
}

/** Everything a test needs to drive the runner or agentStep and assert what it emitted. */
export interface MockPipeline {
  readonly ctx: Ctx;
  readonly observer: RecordingObserver;
  readonly sessionMemory: SpyingSessionMemory;
  readonly registry: { readonly getPrimaryPlugin: Mock };
}

/** Assemble a Ctx with a recording observer, spying session memory, and a configurable agent. */
export function createMockPipeline(options: MockCtxOptions = {}): MockPipeline {
  const observer = createRecordingObserver();
  const sessionMemory = createSpyingSessionMemory();
  const agent = options.agent ?? null;
  const registry = {
    getPrimaryPlugin: vi.fn((type: string) => (type === "agent" ? agent : null)),
    getPluginsByType: vi.fn(() => []),
    getPlugin: vi.fn(() => null),
  };

  const ctx = {
    // Real collaborators the runner and agentStep use.
    observer,
    sessionMemory,
    registry,
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    observationStore: null,
    tracesDir: options.tracesDir ?? null,
    // Stubs for the rest of the orchestrator infrastructure (unused by the dark core).
    eventBus: {},
    safetyLayer: {},
    actionPipeline: {},
    taskEngine: {},
    workspaceManager: {},
    skillsManager: {},
    peopleDirectory: {},
    notifications: {},
    // Per-dispatch state.
    task: createMockTask(options.task),
    sessionId: "session-test",
    traceId: "trace-test",
    worktreePath: options.worktreePath ?? null,
    thoughtsDir: options.thoughtsDir ?? null,
    ...(options.signal ? { signal: options.signal } : {}),
  } as unknown as Ctx;

  return { ctx, observer, sessionMemory, registry };
}

// ── Sub-Phase & Phase Builders ───────────────────────────────────────────────

/** Defaults: a sub-phase that succeeds and advances. Override `skip`, `run`, or `next` per test. */
export function mockSubPhase(name: string, overrides: Partial<SubPhase> = {}): SubPhase {
  return {
    name,
    run: () => Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: `${name} ok` }),
    next: () => ({ go: "advance" }) satisfies Route,
    ...overrides,
  };
}

/** A phase definition. `maxIterations` defaults to 3 (the Review cap). */
export function mockPhase(
  phase: PhaseDefinition["phase"],
  subPhases: readonly SubPhase[],
  maxIterations = 3,
): PhaseDefinition {
  return { phase, subPhases, maxIterations };
}
