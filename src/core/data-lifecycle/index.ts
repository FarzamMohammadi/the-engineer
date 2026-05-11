import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { runIncrementalVacuum } from "../../db/database.js";
import type { DataLifecycleConfig } from "../../schemas/config.js";
import { SystemCleanupCompletedPayloadSchema } from "../../schemas/events.js";
import { SubStates, TaskStates } from "../../schemas/task.js";
import type { Clock } from "../../utils/clock.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type { IObserver } from "../observer/index.js";

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
const ACTIVE_STATES = [
  TaskStates.requirements_gathering,
  TaskStates.queued,
  TaskStates.active,
  TaskStates.blocked,
  TaskStates.review_pending,
  SubStates.supervising,
];

// ── Table Definitions ─────────────────────────────────────────────────────────

interface TableDefinition {
  name: string;
  timestampColumn: string;
  configKey: keyof DataLifecycleConfig["retention"];
  /** Whether to exclude rows belonging to active tasks */
  excludeActiveTasks: boolean;
}

const MANAGED_TABLES: TableDefinition[] = [
  { name: "events", timestampColumn: "timestamp", configKey: "events", excludeActiveTasks: false },
  {
    name: "observations",
    timestampColumn: "start_time",
    configKey: "observations",
    excludeActiveTasks: false,
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

  // Age-based deletion
  const activeTaskClause = excludeActiveTasks
    ? ` AND task_id NOT IN (SELECT id FROM tasks WHERE state IN (${ACTIVE_STATES.map(() => "?").join(", ")}))`
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
 * Collect all blob references still used by llm_call observations.
 * Blob refs are stored inside the input JSON as prompt_ref / response_ref.
 */
export function collectReferencedBlobRefs(db: Database.Database): Set<string> {
  const refs = new Set<string>();

  // Use json_extract at the SQL level to avoid loading full input JSON blobs into JS memory.
  // With thousands of LLM calls, the input column can be multi-KB each — extracting only the
  // two ref strings keeps memory proportional to ref count, not total JSON size.
  const rows = db
    .prepare(
      `SELECT json_extract(input, '$.prompt_ref') as prompt_ref,
              json_extract(input, '$.response_ref') as response_ref
       FROM observations
       WHERE type = 'llm_call' AND input IS NOT NULL`,
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

export function createDataLifecycleManager(deps: DataLifecycleManagerDeps): DataLifecycleManager {
  const { db, eventBus, config, blobsDir, clock, observer } = deps;
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastRun: CleanupStats | null = null;

  function runCleanup(): CleanupStats {
    observer.debug("Data lifecycle cleanup starting");
    const startMs = clock.now();
    const tables: Record<string, TableCleanupResult> = {};

    for (const tableDef of MANAGED_TABLES) {
      const retention = config.retention[tableDef.configKey];
      const cutoff = new Date(clock.now() - retention.max_age_days * 24 * 60 * 60 * 1_000);
      const cutoffISO = cutoff.toISOString();

      tables[tableDef.name] = cleanupTable({
        db,
        tableName: tableDef.name,
        timestampColumn: tableDef.timestampColumn,
        cutoffISO,
        excludeActiveTasks: tableDef.excludeActiveTasks,
      });
    }

    // Blob orphan cleanup after observation pruning
    let blobsDeleted = 0;
    if (blobsDir) {
      const blobsDirPath = path.join(blobsDir, "blobs");
      const referencedRefs = collectReferencedBlobRefs(db);
      blobsDeleted = cleanupOrphanedBlobs(blobsDirPath, referencedRefs);
    }

    // Incremental vacuum (non-critical — failure should not halt cleanup)
    let vacuumRan = false;
    try {
      runIncrementalVacuum(db);
      vacuumRan = true;
    } catch (err) {
      observer.warn("Incremental vacuum failed", { error: sanitizeErrorMessage(err) });
    }

    const durationMs = clock.now() - startMs;
    const timestamp = new Date(clock.now()).toISOString();

    const stats: CleanupStats = {
      timestamp,
      tables,
      blobsDeleted,
      vacuumRan,
      durationMs,
    };

    lastRun = stats;

    observer.info("Data lifecycle cleanup completed", {
      durationMs,
      tables: Object.fromEntries(
        Object.entries(tables).map(([n, r]) => [n, { deleted: r.deleted, remaining: r.remaining }]),
      ),
      blobsDeleted,
      vacuumRan,
    });

    // Emit cleanup event (fire-and-forget — cleanup already completed)
    try {
      eventBus.publish({
        type: "system.cleanup_completed",
        source: "data-lifecycle",
        task_id: null,
        payload: {
          duration_ms: durationMs,
          tables: Object.fromEntries(
            Object.entries(tables).map(([name, result]) => [
              name,
              { deleted: result.deleted, remaining: result.remaining },
            ]),
          ),
          blobs_deleted: blobsDeleted,
          vacuum_ran: vacuumRan,
        },
      } satisfies PublishInput<"system.cleanup_completed">);
    } catch (err) {
      observer.warn("Failed to publish cleanup event", { error: sanitizeErrorMessage(err) });
    }

    return stats;
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
