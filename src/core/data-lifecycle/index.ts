import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { runIncrementalVacuum } from "../../db/database.js";
import type { DataLifecycleConfig } from "../../schemas/config.js";
import type { EventType } from "../../schemas/events.js";
import type { Clock } from "../../utils/clock.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";

const BLOB_TXT_SUFFIX = /\.txt$/;

// ── Types ────────────────────────────────────────────────────────────────────────

export interface TableCleanupResult {
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
}

// Active task states — never prune data belonging to these tasks
const ACTIVE_STATES = ["intake", "queued", "active", "blocked", "review_pending", "supervising"];

// ── Table Definitions ─────────────────────────────────────────────────────────

interface TableDef {
  name: string;
  timestampColumn: string;
  configKey: keyof DataLifecycleConfig["retention"];
  /** Whether to exclude rows belonging to active tasks */
  excludeActiveTasks: boolean;
}

const MANAGED_TABLES: TableDef[] = [
  { name: "events", timestampColumn: "timestamp", configKey: "events", excludeActiveTasks: false },
  {
    name: "action_traces",
    timestampColumn: "timestamp",
    configKey: "action_traces",
    excludeActiveTasks: false,
  },
  {
    name: "phase_metrics",
    timestampColumn: "started_at",
    configKey: "phase_metrics",
    excludeActiveTasks: false,
  },
  {
    name: "llm_traces",
    timestampColumn: "timestamp",
    configKey: "llm_traces",
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

/**
 * Delete rows older than cutoffISO from the given table.
 * If maxCount is set, also trims to keep only the newest N rows.
 * Each operation runs in its own transaction.
 */
export function cleanupTable(
  db: Database.Database,
  tableName: string,
  timestampColumn: string,
  maxCount: number | null,
  cutoffISO: string,
  excludeActiveTasks: boolean,
): TableCleanupResult {
  let totalDeleted = 0;

  // Age-based deletion
  const activeTaskClause = excludeActiveTasks
    ? ` AND task_id NOT IN (SELECT id FROM tasks WHERE state IN (${ACTIVE_STATES.map(() => "?").join(", ")}))`
    : "";

  const ageDeleteSql = `DELETE FROM "${tableName}" WHERE "${timestampColumn}" < ?${activeTaskClause}`;

  const ageDelete = db.transaction(() => {
    const params: (string | number)[] = [cutoffISO];
    if (excludeActiveTasks) {
      params.push(...ACTIVE_STATES);
    }
    const result = db.prepare(ageDeleteSql).run(...params);
    return result.changes;
  });

  totalDeleted += ageDelete();

  // Count-based trimming (keep newest)
  if (maxCount !== null && maxCount > 0) {
    const countDeleteSql = `DELETE FROM "${tableName}" WHERE rowid NOT IN (SELECT rowid FROM "${tableName}" ORDER BY "${timestampColumn}" DESC LIMIT ?)`;

    const countDelete = db.transaction(() => {
      const result = db.prepare(countDeleteSql).run(maxCount);
      return result.changes;
    });

    totalDeleted += countDelete();
  }

  // Get remaining count
  const remaining = (
    db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number }
  ).count;

  return { deleted: totalDeleted, remaining };
}

/**
 * Collect all blob references still used by llm_traces rows.
 */
export function collectReferencedBlobRefs(db: Database.Database): Set<string> {
  const refs = new Set<string>();

  const rows = db.prepare("SELECT prompt_ref, response_ref FROM llm_traces").all() as {
    prompt_ref: string | null;
    response_ref: string | null;
  }[];

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

/**
 * Walk the blobs directory and delete any blob files not in the referenced set.
 * Returns the number of deleted blob files.
 */
export function cleanupOrphanedBlobs(blobsDir: string, referencedRefs: Set<string>): number {
  if (!fs.existsSync(blobsDir)) {
    return 0;
  }

  let deleted = 0;
  const prefixDirs = fs.readdirSync(blobsDir);

  for (const prefix of prefixDirs) {
    const prefixPath = path.join(blobsDir, prefix);
    const stat = fs.statSync(prefixPath);
    if (!stat.isDirectory()) {
      continue;
    }

    const blobFiles = fs.readdirSync(prefixPath);
    for (const blobFile of blobFiles) {
      // Blob ref format: "ab/abc123...def.txt" → reconstruct ref from path
      const hash = blobFile.replace(BLOB_TXT_SUFFIX, "");
      const ref = `${prefix}/${hash}`;

      if (!referencedRefs.has(ref)) {
        fs.unlinkSync(path.join(prefixPath, blobFile));
        deleted++;
      }
    }

    // Remove empty prefix directory
    const remaining = fs.readdirSync(prefixPath);
    if (remaining.length === 0) {
      fs.rmdirSync(prefixPath);
    }
  }

  return deleted;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDataLifecycleManager(deps: DataLifecycleManagerDeps): DataLifecycleManager {
  const { db, eventBus, config, blobsDir, clock } = deps;
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastRun: CleanupStats | null = null;

  function runCleanup(): CleanupStats {
    const startMs = clock.now();
    const tables: Record<string, TableCleanupResult> = {};

    for (const tableDef of MANAGED_TABLES) {
      const retention = config.retention[tableDef.configKey];
      const cutoff = new Date(clock.now() - retention.max_age_days * 24 * 60 * 60 * 1_000);
      const cutoffISO = cutoff.toISOString();

      tables[tableDef.name] = cleanupTable(
        db,
        tableDef.name,
        tableDef.timestampColumn,
        retention.max_count ?? null,
        cutoffISO,
        tableDef.excludeActiveTasks,
      );
    }

    // Blob orphan cleanup after llm_traces pruning
    let blobsDeleted = 0;
    if (blobsDir) {
      const blobsDirPath = path.join(blobsDir, "blobs");
      const referencedRefs = collectReferencedBlobRefs(db);
      blobsDeleted = cleanupOrphanedBlobs(blobsDirPath, referencedRefs);
    }

    // Incremental vacuum
    let vacuumRan = false;
    if (config.vacuum_on_cleanup) {
      runIncrementalVacuum(db);
      vacuumRan = true;
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

    // Emit cleanup event
    eventBus.publish({
      type: "system.cleanup_completed" as EventType,
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
    });

    return stats;
  }

  function start(): void {
    if (!config.enabled || interval) {
      return;
    }
    interval = setInterval(() => {
      runCleanup();
    }, config.interval_ms);
  }

  function stop(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function getLastRun(): CleanupStats | null {
    return lastRun;
  }

  return { start, stop, runCleanup, getLastRun };
}
