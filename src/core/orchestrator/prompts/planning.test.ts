import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type PlanningPromptContext, buildPlanningPrompt } from "./planning.js";

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

function makeContext(overrides: Partial<PlanningPromptContext> = {}): PlanningPromptContext {
  return {
    task: { title: "Add pagination to API", description: "The list endpoint needs pagination" },
    repoContext: makeRepoContext(),
    intakeOutput: {
      complexity: "moderate",
      estimated_phases: [
        "intake_analysis",
        "research",
        "planning",
        "execution",
        "self_review",
        "demo_prep",
        "integration",
      ],
      ambiguities: ["Cursor-based or offset-based?"],
      fast_path: false,
      decomposition_likely: false,
    },
    researchOutput: {
      relevant_files: ["src/routes/users.ts", "src/models/user.ts"],
      relevant_modules: ["routes", "models"],
      conventions: [{ name: "test naming", description: "Uses describe/it blocks" }],
      existing_patterns: ["Factory functions for test helpers"],
      dependencies: ["zod", "better-sqlite3"],
    },
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildPlanningPrompt", () => {
  it("includes task title and description", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("Add pagination to API");
    expect(result).toContain("list endpoint needs pagination");
  });

  it("handles null description", () => {
    const result = buildPlanningPrompt(
      makeContext({ task: { title: "Fix typo", description: null } }),
    );
    expect(result).toContain("Fix typo");
  });

  it("includes intake analysis when available", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("Complexity: moderate");
    expect(result).toContain("Cursor-based or offset-based?");
    expect(result).toContain("Fast path: no");
  });

  it("handles null intakeOutput", () => {
    const result = buildPlanningPrompt(makeContext({ intakeOutput: null }));
    expect(result).toContain("No intake analysis available");
  });

  it("includes research findings when available", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("src/routes/users.ts");
    expect(result).toContain("src/models/user.ts");
    expect(result).toContain("Factory functions for test helpers");
    expect(result).toContain("zod");
  });

  it("handles null researchOutput", () => {
    const result = buildPlanningPrompt(makeContext({ researchOutput: null }));
    expect(result).toContain("No research findings available");
  });

  it("includes repository context without README", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("src/index.ts");
    expect(result).toContain("main");
    expect(result).toContain("test-project");
    // README omitted in planning — already seen in intake
    expect(result).not.toContain("# Test Project");
  });

  it("handles null repoContext", () => {
    const result = buildPlanningPrompt(makeContext({ repoContext: null }));
    expect(result).toContain("No repository context available");
  });

  it("includes knowledge when provided", () => {
    const result = buildPlanningPrompt(makeContext({ repoKnowledge: [makeKnowledgeEntry()] }));
    expect(result).toContain("Known Context");
    expect(result).toContain("Biome");
  });

  it("omits knowledge section when empty", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).not.toContain("Known Context");
  });

  it("includes planning instructions", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("approach");
    expect(result).toContain("file change");
    expect(result).toContain("risks");
    expect(result).toContain("test strategy");
    expect(result).toContain("decomposition");
  });

  it("adapts strategy for trivial complexity", () => {
    const result = buildPlanningPrompt(
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
    expect(result).toContain("low complexity");
    expect(result).toContain("1-3 file changes");
  });

  it("adapts strategy for complex tasks", () => {
    const result = buildPlanningPrompt(
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
    expect(result).toContain("high complexity");
    expect(result).toContain("structured");
  });

  it("uses moderate strategy as default", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("Balance detail with pragmatism");
  });

  it("includes iteration budget", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("10 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("approach");
    expect(result).toContain("file_changes");
    expect(result).toContain("risks");
    expect(result).toContain("decomposition_plan");
  });

  it("includes action reference without write actions", () => {
    const result = buildPlanningPrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("done");
    // Planning should NOT include write actions
    expect(result).not.toContain("write_file:");
    expect(result).not.toContain("edit_file:");
  });
});
