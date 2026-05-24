import {
  type InferenceRequest,
  InferenceRequestSchema,
  type InferenceResult,
  InferenceResultSchema,
  type PluginManifest,
  PluginManifestSchema,
  type TriggerEvent,
  TriggerEventSchema,
} from "../../src/schemas/adapters.js";
import { type Event, EventSchema } from "../../src/schemas/events.js";
import { type Task, TaskSchema, TaskStates } from "../../src/schemas/task.js";

// ── Plugin Manifest ─────────────────────────────────────────────────────────

/**
 * Create a Zod-valid PluginManifest with sensible defaults.
 * Pass overrides to customize any field.
 */
export function createMockManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return PluginManifestSchema.parse({
    id: "mock-plugin",
    type: "trigger",
    version: "1.0.0",
    name: "Mock Plugin",
    description: "A mock plugin for testing",
    ...overrides,
  });
}

// ── Trigger Event ───────────────────────────────────────────────────────────

/**
 * Create a Zod-valid TriggerEvent with sensible defaults.
 */
export function createMockTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return TriggerEventSchema.parse({
    idempotency_key: "mock:issue:test-repo:1",
    source: "mock-trigger",
    event_type: "issue_opened",
    external_ref: {
      type: "test_issue",
      repo: "test/repo",
      id: "1",
      url: "https://github.com/test/repo/issues/1",
    },
    title: "Mock issue",
    body: null,
    repo: "test/repo",
    clone_url: "https://github.com/test/repo.git",
    thoughts_id: "issue-1",
    metadata: null,
    ...overrides,
  });
}

// ── Event ───────────────────────────────────────────────────────────────────

/**
 * Create a Zod-valid Event with sensible defaults.
 * The `type` and `payload` are required since they define the event's semantics.
 */
export function createMockEvent(
  type: string,
  payload: Record<string, unknown>,
  overrides?: Partial<Omit<Event, "type" | "payload">>,
): Event {
  return EventSchema.parse({
    id: "01MOCK000000000000000000000",
    sequence: 1,
    type,
    source: "mock",
    task_id: null,
    timestamp: new Date().toISOString(),
    payload,
    ...overrides,
  });
}

// ── Task ────────────────────────────────────────────────────────────────────

/**
 * Create a Zod-valid Task with sensible defaults.
 * The Task schema is large — this provides a complete valid baseline.
 */
export function createMockTask(overrides?: Partial<Task>): Task {
  const now = new Date().toISOString();
  return TaskSchema.parse({
    id: "01MOCK000000000000000000000",
    external_ref: null,
    idempotency_key: "mock:01MOCK",
    state: TaskStates.requirements_gathering,
    sub_state: null,
    phase: null,
    title: "Mock task",
    description: "A mock task for testing",
    source_text: "Mock source text",
    acceptance_criteria: [],
    team: [],
    related: [],
    decisions: [],
    repo: null,
    clone_url: null,
    thoughts_id: null,
    workspace: null,
    review: null,
    blocked: null,
    return_to_phase: null,
    priority: 50,
    llm_tokens: 0,
    llm_cost_usd: 0,
    compute_time_ms: 0,
    created_at: now,
    started_at: null,
    completed_at: null,
    last_transition_at: now,
    session_id: null,
    ...overrides,
  });
}

// ── Inference Request ──────────────────────────────────────────────────────

/**
 * Create a Zod-valid InferenceRequest with sensible defaults.
 */
export function createMockInferenceRequest(overrides?: Partial<InferenceRequest>): InferenceRequest {
  return InferenceRequestSchema.parse({
    prompt: "Mock prompt",
    system_prompt: null,
    cwd: null,
    trace_output_path: null,
    ...overrides,
  });
}

// ── Inference Result ───────────────────────────────────────────────────────

/**
 * Create a valid InferenceResult with sensible defaults.
 * Not Zod-parsed since it's a return value, but matches the schema shape.
 */
export function createMockInferenceResult(overrides?: Partial<InferenceResult>): InferenceResult {
  return InferenceResultSchema.parse({
    content: "Mock inference response",
    cost_usd: 0.01,
    duration_ms: 100,
    usage: null,
    ...overrides,
  });
}
