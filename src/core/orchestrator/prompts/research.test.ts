import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type ResearchPromptContext, buildResearchPrompt } from "./research.js";

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

function makeContext(overrides: Partial<ResearchPromptContext> = {}): ResearchPromptContext {
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
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildResearchPrompt", () => {
  it("includes task title and description", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("Add pagination to API");
    expect(result).toContain("list endpoint needs pagination");
  });

  it("includes intake analysis results when available", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("Complexity: moderate");
    expect(result).toContain("Cursor-based or offset-based?");
    expect(result).toContain("Fast path: no");
  });

  it("handles null intakeOutput", () => {
    const result = buildResearchPrompt(makeContext({ intakeOutput: null }));
    expect(result).toContain("No intake analysis available");
    expect(result).not.toContain("Complexity:");
  });

  it("includes repository context", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("src/index.ts");
    expect(result).toContain("Initial commit");
    expect(result).toContain("main");
  });

  it("handles null repoContext", () => {
    const result = buildResearchPrompt(makeContext({ repoContext: null }));
    expect(result).toContain("No repository context available");
  });

  it("includes knowledge when provided", () => {
    const result = buildResearchPrompt(makeContext({ repoKnowledge: [makeKnowledgeEntry()] }));
    expect(result).toContain("Known Context");
    expect(result).toContain("Biome");
  });

  it("includes research instructions", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("conventions");
    expect(result).toContain("dependencies");
    expect(result).toContain("tests");
    expect(result).toContain("patterns");
  });

  it("adapts strategy for trivial complexity", () => {
    const result = buildResearchPrompt(
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
    expect(result).toContain("2-3 file reads");
  });

  it("adapts strategy for complex tasks", () => {
    const result = buildResearchPrompt(
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
    expect(result).toContain("systematic");
  });

  it("uses moderate strategy as default", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("Balance thoroughness");
  });

  it("includes iteration budget", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("15 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("relevant_files");
    expect(result).toContain("relevant_modules");
    expect(result).toContain("conventions");
    expect(result).toContain("existing_patterns");
    expect(result).toContain("dependencies");
  });

  it("includes action reference with run_command", () => {
    const result = buildResearchPrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("run_command");
    expect(result).toContain("done");
    // Should NOT include write actions
    expect(result).not.toContain("write_file:");
    expect(result).not.toContain("edit_file:");
  });
});
