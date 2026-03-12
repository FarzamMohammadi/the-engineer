import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type DemoPrepPromptContext, buildDemoPrepPrompt } from "./demo-prep.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    readme: "# Test Project",
    directoryTree: "./src/index.ts\n./src/utils.ts",
    recentCommits: "abc1234 Initial commit",
    gitBranch: "feat/pagination",
    packageInfo: "Name: test-project",
    ...overrides,
  };
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: "k-001",
    scope: "repo",
    repo_scope: "owner/repo",
    domain: "conventions",
    key: "style",
    body: "Uses Biome for linting",
    confidence: "observed",
    evidence: [],
    created_at: "2026-01-01T00:00:00Z",
    last_confirmed: "2026-01-01T00:00:00Z",
    superseded_by: null,
    source_task_id: "task-001",
    source_phase: "research",
    ...overrides,
  };
}

function makeContext(overrides: Partial<DemoPrepPromptContext> = {}): DemoPrepPromptContext {
  return {
    task: { title: "Add pagination to API", description: "The list endpoint needs pagination" },
    repoContext: makeRepoContext(),
    intakeOutput: {
      complexity: "moderate",
      estimated_phases: [],
      ambiguities: [],
      fast_path: false,
      decomposition_likely: false,
    },
    planningOutput: {
      approach: "Add offset-based pagination to the listUsers endpoint",
      file_changes: [],
      risks: [],
      decomposition_plan: null,
    },
    executionOutput: {
      files_changed: ["src/routes/users.ts", "src/routes/users.test.ts"],
      tests_written: ["src/routes/users.test.ts"],
      test_results: { passed: 5, failed: 0, skipped: 0 },
      build_status: "passing",
    },
    selfReviewOutput: {
      quality_assessment: "ship_it",
      findings: [],
      refactoring_applied: ["Extracted validation helper"],
    },
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildDemoPrepPrompt", () => {
  it("includes task title and description", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("Add pagination to API");
    expect(result).toContain("list endpoint needs pagination");
  });

  it("handles null description", () => {
    const result = buildDemoPrepPrompt(
      makeContext({ task: { title: "Fix typo", description: null } }),
    );
    expect(result).toContain("Fix typo");
  });

  it("includes execution summary", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("Implementation Summary");
    expect(result).toContain("src/routes/users.ts");
    expect(result).toContain("5 passed");
  });

  it("handles null executionOutput", () => {
    const result = buildDemoPrepPrompt(makeContext({ executionOutput: null }));
    expect(result).toContain("No execution summary available");
  });

  it("includes review assessment", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("Review Assessment");
    expect(result).toContain("ship_it");
  });

  it("handles null selfReviewOutput", () => {
    const result = buildDemoPrepPrompt(makeContext({ selfReviewOutput: null }));
    expect(result).toContain("No review assessment available");
  });

  it("includes planning approach for PR context", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("Original Approach");
    expect(result).toContain("offset-based pagination");
  });

  it("handles null planningOutput", () => {
    const result = buildDemoPrepPrompt(makeContext({ planningOutput: null }));
    expect(result).toContain("No planning context available");
  });

  it("includes repo context with branch", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("Branch: feat/pagination");
  });

  it("handles null repoContext", () => {
    const result = buildDemoPrepPrompt(makeContext({ repoContext: null }));
    expect(result).toContain("No repository context available");
  });

  it("includes knowledge when provided", () => {
    const result = buildDemoPrepPrompt(makeContext({ repoKnowledge: [makeKnowledgeEntry()] }));
    expect(result).toContain("Known Context");
    expect(result).toContain("Biome");
  });

  it("omits knowledge section when empty", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).not.toContain("Known Context");
  });

  it("includes PR description instructions", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("PR description");
    expect(result).toContain("full story");
    expect(result).toContain("How to test");
    expect(result).toContain("breaking changes");
  });

  it("includes demo artifact guidance", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("Frontend");
    expect(result).toContain("Backend");
    expect(result).toContain("Infrastructure");
  });

  it("includes iteration budget", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("10 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("artifacts");
    expect(result).toContain("pr_number");
    expect(result).toContain("pr_description");
  });

  it("includes action reference", () => {
    const result = buildDemoPrepPrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("write_file");
    expect(result).toContain("run_command");
    expect(result).toContain("done");
  });
});
