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
import type { AgentCapabilities, AgentRunRequest, AgentRunResult, Person } from "../../src/schemas/adapters.js";
import {
  OrchestratorConfigSchema,
  type SafetyConfig,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../../src/schemas/config.js";
import type { Task } from "../../src/schemas/task.js";
import { createMockTask } from "./mock-factories.js";

// ── Recording Observer ───────────────────────────────────────────────────────

/** A captured `recordDecision` call. */
export interface RecordedDecision {
  readonly name: string;
  readonly chosen: string;
  readonly reasoning: string;
  /** The alternatives offered — so a test can assert the road not taken is recorded. */
  readonly options: ReadonlyArray<{ id: string; description: string }>;
  /** The trace-correlation scope the decision was recorded under (nesting + phase). */
  readonly opts?: Record<string, unknown> | undefined;
}

/** A captured `observe` call. */
export interface RecordedObservation {
  readonly type: string;
  readonly name: string;
  readonly data: Record<string, unknown>;
  /** The id this observation was assigned (what `observe` returned) — the parent key for the run's children. */
  readonly id: string;
  /** The trace-correlation scope it was recorded under (parent_observation_id, phase) — lets a test assert parentage. */
  readonly opts?: Record<string, unknown> | undefined;
}

/** A captured `startSpan` call and the state it ended in. */
export interface RecordedSpan {
  readonly type: string;
  readonly name: string;
  readonly input?: Record<string, unknown> | undefined;
  output?: Record<string, unknown> | undefined;
  errored?: boolean;
}

/** A captured log call. */
export interface RecordedLog {
  readonly level: "info" | "warn" | "error" | "debug";
  readonly msg: string;
}

/** A captured `recordError` call. */
export interface RecordedError {
  readonly operation: string;
  readonly component: string;
  /** The trace-correlation scope it was recorded under — lets a test assert it parents on the failing run. */
  readonly opts?: Record<string, unknown> | undefined;
}

/** An IObserver that records every emission so tests can assert what the runner produced. */
export interface RecordingObserver extends IObserver {
  readonly decisions: RecordedDecision[];
  readonly observations: RecordedObservation[];
  readonly spans: RecordedSpan[];
  readonly blobs: string[];
  readonly errors: RecordedError[];
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
  const spans: RecordedSpan[] = [];
  const blobs: string[] = [];
  const errors: RecordedError[] = [];
  const logs: RecordedLog[] = [];

  const log = (level: RecordedLog["level"]) => (msg: string) => {
    logs.push({ level, msg });
  };

  const observer: RecordingObserver = {
    decisions,
    observations,
    spans,
    blobs,
    errors,
    logs,
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("debug"),
    startSpan: (type, name, input) => {
      const record: RecordedSpan = { type, name, input };
      spans.push(record);
      return {
        id: "",
        end(output) {
          record.output = output;
        },
        startChild() {
          return NO_OP_SPAN;
        },
        addEvent() {
          /* no-op */
        },
        setError() {
          record.errored = true;
        },
      };
    },
    observe: (type, name, data, opts) => {
      // Hand back a real, unique id (not "") so the runner's per-run correlation can thread it: a
      // sub_phase_started's id becomes the parent the run's later observations are recorded under.
      const id = `obs-${String(observations.length + 1)}`;
      observations.push({ type, name, data, id, opts: opts as Record<string, unknown> | undefined });
      return id;
    },
    recordDecision: (name, _context, options, chosen, reasoning, _confidence, opts) => {
      decisions.push({ name, chosen, reasoning, options: [...options], opts });
      return "";
    },
    recordError: (_error, context, _recovery, opts) => {
      errors.push({ operation: context.operation, component: context.component, opts });
      return "";
    },
    storeBlob: (content) => {
      blobs.push(content);
      return `blob-${String(blobs.length)}`;
    },
    readBlob: () => null,
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

/** Default capabilities for a fake agent: reports nothing, including no activity streaming (the honest current state). */
const FAKE_CAPABILITIES: AgentCapabilities = {
  model_id: "fake-model",
  supports_usage_reporting: false,
  supports_quota_reporting: false,
  supports_activity_streaming: false,
  context_window: null,
};

/**
 * Build an AgentAdapter whose `run` is the given behavior (write a result, throw, honor the signal).
 * `capabilities` overrides default capability flags — pass `{ supports_activity_streaming: true }` to
 * exercise the live-activity path (agentStep gates the `on_activity` sink on this flag).
 */
export function fakeAgent(
  run: (request: AgentRunRequest) => Promise<AgentRunResult>,
  capabilities: Partial<AgentCapabilities> = {},
): AgentAdapter {
  return {
    run: vi.fn(run),
    getCapabilities: () => ({ ...FAKE_CAPABILITIES, ...capabilities }),
    manifest: { id: "fake-agent" },
  } as unknown as AgentAdapter;
}

/** A pass-through action pipeline: runs the gated function and reports it executed. */
function passThroughActionPipeline(): { execute: (input: { executeFn: () => unknown }) => Promise<unknown> } {
  return { execute: async (input) => ({ outcome: "executed", result: await input.executeFn() }) };
}

// ── Ctx Factory ──────────────────────────────────────────────────────────────

/** The minimal safety-layer surface the runner's autonomy consult touches. */
export type MockConsultJudgment = (query: unknown) => { action: "proceed" | "ask_human" | "deny"; reason: string };

/** Overrides for the mock context. */
export interface MockCtxOptions {
  readonly task?: Partial<Task>;
  readonly worktreePath?: string | null;
  readonly thoughtsDir?: string | null;
  readonly tracesDir?: string | null;
  readonly signal?: AbortSignal;
  readonly agent?: AgentAdapter | null;
  readonly people?: readonly Person[];
  /** Override the owner's safety policy rendered into the agent brief. Defaults to schema defaults. */
  readonly safetyConfig?: Partial<SafetyConfig>;
  /** Override the safety layer's autonomy verdict. Defaults to "proceed" (no escalation). */
  readonly consultJudgment?: MockConsultJudgment;
  /** The dispatch's root observation id — the parent of the pipeline spine. Default null (no root). */
  readonly rootObservationId?: string;
}

/** Everything a test needs to drive the runner or agentStep and assert what it emitted. */
export interface MockPipeline {
  readonly ctx: Ctx;
  readonly observer: RecordingObserver;
  readonly sessionMemory: SpyingSessionMemory;
  readonly registry: { readonly getPrimaryPlugin: Mock };
  /** Spy on the safety layer's autonomy consult, so a test can assert what the runner asked. */
  readonly consultJudgment: Mock;
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
  const consult = options.consultJudgment ?? (() => ({ action: "proceed" as const, reason: "test default" }));
  const consultJudgment = vi.fn(consult);
  // Resolve people from `options.people` so getOwner() reflects what a test configures (the runner's
  // no-owner autonomy edge reads it). Default is no people — getOwner() is null, the honest empty state.
  const people = options.people ?? [];
  const owner = people.find((p) => p.roles.includes("owner")) ?? null;

  const ctx = {
    // Real collaborators the runner and agentStep use.
    observer,
    sessionMemory,
    registry,
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    safetyConfig: SafetyConfigSchema.parse(options.safetyConfig ?? {}),
    tracesDir: options.tracesDir ?? null,
    // Stubs the runner and agentStep touch: gate the agent run, record its cost, mirror task position.
    eventBus: { publish: () => undefined },
    safetyLayer: { consultJudgment },
    actionPipeline: passThroughActionPipeline(),
    taskEngine: { updateTaskField: () => undefined, updateTracking: () => undefined },
    workspaceManager: {},
    skillsManager: { getDir: () => "/tmp/skills" },
    peopleDirectory: {
      getAll: () => people,
      getPerson: (id: string) => people.find((p) => p.id === id) ?? null,
      getByRole: (role: string) => people.filter((p) => p.roles.includes(role)),
      getOwner: () => owner,
      getReviewers: () => people.filter((p) => p.roles.includes("reviewer")),
      resolveContact: () => null,
    },
    notifications: {},
    // Per-dispatch state.
    task: createMockTask(options.task),
    sessionId: "session-test",
    traceId: "trace-test",
    worktreePath: options.worktreePath ?? null,
    thoughtsDir: options.thoughtsDir ?? null,
    // The dispatch root id (the spine's parent) and the per-run id the runner stamps each sub-phase.
    rootObservationId: options.rootObservationId,
    subPhaseRunObsId: undefined,
    ...(options.signal ? { signal: options.signal } : {}),
  } as unknown as Ctx;

  return { ctx, observer, sessionMemory, registry, consultJudgment };
}

/** A minimal owner Person for tests that need getOwner() to resolve (the runner's autonomy ask path). */
export function mockOwner(overrides: Partial<Person> = {}): Person {
  return {
    id: "owner",
    name: "Owner",
    roles: ["owner"],
    contacts: [{ channel: "telegram", handle: "@owner" }],
    ...overrides,
  };
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

/** A phase definition. `maxIterations` defaults to 3 (the Review cap); `extra` sets optional fields (e.g. `consultsDecisions`). */
export function mockPhase(
  phase: PhaseDefinition["phase"],
  subPhases: readonly SubPhase[],
  maxIterations = 3,
  extra: Partial<Omit<PhaseDefinition, "phase" | "subPhases" | "maxIterations">> = {},
): PhaseDefinition {
  return { phase, subPhases, maxIterations, ...extra };
}
