import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ObservationStore, createObservationStore } from "../../../../src/core/observer/index.js";
import { taskRoutes } from "../../../../src/dashboard/api/tasks.js";
import { createInMemoryDatabase } from "../../../../src/db/database.js";
import type { DatabaseHandle } from "../../../../src/db/database.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Insert a task with all required NOT NULL columns. */
function insertTask(db: Database.Database, id: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    state: TaskStates.active,
    sub_state: SubStates.working as string | null,
    phase: null as string | null,
    sub_phase: null as string | null,
    phase_iteration: 0,
    total_reworks: 0,
    priority: 50,
    title: "Test task",
    description: "",
    created_at: "2026-01-15T10:30:00Z",
    last_transition_at: "2026-01-15T10:30:00Z",
    blocked: null as string | null,
    reaped_at: null as string | null,
    idempotency_key: `test:${id}`,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, phase, sub_phase, phase_iteration, total_reworks,
       priority, title, description, created_at, last_transition_at, blocked, reaped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.idempotency_key,
    defaults.state,
    defaults.sub_state,
    defaults.phase,
    defaults.sub_phase,
    defaults.phase_iteration,
    defaults.total_reworks,
    defaults.priority,
    defaults.title,
    defaults.description,
    defaults.created_at,
    defaults.last_transition_at,
    defaults.blocked,
    defaults.reaped_at,
  );
}

/** Insert an observation row carrying a trace_id (the dispatch's trace ULID). */
function insertObservation(
  db: Database.Database,
  id: string,
  taskId: string,
  traceId: string | null,
  startTime: string,
): void {
  db.prepare(
    `INSERT INTO observations (id, trace_id, type, name, task_id, start_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, traceId, "task_execution", "dispatch", taskId, startTime);
}

/** Insert a phase_transition observation carrying its phase in `input.phase` (the runner's real shape). */
function insertPhaseTransition(
  db: Database.Database,
  id: string,
  taskId: string,
  name: string,
  input: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO observations (id, type, name, task_id, start_time, input)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "phase_transition", name, taskId, "2026-01-15T10:30:00Z", JSON.stringify(input));
}

// The detail and cancel endpoints query deps.db directly and never touch the observation store; a bare stub
// satisfies the type.
const observationStoreStub = {} as unknown as ObservationStore;

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("taskRoutes — POST /:id/cancel", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof taskRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    // In-memory DB is a single connection; it serves as both the read and write handle.
    app = taskRoutes({ db: handle.db, writeDb: handle.db, observationStore: observationStoreStub });
  });

  afterEach(() => {
    handle.close();
  });

  it("cancels a cancellable task: transitions it to cancelled, bumps version, writes a transition row", async () => {
    insertTask(handle.db, "task-1", { state: TaskStates.active, sub_state: SubStates.working });

    const res = await app.request("/task-1/cancel", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const task = handle.db
      .prepare("SELECT state, sub_state, completed_at, version FROM tasks WHERE id = ?")
      .get("task-1") as {
      state: string;
      sub_state: string | null;
      completed_at: string | null;
      version: number;
    };
    expect(task.state).toBe(TaskStates.cancelled);
    expect(task.sub_state).toBeNull();
    expect(task.completed_at).not.toBeNull();
    // The cancel bumps `version` so it joins the daemon's optimistic-concurrency CAS — exactly one writer wins.
    expect(task.version).toBe(2);

    // A state_transitions row is written with the real schema columns (from_sub/to_sub, not *_sub_state).
    const transition = handle.db
      .prepare(
        "SELECT task_id, from_state, from_sub, to_state, to_sub, reason, triggered_by FROM state_transitions WHERE task_id = ?",
      )
      .get("task-1") as {
      task_id: string;
      from_state: string;
      from_sub: string | null;
      to_state: string;
      to_sub: string | null;
      reason: string;
      triggered_by: string;
    };
    expect(transition.from_state).toBe(TaskStates.active);
    expect(transition.from_sub).toBe(SubStates.working);
    expect(transition.to_state).toBe(TaskStates.cancelled);
    expect(transition.to_sub).toBeNull();
    expect(transition.triggered_by).toBe("dashboard");
    expect(transition.reason).toBe("dashboard_cancel");
  });

  it("returns 400 for a task in a non-cancellable state", async () => {
    insertTask(handle.db, "task-done", { state: TaskStates.completed, sub_state: null });

    const res = await app.request("/task-done/cancel", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("Cannot cancel"),
    });

    // The task is untouched and no transition was written.
    const task = handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-done") as { state: string };
    expect(task.state).toBe(TaskStates.completed);
    const count = handle.db
      .prepare("SELECT COUNT(*) AS n FROM state_transitions WHERE task_id = ?")
      .get("task-done") as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns 404 when the task does not exist", async () => {
    const res = await app.request("/missing/cancel", { method: "POST" });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Task not found" });
  });
});

describe("taskRoutes — POST /:id/retry", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof taskRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    app = taskRoutes({ db: handle.db, writeDb: handle.db, observationStore: observationStoreStub });
  });

  afterEach(() => {
    handle.close();
  });

  it("retries a failed task: re-queues it, bumps version, writes a transition row", async () => {
    insertTask(handle.db, "task-failed", { state: TaskStates.failed, sub_state: null });

    const res = await app.request("/task-failed/retry", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const task = handle.db.prepare("SELECT state, version FROM tasks WHERE id = ?").get("task-failed") as {
      state: string;
      version: number;
    };
    expect(task.state).toBe(TaskStates.queued);
    expect(task.version).toBe(2);

    const transition = handle.db
      .prepare("SELECT from_state, to_state, reason, triggered_by FROM state_transitions WHERE task_id = ?")
      .get("task-failed") as { from_state: string; to_state: string; reason: string; triggered_by: string };
    expect(transition.from_state).toBe(TaskStates.failed);
    expect(transition.to_state).toBe(TaskStates.queued);
    expect(transition.reason).toBe("dashboard_retry");
    expect(transition.triggered_by).toBe("dashboard");
  });

  it("retries a blocked task", async () => {
    insertTask(handle.db, "task-blocked", { state: TaskStates.blocked, sub_state: null });

    const res = await app.request("/task-blocked/retry", { method: "POST" });

    expect(res.status).toBe(200);
    const task = handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-blocked") as { state: string };
    expect(task.state).toBe(TaskStates.queued);
  });

  it("resumes a cancelled task whose work still exists (reaped_at NULL)", async () => {
    insertTask(handle.db, "task-cancelled", { state: TaskStates.cancelled, sub_state: null, reaped_at: null });

    const res = await app.request("/task-cancelled/retry", { method: "POST" });

    expect(res.status).toBe(200);
    const task = handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-cancelled") as { state: string };
    expect(task.state).toBe(TaskStates.queued);
  });

  it("returns 409 when resuming a cancelled task whose work was already reaped", async () => {
    insertTask(handle.db, "task-reaped", {
      state: TaskStates.cancelled,
      sub_state: null,
      reaped_at: "2026-01-16T09:00:00Z",
    });

    const res = await app.request("/task-reaped/retry", { method: "POST" });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("cleaned up"),
    });
    // Untouched — still cancelled.
    const task = handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-reaped") as { state: string };
    expect(task.state).toBe(TaskStates.cancelled);
  });

  it("returns 409 when a newer task already holds the source's idempotency key", async () => {
    // Cancel freed the key; a fresh task was triggered from the same source and is live.
    insertTask(handle.db, "task-old", {
      state: TaskStates.cancelled,
      sub_state: null,
      reaped_at: null,
      idempotency_key: "github:issue-7",
    });
    insertTask(handle.db, "task-new", { state: TaskStates.queued, sub_state: null, idempotency_key: "github:issue-7" });

    const res = await app.request("/task-old/retry", { method: "POST" });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("task-new"),
    });
    // The cancelled task is untouched; the live clone stands.
    const task = handle.db.prepare("SELECT state FROM tasks WHERE id = ?").get("task-old") as { state: string };
    expect(task.state).toBe(TaskStates.cancelled);
  });

  it("returns 400 for a task in a non-retryable state", async () => {
    insertTask(handle.db, "task-active", { state: TaskStates.active, sub_state: SubStates.working });

    const res = await app.request("/task-active/retry", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("Cannot retry"),
    });

    const count = handle.db
      .prepare("SELECT COUNT(*) AS n FROM state_transitions WHERE task_id = ?")
      .get("task-active") as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns 404 when the task does not exist", async () => {
    const res = await app.request("/missing/retry", { method: "POST" });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Task not found" });
  });
});

describe("taskRoutes — POST /:id/rerun", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof taskRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    app = taskRoutes({ db: handle.db, writeDb: handle.db, observationStore: observationStoreStub });
  });

  afterEach(() => {
    handle.close();
  });

  it("writes a task.rerun_requested event for a cancelled task", async () => {
    insertTask(handle.db, "task-reaped", {
      state: TaskStates.cancelled,
      sub_state: null,
      reaped_at: "2026-01-16T09:00:00Z",
    });

    const res = await app.request("/task-reaped/rerun", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const event = handle.db
      .prepare("SELECT type, source, task_id, payload FROM events WHERE task_id = ?")
      .get("task-reaped") as { type: string; source: string; task_id: string; payload: string };
    expect(event.type).toBe("task.rerun_requested");
    expect(event.source).toBe("dashboard");
    expect(JSON.parse(event.payload)).toEqual({ task_id: "task-reaped" });
  });

  it("returns 409 and writes no event for a cancelled task that is not yet reaped (still resumable)", async () => {
    insertTask(handle.db, "task-unreaped", { state: TaskStates.cancelled, sub_state: null, reaped_at: null });

    const res = await app.request("/task-unreaped/rerun", { method: "POST" });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("resumed") });
    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns 400 and writes no event when the task is not cancelled", async () => {
    insertTask(handle.db, "task-active", { state: TaskStates.active, sub_state: SubStates.working });

    const res = await app.request("/task-active/rerun", { method: "POST" });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("can be re-run") });
    const count = handle.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns 404 when the task does not exist", async () => {
    const res = await app.request("/missing/rerun", { method: "POST" });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "Task not found" });
  });
});

describe("taskRoutes — GET /:id trace_otlp_id", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof taskRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    app = taskRoutes({ db: handle.db, writeDb: handle.db, observationStore: observationStoreStub });
  });

  afterEach(() => {
    handle.close();
  });

  async function detailTraceId(taskId: string): Promise<unknown> {
    const res = await app.request(`/${taskId}`);
    const body = (await res.json()) as { task: { trace_otlp_id: unknown } };
    return body.task.trace_otlp_id;
  }

  it("derives the OTLP trace id from the task's dispatch via the shared deriveTraceId (no drift)", async () => {
    insertTask(handle.db, "task-traced");
    // The canonical ULID spec vector; deriveTraceId decodes it to this exact hex (asserted in the otlp tests).
    insertObservation(handle.db, "obs-1", "task-traced", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "2026-01-15T10:30:00Z");

    expect(await detailTraceId("task-traced")).toBe("01563e3ab5d3d6764c61efb99302bd5b");
  });

  it("uses the most recent dispatch when a task has been dispatched more than once", async () => {
    insertTask(handle.db, "task-multi");
    insertObservation(handle.db, "obs-old", "task-multi", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "2026-01-15T10:30:00Z");
    // A later dispatch mints a fresh trace ULID; the link should open it, not the stale one.
    insertObservation(handle.db, "obs-new", "task-multi", "01BX5ZZKBKACTAV9WEVGEMMVRZ", "2026-01-15T12:00:00Z");

    const otlpId = await detailTraceId("task-multi");
    expect(otlpId).not.toBe("01563e3ab5d3d6764c61efb99302bd5b");
    expect(otlpId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is null when the task has no observation carrying a trace_id", async () => {
    insertTask(handle.db, "task-untraced");
    insertObservation(handle.db, "obs-null", "task-untraced", null, "2026-01-15T10:30:00Z");

    expect(await detailTraceId("task-untraced")).toBeNull();
  });

  it("is null (does not 500) when a stored trace_id is not a valid ULID", async () => {
    insertTask(handle.db, "task-bad");
    insertObservation(handle.db, "obs-bad", "task-bad", "not-a-ulid", "2026-01-15T10:30:00Z");

    expect(await detailTraceId("task-bad")).toBeNull();
  });
});

describe("taskRoutes — GET / phases_ran and loop columns", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof taskRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    app = taskRoutes({ db: handle.db, writeDb: handle.db, observationStore: observationStoreStub });
  });

  afterEach(() => {
    handle.close();
  });

  async function listTasks(): Promise<Record<string, unknown>[]> {
    const res = await app.request("/");
    const body = (await res.json()) as { tasks: Record<string, unknown>[] };
    return body.tasks;
  }

  it("derives distinct REAL phases from observation input.phase, not the observation name", async () => {
    insertTask(handle.db, "task-1");
    // The runner stores the phase in input.phase; the `name` column holds the EVENT name, which the old
    // (broken) implementation collected — meaningless strings like "phase_entered".
    insertPhaseTransition(handle.db, "o1", "task-1", "phase_entered", { phase: "research" });
    insertPhaseTransition(handle.db, "o2", "task-1", "sub_phase_started", {
      phase: "research",
      subPhase: "investigate",
    });
    insertPhaseTransition(handle.db, "o3", "task-1", "phase_entered", { phase: "planning" });

    const [task] = await listTasks();

    // Distinct real phases, first-seen order — never the event names.
    expect(task?.["phases_ran"]).toEqual(["research", "planning"]);
  });

  it("ignores values in input.phase that are not real pipeline phases", async () => {
    insertTask(handle.db, "task-junk");
    insertPhaseTransition(handle.db, "j1", "task-junk", "phase_entered", { phase: "execution" });
    // Stale/garbage phase names (the very thing the old vocabulary drifted to) are dropped.
    insertPhaseTransition(handle.db, "j2", "task-junk", "phase_entered", { phase: "self_review" });
    insertPhaseTransition(handle.db, "j3", "task-junk", "sub_phase_started", { subPhase: "verify" });

    const [task] = await listTasks();

    expect(task?.["phases_ran"]).toEqual(["execution"]);
  });

  it("exposes sub_phase, phase_iteration, and total_reworks on the list row", async () => {
    insertTask(handle.db, "task-loop", {
      phase: "execution",
      sub_phase: "verify",
      phase_iteration: 2,
      total_reworks: 1,
    });

    const [task] = await listTasks();

    expect(task?.["phase"]).toBe("execution");
    expect(task?.["sub_phase"]).toBe("verify");
    expect(task?.["phase_iteration"]).toBe(2);
    expect(task?.["total_reworks"]).toBe(1);
  });

  it("surfaces the coarse block_reason enum from the blocked payload, for the block-reason filter", async () => {
    insertTask(handle.db, "task-blocked", {
      state: TaskStates.blocked,
      blocked: JSON.stringify({
        reason: "need_more_info",
        category: "awaiting_human",
        sub_phase: "gather",
        needed: "Confirm the target repo",
      }),
    });

    const [task] = await listTasks();

    expect(task?.["block_reason"]).toBe("need_more_info");
  });

  it("leaves block_reason null when the task is not blocked, and surfaces reaped_at when set", async () => {
    insertTask(handle.db, "task-done", {
      state: TaskStates.completed,
      reaped_at: "2026-01-16T09:00:00Z",
    });

    const [task] = await listTasks();

    expect(task?.["block_reason"]).toBeNull();
    expect(task?.["reaped_at"]).toBe("2026-01-16T09:00:00Z");
  });
});

describe("taskRoutes — GET /:id/agent-activity", () => {
  let handle: DatabaseHandle;
  let store: ObservationStore;
  let app: ReturnType<typeof taskRoutes>;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    // The agent-activity route reads through the real ObservationStore (not the stub the other suites use).
    store = createObservationStore(handle.db);
    app = taskRoutes({ db: handle.db, writeDb: handle.db, observationStore: store });
    insertTask(handle.db, "task-1");
  });

  afterEach(() => {
    handle.close();
  });

  /** Write an agent_call span and return its id, so child activities can parent on it. */
  function openAgentCall(taskId: string, name: string): string {
    return store.startSpan("agent_call", name, undefined, { task_id: taskId }).id;
  }

  /** Write one agent_activity child under a call. */
  function writeActivity(taskId: string, callId: string, name: string, data: Record<string, unknown>): void {
    store.observe("agent_activity", name, data, { task_id: taskId, parent_observation_id: callId });
  }

  async function fetchActivities(taskId: string, call: string | null): Promise<Record<string, unknown>[]> {
    const query = call === null ? "" : `?call=${encodeURIComponent(call)}`;
    const res = await app.request(`/${taskId}/agent-activity${query}`);
    const body = (await res.json()) as { activities: Record<string, unknown>[] };
    return body.activities;
  }

  it("returns one call's agent_activity children in insertion order", async () => {
    const call = openAgentCall("task-1", "implement");
    writeActivity("task-1", call, "assistant_text", { kind: "assistant_text", text: "Reading the file." });
    writeActivity("task-1", call, "Bash", { kind: "tool_use", tool_call_id: "t1", name: "Bash", input: "ls" });
    writeActivity("task-1", call, "tool_result", {
      kind: "tool_result",
      tool_call_id: "t1",
      status: "ok",
      output: "a\nb",
    });

    const activities = await fetchActivities("task-1", call);

    expect(activities.map((a) => a["name"])).toEqual(["assistant_text", "Bash", "tool_result"]);
    expect(activities.every((a) => a["parent_observation_id"] === call)).toBe(true);
    expect(activities.every((a) => a["type"] === "agent_activity")).toBe(true);
  });

  it("does not leak another call's activities", async () => {
    const callA = openAgentCall("task-1", "implement");
    const callB = openAgentCall("task-1", "verify");
    writeActivity("task-1", callA, "assistant_text", { kind: "assistant_text", text: "A" });
    writeActivity("task-1", callB, "assistant_text", { kind: "assistant_text", text: "B" });

    const activities = await fetchActivities("task-1", callA);

    expect(activities).toHaveLength(1);
    expect((activities[0]?.["input"] as Record<string, unknown>)["text"]).toBe("A");
  });

  it("scopes by task_id so a foreign call id surfaces nothing", async () => {
    insertTask(handle.db, "task-2");
    const foreignCall = openAgentCall("task-2", "implement");
    writeActivity("task-2", foreignCall, "assistant_text", { kind: "assistant_text", text: "foreign" });

    // The call belongs to task-2; asking for it under task-1 must return nothing.
    expect(await fetchActivities("task-1", foreignCall)).toEqual([]);
  });

  it("returns an empty list when the call query param is absent", async () => {
    const call = openAgentCall("task-1", "implement");
    writeActivity("task-1", call, "assistant_text", { kind: "assistant_text", text: "hi" });

    expect(await fetchActivities("task-1", null)).toEqual([]);
  });
});
