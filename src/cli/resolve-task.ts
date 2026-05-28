import type BetterSqlite3 from "better-sqlite3";

import { getOutput } from "./output.js";

interface TaskIdRow {
  readonly id: string;
}

/** Resolve a full task ID or unique prefix to the canonical ID, printing errors on failure. */
export function resolveTaskId(db: BetterSqlite3.Database, input: string): string | null {
  const out = getOutput();

  const exact = db.prepare("SELECT id FROM tasks WHERE id = ?").get(input) as TaskIdRow | undefined;
  if (exact) {
    return exact.id;
  }

  const matches = db.prepare("SELECT id FROM tasks WHERE id LIKE ? ORDER BY id").all(`${input}%`) as TaskIdRow[];

  if (matches.length === 0) {
    out.error(`Task not found: ${input}`);
    return null;
  }

  if (matches.length === 1) {
    return matches[0]?.id ?? null;
  }

  const ids = matches.map((r) => r.id).join(", ");
  out.error(`Ambiguous prefix "${input}" matches ${String(matches.length)} tasks: ${ids}`);
  return null;
}
