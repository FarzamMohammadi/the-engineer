import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type IntegrationPromptContext, buildIntegrationPrompt } from "./integration.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    readme: "# Test Project",
    directoryTree: "./src/index.ts\n./src/utils.ts",
    recentCommits: "abc1234 Initial commit",
    gitBranch: "feat/main-task",
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

function makeContext(overrides: Partial<IntegrationPromptContext> = {}): IntegrationPromptContext {
  return {
    task: { title: "Implement user management", description: "Full user CRUD with auth" },
    repoContext: makeRepoContext(),
    executionOutput: {
      files_changed: ["src/index.ts"],
      tests_written: [],
      test_results: { passed: 0, failed: 0, skipped: 0 },
      build_status: "passing",
    },
    selfReviewOutput: {
      quality_assessment: "ship_it",
      findings: [],
      refactoring_applied: [],
    },
    childSummaries: [
      {
        child_id: "task-child-1",
        child_title: "Add user model",
        branch: "feat/user-model",
        test_status: "passing",
        files_changed: ["src/models/user.ts", "src/models/user.test.ts"],
      },
      {
        child_id: "task-child-2",
        child_title: "Add auth middleware",
        branch: "feat/auth-middleware",
        test_status: "passing",
        files_changed: ["src/middleware/auth.ts"],
      },
    ],
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildIntegrationPrompt", () => {
  it("includes task title and description", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("Implement user management");
    expect(result).toContain("Full user CRUD with auth");
  });

  it("handles null description", () => {
    const result = buildIntegrationPrompt(
      makeContext({ task: { title: "Big refactor", description: null } }),
    );
    expect(result).toContain("Big refactor");
  });

  it("formats child summaries with titles and branches", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("2 child task(s)");
    expect(result).toContain("Add user model");
    expect(result).toContain("task-child-1");
    expect(result).toContain("feat/user-model");
    expect(result).toContain("src/models/user.ts");
    expect(result).toContain("Add auth middleware");
    expect(result).toContain("task-child-2");
    expect(result).toContain("feat/auth-middleware");
  });

  it("handles empty childSummaries", () => {
    const result = buildIntegrationPrompt(makeContext({ childSummaries: [] }));
    expect(result).toContain("No child tasks to integrate");
  });

  it("includes parent execution summary", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("Parent Execution");
    expect(result).toContain("src/index.ts");
  });

  it("handles null executionOutput", () => {
    const result = buildIntegrationPrompt(makeContext({ executionOutput: null }));
    expect(result).toContain("No parent-level execution was performed");
  });

  it("includes parent review assessment", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("Parent Review");
    expect(result).toContain("ship_it");
  });

  it("handles null selfReviewOutput", () => {
    const result = buildIntegrationPrompt(makeContext({ selfReviewOutput: null }));
    expect(result).toContain("No parent-level review was performed");
  });

  it("includes repo context (branch only)", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("Branch: feat/main-task");
    expect(result).not.toContain("File Structure");
  });

  it("handles null repoContext", () => {
    const result = buildIntegrationPrompt(makeContext({ repoContext: null }));
    // Repository section should not appear, but child branches still show "Branch:"
    expect(result).not.toContain("## Repository");
  });

  it("includes knowledge when provided", () => {
    const result = buildIntegrationPrompt(makeContext({ repoKnowledge: [makeKnowledgeEntry()] }));
    expect(result).toContain("Known Context");
    expect(result).toContain("Biome");
  });

  it("omits knowledge section when empty", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).not.toContain("Known Context");
  });

  it("includes integration instructions", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("merge conflicts");
    expect(result).toContain("integration tests");
    expect(result).toContain("full test suite");
    expect(result).toContain("Overlapping file modifications");
  });

  it("includes iteration budget", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("20 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("children_verified");
    expect(result).toContain("integration_tests");
    expect(result).toContain("conflicts_found");
    expect(result).toContain("resolution_actions");
  });

  it("includes action reference with full write access", () => {
    const result = buildIntegrationPrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("write_file");
    expect(result).toContain("edit_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("run_command");
    expect(result).toContain("done");
  });
});
