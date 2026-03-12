import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type SelfReviewPromptContext, buildSelfReviewPrompt } from "./self-review.js";

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

function makeContext(overrides: Partial<SelfReviewPromptContext> = {}): SelfReviewPromptContext {
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
      file_changes: [
        { file: "src/routes/users.ts", change_type: "modify", description: "Add page params" },
      ],
      risks: [],
      decomposition_plan: null,
    },
    executionOutput: {
      files_changed: ["src/routes/users.ts", "src/routes/users.test.ts"],
      tests_written: ["src/routes/users.test.ts"],
      test_results: { passed: 5, failed: 0, skipped: 0 },
      build_status: "passing",
    },
    selfReviewFindings: null,
    loopbackCount: 0,
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildSelfReviewPrompt", () => {
  it("includes task title and description", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("Add pagination to API");
    expect(result).toContain("list endpoint needs pagination");
  });

  it("handles null description", () => {
    const result = buildSelfReviewPrompt(
      makeContext({ task: { title: "Fix typo", description: null } }),
    );
    expect(result).toContain("Fix typo");
  });

  it("includes planning output as original plan", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("Original Plan");
    expect(result).toContain("offset-based pagination");
  });

  it("handles null planningOutput", () => {
    const result = buildSelfReviewPrompt(makeContext({ planningOutput: null }));
    expect(result).toContain("No plan available");
  });

  it("includes execution summary", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("Execution Summary");
    expect(result).toContain("src/routes/users.ts");
    expect(result).toContain("5 passed");
  });

  it("handles null executionOutput", () => {
    const result = buildSelfReviewPrompt(makeContext({ executionOutput: null }));
    expect(result).toContain("No execution summary available");
  });

  it("includes prior review findings on loopback", () => {
    const result = buildSelfReviewPrompt(
      makeContext({
        selfReviewFindings: {
          quality_assessment: "needs_work",
          findings: [
            {
              type: "logic",
              file: "src/index.ts",
              description: "Missing null check",
              fixed: false,
            },
          ],
          refactoring_applied: [],
        },
        loopbackCount: 1,
      }),
    );
    expect(result).toContain("Previous Review Findings (Loopback #1)");
    expect(result).toContain("Missing null check");
    expect(result).toContain("have been addressed");
  });

  it("omits prior findings section on first pass", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).not.toContain("Previous Review Findings");
  });

  it("omits prior findings when selfReviewFindings is null even with loopbackCount", () => {
    const result = buildSelfReviewPrompt(
      makeContext({ selfReviewFindings: null, loopbackCount: 1 }),
    );
    expect(result).not.toContain("Previous Review Findings");
  });

  it("includes minimal repo context (branch only)", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("Branch: feat/pagination");
    expect(result).not.toContain("File Structure");
    expect(result).not.toContain("# Test Project");
  });

  it("handles null repoContext", () => {
    const result = buildSelfReviewPrompt(makeContext({ repoContext: null }));
    expect(result).not.toContain("Branch:");
  });

  it("includes knowledge when provided", () => {
    const result = buildSelfReviewPrompt(makeContext({ repoKnowledge: [makeKnowledgeEntry()] }));
    expect(result).toContain("Known Context");
    expect(result).toContain("Biome");
  });

  it("omits knowledge section when empty", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).not.toContain("Known Context");
  });

  it("includes review instructions with checklist", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("Logic errors");
    expect(result).toContain("Security vulnerabilities");
    expect(result).toContain("Performance concerns");
    expect(result).toContain("Maintainability");
    expect(result).toContain("ship_it");
    expect(result).toContain("needs_work");
    expect(result).toContain("fundamental_issues");
  });

  it("adapts strategy for trivial complexity", () => {
    const result = buildSelfReviewPrompt(
      makeContext({
        intakeOutput: {
          complexity: "trivial",
          estimated_phases: [],
          ambiguities: [],
          fast_path: true,
          decomposition_likely: false,
        },
      }),
    );
    expect(result).toContain("Quick sanity check");
    expect(result).toContain("don't over-review");
  });

  it("adapts strategy for complex tasks", () => {
    const result = buildSelfReviewPrompt(
      makeContext({
        intakeOutput: {
          complexity: "complex",
          estimated_phases: [],
          ambiguities: [],
          fast_path: false,
          decomposition_likely: true,
        },
      }),
    );
    expect(result).toContain("Thorough review");
    expect(result).toContain("cross-cutting concerns");
  });

  it("uses moderate strategy as default", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("Standard review");
  });

  it("adapts strategy for loopback", () => {
    const result = buildSelfReviewPrompt(makeContext({ loopbackCount: 2 }));
    expect(result).toContain("loopback #2");
    expect(result).toContain("specific issues identified");
  });

  it("includes iteration budget", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("15 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("findings");
    expect(result).toContain("refactoring_applied");
    expect(result).toContain("quality_assessment");
  });

  it("includes action reference without write actions", () => {
    const result = buildSelfReviewPrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("run_command");
    expect(result).toContain("done");
    expect(result).not.toContain("- write_file:");
    expect(result).not.toContain("- edit_file:");
  });
});
