import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

import { extractErrorMessage } from "../utils/errors.js";

// ── Error Classes ────────────────────────────────────────────────────────────────

export class DatabaseError extends Error {
  readonly dbPath: string;

  constructor(message: string, dbPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseError";
    this.dbPath = dbPath;
  }
}

export class MigrationError extends DatabaseError {
  readonly migrationFile: string;
  readonly version: number;

  constructor(
    message: string,
    dbPath: string,
    migrationFile: string,
    version: number,
    options?: ErrorOptions,
  ) {
    super(message, dbPath, options);
    this.name = "MigrationError";
    this.migrationFile = migrationFile;
    this.version = version;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────────

export interface DatabaseHandle {
  db: Database.Database;
  close(): void;
}

// ── Migration Runner (internal) ──────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");

const MIGRATION_FILE_PATTERN = /^(\d+)_.*\.sql$/;

// Matches bare BEGIN/COMMIT/ROLLBACK at statement level (not inside strings or comments).
// Migration files MUST NOT contain transaction control — the runner wraps each in a transaction.
const TRANSACTION_STATEMENT_PATTERN = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/im;

const BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_SIZE_MB = 64;

/** Options for database creation. */
export interface DatabaseOptions {
  /** SQLite page cache size in MB. Default: 64. */
  cacheSizeMb?: number;
}

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

function loadMigrations(migrationsDir: string, dbPath: string): MigrationFile[] {
  let files: string[];
  try {
    files = fs.readdirSync(migrationsDir).sort();
  } catch (error) {
    throw new DatabaseError(
      `Cannot read migrations directory "${migrationsDir}": ${extractErrorMessage(error)}`,
      dbPath,
      { cause: error },
    );
  }
  const migrations: MigrationFile[] = [];

  for (const filename of files) {
    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (!match?.[1]) {
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    let sql: string;
    try {
      sql = fs.readFileSync(path.join(migrationsDir, filename), "utf-8");
    } catch (error) {
      throw new DatabaseError(
        `Cannot read migration file "${filename}": ${extractErrorMessage(error)}`,
        dbPath,
        { cause: error },
      );
    }
    migrations.push({ version, filename, sql });
  }

  return migrations;
}

function runMigrations(db: Database.Database, dbPath: string, migrationsDir: string): void {
  // 1. Bootstrap _meta table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 2. Ensure schema_version row exists
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;

  if (!row) {
    db.prepare("INSERT INTO _meta (key, value) VALUES ('schema_version', '0')").run();
  }

  const currentVersion = row ? Number.parseInt(row.value, 10) : 0;

  // 3. Load and filter migrations
  const migrations = loadMigrations(migrationsDir, dbPath);
  const unapplied = migrations.filter((m) => m.version > currentVersion);

  // 4. Apply each migration in its own transaction
  for (const migration of unapplied) {
    // Guard: migration files must not contain their own transaction control.
    // The runner wraps each file in a transaction; nested BEGIN/COMMIT would throw.
    if (TRANSACTION_STATEMENT_PATTERN.test(migration.sql)) {
      throw new MigrationError(
        `Migration ${migration.filename} contains transaction statements (BEGIN/COMMIT/ROLLBACK). Migration files must not manage their own transactions — the runner wraps each in one.`,
        dbPath,
        migration.filename,
        migration.version,
      );
    }

    const applyMigration = db.transaction(() => {
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new MigrationError(
          `Migration ${migration.filename} failed: ${extractErrorMessage(error)}`,
          dbPath,
          migration.filename,
          migration.version,
          { cause: error },
        );
      }
      db.prepare("UPDATE _meta SET value = ? WHERE key = 'schema_version'").run(
        migration.version.toString(),
      );
    });

    applyMigration();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Best-effort chmod 0o600 — non-fatal on unsupported filesystems (e.g. FAT32). */
function restrictFilePermissions(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal: chmod may fail on some filesystems
  }
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Opens a SQLite database at the given path, applies unapplied migrations,
 * enables WAL mode and synchronous=NORMAL.
 *
 * Creates the database file and parent directories if they don't exist.
 */
export function createDatabase(dbPath: string, options?: DatabaseOptions): DatabaseHandle {
  // Ensure parent directories exist (owner-only access)
  const dbDir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new DatabaseError(
      `Cannot create database directory "${dbDir}": ${extractErrorMessage(error)}`,
      dbPath,
      { cause: error },
    );
  }

  let db: Database.Database;
  try {
    db = new BetterSqlite3(dbPath);
  } catch (error) {
    throw new DatabaseError(
      `Failed to open database at ${dbPath}: ${extractErrorMessage(error)}`,
      dbPath,
      { cause: error },
    );
  }

  restrictFilePermissions(dbPath);

  // All post-open work in a single try/catch — if anything fails, close the DB
  // handle so it doesn't leak (the handle is never returned on error).
  try {
    // FK enforcement must be set before migrations — per-connection, not persisted
    db.pragma("foreign_keys = ON");

    // auto_vacuum must be set before any tables exist. For existing databases where
    // tables already exist, this is silently ignored (correct SQLite behavior).
    // Only new installations benefit from incremental vacuum.
    db.pragma("auto_vacuum = INCREMENTAL");

    // Run migrations
    runMigrations(db, dbPath, MIGRATIONS_DIR);

    // WAL mode + pragmas after migrations (per sqlite.md startup flow)
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Cache size: negative value = KiB (SQLite convention)
    const cacheSizeMb = options?.cacheSizeMb ?? DEFAULT_CACHE_SIZE_MB;
    db.pragma(`cache_size = -${cacheSizeMb * 1_024}`);
  } catch (error) {
    db.close();
    // MigrationError already has full context (file, version) — re-throw directly
    if (error instanceof MigrationError) {
      throw error;
    }
    throw new DatabaseError(
      `Database initialization failed at ${dbPath}: ${extractErrorMessage(error)}`,
      dbPath,
      { cause: error },
    );
  }

  // Restrict WAL/SHM sidecar files to owner-only access
  for (const suffix of ["-wal", "-shm"]) {
    restrictFilePermissions(dbPath + suffix);
  }

  return {
    db,
    close() {
      db.close();
    },
  };
}

/**
 * Creates an in-memory SQLite database with all migrations applied.
 * WAL mode is not set (not supported for :memory:).
 */
export function createInMemoryDatabase(): DatabaseHandle {
  const db = new BetterSqlite3(":memory:");

  // FK enforcement must be set before migrations — per-connection, not persisted
  db.pragma("foreign_keys = ON");

  runMigrations(db, ":memory:", MIGRATIONS_DIR);

  return {
    db,
    close() {
      db.close();
    },
  };
}

/**
 * Runs SQLite incremental vacuum to reclaim space after large deletes.
 * Only effective when `auto_vacuum = INCREMENTAL` was set at DB creation.
 */
export function runIncrementalVacuum(db: Database.Database): void {
  db.pragma("incremental_vacuum");
}
