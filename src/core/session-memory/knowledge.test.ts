import { afterEach, describe, expect, it } from "vitest";

import {
  type TestDatabaseHandle,
  createTestDatabase,
} from "../../../test/helpers/test-database.js";
import type { StoreKnowledgeInput } from "../interfaces/session-memory.interface.js";
import { KnowledgeStore } from "./knowledge.js";

const HEX_32 = /^[\da-f]{32}$/;

let testDb: TestDatabaseHandle;
let knowledge: KnowledgeStore;

function setup(): void {
  testDb = createTestDatabase();
  knowledge = new KnowledgeStore(testDb.db);
}

function makeInput(overrides?: Partial<StoreKnowledgeInput>): StoreKnowledgeInput {
  return {
    scope: "repo",
    repoScope: "owner/repo",
    domain: "conventions",
    key: "test framework",
    body: "Uses Vitest for all tests",
    confidence: "observed",
    evidence: [{ task_id: "task-1", description: "Saw vitest.config.ts" }],
    sourceTaskId: "task-1",
    sourcePhase: "research",
    ...overrides,
  };
}

afterEach(() => testDb.cleanup());

describe("KnowledgeStore", () => {
  it("generates a deterministic content-hash ID", () => {
    setup();
    const entry1 = knowledge.storeKnowledge(makeInput());
    const entry2 = knowledge.storeKnowledge(makeInput());

    expect(entry1.id).toBe(entry2.id);
    expect(entry1.id).toHaveLength(32);
    expect(entry1.id).toMatch(HEX_32);
  });

  it("updates last_confirmed when same hash exists (idempotent upsert)", () => {
    setup();
    const entry1 = knowledge.storeKnowledge(makeInput());
    const entry2 = knowledge.storeKnowledge(makeInput());

    expect(entry2.id).toBe(entry1.id);
    expect(entry2.last_confirmed >= entry1.last_confirmed).toBe(true);
  });

  it("different body produces different ID", () => {
    setup();
    const entry1 = knowledge.storeKnowledge(makeInput({ body: "Uses Jest" }));
    const entry2 = knowledge.storeKnowledge(makeInput({ body: "Uses Vitest" }));

    expect(entry1.id).not.toBe(entry2.id);
  });

  it("different repo_scope produces different ID", () => {
    setup();
    const entry1 = knowledge.storeKnowledge(makeInput({ repoScope: "owner/repo-a" }));
    const entry2 = knowledge.storeKnowledge(makeInput({ repoScope: "owner/repo-b" }));

    expect(entry1.id).not.toBe(entry2.id);
  });

  it("stores user-scope knowledge with null repo_scope", () => {
    setup();
    const entry = knowledge.storeKnowledge(makeInput({ scope: "user", repoScope: null }));

    expect(entry.scope).toBe("user");
    expect(entry.repo_scope).toBeNull();
  });

  it("returns only non-superseded entries", () => {
    setup();
    const old = knowledge.storeKnowledge(makeInput({ key: "old-key", body: "old body" }));
    const newer = knowledge.storeKnowledge(makeInput({ key: "new-key", body: "new body" }));
    knowledge.supersedeKnowledge(old.id, newer.id);

    const results = knowledge.getKnowledge("repo", "owner/repo");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(newer.id);
  });

  it("filters by repo scope", () => {
    setup();
    knowledge.storeKnowledge(makeInput({ repoScope: "owner/repo-a", key: "k1" }));
    knowledge.storeKnowledge(makeInput({ repoScope: "owner/repo-b", key: "k2" }));

    const resultsA = knowledge.getKnowledge("repo", "owner/repo-a");
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].key).toBe("k1");
  });

  it("returns all active entries when no repo scope given", () => {
    setup();
    knowledge.storeKnowledge(makeInput({ repoScope: "owner/repo-a", key: "k1" }));
    knowledge.storeKnowledge(makeInput({ repoScope: "owner/repo-b", key: "k2" }));

    const results = knowledge.getKnowledge("repo");
    expect(results).toHaveLength(2);
  });

  it("supersession chain: only latest entry returned", () => {
    setup();
    const a = knowledge.storeKnowledge(makeInput({ body: "A" }));
    const b = knowledge.storeKnowledge(makeInput({ body: "B" }));
    const c = knowledge.storeKnowledge(makeInput({ body: "C" }));

    knowledge.supersedeKnowledge(a.id, b.id);
    knowledge.supersedeKnowledge(b.id, c.id);

    const results = knowledge.getKnowledge("repo", "owner/repo");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(c.id);
  });

  it("throws for non-existent old ID on supersede", () => {
    setup();
    expect(() => knowledge.supersedeKnowledge("nonexistent", "new-id")).toThrow(
      'knowledge entry "nonexistent" not found',
    );
  });

  it("confirms knowledge and updates last_confirmed", () => {
    setup();
    const entry = knowledge.storeKnowledge(makeInput());
    const originalConfirmed = entry.last_confirmed;

    knowledge.confirmKnowledge(entry.id);

    const results = knowledge.getKnowledge("repo", "owner/repo");
    expect(results[0].last_confirmed >= originalConfirmed).toBe(true);
  });

  it("throws for non-existent ID on confirm", () => {
    setup();
    expect(() => knowledge.confirmKnowledge("nonexistent")).toThrow(
      'knowledge entry "nonexistent" not found',
    );
  });
});
