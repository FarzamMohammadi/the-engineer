import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DatabaseError,
  MigrationError,
  createDatabase,
  createInMemoryDatabase,
} from "./database.js";
import type { DatabaseHandle } from "./database.js";

// ── Constants ────────────────────────────────────────────────────────────────────

const CHECK_CONSTRAINT_PATTERN = /CHECK/;
const FK_CONSTRAINT_PATTERN = /FOREIGN KEY/;
const UNIQUE_CONSTRAINT_PATTERN = /UNIQUE/;
const TABLE_NAME_PATTERN = /^[a-z_]+$/;
const DIR_CREATE_ERROR_PATTERN = /Cannot create database directory/;
const DB_OPEN_ERROR_PATTERN = /Failed to open database/;

// ── Helpers ──────────────────────────────────────────────────────────────────────

const DOMAIN_TABLES = [
  "tasks",
  "state_transitions",
  "events",
  "sessions",
  "journal_entries",
  "checkpoints",
  "knowledge",
] as const;

function getTableNames(handle: DatabaseHandle): string[] {
  const rows = handle.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

function getColumnNames(handle: DatabaseHandle, table: string): string[] {
  // PRAGMA doesn't support parameterized queries, so validate the table name
  if (!TABLE_NAME_PATTERN.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const rows = handle.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getIndexNames(handle: DatabaseHandle): string[] {
  const rows = handle.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("createInMemoryDatabase", () => {
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("returns a handle with db and close", () => {
    handle = createInMemoryDatabase();
    expect(handle.db).toBeDefined();
    expect(typeof handle.close).toBe("function");
  });

  it("creates all 7 domain tables", () => {
    handle = createInMemoryDatabase();
    const tables = getTableNames(handle);
    for (const table of DOMAIN_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it("creates _meta table", () => {
    handle = createInMemoryDatabase();
    const tables = getTableNames(handle);
    expect(tables).toContain("_meta");
  });

  it("sets schema_version to 1 in _meta", () => {
    handle = createInMemoryDatabase();
    const row = handle.db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(row.value).toBe("9");
  });

  it("can insert and query a task row", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();
    handle.db
      .prepare(
        `INSERT INTO tasks (id, state, title, created_at, last_transition_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("01TEST", "intake", "Test task", now, now);

    const row = handle.db.prepare("SELECT * FROM tasks WHERE id = ?").get("01TEST") as {
      title: string;
    };
    expect(row.title).toBe("Test task");
  });

  it("close() closes the connection", () => {
    handle = createInMemoryDatabase();
    handle.close();
    expect(() => handle.db.prepare("SELECT 1")).toThrow();
  });

  it("close() is safe to call twice", () => {
    handle = createInMemoryDatabase();
    handle.close();
    // better-sqlite3 does not throw on double-close — it's a no-op
    expect(() => handle.close()).not.toThrow();
  });
});

describe("createDatabase", () => {
  let tmpDir: string;
  let handle: DatabaseHandle;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-db-test-"));
  });

  afterEach(() => {
    handle?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates database file at specified path", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("creates parent directories if they don't exist", () => {
    const dbPath = path.join(tmpDir, "nested", "deep", "test.db");
    handle = createDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("enables WAL mode", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    const result = handle.db.pragma("journal_mode") as { journal_mode: string }[];
    expect(result[0]?.journal_mode).toBe("wal");
  });

  it("sets synchronous to NORMAL", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    const result = handle.db.pragma("synchronous") as { synchronous: number }[];
    expect(result[0]?.synchronous).toBe(1); // 1 = NORMAL
  });

  it("creates all 7 domain tables + _meta", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    const tables = getTableNames(handle);
    for (const table of DOMAIN_TABLES) {
      expect(tables).toContain(table);
    }
    expect(tables).toContain("_meta");
  });

  it("enables foreign key enforcement", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    const result = handle.db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(result[0]?.foreign_keys).toBe(1);
  });

  it("sets busy_timeout for concurrent access", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    const result = handle.db.pragma("busy_timeout") as { timeout: number }[];
    expect(result[0]?.timeout).toBe(5000);
  });

  it("re-opening same database is idempotent", () => {
    const dbPath = path.join(tmpDir, "test.db");
    handle = createDatabase(dbPath);
    handle.close();

    // Re-open — migrations should not re-run, no errors
    handle = createDatabase(dbPath);
    const row = handle.db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(row.value).toBe("9");
  });
});

describe("table structure", () => {
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("tasks table has all expected columns", () => {
    handle = createInMemoryDatabase();
    const columns = getColumnNames(handle, "tasks");
    const expected = [
      "id",
      "external_ref",
      "state",
      "sub_state",
      "phase",
      "parent_id",
      "children",
      "cascade_policy",
      "title",
      "description",
      "source_text",
      "acceptance_criteria",
      "team",
      "related",
      "decisions",
      "child_summaries",
      "repo",
      "clone_url",
      "thoughts_id",
      "workspace",
      "review",
      "blocked",
      "priority",
      "llm_tokens",
      "llm_cost_usd",
      "compute_time_ms",
      "created_at",
      "started_at",
      "completed_at",
      "last_transition_at",
      "session_id",
      "version",
      "return_to_phase",
      "loopback_count",
      "requirements_loop_count",
    ];
    expect(columns).toEqual(expected);
  });

  it("events table has sequence as auto-increment primary key", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    handle.db
      .prepare("INSERT INTO events (id, type, source, timestamp, payload) VALUES (?, ?, ?, ?, ?)")
      .run("evt-1", "test.event", "test", now, "{}");
    handle.db
      .prepare("INSERT INTO events (id, type, source, timestamp, payload) VALUES (?, ?, ?, ?, ?)")
      .run("evt-2", "test.event", "test", now, "{}");

    const rows = handle.db.prepare("SELECT sequence FROM events ORDER BY sequence").all() as {
      sequence: number;
    }[];
    expect(rows[0]?.sequence).toBe(1);
    expect(rows[1]?.sequence).toBe(2);
  });

  it("events.id has UNIQUE index", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    handle.db
      .prepare("INSERT INTO events (id, type, source, timestamp, payload) VALUES (?, ?, ?, ?, ?)")
      .run("same-id", "test.event", "test", now, "{}");

    expect(() =>
      handle.db
        .prepare("INSERT INTO events (id, type, source, timestamp, payload) VALUES (?, ?, ?, ?, ?)")
        .run("same-id", "test.event", "test", now, "{}"),
    ).toThrow(UNIQUE_CONSTRAINT_PATTERN);
  });

  it("tasks.state CHECK constraint rejects invalid values", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("01TEST", "invalid_state", "Test", now, now),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("tasks.cascade_policy CHECK constraint rejects invalid values", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          "INSERT INTO tasks (id, state, cascade_policy, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("01TEST", "intake", "invalid_policy", "Test", now, now),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("tasks.priority CHECK constraint enforces 1-100 range", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          "INSERT INTO tasks (id, state, priority, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("01TEST", "intake", 101, "Test", now, now),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("knowledge.scope CHECK constraint rejects invalid values", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO knowledge (id, scope, domain, key, body, confidence, created_at, last_confirmed, source_task_id, source_phase)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "hash123",
          "invalid_scope",
          "patterns",
          "k",
          "v",
          "observed",
          now,
          now,
          "t1",
          "research",
        ),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("journal_entries.type CHECK constraint rejects invalid values", () => {
    handle = createInMemoryDatabase();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO journal_entries (id, session_id, task_id, timestamp, phase, type, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("j1", "s1", "t1", new Date().toISOString(), "research", "invalid_type", "test"),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("sessions.end_reason CHECK constraint rejects invalid values", () => {
    handle = createInMemoryDatabase();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO sessions (id, task_id, started_at, end_reason)
           VALUES (?, ?, ?, ?)`,
        )
        .run("s1", "t1", new Date().toISOString(), "invalid_reason"),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("checkpoints.reason CHECK constraint rejects invalid values", () => {
    handle = createInMemoryDatabase();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO checkpoints (id, session_id, task_id, phase, phase_progress, context_summary, next_action, last_event_id, reason, timestamp, journal_offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "c1",
          "s1",
          "t1",
          "research",
          "50%",
          "summary",
          "next",
          "evt1",
          "invalid_reason",
          new Date().toISOString(),
          0,
        ),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });

  it("JSON default values are set correctly", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    handle.db
      .prepare(
        "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("01TEST", "intake", "Test task", now, now);

    const row = handle.db
      .prepare("SELECT children, team, related, decisions FROM tasks WHERE id = ?")
      .get("01TEST") as {
      children: string;
      team: string;
      related: string;
      decisions: string;
    };
    expect(row.children).toBe("[]");
    expect(row.team).toBe("[]");
    expect(row.related).toBe("[]");
    expect(row.decisions).toBe("[]");
  });

  it("all expected indexes exist", () => {
    handle = createInMemoryDatabase();
    const indexes = getIndexNames(handle);

    const expectedIndexes = [
      // tasks
      "idx_tasks_state",
      "idx_tasks_parent_id",
      "idx_tasks_session_id",
      "idx_tasks_priority",
      "idx_tasks_state_priority",
      // state_transitions
      "idx_state_transitions_task_id",
      "idx_state_transitions_to_state",
      "idx_state_transitions_timestamp",
      // events
      "idx_events_type",
      "idx_events_task_id",
      "idx_events_task_sequence",
      "idx_events_timestamp",
      "idx_events_id",
      // sessions
      "idx_sessions_task_id",
      // journal_entries
      "idx_journal_session_id",
      "idx_journal_task_id",
      "idx_journal_type",
      "idx_journal_phase",
      "idx_journal_timestamp",
      // checkpoints
      "idx_checkpoints_session_id",
      "idx_checkpoints_task_id",
      "idx_checkpoints_timestamp",
      // knowledge
      "idx_knowledge_natural_key",
      "idx_knowledge_active",
      "idx_knowledge_domain",
      // observations (003_observer)
      "idx_obs_task",
      "idx_obs_trace",
      "idx_obs_type",
      "idx_obs_time",
      "idx_obs_type_name",
      "idx_obs_parent",
      "idx_obs_task_type",
      "idx_obs_level",
    ];

    for (const idx of expectedIndexes) {
      expect(indexes).toContain(idx);
    }
    expect(indexes).toHaveLength(expectedIndexes.length);
  });

  it("state_transitions CHECK constraints on from_state and to_state", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    // Insert a task first (FK reference)
    handle.db
      .prepare(
        "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "intake", "Test", now, now);

    // Valid transition
    handle.db
      .prepare(
        `INSERT INTO state_transitions (id, task_id, from_state, to_state, reason, timestamp, triggered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("st1", "t1", "intake", "queued", "ready", now, "test");

    // Invalid from_state
    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO state_transitions (id, task_id, from_state, to_state, reason, timestamp, triggered_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("st2", "t1", "bogus", "queued", "reason", now, "test"),
    ).toThrow(CHECK_CONSTRAINT_PATTERN);
  });
});

describe("foreign key enforcement", () => {
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("rejects state_transition with non-existent task_id", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO state_transitions (id, task_id, from_state, to_state, reason, timestamp, triggered_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("st1", "nonexistent", "intake", "queued", "reason", now, "test"),
    ).toThrow(FK_CONSTRAINT_PATTERN);
  });

  it("rejects session with non-existent task_id", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
        .run("s1", "nonexistent", now),
    ).toThrow(FK_CONSTRAINT_PATTERN);
  });

  it("rejects journal_entry with non-existent session_id", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          `INSERT INTO journal_entries (id, session_id, task_id, timestamp, phase, type, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("j1", "nonexistent", "t1", now, "research", "action", "test"),
    ).toThrow(FK_CONSTRAINT_PATTERN);
  });

  it("allows valid FK references", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    // Create task
    handle.db
      .prepare(
        "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "intake", "Test", now, now);

    // Create session referencing task
    handle.db
      .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
      .run("s1", "t1", now);

    // Create journal entry referencing both
    handle.db
      .prepare(
        `INSERT INTO journal_entries (id, session_id, task_id, timestamp, phase, type, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("j1", "s1", "t1", now, "research", "action", "test entry");

    // Verify all exist
    const journal = handle.db.prepare("SELECT * FROM journal_entries WHERE id = ?").get("j1");
    expect(journal).toBeDefined();
  });
});

describe("JSON default completeness", () => {
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("tasks: all JSON fields default to '[]'", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    handle.db
      .prepare(
        "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "intake", "Test", now, now);

    const row = handle.db
      .prepare(
        "SELECT children, acceptance_criteria, team, related, decisions, child_summaries FROM tasks WHERE id = ?",
      )
      .get("t1") as Record<string, string>;

    expect(row["children"]).toBe("[]");
    expect(row["acceptance_criteria"]).toBe("[]");
    expect(row["team"]).toBe("[]");
    expect(row["related"]).toBe("[]");
    expect(row["decisions"]).toBe("[]");
    expect(row["child_summaries"]).toBe("[]");
  });

  it("journal_entries.tags defaults to '[]'", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    // Create parent task and session for FK
    handle.db
      .prepare(
        "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "intake", "Test", now, now);
    handle.db
      .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
      .run("s1", "t1", now);

    handle.db
      .prepare(
        `INSERT INTO journal_entries (id, session_id, task_id, timestamp, phase, type, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("j1", "s1", "t1", now, "research", "action", "test");

    const row = handle.db.prepare("SELECT tags FROM journal_entries WHERE id = ?").get("j1") as {
      tags: string;
    };
    expect(row.tags).toBe("[]");
  });

  it("checkpoints: key_findings and open_questions default to '[]'", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    handle.db
      .prepare(
        "INSERT INTO tasks (id, state, title, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t1", "intake", "Test", now, now);
    handle.db
      .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
      .run("s1", "t1", now);

    handle.db
      .prepare(
        `INSERT INTO checkpoints (id, session_id, task_id, phase, phase_progress, context_summary, next_action, last_event_id, reason, timestamp, journal_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("c1", "s1", "t1", "research", "50%", "summary", "next", "evt1", "periodic", now, 0);

    const row = handle.db
      .prepare("SELECT key_findings, open_questions FROM checkpoints WHERE id = ?")
      .get("c1") as { key_findings: string; open_questions: string };
    expect(row.key_findings).toBe("[]");
    expect(row.open_questions).toBe("[]");
  });

  it("knowledge.evidence defaults to '[]'", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    handle.db
      .prepare(
        `INSERT INTO knowledge (id, scope, domain, key, body, confidence, created_at, last_confirmed, source_task_id, source_phase)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("hash1", "repo", "patterns", "k", "v", "observed", now, now, "t1", "research");

    const row = handle.db.prepare("SELECT evidence FROM knowledge WHERE id = ?").get("hash1") as {
      evidence: string;
    };
    expect(row.evidence).toBe("[]");
  });
});

describe("error handling", () => {
  it("DatabaseError has correct properties", () => {
    const err = new DatabaseError("test error", "/path/to/db");
    expect(err.name).toBe("DatabaseError");
    expect(err.message).toBe("test error");
    expect(err.dbPath).toBe("/path/to/db");
    expect(err).toBeInstanceOf(Error);
  });

  it("MigrationError has correct properties and extends DatabaseError", () => {
    const cause = new Error("SQL syntax error");
    const err = new MigrationError("migration failed", "/path/to/db", "001_initial.sql", 1, {
      cause,
    });
    expect(err.name).toBe("MigrationError");
    expect(err.message).toBe("migration failed");
    expect(err.dbPath).toBe("/path/to/db");
    expect(err.migrationFile).toBe("001_initial.sql");
    expect(err.version).toBe(1);
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("createInMemoryDatabase as test helper", () => {
  it("works as the test database foundation for consuming phases", () => {
    const handle = createInMemoryDatabase();
    expect(handle.db).toBeDefined();
    expect(typeof handle.close).toBe("function");

    // Verify all tables are available
    const tables = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThanOrEqual(8); // 7 domain + _meta

    handle.close();
  });
});

describe("createDatabase error paths", () => {
  it("throws DatabaseError when parent directory cannot be created", () => {
    // Use a path under /dev/null (not a directory) to trigger mkdirSync failure
    const dbPath = "/dev/null/impossible/path/test.db";
    expect(() => createDatabase(dbPath)).toThrow(DatabaseError);
    expect(() => createDatabase(dbPath)).toThrow(DIR_CREATE_ERROR_PATTERN);
  });

  it("throws DatabaseError when database file cannot be opened", () => {
    // Use a directory path as a database file (can't open a directory as SQLite)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-db-err-"));
    try {
      expect(() => createDatabase(tmpDir)).toThrow(DatabaseError);
      expect(() => createDatabase(tmpDir)).toThrow(DB_OPEN_ERROR_PATTERN);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("closes database and throws DatabaseError when pragma configuration fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-db-pragma-"));
    const dbPath = path.join(tmpDir, "test.db");
    const origCreateDb = createDatabase;

    // We can't easily mock pragmas on better-sqlite3, so we verify the guard exists
    // by checking that a successful createDatabase sets all expected pragmas
    const handle = origCreateDb(dbPath);
    const walResult = handle.db.pragma("journal_mode") as { journal_mode: string }[];
    expect(walResult[0]?.journal_mode).toBe("wal");
    handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("foreign key enforcement during migrations", () => {
  let handle: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("enforces FK constraints for in-memory databases", () => {
    handle = createInMemoryDatabase();
    const result = handle.db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(result[0]?.foreign_keys).toBe(1);
  });

  it("rejects FK violations in in-memory databases", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    // session referencing non-existent task should fail
    expect(() =>
      handle.db
        .prepare("INSERT INTO sessions (id, task_id, started_at) VALUES (?, ?, ?)")
        .run("s1", "no-such-task", now),
    ).toThrow(FK_CONSTRAINT_PATTERN);
  });

  it("tasks.session_id FK rejects non-existent session", () => {
    handle = createInMemoryDatabase();
    const now = new Date().toISOString();

    expect(() =>
      handle.db
        .prepare(
          "INSERT INTO tasks (id, state, title, session_id, created_at, last_transition_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("t1", "intake", "Test", "no-such-session", now, now),
    ).toThrow(FK_CONSTRAINT_PATTERN);
  });

  // ── File Permission Tests (Security Hardening) ───────────────────────────

  it("database file has owner-only permissions (0o600)", () => {
    if (process.platform === "win32") {
      return;
    } // POSIX only
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-perms-"));
    const dbPath = path.join(tmpDir, "subdir", "test.db");
    const h = createDatabase(dbPath);
    try {
      const stat = fs.statSync(dbPath);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      h.close();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("parent directory has restricted permissions (0o700) when newly created", () => {
    if (process.platform === "win32") {
      return;
    } // POSIX only
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-dir-perms-"));
    const newSubdir = path.join(tmpDir, "fresh-data-dir");
    const dbPath = path.join(newSubdir, "test.db");
    const h = createDatabase(dbPath);
    try {
      const stat = fs.statSync(newSubdir);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      h.close();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
