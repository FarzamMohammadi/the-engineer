import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type BetterSqlite3 from "better-sqlite3";

import { createOutput, resetOutput } from "../../../src/cli/output.js";
import { resolveTaskId } from "../../../src/cli/resolve-task.js";
import { createDatabase } from "../../../src/db/database.js";

let tempDir: string;
let db: BetterSqlite3.Database;
let stderrWrites: string[];

function insertTask(id: string, state = "queued"): void {
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, title, priority, state, sub_state, created_at, last_transition_at)
     VALUES (?, ?, 'Test task', 50, ?, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id, `test:${id}`, state);
}

beforeEach(() => {
  tempDir = join(tmpdir(), `resolve-task-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "data"), { recursive: true });

  const dbPath = join(tempDir, "data", "engineer.db");
  const handle = createDatabase(dbPath);
  db = handle.db;

  stderrWrites = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrWrites.push(String(chunk));
    return true;
  });

  createOutput({ mode: "human", color: false });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  resetOutput();
});

describe("resolveTaskId", () => {
  it("resolves exact full ID", () => {
    insertTask("01HXYZ1234567890ABCDEFGHIJ");

    const result = resolveTaskId(db, "01HXYZ1234567890ABCDEFGHIJ");
    expect(result).toBe("01HXYZ1234567890ABCDEFGHIJ");
  });

  it("resolves unique prefix to full ID", () => {
    insertTask("01HXYZ1234567890ABCDEFGHIJ");

    const result = resolveTaskId(db, "01HXYZ12");
    expect(result).toBe("01HXYZ1234567890ABCDEFGHIJ");
  });

  it("returns null and prints error for no match", () => {
    const result = resolveTaskId(db, "NONEXISTENT");
    expect(result).toBeNull();
    expect(stderrWrites.join("")).toContain("Task not found: NONEXISTENT");
  });

  it("returns null and prints error for ambiguous prefix", () => {
    insertTask("01HXYZ1234567890ABCDEFGH01");
    insertTask("01HXYZ1234567890ABCDEFGH02");

    const result = resolveTaskId(db, "01HXYZ");
    expect(result).toBeNull();
    expect(stderrWrites.join("")).toContain("Ambiguous prefix");
    expect(stderrWrites.join("")).toContain("01HXYZ1234567890ABCDEFGH01");
    expect(stderrWrites.join("")).toContain("01HXYZ1234567890ABCDEFGH02");
  });

  it("prefers exact match over prefix match", () => {
    insertTask("01HXYZ12");
    insertTask("01HXYZ1234567890ABCDEFGHIJ");

    const result = resolveTaskId(db, "01HXYZ12");
    expect(result).toBe("01HXYZ12");
  });

  it("works with single-character prefix when unique", () => {
    insertTask("AONLY0000000000000000000001");

    const result = resolveTaskId(db, "A");
    expect(result).toBe("AONLY0000000000000000000001");
  });
});
