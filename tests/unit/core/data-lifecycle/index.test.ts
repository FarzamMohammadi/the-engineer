import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOrphanedBlobs,
  cleanupTable,
  collectReferencedBlobRefs,
  createDataLifecycleManager,
} from "../../../../src/core/data-lifecycle/index.js";
import { EventBus } from "../../../../src/core/event-bus/index.js";
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
  db.prepare("INSERT INTO events (id, type, source, task_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
    id ?? `evt-${Date.now()}-${Math.random()}`,
    "test.event",
    "test",
    null,
    timestamp,
    "{}",
  );
}

function insertObservation(
  db: TestDatabaseHandle["db"],
  timestamp: string,
  type: string,
  name: string,
  input?: Record<string, unknown> | null,
): void {
  db.prepare(
    `INSERT INTO observations (id, type, name, task_id, start_time, end_time, level, status, input)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}

function insertLlmObservation(
  db: TestDatabaseHandle["db"],
  timestamp: string,
  promptRef?: string | null,
  responseRef?: string | null,
): void {
  insertObservation(db, timestamp, "agent_call", "completion", {
    prompt_ref: promptRef ?? null,
    response_ref: responseRef ?? null,
    cost_usd: 0.01,
    duration_ms: 150,
  });
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function createFakeClock(now = Date.now()): { now: () => number } {
  return { now: () => now };
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
});

describe("collectReferencedBlobRefs", () => {
  let dbHandle: TestDatabaseHandle;

  beforeEach(() => {
    dbHandle = createTestDatabase();
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  it("returns all distinct prompt_ref and response_ref from agent_call observations", () => {
    insertLlmObservation(dbHandle.db, new Date().toISOString(), "ab/abc123", "cd/cde456");
    insertLlmObservation(dbHandle.db, new Date().toISOString(), "ef/efg789", null);

    const refs = collectReferencedBlobRefs(dbHandle.db);

    expect(refs.size).toBe(3);
    expect(refs.has("ab/abc123")).toBe(true);
    expect(refs.has("cd/cde456")).toBe(true);
    expect(refs.has("ef/efg789")).toBe(true);
  });

  it("skips null refs", () => {
    insertLlmObservation(dbHandle.db, new Date().toISOString(), null, null);

    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(0);
  });

  it("returns empty set when no observations exist", () => {
    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(0);
  });

  it("deduplicates shared refs", () => {
    insertLlmObservation(dbHandle.db, new Date().toISOString(), "ab/same", "cd/same2");
    insertLlmObservation(dbHandle.db, new Date().toISOString(), "ab/same", "cd/same2");

    const refs = collectReferencedBlobRefs(dbHandle.db);
    expect(refs.size).toBe(2);
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
    const deleted = cleanupOrphanedBlobs(tmpDir, referenced);

    expect(deleted).toBe(1);
    expect(fs.existsSync(path.join(prefix, "abc123.txt"))).toBe(true);
    expect(fs.existsSync(path.join(prefix, "abd456.txt"))).toBe(false);
  });

  it("preserves referenced blob files", () => {
    const prefix = path.join(tmpDir, "cd");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, "cde789.txt"), "content");

    const referenced = new Set(["cd/cde789"]);
    const deleted = cleanupOrphanedBlobs(tmpDir, referenced);

    expect(deleted).toBe(0);
    expect(fs.existsSync(path.join(prefix, "cde789.txt"))).toBe(true);
  });

  it("handles missing blobs directory gracefully", () => {
    const deleted = cleanupOrphanedBlobs("/nonexistent/path", new Set());
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

      const deleted = cleanupOrphanedBlobs(tmpDir, new Set());

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

    const deleted = cleanupOrphanedBlobs(tmpDir, new Set());
    expect(deleted).toBe(3);
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
    expect(events[0]?.payload).toHaveProperty("blobs_deleted");
    expect(events[0]?.payload).toHaveProperty("vacuum_ran");
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
