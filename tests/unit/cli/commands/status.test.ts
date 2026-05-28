import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStatus } from "../../../../src/cli/commands/status.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { createDatabase } from "../../../../src/db/database.js";

let tempDir: string;
let stdoutWrites: string[];

function insertTask(db: import("better-sqlite3").Database, id: string, overrides: Record<string, unknown> = {}): void {
  const defaults = {
    state: "queued",
    title: "Test task",
    created_at: "2026-01-01T00:00:00Z",
    last_transition_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, idempotency_key, title, priority, state, sub_state, created_at, last_transition_at)
     VALUES (?, ?, ?, 50, ?, NULL, ?, ?)`,
  ).run(id, `test:${id}`, defaults.title, defaults.state, defaults.created_at, defaults.last_transition_at);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "status-test-"));
  mkdirSync(join(tempDir, "run"), { recursive: true });
  stdoutWrites = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  resetOutput();
  vi.restoreAllMocks();
});

describe("runStatus", () => {
  it("shows stopped when no PID file exists", () => {
    createOutput({ mode: "human", color: false });
    const code = runStatus(tempDir);
    expect(code).toBe(0);
    expect(stdoutWrites.join("")).toContain("stopped");
  });

  it("shows stopped when PID file points to dead process", () => {
    createOutput({ mode: "human", color: false });
    writeFileSync(join(tempDir, "run", "engineer.pid"), "99999999\n");
    const code = runStatus(tempDir);
    expect(code).toBe(0);
    expect(stdoutWrites.join("")).toContain("stopped");
  });

  it("shows 'Tasks: none' when database has no tasks", () => {
    createOutput({ mode: "human", color: false });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);
    expect(stdoutWrites.join("")).toContain("Tasks: none");
  });

  it("lists non-terminal tasks with ID prefix, title, and age", () => {
    createOutput({ mode: "human", color: false });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01HXYZ1234567890ABCDEFGHIJ", {
      state: "active",
      title: "Add OAuth scope toggle",
    });
    insertTask(handle.db, "01HXYW9876543210ABCDEFGHIJ", {
      state: "queued",
      title: "Fix README link rot",
    });
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("1 active, 1 queued");
    expect(output).toContain("01HXYZ12");
    expect(output).toContain("Add OAuth scope toggle");
    expect(output).toContain("01HXYW98");
    expect(output).toContain("Fix README link rot");
  });

  it("excludes completed and failed tasks by default", () => {
    createOutput({ mode: "human", color: false });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01ACTIVE00000000000000000A", { state: "active", title: "Active task" });
    insertTask(handle.db, "01DONE0000000000000000000A", { state: "completed", title: "Done task" });
    insertTask(handle.db, "01FAIL0000000000000000000A", { state: "failed", title: "Failed task" });
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("Active task");
    expect(output).not.toContain("Done task");
    expect(output).not.toContain("Failed task");
  });

  it("includes all tasks with --all flag", () => {
    createOutput({ mode: "human", color: false });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01ACTIVE00000000000000000A", { state: "active", title: "Active task" });
    insertTask(handle.db, "01DONE0000000000000000000A", { state: "completed", title: "Done task" });
    insertTask(handle.db, "01FAIL0000000000000000000A", { state: "failed", title: "Failed task" });
    handle.close();

    const code = runStatus(tempDir, { all: true });
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("Active task");
    expect(output).toContain("Done task");
    expect(output).toContain("Failed task");
  });

  it("orders active tasks before queued", () => {
    createOutput({ mode: "human", color: false });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01QUEUED000000000000000001", { state: "queued", title: "Queued first" });
    insertTask(handle.db, "01ACTIVE000000000000000001", { state: "active", title: "Active first" });
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    const activeIdx = output.indexOf("Active first");
    const queuedIdx = output.indexOf("Queued first");
    expect(activeIdx).toBeLessThan(queuedIdx);
  });

  it("outputs JSON with task details", () => {
    createOutput({ mode: "json" });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01HXYZ1234567890ABCDEFGHIJ", {
      state: "active",
      title: "Add OAuth scope toggle",
    });
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdoutWrites.join(""));
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe("01HXYZ1234567890ABCDEFGHIJ");
    expect(parsed.tasks[0].state).toBe("active");
    expect(parsed.tasks[0].title).toBe("Add OAuth scope toggle");
  });

  it("truncates long titles", () => {
    createOutput({ mode: "human", color: false });
    const dbPath = join(tempDir, "data", "engineer.db");
    const handle = createDatabase(dbPath);
    insertTask(handle.db, "01LONG0000000000000000000A", {
      state: "active",
      title: "This is a very long task title that should be truncated to fit the display",
    });
    handle.close();

    const code = runStatus(tempDir);
    expect(code).toBe(0);

    const output = stdoutWrites.join("");
    expect(output).toContain("…");
    expect(output).not.toContain("to fit the display");
  });
});
