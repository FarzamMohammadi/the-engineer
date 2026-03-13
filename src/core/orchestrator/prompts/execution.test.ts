import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type ExecutionPromptContext, buildExecutionPrompt } from "./execution.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    readme: "# Test Project",
    directoryTree: "./src/index.ts\n./src/utils.ts",
    recentCommits: "abc1234 Initial commit",
    gitBranch: "main",
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

function makeContext(overrides: Partial<ExecutionPromptContext> = {}): ExecutionPromptContext {
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
    researchOutput: {
      relevant_files: ["src/routes/users.ts"],
      relevant_modules: ["routes"],
      conventions: [{ name: "test naming", description: "Uses describe/it blocks" }],
      existing_patterns: ["Factory functions for test helpers"],
      dependencies: ["zod"],
    },
    planningOutput: {
      approach: "Add offset-based pagination to the listUsers endpoint",
      file_changes: [
        {
          file: "src/routes/users.ts",
          change_type: "modify",
          description: "Add page/limit params",
        },
        {
          file: "src/routes/users.test.ts",
          change_type: "create",
          description: "Pagination tests",
        },
      ],
      risks: [
        {
          risk: "Breaking existing consumers",
          mitigation: "Default values maintain backward compat",
        },
      ],
      decomposition_plan: null,
    },
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildExecutionPrompt", () => {
  it("includes task title and description", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("Add pagination to API");
    expect(result).toContain("list endpoint needs pagination");
  });

  it("handles null description", () => {
    const result = buildExecutionPrompt(
      makeContext({ task: { title: "Fix typo", description: null } }),
    );
    expect(result).toContain("Fix typo");
  });

  it("includes plan when available", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("offset-based pagination");
    expect(result).toContain("[modify] src/routes/users.ts");
    expect(result).toContain("[create] src/routes/users.test.ts");
    expect(result).toContain("Breaking existing consumers");
  });

  it("handles null planningOutput", () => {
    const result = buildExecutionPrompt(makeContext({ planningOutput: null }));
    expect(result).toContain("No plan available");
    expect(result).toContain("existing codebase conventions");
  });

  it("includes research conventions when available", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("src/routes/users.ts");
    expect(result).toContain("Factory functions for test helpers");
  });

  it("handles null researchOutput", () => {
    const result = buildExecutionPrompt(makeContext({ researchOutput: null }));
    expect(result).toContain("No research context available");
  });

  it("includes minimal repository context", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("Branch: main");
    // Should NOT include directory tree, README, or commits
    expect(result).not.toContain("File Structure");
    expect(result).not.toContain("# Test Project");
    expect(result).not.toContain("Recent Commits");
  });

  it("handles null repoContext", () => {
    const result = buildExecutionPrompt(makeContext({ repoContext: null }));
    // No repo section at all — not even a "no context" message
    expect(result).not.toContain("Repository");
  });

  it("omits repo section when branch is empty", () => {
    const result = buildExecutionPrompt(
      makeContext({ repoContext: makeRepoContext({ gitBranch: "" }) }),
    );
    expect(result).not.toContain("Branch:");
  });

  it("includes knowledge when provided", () => {
    const result = buildExecutionPrompt(makeContext({ repoKnowledge: [makeKnowledgeEntry()] }));
    expect(result).toContain("Known Context");
    expect(result).toContain("Biome");
  });

  it("omits knowledge section when empty", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).not.toContain("Known Context");
  });

  it("includes execution instructions with test-fix loop", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("foundation");
    expect(result).toContain("test-fix loop");
    expect(result).toContain("Fix failures immediately");
    expect(result).toContain("commit");
  });

  it("adapts strategy for trivial complexity", () => {
    const result = buildExecutionPrompt(
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
    expect(result).toContain("simple change");
    expect(result).toContain("MUST read and modify actual files");
  });

  it("adapts strategy for complex tasks", () => {
    const result = buildExecutionPrompt(
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
    expect(result).toContain("complex implementation");
    expect(result).toContain("dependency order");
  });

  it("uses moderate strategy as default", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("Follow the plan methodically");
  });

  it("includes iteration budget", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("25 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("files_changed");
    expect(result).toContain("tests_written");
    expect(result).toContain("test_results");
    expect(result).toContain("build_status");
  });

  it("includes action reference with write actions", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("write_file");
    expect(result).toContain("edit_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("run_command");
    expect(result).toContain("done");
  });

  // ── Feedback Injection ──────────────────────────────────────────────

  it("includes feedback section when unapplied feedback present", () => {
    const result = buildExecutionPrompt(
      makeContext({
        feedbackRounds: [
          { stage: "demo", comments: ["Please use camelCase for variables"], applied: false },
        ],
      }),
    );
    expect(result).toContain("Reviewer Feedback (MUST ADDRESS)");
    expect(result).toContain("Please use camelCase for variables");
  });

  it("omits feedback section when no feedback rounds", () => {
    const result = buildExecutionPrompt(makeContext());
    expect(result).not.toContain("Reviewer Feedback");
  });

  it("omits feedback section when all feedback is applied", () => {
    const result = buildExecutionPrompt(
      makeContext({
        feedbackRounds: [{ stage: "demo", comments: ["Already done"], applied: true }],
      }),
    );
    expect(result).not.toContain("Reviewer Feedback");
  });
});
