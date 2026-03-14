import type Database from "better-sqlite3";

import type { KnowledgeEntry, KnowledgeScope } from "../../schemas/session-memory.js";
import { knowledgeId } from "../../schemas/session-memory.js";
import type { StoreKnowledgeInput } from "../interfaces/session-memory.interface.js";
import { KnowledgeNotFoundError } from "./errors.js";
import { type KnowledgeEntryRow, rowToKnowledgeEntry } from "./row-mappers.js";

/**
 * Persistent knowledge store: patterns and conventions learned across tasks.
 *
 * Uses content-hash IDs for idempotent upsert. Knowledge is isolated by scope
 * (repo/user) and optionally by repoScope for per-repository knowledge.
 */
export class KnowledgeStore {
  private readonly insertKnowledgeStmt: Database.Statement;
  private readonly getKnowledgeByIdStmt: Database.Statement;
  private readonly getActiveKnowledgeStmt: Database.Statement;
  private readonly getActiveKnowledgeRepoStmt: Database.Statement;
  private readonly supersedeKnowledgeStmt: Database.Statement;
  private readonly confirmKnowledgeStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertKnowledgeStmt = db.prepare(`
      INSERT INTO knowledge (
        id, scope, repo_scope, domain, key, body, confidence, evidence,
        created_at, last_confirmed, superseded_by, source_task_id, source_phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getKnowledgeByIdStmt = db.prepare("SELECT * FROM knowledge WHERE id = ?");

    this.getActiveKnowledgeStmt = db.prepare(
      "SELECT * FROM knowledge WHERE scope = ? AND superseded_by IS NULL ORDER BY created_at ASC",
    );

    this.getActiveKnowledgeRepoStmt = db.prepare(
      "SELECT * FROM knowledge WHERE scope = ? AND repo_scope = ? AND superseded_by IS NULL ORDER BY created_at ASC",
    );

    this.supersedeKnowledgeStmt = db.prepare("UPDATE knowledge SET superseded_by = ? WHERE id = ?");

    this.confirmKnowledgeStmt = db.prepare("UPDATE knowledge SET last_confirmed = ? WHERE id = ?");
  }

  storeKnowledge(input: StoreKnowledgeInput): KnowledgeEntry {
    const repoScope = input.repoScope ?? null;
    const id = knowledgeId(input.scope, repoScope, input.key, input.body);
    const now = new Date().toISOString();

    // Idempotent upsert: if content hash matches, just confirm
    const existing = this.getKnowledgeByIdStmt.get(id) as KnowledgeEntryRow | undefined;
    if (existing) {
      this.confirmKnowledgeStmt.run(now, id);
      return rowToKnowledgeEntry({ ...existing, last_confirmed: now });
    }

    this.insertKnowledgeStmt.run(
      id,
      input.scope,
      repoScope,
      input.domain,
      input.key,
      input.body,
      input.confidence,
      JSON.stringify(input.evidence),
      now,
      now,
      null,
      input.sourceTaskId,
      input.sourcePhase,
    );

    return {
      id,
      scope: input.scope,
      repo_scope: repoScope,
      domain: input.domain,
      key: input.key,
      body: input.body,
      confidence: input.confidence,
      evidence: input.evidence,
      created_at: now,
      last_confirmed: now,
      superseded_by: null,
      source_task_id: input.sourceTaskId,
      source_phase: input.sourcePhase,
    };
  }

  getKnowledge(scope: KnowledgeScope, repoScope?: string | null): KnowledgeEntry[] {
    const rows =
      repoScope != null
        ? (this.getActiveKnowledgeRepoStmt.all(scope, repoScope) as KnowledgeEntryRow[])
        : (this.getActiveKnowledgeStmt.all(scope) as KnowledgeEntryRow[]);
    return rows.map(rowToKnowledgeEntry);
  }

  supersedeKnowledge(oldId: string, newId: string): void {
    const result = this.supersedeKnowledgeStmt.run(newId, oldId);
    if (result.changes === 0) {
      throw new KnowledgeNotFoundError(oldId);
    }
  }

  confirmKnowledge(id: string): void {
    const now = new Date().toISOString();
    const result = this.confirmKnowledgeStmt.run(now, id);
    if (result.changes === 0) {
      throw new KnowledgeNotFoundError(id);
    }
  }
}
