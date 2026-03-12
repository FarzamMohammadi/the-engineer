import {
  type CompletionRequest,
  CompletionRequestSchema,
  type CompletionResult,
  type PluginManifest,
  PluginManifestSchema,
  type ToolResult,
  ToolResultSchema,
  type TriggerEvent,
  TriggerEventSchema,
} from "../../src/schemas/adapters.js";
import { type Event, EventSchema } from "../../src/schemas/events.js";
import { type Task, TaskSchema } from "../../src/schemas/task.js";

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
    external_ref: "https://github.com/test/repo/issues/1",
    title: "Mock issue",
    body: null,
    repo: "test/repo",
    clone_url: "https://github.com/test/repo.git",
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
    state: "intake",
    sub_state: null,
    phase: null,
    parent_id: null,
    children: [],
    cascade_policy: "best_effort",
    title: "Mock task",
    description: "A mock task for testing",
    source_text: "Mock source text",
    acceptance_criteria: [],
    team: [],
    related: [],
    decisions: [],
    child_summaries: [],
    repo: null,
    clone_url: null,
    workspace: null,
    review: null,
    blocked: null,
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

// ── Completion Request ──────────────────────────────────────────────────────

/**
 * Create a Zod-valid CompletionRequest with sensible defaults.
 */
export function createMockCompletionRequest(
  overrides?: Partial<CompletionRequest>,
): CompletionRequest {
  return CompletionRequestSchema.parse({
    prompt: "Mock prompt",
    options: {
      max_tokens: null,
      temperature: null,
      stop: null,
      tools: null,
    },
    ...overrides,
  });
}

// ── Completion Result ───────────────────────────────────────────────────────

/**
 * Create a valid CompletionResult with sensible defaults.
 * Not Zod-parsed since it's a return value, but matches the schema shape.
 */
export function createMockCompletionResult(
  overrides?: Partial<CompletionResult>,
): CompletionResult {
  return {
    content: "Mock completion response",
    tool_calls: null,
    finish_reason: "stop",
    usage: {
      tokens_in: 100,
      tokens_out: 50,
      spend_usd: null,
      remaining: null,
      resets_at: null,
    },
    ...overrides,
  };
}

// ── Tool Result ─────────────────────────────────────────────────────────────

/**
 * Create a Zod-valid ToolResult with sensible defaults.
 */
export function createMockToolResult(overrides?: Partial<ToolResult>): ToolResult {
  return ToolResultSchema.parse({
    success: true,
    output: "Mock tool output",
    side_effects: [],
    error: null,
    ...overrides,
  });
}
