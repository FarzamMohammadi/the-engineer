import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { runIncrementalVacuum } from "../../db/database.js";
import type { DataLifecycleConfig } from "../../schemas/config.js";
import { SystemCleanupCompletedPayloadSchema } from "../../schemas/events.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { TaskStates } from "../../schemas/task.js";
import type { Clock } from "../../utils/clock.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import { BLOB_REF_KEY_SUFFIX, isBlobRef } from "../observer/blob-ref.js";
import type { IObserver } from "../observer/index.js";

export { MONTHLY_REPLAY_FLOOR_DAYS, inspectRetentionConfig } from "./inspect.js";

// ── Event Declarations ────────────────────────────────────────────────────────

/** Events published by the data-lifecycle manager. */
export const EVENTS: EventDeclaration[] = [
  {
    type: "system.cleanup_completed",
    description: "Emitted after data lifecycle cleanup completes",
    payloadSchema: SystemCleanupCompletedPayloadSchema,
    publishers: ["data-lifecycle"],
    subscribers: [],
  },
];

const BLOB_TXT_SUFFIX = /\.txt$/;

// ── Types ────────────────────────────────────────────────────────────────────────

interface TableCleanupResult {
  deleted: number;
  remaining: number;
}

export interface CleanupStats {
  timestamp: string;
  tables: Record<string, TableCleanupResult>;
  /** Distinct blob refs the retained observations still point at — the protected set's size. */
  blobsReferenced: number;
  /** Blob files the sweep walked on disk (0 when blob cleanup was skipped). */
  blobsScanned: number;
  blobsDeleted: number;
  vacuumRan: boolean;
  durationMs: number;
}

export interface DataLifecycleManager {
  start(): void;
  stop(): void;
  runCleanup(): CleanupStats;
  getLastRun(): CleanupStats | null;
}

interface DataLifecycleManagerDeps {
  db: Database.Database;
  eventBus: IEventBus;
  config: DataLifecycleConfig;
  blobsDir: string | null;
  clock: Clock;
  observer: IObserver;
}

// Active task states — never prune data belonging to these tasks
const ACTIVE_STATES = [TaskStates.requirements_gathering, TaskStates.queued, TaskStates.active, TaskStates.blocked];

// ── Table Definitions ─────────────────────────────────────────────────────────

interface TableDefinition {
  name: string;
  timestampColumn: string;
  configKey: keyof DataLifecycleConfig["retention"];
  /** Whether to exclude rows belonging to active tasks */
  excludeActiveTasks: boolean;
}

const MANAGED_TABLES: TableDefinition[] = [
  { name: "events", timestampColumn: "timestamp", configKey: "events", excludeActiveTasks: true },
  {
    name: "observations",
    timestampColumn: "start_time",
    configKey: "observations",
    excludeActiveTasks: true,
  },
  {
    name: "journal_entries",
    timestampColumn: "timestamp",
    configKey: "journal_entries",
    excludeActiveTasks: true,
  },
  {
    name: "checkpoints",
    timestampColumn: "timestamp",
    configKey: "checkpoints",
    excludeActiveTasks: true,
  },
];

// ── Pure Functions (exported for testing) ────────────────────────────────────

/** Options for table cleanup. */
export interface CleanupTableOptions {
  db: Database.Database;
  tableName: string;
  timestampColumn: string;
  cutoffISO: string;
  excludeActiveTasks: boolean;
}

/**
 * Delete rows older than cutoffISO from the given table.
 * Runs in a transaction.
 */
export function cleanupTable(opts: CleanupTableOptions): TableCleanupResult {
  const { db, tableName, timestampColumn, cutoffISO, excludeActiveTasks } = opts;

  // Age-based deletion.
  // NULL-safe active-task protection. `events` and `observations` carry system rows with task_id IS NULL
  // (the cost / health / trigger / cleanup audit trail). A bare `task_id NOT IN (active set)` would never
  // match those rows — SQL `NULL NOT IN (non-empty set)` evaluates to NULL, not TRUE — so a system row would
  // be RETAINED whenever any task is active and pruned only when none are: non-deterministic per tick, and an
  // unbounded leak on the two highest-volume tables. The explicit `task_id IS NULL OR ...` arm prunes system
  // rows and terminal-task rows by age; only live-task rows are protected.
  const activeTaskClause = excludeActiveTasks
    ? ` AND (task_id IS NULL OR task_id NOT IN (SELECT id FROM tasks WHERE state IN (${ACTIVE_STATES.map(() => "?").join(", ")})))`
    : "";

  const ageDeleteSql = `DELETE FROM "${tableName}" WHERE "${timestampColumn}" < ?${activeTaskClause}`;

  const deleted = db.transaction(() => {
    const params: (string | number)[] = [cutoffISO];
    if (excludeActiveTasks) {
      params.push(...ACTIVE_STATES);
    }
    const result = db.prepare(ageDeleteSql).run(...params);
    return result.changes;
  })();

  // Get remaining count
  const remaining = (db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number }).count;

  return { deleted, remaining };
}

/**
 * Collect every blob reference still used by a retained observation — the protected set the orphan sweep
 * must never delete.
 *
 * A ref is any value under a `*_blob` key (the shared convention in `../observer/blob-ref.ts`: `agent-step.ts`
 * writes `prompt_blob`/`result_blob`/`transcript_blob`, `agent-activity/mapping.ts` writes
 * `text_blob`/`input_blob`/`output_blob`) on either JSON side of any observation. Matching the *convention*
 * rather than a hardcoded key list means a new `*_blob` field is protected with no change here — the drift
 * that silently emptied this set and let the sweep delete every blob can no longer recur from a rename.
 *
 * `json_each` walks each row's top-level `input`/`output` keys inside SQLite, so multi-KB payloads never load
 * into JS; the `__/%` SQL guard plus the JS-side {@link isBlobRef} drop the empty string a failed capture
 * writes and anything that isn't a well-formed ref.
 */
export function collectReferencedBlobRefs(db: Database.Database): Set<string> {
  const likeSuffix = `%${BLOB_REF_KEY_SUFFIX}`;
  const rows = db
    .prepare(
      `SELECT je.value AS ref FROM observations o, json_each(o.input) je
         WHERE je.key LIKE ? AND je.value LIKE '__/%'
       UNION
       SELECT je.value AS ref FROM observations o, json_each(o.output) je
         WHERE je.key LIKE ? AND je.value LIKE '__/%'`,
    )
    .all(likeSuffix, likeSuffix) as { ref: string }[];

  const refs = new Set<string>();
  for (const { ref } of rows) {
    if (isBlobRef(ref)) {
      refs.add(ref);
    }
  }
  return refs;
}

/**
 * A crude, JSON-parse-free probe: does any agent observation's raw text contain a `*_blob` key? Used only by
 * the orphan-sweep tripwire as an independent corroborating signal. It is *deliberately* a different mechanism
 * than {@link collectReferencedBlobRefs} (substring match, not `json_each`), so a regression in that extraction
 * cannot also defeat this guard. The `_` in the LIKE pattern is a single-char wildcard — harmless here, since
 * over-matching only makes the tripwire more conservative (skip rather than delete).
 */
export function observationsCarryBlobRefs(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM observations
         WHERE type IN ('agent_call', 'agent_activity') AND (input LIKE '%_blob%' OR output LIKE '%_blob%')
       ) AS present`,
    )
    .get() as { present: number };
  return row.present === 1;
}

/** Check that a file's real path is confined within the expected base directory. */
function isConfinedPath(filePath: string, resolvedBase: string): boolean {
  try {
    const realPath = fs.realpathSync(filePath);
    return realPath.startsWith(resolvedBase + path.sep);
  } catch {
    return false;
  }
}

/** What one orphan-blob sweep walked and removed — `scanned` is every blob file seen, `deleted` the orphans removed. */
export interface BlobCleanupResult {
  deleted: number;
  scanned: number;
}

/**
 * Walk the blobs directory and delete any blob file not in the referenced set.
 * Returns the count of files walked (`scanned`) and removed (`deleted`).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: defensive filesystem traversal with error handling at each level
export function cleanupOrphanedBlobs(blobsDir: string, referencedRefs: Set<string>): BlobCleanupResult {
  if (!fs.existsSync(blobsDir)) {
    return { deleted: 0, scanned: 0 };
  }

  const resolvedBase = fs.realpathSync(blobsDir);
  let deleted = 0;
  let scanned = 0;
  let prefixDirs: string[];
  try {
    prefixDirs = fs.readdirSync(blobsDir);
  } catch {
    return { deleted: 0, scanned: 0 }; // Can't read blobs dir — nothing to clean
  }

  for (const prefix of prefixDirs) {
    const prefixPath = path.join(blobsDir, prefix);
    try {
      const stat = fs.statSync(prefixPath);
      if (!stat.isDirectory()) {
        continue;
      }
    } catch {
      continue; // Entry disappeared or permission denied
    }

    let blobFiles: string[];
    try {
      blobFiles = fs.readdirSync(prefixPath);
    } catch {
      continue; // Can't read prefix dir
    }

    for (const blobFile of blobFiles) {
      scanned++;
      // Blob ref format: "ab/abc123...def.txt" → reconstruct ref from path
      const hash = blobFile.replace(BLOB_TXT_SUFFIX, "");
      const ref = `${prefix}/${hash}`;

      if (!referencedRefs.has(ref)) {
        const filePath = path.join(prefixPath, blobFile);
        if (!isConfinedPath(filePath, resolvedBase)) {
          continue;
        }
        try {
          fs.unlinkSync(filePath);
          deleted++;
        } catch {
          // File already removed or permission denied — skip
        }
      }
    }

    // Remove empty prefix directory
    try {
      const remainingFiles = fs.readdirSync(prefixPath);
      if (remainingFiles.length === 0) {
        fs.rmdirSync(prefixPath);
      }
    } catch {
      // Directory already removed or not empty — skip
    }
  }

  return { deleted, scanned };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * The data-lifecycle manager — a daemon-resident periodic service that prunes aged rows from the
 * local SQLite tables (events, observations, journal entries, checkpoints), sweeps orphaned blob
 * files, and runs an incremental vacuum.
 *
 * It shares its shape with the {@link createWorkspaceReaper workspace reaper} ({ start, stop, a
 * single run method, getLastRun }, an injected clock, a setInterval loop, a durable per-sweep
 * `system.*_completed` event for the dashboard's separate process). The two are deliberately kept
 * independent — no shared sweep helper — because their failure envelopes differ. The deliberate
 * asymmetry: this manager has NO re-entrancy guard, while the reaper has one. That is correct, not a
 * gap. `runCleanup` is fully synchronous — better-sqlite3 is synchronous and the blob sweep is
 * synchronous `fs`, so the event loop cannot re-enter `runCleanup` between a `setInterval` tick and
 * its completion. The reaper does async git + network I/O, so its sweep can overlap a later tick and
 * genuinely needs the `running` guard. Adding a guard here would be dead defensive code for a
 * re-entry that cannot occur.
 */
export function createDataLifecycleManager(deps: DataLifecycleManagerDeps): DataLifecycleManager {
  const { db, eventBus, config, blobsDir, clock, observer } = deps;
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastRun: CleanupStats | null = null;

  /**
   * Run one cleanup sweep. Each stage is failure-isolated (§5): one table's throw, or the blob
   * stage's throw, no longer aborts the sweep — the other stages still run. Stats, `lastRun`, the
   * info log, and the durable `system.cleanup_completed` event are computed and published from a
   * `finally` block (mirroring the reaper) so the completion event and the dashboard liveness card
   * stay truthful even on a mid-sweep failure. Sweep ordering is preserved: blob cleanup runs after
   * table pruning, since it reads the just-pruned `observations` for live blob references.
   */
  function runCleanup(): CleanupStats {
    observer.debug("Data lifecycle cleanup starting");
    const startMs = clock.now();
    const tables: Record<string, TableCleanupResult> = {};
    let blobsReferenced = 0;
    let blobsScanned = 0;
    let blobsDeleted = 0;
    let vacuumRan = false;

    try {
      for (const tableDef of MANAGED_TABLES) {
        // Per-table isolation: one table's failure is non-fatal to the sweep; the rest still prune.
        try {
          const retention = config.retention[tableDef.configKey];
          const cutoffISO = new Date(clock.now() - retention.max_age_days * 24 * 60 * 60 * 1_000).toISOString();
          tables[tableDef.name] = cleanupTable({
            db,
            tableName: tableDef.name,
            timestampColumn: tableDef.timestampColumn,
            cutoffISO,
            excludeActiveTasks: tableDef.excludeActiveTasks,
          });
        } catch (err) {
          observer.warn("Table cleanup failed — skipping it, continuing the sweep", {
            table: tableDef.name,
            error: sanitizeErrorMessage(err),
          });
        }
      }

      // Blob orphan cleanup after observation pruning — extracted into its own failure-isolated helper
      // (the json_each query can throw) so the sweep proceeds to vacuum regardless.
      const blobStats = runBlobCleanup();
      blobsReferenced = blobStats.referenced;
      blobsScanned = blobStats.scanned;
      blobsDeleted = blobStats.deleted;

      // Incremental vacuum (non-critical — failure should not halt cleanup)
      try {
        runIncrementalVacuum(db);
        vacuumRan = true;
      } catch (err) {
        observer.warn("Incremental vacuum failed", { error: sanitizeErrorMessage(err) });
      }
    } finally {
      lastRun = finalizeSweep({ tables, blobsReferenced, blobsScanned, blobsDeleted, vacuumRan, startMs });
    }

    return lastRun;
  }

  /**
   * The blob stage of one sweep: collect the protected set, run the drift tripwire, and reclaim orphans.
   * Failure-isolated — it returns zeroed tallies when blobsDir is unset, when the tripwire skips, or when the
   * json_each query throws — so {@link runCleanup} stays flat and its other stages run regardless.
   */
  function runBlobCleanup(): { referenced: number; scanned: number; deleted: number } {
    if (!blobsDir) {
      return { referenced: 0, scanned: 0, deleted: 0 };
    }
    try {
      const referencedRefs = collectReferencedBlobRefs(db);
      // Tripwire: an empty protected set while observations still carry `*_blob` refs is the signature of
      // extraction drift (it has happened — see blob-ref.ts). Deleting against an empty set wipes every blob
      // and is unrecoverable, so refuse and warn instead of nuking. observationsCarryBlobRefs is a crude
      // substring probe — a different mechanism than the extraction — so one regression can't fool both.
      if (referencedRefs.size === 0 && observationsCarryBlobRefs(db)) {
        observer.warn(
          "Blob cleanup skipped — 0 referenced refs but observations still carry blob refs (extraction drift?)",
        );
        return { referenced: 0, scanned: 0, deleted: 0 };
      }
      const result = cleanupOrphanedBlobs(path.join(blobsDir, "blobs"), referencedRefs);
      return { referenced: referencedRefs.size, scanned: result.scanned, deleted: result.deleted };
    } catch (err) {
      observer.warn("Blob cleanup failed — skipping it, continuing the sweep", {
        error: sanitizeErrorMessage(err),
      });
      return { referenced: 0, scanned: 0, deleted: 0 };
    }
  }

  /**
   * Compute the sweep stats, log them, emit the rich liveness observation, and publish the durable
   * completion event. Called from `runCleanup`'s `finally` so liveness never lies — even a sweep that
   * threw mid-way emits its completion record (with whatever stages did finish), the same way the
   * reaper publishes from its own `finally`.
   */
  function finalizeSweep(partial: {
    tables: Record<string, TableCleanupResult>;
    blobsReferenced: number;
    blobsScanned: number;
    blobsDeleted: number;
    vacuumRan: boolean;
    startMs: number;
  }): CleanupStats {
    const { tables, blobsReferenced, blobsScanned, blobsDeleted, vacuumRan, startMs } = partial;
    const durationMs = clock.now() - startMs;
    const stats: CleanupStats = {
      timestamp: new Date(clock.now()).toISOString(),
      tables,
      blobsReferenced,
      blobsScanned,
      blobsDeleted,
      vacuumRan,
      durationMs,
    };

    observer.info("Data lifecycle cleanup completed", {
      durationMs,
      tables,
      blobsReferenced,
      blobsScanned,
      blobsDeleted,
      vacuumRan,
    });

    // Liveness observation for the dashboard: the durable event below is the cross-process record the
    // separate dashboard reads; this observation lands the same sweep on the task-less trace timeline.
    // A 0-row sweep still emits (correct for liveness — not noise): it proves the service is alive.
    emitSweepObservation(stats);
    publishCleanupCompleted(stats);
    return stats;
  }

  function emitSweepObservation(stats: CleanupStats): void {
    try {
      // No task_id — a cleanup sweep is task-less (system-scoped), so the observation lands on the
      // task-less trace timeline rather than under any one task.
      observer.observe(
        ObservationTypes.state_transition,
        "data_lifecycle_sweep_completed",
        {
          tables: stats.tables,
          blobs_referenced: stats.blobsReferenced,
          blobs_scanned: stats.blobsScanned,
          blobs_deleted: stats.blobsDeleted,
          vacuum_ran: stats.vacuumRan,
          duration_ms: stats.durationMs,
        },
        { level: "info" },
      );
    } catch (err) {
      observer.warn("Failed to record the cleanup observation", { error: sanitizeErrorMessage(err) });
    }
  }

  function publishCleanupCompleted(stats: CleanupStats): void {
    // Fire-and-forget — the sweep already completed, so a publish failure is logged and swallowed
    // rather than allowed to surface as a sweep failure.
    try {
      eventBus.publish({
        type: "system.cleanup_completed",
        source: "data-lifecycle",
        task_id: null,
        payload: {
          duration_ms: stats.durationMs,
          tables: stats.tables,
          blobs_referenced: stats.blobsReferenced,
          blobs_scanned: stats.blobsScanned,
          blobs_deleted: stats.blobsDeleted,
          vacuum_ran: stats.vacuumRan,
        },
      } satisfies PublishInput<"system.cleanup_completed">);
    } catch (err) {
      observer.warn("Failed to publish cleanup event", { error: sanitizeErrorMessage(err) });
    }
  }

  function start(): void {
    if (!config.enabled || interval) {
      return;
    }
    observer.info("Data lifecycle manager started", { intervalMs: config.interval_ms });
    interval = setInterval(() => {
      try {
        runCleanup();
      } catch (err) {
        observer.error("Data lifecycle cleanup failed", { error: sanitizeErrorMessage(err) });
      }
    }, config.interval_ms);
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
      observer.debug("Data lifecycle manager stopped");
    }
  }

  function getLastRun(): CleanupStats | null {
    return lastRun;
  }

  return { start, stop, runCleanup, getLastRun };
}
