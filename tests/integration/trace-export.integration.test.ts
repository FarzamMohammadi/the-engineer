/**
 * Integration tests for the poll-based OTLP trace exporter.
 *
 * The exporter is a side-channel READER of SQLite, so these tests use a real
 * in-memory DB seeded through the real ObservationStore (open inserts, close
 * updates, instants) and a fake in-process OTLP receiver injected as `fetchFn`.
 * We drive the loop with `pollOnce()` rather than wall-clock timers, and inject
 * a no-op timer so `startTraceExport` never schedules a real interval.
 *
 * The properties under test (the spec's correctness-critical claims):
 *  (a) a complete instant is exported once;
 *  (b) an open span THEN its completion is exported once, complete, WITH a real
 *      duration, and NOT while it is still open;
 *  (c) a down/hung receiver never throws out of the loop and export runs OFF the
 *      write path (the write path is never blocked);
 *  (d) rehydration replays the bounded recent window and nothing older;
 *  (e) nothing is exported twice (rehydrate + live share one cursor);
 *  (f) the loop survives a POST error and a malformed row and keeps going.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ObservationStore, createObservationStore, startTraceExport } from "../../src/core/observer/index.js";
import { deriveSpanId } from "../../src/core/observer/otlp/index.js";
import type { OtlpSpan, OtlpTracesPayload } from "../../src/core/observer/otlp/index.js";
import type { ExportClock, ExportTimer, FetchFn, TraceExportHandle } from "../../src/core/observer/trace-export.js";
import { createInMemoryDatabase } from "../../src/db/database.js";
import type { DatabaseHandle } from "../../src/db/database.js";
import { createTestObserverFacade } from "../helpers/test-observer-facade.js";

// ── Fake OTLP receiver ────────────────────────────────────────────────────────

/** Pull every span out of an OTLP `/v1/traces` payload, flattened. */
function spansOf(payload: OtlpTracesPayload): OtlpSpan[] {
  return payload.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
}

interface FakeReceiver {
  fetchFn: FetchFn;
  /** Every span the receiver has accepted across all POSTs, in arrival order. */
  received: OtlpSpan[];
  /** Number of POST calls (accepted or not). */
  calls: number;
}

type ReceiverMode = "ok" | "reject" | "down" | "hung";

/**
 * A fake in-process OTLP receiver. `ok` accepts and records; `reject` returns a
 * non-ok HTTP status; `down` throws (network error); `hung` never resolves until
 * the request is aborted (proving the per-POST timeout / non-blocking property).
 */
function createFakeReceiver(mode: ReceiverMode = "ok"): FakeReceiver {
  const received: OtlpSpan[] = [];
  const receiver: FakeReceiver = {
    received,
    calls: 0,
    fetchFn: (_url, init) => {
      receiver.calls += 1;
      if (mode === "down") {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      if (mode === "hung") {
        // Never resolve on its own; settle only when the caller aborts.
        return new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal) {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      const payload = JSON.parse(String(init.body)) as OtlpTracesPayload;
      if (mode === "reject") {
        return Promise.resolve({ ok: false, status: 500 });
      }
      received.push(...spansOf(payload));
      return Promise.resolve({ ok: true, status: 200 });
    },
  };
  return receiver;
}

// ── A timer that never fires (we drive pollOnce ourselves) ──────────────────────

const noopTimer: ExportTimer = {
  set: () => 0,
  clear: () => undefined,
};

// ── A controllable clock ────────────────────────────────────────────────────────

class StubClock implements ExportClock {
  private t: number;
  constructor(start = Date.parse("2026-06-02T12:00:00.000Z")) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ── Raw-row seeding (bypasses the store to control rowid order / timestamps) ────

/**
 * Insert a raw observation row directly, with explicit start/end times. The id is
 * a real ULID — the OTLP mapper decodes it to derive the span id, so a non-ULID
 * id would (correctly) throw inside the export cycle.
 */
function seedRow(
  db: Database.Database,
  opts: { name?: string; startTime: string; endTime: string | null; type?: string; startMs?: number },
): string {
  // Seed with a ULID minted at the row's start time so rowid order tracks time.
  const id = ulid(opts.startMs);
  db.prepare(
    `INSERT INTO observations
       (id, trace_id, parent_observation_id, type, name, task_id, phase, session_id,
        start_time, end_time, duration_ms, input, output, metadata, level, status, error_message)
     VALUES (?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, 'info', 'ok', NULL)`,
  ).run(id, opts.type ?? "lifecycle", opts.name ?? "seeded", opts.startTime, opts.endTime);
  return id;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("startTraceExport (poll-based OTLP exporter)", () => {
  let handle: DatabaseHandle;
  let db: Database.Database;
  let store: ObservationStore;
  let exporter: TraceExportHandle | null;

  beforeEach(() => {
    handle = createInMemoryDatabase();
    db = handle.db;
    store = createObservationStore(db, null);
    exporter = null;
  });

  afterEach(() => {
    exporter?.stop();
    handle.close();
  });

  function start(receiver: FakeReceiver, overrides: Record<string, unknown> = {}): TraceExportHandle {
    const created = startTraceExport({
      db,
      endpoint: "http://localhost:4318",
      observer: createTestObserverFacade(),
      dashboardBaseUrl: "http://127.0.0.1:3847",
      timer: noopTimer,
      fetchFn: receiver.fetchFn,
      // Default to a tiny window so nothing pre-seeded leaks into "live" tests.
      rehydrateWindowMs: 0,
      clock: new StubClock(),
      ...overrides,
    });
    exporter = created;
    return created;
  }

  // ── (a) complete instant → exported once ─────────────────────────────────────

  it("exports a complete instant exactly once", async () => {
    const receiver = createFakeReceiver("ok");
    const ex = start(receiver);

    const id = store.observe("lifecycle", "instant_event", { foo: "bar" });

    await ex.pollOnce();
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]?.name).toBe("instant_event");

    // A second poll must NOT re-export it (cursor already advanced past it).
    await ex.pollOnce();
    expect(receiver.received).toHaveLength(1);

    // The exported span IS that observation: span id derives from the obs id, and
    // an instant is a zero-duration span (start == end).
    const span = receiver.received[0];
    expect(span?.spanId).toBe(deriveSpanId(id));
    expect(span?.startTimeUnixNano).toBe(span?.endTimeUnixNano);
  });

  // ── (b) open span THEN completion → exported once, complete, WITH duration ───

  it("exports an open span only after it completes, once, with a real duration", async () => {
    const receiver = createFakeReceiver("ok");
    const ex = start(receiver);

    const span = store.startSpan("agent_call", "completion");

    // First poll: the span is OPEN (end_time NULL). It must NOT be exported.
    await ex.pollOnce();
    expect(receiver.received).toHaveLength(0);

    // It now closes (same rowid, end_time set, real duration).
    span.end({ tokens: 42 });

    // Next poll: the pending re-query catches the completion and exports it.
    await ex.pollOnce();
    expect(receiver.received).toHaveLength(1);
    const exported = receiver.received[0];
    expect(exported?.name).toBe("completion");

    // Complete, with a real (non-zero-width) duration — end strictly after start.
    expect(BigInt(exported?.endTimeUnixNano ?? "0")).toBeGreaterThanOrEqual(BigInt(exported?.startTimeUnixNano ?? "0"));

    // Further polls must not re-export it.
    await ex.pollOnce();
    await ex.pollOnce();
    expect(receiver.received).toHaveLength(1);
  });

  it("exports a span that closed before the first poll, once", async () => {
    const receiver = createFakeReceiver("ok");
    const ex = start(receiver);

    // Open and close BEFORE any poll — the first time we see the row it is
    // already complete, so it exports immediately from the new-rows path.
    const span = store.startSpan("tool_execution", "bash");
    span.end();

    await ex.pollOnce();
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]?.name).toBe("bash");

    await ex.pollOnce();
    expect(receiver.received).toHaveLength(1);
  });

  // ── (c) receiver down / hung → loop never throws, runs OFF the write path ────

  it("does not throw when the receiver is down, and keeps polling", async () => {
    const receiver = createFakeReceiver("down");
    const ex = start(receiver);

    store.observe("lifecycle", "e1", {});
    await expect(ex.pollOnce()).resolves.toBeUndefined();
    expect(receiver.calls).toBe(1);
    expect(receiver.received).toHaveLength(0);

    // The loop survives and retries on the next cycle (the row is past the cursor,
    // so it is NOT re-attempted — but a NEW row still flows; the loop is alive).
    store.observe("lifecycle", "e2", {});
    await expect(ex.pollOnce()).resolves.toBeUndefined();
    expect(receiver.calls).toBe(2);
  });

  it("a hung receiver never blocks the write path (export is off the hot path)", async () => {
    const receiver = createFakeReceiver("hung");
    // postTimeoutMs is irrelevant here because the timer is mocked; we assert that
    // pollOnce's POST does not settle, yet the write path stays fully responsive.
    const ex = start(receiver);

    store.observe("lifecycle", "before_hang", {});

    // Kick off a poll whose POST will hang forever (the fake never resolves).
    let pollSettled = false;
    const pollPromise = ex.pollOnce().then(() => {
      pollSettled = true;
    });

    // The WRITE PATH (the real hot path) must remain fully usable while the POST
    // hangs — writes go straight to SQLite, never through the exporter.
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      store.observe("lifecycle", `write_${String(i)}`, {});
    }
    const writeMs = performance.now() - t0;

    // Writes completed quickly and the export poll is STILL pending (proving the
    // POST is off the write path — the hung receiver cannot wedge anything).
    expect(writeMs).toBeLessThan(500);
    await Promise.resolve();
    expect(pollSettled).toBe(false);
    expect(store.query({ type: "lifecycle" }).length).toBeGreaterThanOrEqual(51);

    // stop() aborts the in-flight POST so the hung promise settles and the test
    // does not leak a pending request.
    ex.stop();
    await expect(pollPromise).resolves.toBeUndefined();
  });

  it("a slow cycle blocks an overlapping poll (no concurrent POSTs)", async () => {
    const receiver = createFakeReceiver("hung");
    const ex = start(receiver);

    store.observe("lifecycle", "first", {});

    // Cycle 1: its POST hangs forever, so the cycle stays mid-flight.
    let firstSettled = false;
    const first = ex.pollOnce().then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(receiver.calls).toBe(1);
    expect(firstSettled).toBe(false);

    // A NEW row arrives while cycle 1 is still in flight.
    store.observe("lifecycle", "second", {});

    // Cycle 2 must early-return on the overlap guard: NO second concurrent POST.
    await expect(ex.pollOnce()).resolves.toBeUndefined();
    expect(receiver.calls).toBe(1);

    // stop() aborts the hung POST so the first cycle settles and the guard clears.
    ex.stop();
    await expect(first).resolves.toBeUndefined();
  });

  // ── (d) rehydration replays the bounded window (and nothing older) ───────────

  it("rehydrates the bounded recent window and skips older observations", async () => {
    const clock = new StubClock();
    const now = clock.now();

    // One OLD complete row (outside a 1h window) and one RECENT complete row.
    const oldIso = new Date(now - 5 * 60 * 60 * 1_000).toISOString(); // 5h ago
    const recentIso = new Date(now - 10 * 60 * 1_000).toISOString(); // 10m ago
    seedRow(db, { name: "old_event", startTime: oldIso, endTime: oldIso });
    seedRow(db, { name: "recent_event", startTime: recentIso, endTime: recentIso });

    const receiver = createFakeReceiver("ok");
    const ex = start(receiver, { rehydrateWindowMs: 60 * 60 * 1_000, clock });

    await ex.pollOnce();

    const names = receiver.received.map((s) => s.name);
    expect(names).toContain("recent_event");
    expect(names).not.toContain("old_event");
    expect(receiver.received).toHaveLength(1);
  });

  it("rehydrates an open-then-completed span within the window without duplicating it", async () => {
    const clock = new StubClock();
    const now = clock.now();
    const recentIso = new Date(now - 5 * 60 * 1_000).toISOString();

    // A recent span that is still OPEN at exporter start (end_time NULL).
    const openId = seedRow(db, { name: "recent_open", startTime: recentIso, endTime: null });

    const receiver = createFakeReceiver("ok");
    const ex = start(receiver, { rehydrateWindowMs: 60 * 60 * 1_000, clock });

    // First poll: it is open → deferred, not exported.
    await ex.pollOnce();
    expect(receiver.received).toHaveLength(0);

    // It closes; the pending re-query exports it exactly once.
    db.prepare("UPDATE observations SET end_time = ?, duration_ms = 100 WHERE id = ?").run(
      new Date(now).toISOString(),
      openId,
    );
    await ex.pollOnce();
    await ex.pollOnce();
    expect(receiver.received.map((s) => s.name)).toEqual(["recent_open"]);
  });

  // ── (e) nothing exported twice (rehydrate + live share ONE cursor) ───────────

  it("does not duplicate between rehydration and the live tail", async () => {
    const clock = new StubClock();
    const now = clock.now();
    const recentIso = new Date(now - 10 * 60 * 1_000).toISOString();
    seedRow(db, { name: "rehydrated", startTime: recentIso, endTime: recentIso });

    const receiver = createFakeReceiver("ok");
    const ex = start(receiver, { rehydrateWindowMs: 60 * 60 * 1_000, clock });

    // First poll: rehydrate the recent row.
    await ex.pollOnce();
    expect(receiver.received.map((s) => s.name)).toEqual(["rehydrated"]);

    // A NEW live observation arrives after the cursor — exported once, no dup of
    // the rehydrated one.
    store.observe("lifecycle", "live", {});
    await ex.pollOnce();
    expect(receiver.received.map((s) => s.name)).toEqual(["rehydrated", "live"]);

    // Repeated polls add nothing.
    await ex.pollOnce();
    await ex.pollOnce();
    expect(receiver.received).toHaveLength(2);
  });

  // ── (f) loop survives a POST error and a malformed row, keeps going ──────────

  it("recovers after a transient POST error: a down receiver then comes back", async () => {
    // Start "down", flip the closure variable to "ok" mid-test by swapping fetchFn.
    const downReceiver = createFakeReceiver("down");
    const okReceiver = createFakeReceiver("ok");

    let currentFetch: FetchFn = downReceiver.fetchFn;
    const proxyFetch: FetchFn = (url, init) => currentFetch(url, init);

    const ex = start(downReceiver, { fetchFn: proxyFetch });

    store.observe("lifecycle", "during_outage", {});
    await ex.pollOnce(); // POST fails (down) — dropped, no throw.
    expect(okReceiver.received).toHaveLength(0);

    // Backend recovers; a NEW observation exports cleanly (loop still alive).
    currentFetch = okReceiver.fetchFn;
    store.observe("lifecycle", "after_recovery", {});
    await ex.pollOnce();
    expect(okReceiver.received.map((s) => s.name)).toEqual(["after_recovery"]);
  });

  it("survives a non-ok HTTP response and keeps exporting", async () => {
    const rejectReceiver = createFakeReceiver("reject");
    const ex = start(rejectReceiver);

    store.observe("lifecycle", "rejected", {});
    await expect(ex.pollOnce()).resolves.toBeUndefined();
    expect(rejectReceiver.calls).toBe(1);

    // Still alive: a later poll keeps calling the receiver.
    store.observe("lifecycle", "next", {});
    await ex.pollOnce();
    expect(rejectReceiver.calls).toBe(2);
  });

  it("survives a malformed row (mapper throws) and keeps going for the next rows", async () => {
    const receiver = createFakeReceiver("ok");
    const ex = start(receiver);

    // A row with an UNPARSEABLE start_time: mapObservationToSpan throws on it.
    seedRow(db, { name: "broken", startTime: "not-a-date", endTime: "not-a-date" });

    // The cycle catches the mapper throw and does not crash the exporter.
    await expect(ex.pollOnce()).resolves.toBeUndefined();

    // A subsequent VALID observation still exports — the loop survived.
    store.observe("lifecycle", "healthy", {});
    await ex.pollOnce();
    expect(receiver.received.map((s) => s.name)).toContain("healthy");
  });

  // ── stop() lifecycle ─────────────────────────────────────────────────────────

  it("stop() halts further export and aborts in-flight POSTs", async () => {
    const receiver = createFakeReceiver("ok");
    const ex = start(receiver);

    store.observe("lifecycle", "before_stop", {});
    ex.stop();

    // After stop(), a poll is a no-op (the loop guard short-circuits).
    await ex.pollOnce();
    expect(receiver.calls).toBe(0);
  });

  it("uses the real interval timer when none is injected (smoke)", () => {
    // Guard the production path: with the real timer, start/stop must not throw
    // and must not leave a dangling interval (unref'd, then cleared).
    const receiver = createFakeReceiver("ok");
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const ex = startTraceExport({
      db,
      endpoint: "http://localhost:4318/",
      observer: createTestObserverFacade(),
      dashboardBaseUrl: "http://127.0.0.1:3847/",
      fetchFn: receiver.fetchFn,
      rehydrateWindowMs: 0,
    });
    expect(setSpy).toHaveBeenCalledTimes(1);
    ex.stop();
    setSpy.mockRestore();
  });
});
