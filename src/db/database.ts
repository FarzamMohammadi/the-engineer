import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

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

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

function loadMigrations(migrationsDir: string): MigrationFile[] {
  const files = fs.readdirSync(migrationsDir).sort();
  const migrations: MigrationFile[] = [];

  for (const filename of files) {
    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (!match?.[1]) {
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf-8");
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
  const migrations = loadMigrations(migrationsDir);
  const unapplied = migrations.filter((m) => m.version > currentVersion);

  // 4. Apply each migration in its own transaction
  for (const migration of unapplied) {
    const applyMigration = db.transaction(() => {
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new MigrationError(
          `Migration ${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
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

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Opens a SQLite database at the given path, applies unapplied migrations,
 * enables WAL mode and synchronous=NORMAL.
 *
 * Creates the database file and parent directories if they don't exist.
 */
export function createDatabase(dbPath: string): DatabaseHandle {
  // Ensure parent directories exist
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db: Database.Database;
  try {
    db = new BetterSqlite3(dbPath);
  } catch (error) {
    throw new DatabaseError(
      `Failed to open database at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
      dbPath,
      { cause: error },
    );
  }

  // Run migrations
  runMigrations(db, dbPath, MIGRATIONS_DIR);

  // Enable WAL mode and pragmas (after migrations, per spec)
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

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

  runMigrations(db, ":memory:", MIGRATIONS_DIR);

  db.pragma("foreign_keys = ON");

  return {
    db,
    close() {
      db.close();
    },
  };
}
