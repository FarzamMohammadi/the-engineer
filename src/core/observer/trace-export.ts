/**
 * Poll-based OTLP trace exporter — the live observability lens.
 *
 * Projects The Engineer's observation tree into any OTLP/HTTP backend (Jaeger
 * v2, the OTel Collector, …) as a side-channel READER of SQLite. It is NOT on
 * the pipeline write path: `notify`/`startSpan`/`end` write rows; this exporter
 * polls those rows on its OWN timer and POSTs them. A down or slow backend
 * therefore CANNOT affect task latency or startup — the linchpin invariant.
 *
 * Why poll, not subscribe: post-s56 there is no in-memory observation stream;
 * the dashboard's SSE route (src/dashboard/api/stream.ts) is the template — a
 * rowid high-water cursor over `observations`. We reuse that mechanism here.
 *
 * The span-completion subtlety (the part that bites): a span row is INSERTED
 * open (`end_time` NULL) at rowid R and later UPDATED on close at the SAME rowid
 * R — `rowid` does not change on UPDATE. A naive `rowid > cursor` poll therefore
 * SEES the open insert but MISSES the close update. So we export ONLY COMPLETE
 * observations and track the open ones:
 *
 *   - A newly-seen row with `end_time` set (an instant, or a span that closed
 *     before we polled) is exported immediately.
 *   - A newly-seen row with `end_time` NULL (an open span) is NOT exported; its
 *     id joins an in-memory `pending` set.
 *   - Each poll ALSO re-queries the pending ids for completion
 *     (`WHERE id IN (...) AND end_time IS NOT NULL`); the now-complete ones are
 *     exported with their real duration and dropped from `pending`.
 *
 * Net: every observation is exported AT MOST ONCE, when complete, with a real
 * duration — no reliance on backend (traceId,spanId) dedup.
 *
 * Best-effort, at-most-once (NOT at-least-once): the poll loop is total-catch
 * (never throws out of the timer); a failed/slow POST (per-POST AbortSignal
 * timeout) is caught, rate-limited-warned, and DROPPED. A COMPLETE observation
 * whose POST fails is gone from the export stream — its rowid is already past the
 * cursor and it is not re-queued. SQLite remains the system of record, so nothing
 * is lost there; only the live projection has a gap. The one thing that DOES
 * re-attempt naturally is a still-open span: it stays in `pending` until it
 * completes, so its (later) export is independent of any earlier failed POST.
 * One endpoint, no fan-out.
 *
 * Rehydration: on start the cursor is set BACK by a bounded recent window so the
 * first polls replay recent COMPLETE observations into a freshly-started
 * backend; the live tail then continues from the same cursor. ONE cursor unifies
 * rehydrate + live.
 */

import type Database from "better-sqlite3";

import type { IObserver } from "./facade.js";
import { type AttributeContext, type OtlpSpan, buildResourceSpans, mapObservationToSpan } from "./otlp/index.js";

import { type Observation, rowToObservation } from "../../schemas/observer.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";

// ── Tuning constants (injectable via deps for tests) ──────────────────────────

/** Poll cadence. Matches the dashboard SSE route — fresh enough for a live view. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * How far back the start cursor reaches so the first polls replay recent history
 * into a freshly-started backend. Bounded (NOT full history): a backend restart
 * should resurface the last few hours of work, not weeks. The hard cap is the
 * data-lifecycle retention; this window is the practical "recent work" horizon.
 */
const DEFAULT_REHYDRATE_WINDOW_MS = 6 * 60 * 60 * 1_000; // 6 hours

/** Max rows pulled per poll — bounds memory and POST size under a burst/backlog. */
const DEFAULT_BATCH_LIMIT = 200;

/** Per-POST timeout. A hung backend must never stall the loop past this. */
const DEFAULT_POST_TIMEOUT_MS = 5_000;

/** Minimum gap between export-failure warnings so a down backend cannot spam logs. */
const WARN_RATE_LIMIT_MS = 60_000;

/**
 * Cap on the `pending` set. An open span that never closes (a crash mid-task)
 * would otherwise leak forever; once we exceed this, the oldest ids are dropped
 * (their completion, if it ever lands, is simply not exported — best-effort).
 */
const PENDING_MAX = 10_000;

/** Strips trailing slashes so `<base>/v1/traces` and blob URLs never double up. */
const TRAILING_SLASHES = /\/+$/;

// ── Dependencies ──────────────────────────────────────────────────────────────

/** Minimal clock — injectable for deterministic rate-limit/window tests. */
export interface ExportClock {
  now(): number;
}

/** Injectable timer surface (real `setInterval` in prod, fake in tests). */
export interface ExportTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** A `fetch`-shaped function (the global in prod, a fake receiver in tests). */
export type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

export interface TraceExportDeps {
  /** Read handle on the observations DB (WAL concurrent reader). */
  db: Database.Database;
  /** OTLP/HTTP base URL; spans POST to `<endpoint>/v1/traces`. */
  endpoint: string;
  /** Observer for rate-limited warnings (best-effort; no console.* in src). */
  observer: IObserver;
  /** Dashboard base URL, threaded into blob-ref attributes (no trailing slash). */
  dashboardBaseUrl: string;
  /** Poll cadence in ms. Default: 1s. */
  intervalMs?: number;
  /** Rehydration look-back window in ms. Default: 6h. */
  rehydrateWindowMs?: number;
  /** Max rows per poll. Default: 200. */
  batchLimit?: number;
  /** Per-POST timeout in ms. Default: 5s. */
  postTimeoutMs?: number;
  /** Injectable clock. Default: Date.now. */
  clock?: ExportClock;
  /** Injectable timer. Default: setInterval/clearInterval (unref'd). */
  timer?: ExportTimer;
  /** Injectable fetch. Default: globalThis.fetch. */
  fetchFn?: FetchFn;
}

/** Handle returned by {@link startTraceExport}. */
export interface TraceExportHandle {
  /** Stop the poll timer and abort any in-flight POST. */
  stop(): void;
  /**
   * Run one poll cycle synchronously-then-awaited. Exposed for tests so they
   * drive the loop deterministically instead of waiting on wall-clock timers.
   */
  pollOnce(): Promise<void>;
}

// ── Raw row shape (matches the dashboard SSE route) ───────────────────────────

interface ObservationRow {
  rowid: number;
  id: string;
  trace_id: string | null;
  parent_observation_id: string | null;
  type: string;
  name: string;
  task_id: string | null;
  phase: string | null;
  session_id: string | null;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  input: string | null;
  output: string | null;
  metadata: string | null;
  level: string;
  status: string;
  error_message: string | null;
}

// ── Default collaborators ─────────────────────────────────────────────────────

const realClock: ExportClock = { now: () => Date.now() };

const realTimer: ExportTimer = {
  set(callback, ms) {
    const handle = setInterval(callback, ms);
    // unref so a quiet exporter never keeps the process alive on shutdown.
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

const realFetch: FetchFn = (url, init) => globalThis.fetch(url, init);

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Start the poll-based trace exporter. Returns a handle whose `stop()` clears
 * the timer and aborts any in-flight POST. The timer starts immediately.
 */
export function startTraceExport(deps: TraceExportDeps): TraceExportHandle {
  const {
    db,
    endpoint,
    observer,
    dashboardBaseUrl,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    rehydrateWindowMs = DEFAULT_REHYDRATE_WINDOW_MS,
    batchLimit = DEFAULT_BATCH_LIMIT,
    postTimeoutMs = DEFAULT_POST_TIMEOUT_MS,
    clock = realClock,
    timer = realTimer,
    fetchFn = realFetch,
  } = deps;

  const tracesUrl = `${endpoint.replace(TRAILING_SLASHES, "")}/v1/traces`;
  const attrCtx: AttributeContext = { dashboardBaseUrl: dashboardBaseUrl.replace(TRAILING_SLASHES, "") };

  // ── Rehydration cursor (lives in the factory so a broken read warns once) ───

  /**
   * Compute the start cursor: the largest rowid OLDER than the rehydrate window,
   * so a `rowid > cursor` poll replays exactly the recent window (and nothing
   * before it). The window anchors on `start_time` — a span that STARTED before
   * the window is excluded even if it COMPLETED recently (we never rehydrate a
   * long-running span whose root predates the window). Falls back to the current
   * max rowid (live tail only) when the window is empty or the query fails — never
   * replays full history. A query failure is a one-shot WARN (Fail Loud), not a
   * silent fallback: a broken rehydrate read would otherwise hide as "no recent
   * history" with no signal.
   */
  function computeRehydrateCursor(windowMs: number): number {
    try {
      const cutoffISO = new Date(clock.now() - windowMs).toISOString();
      const row = db.prepare("SELECT MAX(rowid) AS rowid FROM observations WHERE start_time < ?").get(cutoffISO) as
        | { rowid: number | null }
        | undefined;
      if (row?.rowid != null) {
        return row.rowid;
      }
      // No rows older than the cutoff: either the table is empty, or everything is
      // within the window. Start from 0 so the whole (bounded) window replays.
      return 0;
    } catch (error) {
      // Fail Loud: a broken rehydrate read must be visible, not swallowed. Warn
      // once, then fall back to the live tail (current max rowid) so we can never
      // replay unbounded history or crash startup.
      observer.warn("Trace export rehydrate-cursor read failed; falling back to live tail", {
        error: sanitizeErrorMessage(error),
      });
      try {
        const row = db.prepare("SELECT MAX(rowid) AS rowid FROM observations").get() as
          | { rowid: number | null }
          | undefined;
        return row?.rowid ?? 0;
      } catch {
        return 0;
      }
    }
  }

  // ── State (single cursor unifies rehydrate + live tail) ─────────────────────

  // High-water mark: the largest rowid we have already SEEN (not necessarily
  // exported — an open span is seen but deferred to `pending`).
  let cursor = computeRehydrateCursor(rehydrateWindowMs);
  // Ids of open spans seen but not yet exported (insertion-order for FIFO drop).
  const pending = new Set<string>();
  // Aborts the current in-flight POST on stop(). One POST at a time per cycle.
  let inFlight: AbortController | null = null;
  let stopped = false;
  let lastWarnAt = 0;
  // Re-entrancy guard: true while a poll cycle is mid-flight. A slow backend can
  // make a POST outlast the poll interval, so the timer would otherwise fire a
  // SECOND overlapping pollOnce — concurrent POSTs, and a racy `cursor`/`pending`
  // read mid-mutation. The guard makes the new cycle return early and lets the
  // running one finish. It also makes the "collect synchronously, THEN await"
  // invariant explicit: rows are read into a batch before any await, so the
  // single in-flight cycle owns the cursor for its whole duration.
  let isPolling = false;

  // ── Warnings (rate-limited so a down backend cannot spam) ───────────────────

  function warnRateLimited(message: string, error: unknown): void {
    const now = clock.now();
    if (now - lastWarnAt < WARN_RATE_LIMIT_MS) {
      return;
    }
    lastWarnAt = now;
    observer.warn(message, { endpoint: tracesUrl, error: sanitizeErrorMessage(error) });
  }

  // ── POST one batch of spans (best-effort, per-POST timeout) ─────────────────

  async function postSpans(spans: OtlpSpan[]): Promise<void> {
    if (spans.length === 0) {
      return;
    }
    const payload = buildResourceSpans(spans);
    const controller = new AbortController();
    inFlight = controller;
    const timeoutId = setTimeout(() => controller.abort(), postTimeoutMs);
    try {
      const res = await fetchFn(tracesUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        warnRateLimited("Trace export POST rejected by backend", new Error(`HTTP ${String(res.status)}`));
      }
    } catch (error) {
      // Network error, timeout/abort, or a thrown fetch — drop and warn. At-most-once:
      // these spans are NOT re-queued. A complete observation in this batch is already
      // past the cursor, so its failed POST is a permanent gap in the live projection
      // (SQLite still has it — the backend is a disposable lens, not the record). Only a
      // still-open span re-attempts later, and only because it lingers in `pending` until
      // it completes — never as a retry of THIS failed POST.
      warnRateLimited("Trace export POST failed", error);
    } finally {
      clearTimeout(timeoutId);
      if (inFlight === controller) {
        inFlight = null;
      }
    }
  }

  // ── Collect complete observations to export this cycle ──────────────────────

  /**
   * Pull rows newer than the cursor. A complete one (end_time set — an instant,
   * or a span that closed before we polled) is returned for export; an open one
   * (end_time NULL) is deferred to `pending`. The cursor advances to the max
   * rowid seen so we never re-scan it.
   */
  function collectNewRows(): Observation[] {
    const rows = db
      .prepare("SELECT rowid, * FROM observations WHERE rowid > ? ORDER BY rowid ASC LIMIT ?")
      .all(cursor, batchLimit) as ObservationRow[];

    const complete: Observation[] = [];
    for (const row of rows) {
      cursor = row.rowid;
      if (row.end_time === null) {
        rememberPending(row.id);
      } else {
        complete.push(rowToObservation(row));
      }
    }
    return complete;
  }

  /**
   * Re-query the pending ids for completion. Those now closed are returned for
   * export and dropped from `pending`. Done in id-chunks so the IN-list stays
   * within SQLite's bound-variable ceiling.
   */
  function collectCompletedPending(): Observation[] {
    if (pending.size === 0) {
      return [];
    }
    const ids = [...pending];
    const completed: Observation[] = [];
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT rowid, * FROM observations WHERE id IN (${placeholders}) AND end_time IS NOT NULL`)
        .all(...chunk) as ObservationRow[];
      for (const row of rows) {
        pending.delete(row.id);
        completed.push(rowToObservation(row));
      }
    }
    return completed;
  }

  function rememberPending(id: string): void {
    pending.add(id);
    // FIFO bound: an open span that never closes (a crash) must not leak forever.
    while (pending.size > PENDING_MAX) {
      const oldest = pending.values().next().value;
      if (oldest === undefined) {
        break;
      }
      pending.delete(oldest);
    }
  }

  // ── One poll cycle (TOTAL-CATCH: never throws out of the timer) ─────────────

  async function pollOnce(): Promise<void> {
    if (stopped) {
      return;
    }
    // Overlap guard: if the previous cycle's POST is still in flight (a slow
    // backend outlasting the poll interval), skip this tick rather than fire a
    // second concurrent POST that races the same cursor/pending state. The running
    // cycle finishes and the next tick picks up from where it left off.
    if (isPolling) {
      return;
    }
    isPolling = true;
    try {
      // Collect SYNCHRONOUSLY (no await) before any POST: collectNewRows advances
      // `cursor` and collectCompletedPending mutates `pending`, so this whole batch
      // must be read in one synchronous pass that the single in-flight cycle owns
      // for its duration — the overlap guard above is what keeps that invariant true.
      const observations = [...collectNewRows(), ...collectCompletedPending()];
      if (observations.length === 0) {
        return;
      }
      // Map per-row so one malformed row (e.g. an unparseable timestamp or a
      // non-ULID id) is skipped — warned, not fatal — without sinking its healthy
      // batch-mates. The outer try/catch is the last-resort guard for anything
      // unexpected; the loop MUST survive and keep exporting.
      const spans: OtlpSpan[] = [];
      for (const obs of observations) {
        try {
          spans.push(mapObservationToSpan(obs, attrCtx));
        } catch (error) {
          warnRateLimited("Trace export skipped a malformed observation", error);
        }
      }
      await postSpans(spans);
    } catch (error) {
      // Any unexpected throw (a SQLite read failure, etc.): warn and keep going.
      warnRateLimited("Trace export cycle failed", error);
    } finally {
      isPolling = false;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  const handle = timer.set(() => {
    // pollOnce is total-catch, so its promise NEVER rejects — there is nothing to
    // await or handle in the timer callback (which must stay synchronous and must
    // never throw). We deliberately do not await it; the next tick is independent.
    pollOnce().catch(() => {
      /* unreachable: pollOnce is total-catch — guard only to satisfy the linter */
    });
  }, intervalMs);

  return {
    stop(): void {
      stopped = true;
      timer.clear(handle);
      inFlight?.abort();
      inFlight = null;
    },
    pollOnce,
  };
}
