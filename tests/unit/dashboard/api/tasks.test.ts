import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObservationStore } from "../../../../src/core/observer/index.js";
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
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, sub_state, phase, sub_phase, phase_iteration, total_reworks,
       priority, title, description, created_at, last_transition_at, blocked, reaped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `test:${id}`,
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
