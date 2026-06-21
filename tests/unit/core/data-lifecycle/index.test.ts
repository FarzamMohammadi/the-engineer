import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOrphanedBlobs,
  cleanupTable,
  collectReferencedBlobRefs,
  createDataLifecycleManager,
  observationsCarryBlobRefs,
} from "../../../../src/core/data-lifecycle/index.js";
import { EventBus } from "../../../../src/core/event-bus/index.js";
import { BlobStore } from "../../../../src/core/observer/blob-store.js";
import { createDatabase, runIncrementalVacuum } from "../../../../src/db/database.js";
import {
  DaemonConfigSchema,
  DataLifecycleConfigSchema,
  DatabaseTuningConfigSchema,
} from "../../../../src/schemas/config.js";
import type { DataLifecycleConfig } from "../../../../src/schemas/config.js";
import { createTestDatabase } from "../../../helpers/test-database.js";
import type { TestDatabaseHandle } from "../../../helpers/test-database.js";
import { createTestEventBus } from "../../../helpers/test-event-bus.js";
import type { TestEventBusHandle } from "../../../helpers/test-event-bus.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultConfig(overrides?: Partial<DataLifecycleConfig>): DataLifecycleConfig {
  return {
    enabled: true,
    interval_ms: 3_600_000,
    retention: {
      events: { max_age_days: 90 },
      observations: { max_age_days: 90 },
      journal_entries: { max_age_days: 90 },
      checkpoints: { max_age_days: 90 },
    },
    ...overrides,
  };
}

function insertEvent(db: TestDatabaseHandle["db"], timestamp: string, id?: string): void {
  insertEventForTask(db, timestamp, null, id);
}

/** Insert an event row owned by a specific task (or task_id NULL for a system-level event). */
function insertEventForTask(db: TestDatabaseHandle["db"], timestamp: string, taskId: string | null, id?: string): void {
  db.prepare("INSERT INTO events (id, type, source, task_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
    id ?? `evt-${Date.now()}-${Math.random()}`,
    "test.event",
    "test",
    taskId,
    timestamp,
    "{}",
  );
}

/** Insert a minimal task row in the given state so active-task protection has something to protect. */
function insertTask(db: TestDatabaseHandle["db"], id: string, state: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, state, title, created_at, last_transition_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `idem-${id}`, state, `task ${id}`, now, now);
}

/** Insert an observation row owned by a specific task (or task_id NULL for a system-level observation). */
function insertObservationForTask(db: TestDatabaseHandle["db"], timestamp: string, taskId: string | null): void {
  db.prepare(
    `INSERT INTO observations (id, type, name, task_id, start_time, end_time, level, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`obs-${Date.now()}-${Math.random()}`, "lifecycle", "test_obs", taskId, timestamp, timestamp, "info", "ok");
}

function insertObservation(
  db: TestDatabaseHandle["db"],
  timestamp: string,
  type: string,
  name: string,
  input?: Record<string, unknown> | null,
  output?: Record<string, unknown> | null,
): void {
  db.prepare(
    `INSERT INTO observations (id, type, name, task_id, start_time, end_time, level, status, input, output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `obs-${Date.now()}-${Math.random()}`,
    type,
    name,
    "task-1",
    timestamp,
    timestamp,
    "info",
    "ok",
    input ? JSON.stringify(input) : null,
    output ? JSON.stringify(output) : null,
  );
}

/**
 * Insert an `agent_call` row in the exact shape the engine emits: the prompt ref lives in `input`, the
 * result/transcript refs in `output` (see `agent-step.ts`). Refs left undefined are omitted, matching a run
 * that captured no blob for that slot.
 */
function insertAgentCall(
  db: TestDatabaseHandle["db"],
  timestamp: string,
  refs: { promptBlob?: string; resultBlob?: string; transcriptBlob?: string },
): void {
  insertObservation(
    db,
    timestamp,
    "agent_call",
    "implement",
    { step: "implement", prompt_blob: refs.promptBlob ?? null },
    {
      outcome: "ok",
      cost_usd: 0.01,
      result_blob: refs.resultBlob ?? null,
      transcript_blob: refs.transcriptBlob ?? null,
    },
  );
}

/**
 * Insert an `agent_activity` row in the shape the activity sink emits: its spilled-text/tool-I/O refs live in
 * `input` (`text_blob` / `input_blob` / `output_blob`, see `agent-activity/sink.ts`).
 */
function insertAgentActivity(
  db: TestDatabaseHandle["db"],
  timestamp: string,
  refs: { textBlob?: string; inputBlob?: string; outputBlob?: string },
): void {
  insertObservation(db, timestamp, "agent_activity", "assistant_text", {
    kind: "assistant_text",
    truncated: true,
    text_blob: refs.textBlob ?? null,
    input_blob: refs.inputBlob ?? null,
    output_blob: refs.outputBlob ?? null,
  });
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function createFakeClock(now = Date.now()): { now: () => number } {
  return { now: () => now };
}

/** A realistic blob ref — `<2-hex-prefix>/<64-hex-hash>` — built from a short seed for readable assertions. */
function makeRef(prefix: string, seedChar: string): string {
  return `${prefix}/${seedChar.repeat(64)}`;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cleanupTable", () => {
  let dbHandle: TestDatabaseHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  it("deletes events older than max_age_days", () => {
    insertEvent(dbHandle.db, daysAgo(100)); // old
    insertEvent(dbHandle.db, daysAgo(50)); // recent
    insertEvent(dbHandle.db, new Date().toISOString()); // now

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    const result = cleanupTable({
      db: dbHandle.db,
      tableName: "events",
      timestampColumn: "timestamp",
      cutoffISO: cutoff,
      excludeActiveTasks: false,
    });

    expect(result.deleted).toBe(1);
    expect(result.remaining).toBe(2);
  });

  it("preserves events within max_age_days", () => {
    insertEvent(dbHandle.db, daysAgo(10));
    insertEvent(dbHandle.db, daysAgo(5));

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    const result = cleanupTable({
      db: dbHandle.db,
      tableName: "events",
      timestampColumn: "timestamp",
      cutoffISO: cutoff,
      excludeActiveTasks: false,
    });

    expect(result.deleted).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it("handles empty table", () => {
    const cutoff = new Date().toISOString();
    const result = cleanupTable({
      db: dbHandle.db,
      tableName: "events",
      timestampColumn: "timestamp",
      cutoffISO: cutoff,
      excludeActiveTasks: false,
    });

    expect(result.deleted).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it("is idempotent — running twice does nothing extra", () => {
    insertEvent(dbHandle.db, daysAgo(100));
    insertEvent(dbHandle.db, new Date().toISOString());

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    const first = cleanupTable({
      db: dbHandle.db,
      tableName: "events",
      timestampColumn: "timestamp",
      cutoffISO: cutoff,
      excludeActiveTasks: false,
    });
    const second = cleanupTable({
      db: dbHandle.db,
      tableName: "events",
      timestampColumn: "timestamp",
      cutoffISO: cutoff,
      excludeActiveTasks: false,
    });

    expect(first.deleted).toBe(1);
    expect(second.deleted).toBe(0);
    expect(second.remaining).toBe(1);
  });

  it("works with observations table and start_time column", () => {
    insertObservation(dbHandle.db, daysAgo(100), "tool_execution", "read_file");
    insertObservation(dbHandle.db, daysAgo(10), "tool_execution", "write_file");

    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000).toISOString();
    const result = cleanupTable({
      db: dbHandle.db,
      tableName: "observations",
      timestampColumn: "start_time",
      cutoffISO: cutoff,
      excludeActiveTasks: false,
    });

    expect(result.deleted).toBe(1);
    expect(result.remaining).toBe(1);
  });

  // D5: with active-task protection, the NULL-safe clause must prune system rows (task_id IS NULL) and
  // terminal-task rows by age, while protecting live-task rows — and it must do so DETERMINISTICALLY,
  // whether or not any task is currently active. A bare `task_id NOT IN (active set)` would retain every
  // system row whenever a task is active (NULL NOT IN non-empty = NULL) and prune them when none is, an
  // intermittent unbounded leak on the two highest-volume tables. These four cases lock that out.
  describe("NULL-safe active-task protection", () => {
    function seedThreeOldEvents(db: TestDatabaseHandle["db"]): void {
      insertTask(db, "live", "active");
      insertTask(db, "done", "completed");
      insertEventForTask(db, daysAgo(100), "live"); // active-task event — must survive
      insertEventForTask(db, daysAgo(100), "done"); // terminal-task event — must prune
      insertEventForTask(db, daysAgo(100), null); // system event — must prune
    }

    function pruneOldEvents(db: TestDatabaseHandle["db"]): ReturnType<typeof cleanupTable> {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
      return cleanupTable({
        db,
        tableName: "events",
        timestampColumn: "timestamp",
        cutoffISO: cutoff,
        excludeActiveTasks: true,
      });
    }

    it("prunes a terminal-task event and a system event but protects an active-task event", () => {
      seedThreeOldEvents(dbHandle.db);

      const result = pruneOldEvents(dbHandle.db);

      // terminal + system pruned; the one active-task event remains
      expect(result.deleted).toBe(2);
      expect(result.remaining).toBe(1);
      const survivor = dbHandle.db.prepare("SELECT task_id FROM events").get() as { task_id: string | null };
      expect(survivor.task_id).toBe("live");
    });

    it("prunes the same system event identically when no task is active (determinism)", () => {
      // No active task at all — only a terminal task and a system event, both old.
      insertTask(dbHandle.db, "done", "completed");
      insertEventForTask(dbHandle.db, daysAgo(100), "done");
      insertEventForTask(dbHandle.db, daysAgo(100), null);

      const result = pruneOldEvents(dbHandle.db);

      // Both prune — the system event is NOT retained just because the active set happens to be empty.
      expect(result.deleted).toBe(2);
      expect(result.remaining).toBe(0);
    });

    it("protects an active-task observation but prunes terminal-task and system observations", () => {
      insertTask(dbHandle.db, "live", "active");
      insertTask(dbHandle.db, "done", "completed");
      insertObservationForTask(dbHandle.db, daysAgo(100), "live");
      insertObservationForTask(dbHandle.db, daysAgo(100), "done");
      insertObservationForTask(dbHandle.db, daysAgo(100), null);

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
      const result = cleanupTable({
        db: dbHandle.db,
        tableName: "observations",
        timestampColumn: "start_time",
        cutoffISO: cutoff,
        excludeActiveTasks: true,
      });

      expect(result.deleted).toBe(2);
      expect(result.remaining).toBe(1);
      const survivor = dbHandle.db.prepare("SELECT task_id FROM observations").get() as { task_id: string | null };
      expect(survivor.task_id).toBe("live");
    });

    it("prunes the same system observation identically when no task is active (determinism)", () => {
      insertTask(dbHandle.db, "done", "completed");
      insertObservationForTask(dbHandle.db, daysAgo(100), "done");
      insertObservationForTask(dbHandle.db, daysAgo(100), null);

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
      const result = cleanupTable({
        db: dbHandle.db,
        tableName: "observations",
        timestampColumn: "start_time",
        cutoffISO: cutoff,
        excludeActiveTasks: true,
      });

      expect(result.deleted).toBe(2);
      expect(result.remaining).toBe(0);
    });
  });
});

describe("collectReferencedBlobRefs", () => {
  let dbHandle: TestDatabaseHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  it("collects the agent_call prompt ref from input AND the result/transcript refs from output", () => {
    // The bug this guards against: the prompt ref lives in `input`, but the result and transcript refs live
    // in `output`. Collecting only the input side left every result/transcript blob looking like an orphan.
    insertAgentCall(dbHandle.db, new Date().toISOString(), {
      promptBlob: makeRef("ab", "1"),
      resultBlob: makeRef("cd", "2"),
      transcriptBlob: makeRef("ef", "3"),
    });

    const refs = collectReferencedBlobRefs(dbHandle.db);

    expect(refs.size).toBe(3);
    expect(refs.has(makeRef("ab", "1"))).toBe(true);
    expect(refs.has(makeRef("cd", "2"))).toBe(true);
    expect(refs.has(makeRef("ef", "3"))).toBe(true);
  });

  it("collects the text/input/output refs an agent_activity row carries in its input", () => {
    insertAgentActivity(dbHandle.db, new Date().toISOString(), {
      textBlob: makeRef("11", "a"),
      inputBlob: makeRef("22", "b"),
      outputBlob: makeRef("33", "c"),
    });

    const refs = collectReferencedBlobRefs(dbHandle.db);

    expect(refs.size).toBe(3);
    expect(refs.has(makeRef("11", "a"))).toBe(true);
    expect(refs.has(makeRef("22", "b"))).toBe(true);
    expect(refs.has(makeRef("33", "c"))).toBe(true);
  });

  it("protects a not-yet-written *_blob key with no code change (matches the convention, not a key list)", () => {
    // The point of matching the `*_blob` convention rather than a hardcoded key list: a new ref field is
    // covered for free. A hypothetical `diff_blob` must be collected without touching collectReferencedBlobRefs.
    insertObservation(dbHandle.db, new Date().toISOString(), "agent_call", "implement", {
      step: "implement",
      diff_blob: makeRef("99", "d"),
    });

    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.has(makeRef("99", "d"))).toBe(true);
  });

  it("excludes a *_blob value that clears the SQL shape guard but is not a full ref", () => {
    // `ab/short` passes the cheap `__/%` SQL prefilter but is not a real <2-hex>/<64-hex> ref — the JS-side
    // isBlobRef validation drops it, so a malformed value never enters the protected set.
    insertObservation(dbHandle.db, new Date().toISOString(), "agent_call", "implement", {
      step: "implement",
      prompt_blob: "ab/short",
    });

    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(0);
  });

  it("skips null refs", () => {
    insertAgentCall(dbHandle.db, new Date().toISOString(), {});

    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(0);
  });

  it("returns empty set when no observations exist", () => {
    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(0);
  });

  it("deduplicates shared refs", () => {
    insertAgentCall(dbHandle.db, new Date().toISOString(), {
      promptBlob: makeRef("ab", "1"),
      resultBlob: makeRef("cd", "2"),
    });
    insertAgentCall(dbHandle.db, new Date().toISOString(), {
      promptBlob: makeRef("ab", "1"),
      resultBlob: makeRef("cd", "2"),
    });

    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(2);
  });
});

describe("observationsCarryBlobRefs", () => {
  let dbHandle: TestDatabaseHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  it("is true when an agent observation carries a *_blob key, even a failed (empty) capture", () => {
    insertObservation(dbHandle.db, new Date().toISOString(), "agent_call", "implement", {
      step: "implement",
      prompt_blob: "",
    });
    expect(observationsCarryBlobRefs(dbHandle.db)).toBe(true);
  });

  it("is false when no agent observation carries a *_blob key", () => {
    insertObservation(dbHandle.db, new Date().toISOString(), "lifecycle", "tick", { phase: "queued" });
    expect(observationsCarryBlobRefs(dbHandle.db)).toBe(false);
  });
});

describe("cleanupOrphanedBlobs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-blob-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes unreferenced blob files", () => {
    // Create blob structure
    const prefix = path.join(tmpDir, "ab");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, "abc123.txt"), "content");
    fs.writeFileSync(path.join(prefix, "abd456.txt"), "content");

    const referenced = new Set(["ab/abc123"]);
    const { deleted } = cleanupOrphanedBlobs(tmpDir, referenced);

    expect(deleted).toBe(1);
    expect(fs.existsSync(path.join(prefix, "abc123.txt"))).toBe(true);
    expect(fs.existsSync(path.join(prefix, "abd456.txt"))).toBe(false);
  });

  it("preserves referenced blob files", () => {
    const prefix = path.join(tmpDir, "cd");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, "cde789.txt"), "content");

    const referenced = new Set(["cd/cde789"]);
    const { deleted } = cleanupOrphanedBlobs(tmpDir, referenced);

    expect(deleted).toBe(0);
    expect(fs.existsSync(path.join(prefix, "cde789.txt"))).toBe(true);
  });

  it("handles missing blobs directory gracefully", () => {
    const { deleted } = cleanupOrphanedBlobs("/nonexistent/path", new Set());
    expect(deleted).toBe(0);
  });

  it("removes empty prefix directories", () => {
    const prefix = path.join(tmpDir, "ef");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, "efg000.txt"), "content");

    const referenced = new Set<string>();
    cleanupOrphanedBlobs(tmpDir, referenced);

    expect(fs.existsSync(prefix)).toBe(false);
  });

  it("skips deletion when prefix directory is a symlink to external path", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-outside-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "precious.txt"), "do not delete");

      // Create a symlinked prefix directory inside blobsDir pointing outside
      fs.symlinkSync(outsideDir, path.join(tmpDir, "zz"));

      const { deleted } = cleanupOrphanedBlobs(tmpDir, new Set());

      // The file in the external directory should NOT have been deleted
      expect(deleted).toBe(0);
      expect(fs.existsSync(path.join(outsideDir, "precious.txt"))).toBe(true);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns count of deleted blobs", () => {
    const prefix1 = path.join(tmpDir, "aa");
    const prefix2 = path.join(tmpDir, "bb");
    fs.mkdirSync(prefix1);
    fs.mkdirSync(prefix2);
    fs.writeFileSync(path.join(prefix1, "aaa.txt"), "x");
    fs.writeFileSync(path.join(prefix1, "aab.txt"), "x");
    fs.writeFileSync(path.join(prefix2, "bbb.txt"), "x");

    const { deleted, scanned } = cleanupOrphanedBlobs(tmpDir, new Set());
    expect(deleted).toBe(3);
    expect(scanned).toBe(3); // every blob file is walked, whether or not it is removed
  });
});

describe("createDataLifecycleManager", () => {
  let dbHandle: TestDatabaseHandle;
  let ebHandle: TestEventBusHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
    ebHandle = createTestEventBus();
  });

  afterEach(() => {
    dbHandle.cleanup();
    ebHandle.cleanup();
  });

  it("runCleanup processes all 4 tables", () => {
    // Insert old data in events table
    insertEvent(dbHandle.db, daysAgo(100));
    insertEvent(dbHandle.db, new Date().toISOString());

    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: null,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    const stats = manager.runCleanup();

    expect(stats.tables).toHaveProperty("events");
    expect(stats.tables).toHaveProperty("observations");
    expect(stats.tables).toHaveProperty("journal_entries");
    expect(stats.tables).toHaveProperty("checkpoints");
    expect(stats.tables["events"]?.deleted).toBe(1);
    expect(stats.tables["events"]?.remaining).toBe(1);
  });

  it("emits system.cleanup_completed event", () => {
    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: null,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    manager.runCleanup();

    // The event is emitted on the ebHandle's eventBus, not dbHandle's
    // Since we use two different databases, check ebHandle
    ebHandle.assertEventEmitted("system.cleanup_completed");
    const events = ebHandle.getEmittedEvents("system.cleanup_completed");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toHaveProperty("duration_ms");
    expect(events[0]?.payload).toHaveProperty("tables");
    expect(events[0]?.payload).toHaveProperty("blobs_referenced");
    expect(events[0]?.payload).toHaveProperty("blobs_scanned");
    expect(events[0]?.payload).toHaveProperty("blobs_deleted");
    expect(events[0]?.payload).toHaveProperty("vacuum_ran");
  });

  it("tripwire: skips blob cleanup when the protected set is empty but observations still carry blob refs", () => {
    // A failed capture writes `prompt_blob: ""`: collectReferencedBlobRefs excludes the empty value, so the
    // protected set is empty, yet observationsCarryBlobRefs still sees the `prompt_blob` key. That is the drift
    // signature — the sweep must skip and warn, never delete every blob against an empty set.
    insertObservation(dbHandle.db, new Date().toISOString(), "agent_call", "implement", {
      step: "implement",
      prompt_blob: "",
    });

    const blobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-tripwire-"));
    const blobFile = path.join(blobsRoot, "blobs", "ab", `${"a".repeat(64)}.txt`);
    fs.mkdirSync(path.dirname(blobFile), { recursive: true });
    fs.writeFileSync(blobFile, "precious");

    try {
      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config: defaultConfig(),
        blobsDir: blobsRoot,
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      const stats = manager.runCleanup();

      expect(fs.existsSync(blobFile)).toBe(true); // not swept — the tripwire held
      expect(stats.blobsReferenced).toBe(0);
      expect(stats.blobsScanned).toBe(0); // cleanup skipped entirely — nothing walked
      expect(stats.blobsDeleted).toBe(0);
    } finally {
      fs.rmSync(blobsRoot, { recursive: true, force: true });
    }
  });

  it("does not over-trip: sweeps genuine orphans when no observation carries a blob ref", () => {
    // No agent observation carries a `*_blob` key, so an on-disk blob is a real orphan and must be reclaimed —
    // proving the tripwire fires only on the drift signature, not on a legitimately empty store.
    const blobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-no-trip-"));
    const orphan = path.join(blobsRoot, "blobs", "ab", `${"a".repeat(64)}.txt`);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, "orphan");

    try {
      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config: defaultConfig(),
        blobsDir: blobsRoot,
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      const stats = manager.runCleanup();

      expect(fs.existsSync(orphan)).toBe(false); // swept normally
      expect(stats.blobsScanned).toBe(1);
      expect(stats.blobsDeleted).toBe(1);
    } finally {
      fs.rmSync(blobsRoot, { recursive: true, force: true });
    }
  });

  it("getLastRun returns null before first run", () => {
    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: null,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    expect(manager.getLastRun()).toBeNull();
  });

  it("getLastRun returns stats after cleanup", () => {
    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: null,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    const stats = manager.runCleanup();
    expect(manager.getLastRun()).toBe(stats);
  });

  it("start sets interval and stop clears it", () => {
    vi.useFakeTimers();
    try {
      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config: defaultConfig({ interval_ms: 1000 }),
        blobsDir: null,
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      manager.start();

      // Fast-forward past interval
      vi.advanceTimersByTime(1000);
      expect(manager.getLastRun()).not.toBeNull();

      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start when enabled is false", () => {
    vi.useFakeTimers();
    try {
      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config: defaultConfig({ enabled: false, interval_ms: 100 }),
        blobsDir: null,
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      manager.start();
      vi.advanceTimersByTime(200);
      expect(manager.getLastRun()).toBeNull();

      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start twice", () => {
    vi.useFakeTimers();
    try {
      const config = defaultConfig({ interval_ms: 100 });
      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config,
        blobsDir: null,
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      manager.start();
      manager.start(); // second start should be no-op

      vi.advanceTimersByTime(100);
      // If it started twice, we'd see more than one cleanup event
      const events = ebHandle.getEmittedEvents("system.cleanup_completed");
      expect(events.length).toBe(1);

      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop is safe to call when not started", () => {
    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: null,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    // Should not throw
    manager.stop();
  });

  // D11: a sweep emits a rich liveness observation so the dashboard's task-less trace timeline shows the
  // service is alive — even a 0-row sweep emits (correct for liveness, not noise).
  it("emits a data_lifecycle_sweep_completed observation with the sweep tallies", () => {
    insertEvent(dbHandle.db, daysAgo(100)); // one old event to prune
    const observer = createTestObserverFacade("data-lifecycle");
    const observeSpy = vi.spyOn(observer, "observe");

    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: null,
      clock: createFakeClock(),
      observer,
    });

    manager.runCleanup();

    const sweepObs = observeSpy.mock.calls.find(([, name]) => name === "data_lifecycle_sweep_completed");
    expect(sweepObs).toBeDefined();
    const [type, , data] = sweepObs ?? [];
    expect(type).toBe("state_transition");
    expect(data).toMatchObject({ vacuum_ran: true, blobs_deleted: 0 });
    expect((data as { tables: Record<string, unknown> }).tables).toHaveProperty("events");
  });

  // D6: per-stage failure isolation. One table's throw, or the blob stage's throw, must NOT abort the
  // sweep — the other stages still prune AND system.cleanup_completed still fires (published from finally,
  // so the liveness card never lies even on a mid-sweep failure).
  describe("per-stage failure isolation (D6)", () => {
    it("continues the sweep and still fires the completion event when one table throws", () => {
      insertEvent(dbHandle.db, daysAgo(100)); // old event — should still be pruned
      insertEvent(dbHandle.db, new Date().toISOString());
      // Drop a managed table so its DELETE throws "no such table" mid-sweep.
      dbHandle.db.exec("DROP TABLE checkpoints");

      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config: defaultConfig(),
        blobsDir: null,
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      const stats = manager.runCleanup();

      // The earlier table still pruned despite the later table throwing.
      expect(stats.tables["events"]?.deleted).toBe(1);
      expect(stats.tables["events"]?.remaining).toBe(1);
      // The broken table simply has no entry — it threw and was skipped, not allowed to abort the sweep.
      expect(stats.tables).not.toHaveProperty("checkpoints");
      // Liveness stays truthful: lastRun is set and the completion event fired from the finally block.
      expect(manager.getLastRun()).toBe(stats);
      ebHandle.assertEventEmitted("system.cleanup_completed");
      expect(ebHandle.getEmittedEvents("system.cleanup_completed")).toHaveLength(1);
    });

    it("continues the sweep and still fires the completion event when the blob stage throws", () => {
      insertEvent(dbHandle.db, daysAgo(100)); // old event — should still be pruned
      // Drop observations so the blob-reference json_each query (collectReferencedBlobRefs) throws.
      // The observations table cleanup throws first (isolated); the blob stage then throws on the same
      // missing table — both are caught, and the sweep proceeds to vacuum + the completion event.
      dbHandle.db.exec("DROP TABLE observations");

      const manager = createDataLifecycleManager({
        db: dbHandle.db,
        eventBus: ebHandle.eventBus,
        config: defaultConfig(),
        blobsDir: "/tmp/engineer-blob-isolation-test", // non-null so the blob stage runs
        clock: createFakeClock(),
        observer: createTestObserverFacade("data-lifecycle"),
      });

      const stats = manager.runCleanup();

      // The events table still pruned despite the blob stage (and the observations table) throwing.
      expect(stats.tables["events"]?.deleted).toBe(1);
      expect(stats.blobsDeleted).toBe(0); // blob stage threw → its tally stays 0, sweep not aborted
      expect(manager.getLastRun()).toBe(stats);
      ebHandle.assertEventEmitted("system.cleanup_completed");
      expect(ebHandle.getEmittedEvents("system.cleanup_completed")).toHaveLength(1);
    });
  });
});

// Acceptance criteria: a blob referenced by any RETAINED observation must survive the orphan sweep, whichever
// JSON side carries the ref. This is the regression that emptied a finished session's result/transcript blobs
// from disk while their agent_call rows still pointed at them — the sweep collected only input-side refs.
describe("blob reference integrity across a full sweep", () => {
  let dbHandle: TestDatabaseHandle;
  let ebHandle: TestEventBusHandle;
  let tracesDir: string;

  beforeEach(() => {
    dbHandle = createTestDatabase();
    ebHandle = createTestEventBus();
    tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-blob-integrity-"));
  });

  afterEach(() => {
    dbHandle.cleanup();
    ebHandle.cleanup();
    fs.rmSync(tracesDir, { recursive: true, force: true });
  });

  /** Map a blob ref (`prefix/hash`) to its on-disk file under `<tracesDir>/blobs/`. */
  function blobPath(ref: string): string {
    return path.join(tracesDir, "blobs", `${ref}.txt`);
  }

  /** Refs a retained observation still points at whose blob file is missing from disk (dangling DB→disk refs). */
  function danglingRefs(): string[] {
    const live = collectReferencedBlobRefs(dbHandle.db);
    return [...live].filter((ref) => !fs.existsSync(blobPath(ref)));
  }

  it("keeps the result and transcript blobs of a retained agent_call (refs live in output)", () => {
    const blobStore = new BlobStore(tracesDir);
    // A retained agent_call whose output references its result + transcript blobs, both written to disk.
    const resultBlob = blobStore.store("the agent's session result");
    const transcriptBlob = blobStore.store("the full agent transcript");
    const promptBlob = blobStore.store("the prompt the agent was given");
    insertAgentCall(dbHandle.db, new Date().toISOString(), { promptBlob, resultBlob, transcriptBlob });
    // An orphan blob no observation references — this one is the legitimate sweep target.
    const orphanBlob = blobStore.store("nothing points at me");

    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: tracesDir,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    const stats = manager.runCleanup();

    // The orphan is swept; every blob the retained agent_call points at — on the output side too — survives.
    expect(stats.blobsDeleted).toBe(1);
    expect(fs.existsSync(blobPath(orphanBlob))).toBe(false);
    expect(fs.existsSync(blobPath(promptBlob))).toBe(true);
    expect(fs.existsSync(blobPath(resultBlob))).toBe(true);
    expect(fs.existsSync(blobPath(transcriptBlob))).toBe(true);
    expect(danglingRefs()).toEqual([]);
  });

  it("sweeps the blobs of an aged-out observation but keeps those of the retained one", () => {
    const blobStore = new BlobStore(tracesDir);
    // An old agent_call whose observation row is pruned by age — its blobs become true orphans and are swept.
    const agedResult = blobStore.store("aged result");
    const agedTranscript = blobStore.store("aged transcript");
    insertAgentCall(dbHandle.db, daysAgo(100), { resultBlob: agedResult, transcriptBlob: agedTranscript });
    // A recent agent_call that survives the row prune — its blobs must NOT be swept.
    const liveResult = blobStore.store("live result");
    const liveTranscript = blobStore.store("live transcript");
    insertAgentCall(dbHandle.db, new Date().toISOString(), { resultBlob: liveResult, transcriptBlob: liveTranscript });

    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config: defaultConfig(),
      blobsDir: tracesDir,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    const stats = manager.runCleanup();

    // Row pruning ran before the blob sweep, so the aged row's blobs are now orphans and swept; the retained
    // row's blobs are still referenced and survive — and nothing the surviving rows point at is missing.
    expect(stats.tables["observations"]?.deleted).toBe(1);
    expect(stats.blobsDeleted).toBe(2);
    expect(fs.existsSync(blobPath(agedResult))).toBe(false);
    expect(fs.existsSync(blobPath(agedTranscript))).toBe(false);
    expect(fs.existsSync(blobPath(liveResult))).toBe(true);
    expect(fs.existsSync(blobPath(liveTranscript))).toBe(true);
    expect(danglingRefs()).toEqual([]);
  });
});

describe("DataLifecycleManager integration", () => {
  let dbHandle: TestDatabaseHandle;
  let ebHandle: TestEventBusHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
    ebHandle = createTestEventBus();
  });

  afterEach(() => {
    dbHandle.cleanup();
    ebHandle.cleanup();
  });

  it("insert data, run cleanup, verify deletions and event emission", () => {
    // Insert old and new events
    insertEvent(dbHandle.db, daysAgo(100));
    insertEvent(dbHandle.db, daysAgo(95));
    insertEvent(dbHandle.db, daysAgo(50));
    insertEvent(dbHandle.db, new Date().toISOString());

    // Insert old observation
    insertObservation(dbHandle.db, daysAgo(100), "tool_execution", "read_file");
    insertObservation(dbHandle.db, daysAgo(10), "tool_execution", "write_file");

    const config = defaultConfig();
    const manager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus: ebHandle.eventBus,
      config,
      blobsDir: null,
      clock: createFakeClock(),
      observer: createTestObserverFacade("data-lifecycle"),
    });

    const stats = manager.runCleanup();

    // 2 events older than 90 days deleted
    expect(stats.tables["events"]?.deleted).toBe(2);
    expect(stats.tables["events"]?.remaining).toBe(2);

    // 1 observation older than 90 days deleted
    expect(stats.tables["observations"]?.deleted).toBe(1);
    expect(stats.tables["observations"]?.remaining).toBe(1);

    // Cleanup event emitted
    ebHandle.assertEventEmitted("system.cleanup_completed");
    const events = ebHandle.getEmittedEvents("system.cleanup_completed");
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload["blobs_deleted"]).toBe(0);
  });
});

describe("EventBus subscriber timing guard", () => {
  let dbHandle: TestDatabaseHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  it("does not warn for fast subscribers", () => {
    const observer = createTestObserverFacade("event-bus");
    const warnSpy = vi.spyOn(observer, "warn");

    const eventBus = new EventBus(dbHandle.db, { subscriberWarnThresholdMs: 1000, observer });

    eventBus.subscribe("fast-sub", "*", () => {
      // fast — does nothing
    });

    eventBus.publish({
      type: "task.created",
      source: "test",
      task_id: null,
      payload: {
        task_id: "t",
        parent_id: null,
        title: "t",
        external_ref: null,
        source: "test",
        priority: 50,
        repo: "r",
      },
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns for slow subscribers", () => {
    const observer = createTestObserverFacade("event-bus");
    const warnSpy = vi.spyOn(observer, "warn");

    const eventBus = new EventBus(dbHandle.db, { subscriberWarnThresholdMs: 1, observer });

    eventBus.subscribe("slow-sub", "*", () => {
      // Simulate slow work
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }
    });

    eventBus.publish({
      type: "task.created",
      source: "test",
      task_id: null,
      payload: {
        task_id: "t",
        parent_id: null,
        title: "t",
        external_ref: null,
        source: "test",
        priority: 50,
        repo: "r",
      },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("slow"),
      expect.objectContaining({ subscriberId: "slow-sub", thresholdMs: 1 }),
    );
  });

  it("does not warn when threshold is 0 (disabled)", () => {
    const observer = createTestObserverFacade("event-bus");
    const warnSpy = vi.spyOn(observer, "warn");

    const eventBus = new EventBus(dbHandle.db, { subscriberWarnThresholdMs: 0, observer });

    eventBus.subscribe("any-sub", "*", () => {
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }
    });

    eventBus.publish({
      type: "task.created",
      source: "test",
      task_id: null,
      payload: {
        task_id: "t",
        parent_id: null,
        title: "t",
        external_ref: null,
        source: "test",
        priority: 50,
        repo: "r",
      },
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still delivers event to subscriber regardless of timing", () => {
    const received: string[] = [];

    const observer = createTestObserverFacade("event-bus");
    const eventBus = new EventBus(dbHandle.db, { subscriberWarnThresholdMs: 1, observer });

    eventBus.subscribe("tracked-sub", "*", (event) => {
      received.push(event.type);
    });

    eventBus.publish({
      type: "task.created",
      source: "test",
      task_id: null,
      payload: {
        task_id: "t",
        parent_id: null,
        title: "t",
        external_ref: null,
        source: "test",
        priority: 50,
        repo: "r",
      },
    });

    expect(received).toEqual(["task.created"]);
  });
});

describe("Database tuning", () => {
  it("createDatabase applies cache_size pragma", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-db-test-"));
    try {
      const handle = createDatabase(path.join(tmpDir, "test.db"), { cacheSizeMb: 32 });

      const result = handle.db.pragma("cache_size") as { cache_size: number }[];
      // Negative value = KiB, so 32 MB = -32768
      expect(result[0]?.cache_size).toBe(-32768);

      handle.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createDatabase applies default cache_size when no options", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-db-test-"));
    try {
      const handle = createDatabase(path.join(tmpDir, "test.db"));

      const result = handle.db.pragma("cache_size") as { cache_size: number }[];
      // Default 64 MB = -65536
      expect(result[0]?.cache_size).toBe(-65536);

      handle.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runIncrementalVacuum runs without error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-db-test-"));
    try {
      const handle = createDatabase(path.join(tmpDir, "test.db"));
      // Should not throw
      runIncrementalVacuum(handle.db);
      handle.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Config schema", () => {
  it("DataLifecycleConfigSchema has correct defaults", () => {
    const config = DataLifecycleConfigSchema.parse({});

    expect(config.enabled).toBe(true);
    expect(config.interval_ms).toBe(3_600_000);
    expect(config.retention.events.max_age_days).toBe(90);
    expect(config.retention.observations.max_age_days).toBe(90);
    expect(config.retention.journal_entries.max_age_days).toBe(90);
    expect(config.retention.checkpoints.max_age_days).toBe(90);
  });

  it("DatabaseTuningConfigSchema has correct defaults", () => {
    const config = DatabaseTuningConfigSchema.parse({});

    expect(config.cache_size_mb).toBe(64);
  });

  it("DaemonConfigSchema includes new sections with defaults", () => {
    const config = DaemonConfigSchema.parse({});

    expect(config.data_lifecycle.enabled).toBe(true);
    expect(config.database.cache_size_mb).toBe(64);
    expect(config.subscriber_warn_threshold_ms).toBe(50);
  });

  it("validates custom retention values", () => {
    const config = DataLifecycleConfigSchema.parse({
      retention: {
        events: { max_age_days: 30 },
      },
    });

    expect(config.retention.events.max_age_days).toBe(30);
  });

  it("rejects invalid retention values", () => {
    expect(() =>
      DataLifecycleConfigSchema.parse({
        retention: { events: { max_age_days: -1 } },
      }),
    ).toThrow();
  });
});
