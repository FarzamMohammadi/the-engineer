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
 * Collect all blob references still used by agent_call observations.
 * Blob refs are stored inside the input JSON as prompt_ref / response_ref.
 */
export function collectReferencedBlobRefs(db: Database.Database): Set<string> {
  const refs = new Set<string>();

  // Use json_extract at the SQL level to avoid loading full input JSON blobs into JS memory.
  // With thousands of agent calls, the input column can be multi-KB each — extracting only the
  // two ref strings keeps memory proportional to ref count, not total JSON size.
  const rows = db
    .prepare(
      `SELECT json_extract(input, '$.prompt_ref') as prompt_ref,
              json_extract(input, '$.response_ref') as response_ref
       FROM observations
       WHERE type = 'agent_call' AND input IS NOT NULL`,
    )
    .all() as { prompt_ref: string | null; response_ref: string | null }[];

  for (const row of rows) {
    if (row.prompt_ref) {
      refs.add(row.prompt_ref);
    }
    if (row.response_ref) {
      refs.add(row.response_ref);
    }
  }

  return refs;
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

/**
 * Walk the blobs directory and delete any blob files not in the referenced set.
 * Returns the number of deleted blob files.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: defensive filesystem traversal with error handling at each level
export function cleanupOrphanedBlobs(blobsDir: string, referencedRefs: Set<string>): number {
  if (!fs.existsSync(blobsDir)) {
    return 0;
  }

  const resolvedBase = fs.realpathSync(blobsDir);
  let deleted = 0;
  let prefixDirs: string[];
  try {
    prefixDirs = fs.readdirSync(blobsDir);
  } catch {
    return 0; // Can't read blobs dir — nothing to clean
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

  return deleted;
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

      // Blob orphan cleanup after observation pruning — isolated, because collectReferencedBlobRefs
      // runs a real json_extract query that can throw and must not abort the sweep before vacuum.
      if (blobsDir) {
        try {
          const blobsDirPath = path.join(blobsDir, "blobs");
          const referencedRefs = collectReferencedBlobRefs(db);
          blobsDeleted = cleanupOrphanedBlobs(blobsDirPath, referencedRefs);
        } catch (err) {
          observer.warn("Blob cleanup failed — skipping it, continuing the sweep", {
            error: sanitizeErrorMessage(err),
          });
        }
      }

      // Incremental vacuum (non-critical — failure should not halt cleanup)
      try {
        runIncrementalVacuum(db);
        vacuumRan = true;
      } catch (err) {
        observer.warn("Incremental vacuum failed", { error: sanitizeErrorMessage(err) });
      }
    } finally {
      lastRun = finalizeSweep({ tables, blobsDeleted, vacuumRan, startMs });
    }

    return lastRun;
  }

  /**
   * Compute the sweep stats, log them, emit the rich liveness observation, and publish the durable
   * completion event. Called from `runCleanup`'s `finally` so liveness never lies — even a sweep that
   * threw mid-way emits its completion record (with whatever stages did finish), the same way the
   * reaper publishes from its own `finally`.
   */
  function finalizeSweep(partial: {
    tables: Record<string, TableCleanupResult>;
    blobsDeleted: number;
    vacuumRan: boolean;
    startMs: number;
  }): CleanupStats {
    const { tables, blobsDeleted, vacuumRan, startMs } = partial;
    const durationMs = clock.now() - startMs;
    const stats: CleanupStats = {
      timestamp: new Date(clock.now()).toISOString(),
      tables,
      blobsDeleted,
      vacuumRan,
      durationMs,
    };

    observer.info("Data lifecycle cleanup completed", { durationMs, tables, blobsDeleted, vacuumRan });

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
