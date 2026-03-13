import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import { type IntakePromptContext, buildIntakePrompt } from "./intake.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    readme: "# Test Project\n\nA sample project for testing.",
    directoryTree: "./src/index.ts\n./src/utils.ts\n./package.json",
    recentCommits: "abc1234 Initial commit\ndef5678 Add utils",
    gitBranch: "main",
    packageInfo: "Name: test-project\nDescription: A test project\nScripts: test, build",
    ...overrides,
  };
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: "k-001",
    scope: "repo",
    repo_scope: "owner/repo",
    domain: "conventions",
    key: "test naming",
    body: "Tests use describe/it blocks",
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

function makeContext(overrides: Partial<IntakePromptContext> = {}): IntakePromptContext {
  return {
    task: { title: "Fix the login bug", description: "Users report 500 error on /login" },
    repoContext: makeRepoContext(),
    repoKnowledge: [],
    userKnowledge: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildIntakePrompt", () => {
  it("includes task title and description", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).toContain("Fix the login bug");
    expect(result).toContain("500 error on /login");
  });

  it("includes external ref when available", () => {
    const result = buildIntakePrompt(
      makeContext({
        task: {
          title: "Fix bug",
          description: null,
          external_ref: { type: "github", repo: "org/repo", number: 42 },
        },
      }),
    );
    expect(result).toContain("org/repo");
    expect(result).toContain("#42");
  });

  it("handles missing description gracefully", () => {
    const result = buildIntakePrompt(
      makeContext({
        task: { title: "Do the thing", description: null },
      }),
    );
    expect(result).toContain("Do the thing");
    // Should not crash
    expect(result.length).toBeGreaterThan(100);
  });

  it("includes repository context when available", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).toContain("Test Project");
    expect(result).toContain("src/index.ts");
    expect(result).toContain("Initial commit");
    expect(result).toContain("main");
    expect(result).toContain("test-project");
  });

  it("handles null repoContext", () => {
    const result = buildIntakePrompt(makeContext({ repoContext: null }));
    expect(result).toContain("No repository context available");
    expect(result).toContain("task description alone");
  });

  it("includes knowledge when provided", () => {
    const result = buildIntakePrompt(
      makeContext({
        repoKnowledge: [makeKnowledgeEntry()],
      }),
    );
    expect(result).toContain("Known Context");
    expect(result).toContain("test naming");
    expect(result).toContain("describe/it blocks");
  });

  it("omits knowledge section when empty", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).not.toContain("Known Context");
  });

  it("includes phase instructions", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).toContain("ambiguities");
    expect(result).toContain("complexity");
    expect(result).toContain("trivial");
    expect(result).toContain("decomposition");
  });

  it("includes iteration budget", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).toContain("5 iterations");
  });

  it("includes output schema with all required fields", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).toContain("complexity");
    expect(result).toContain("estimated_phases");
    expect(result).toContain("ambiguities");
    expect(result).toContain("fast_path");
    expect(result).toContain("decomposition_likely");
  });

  it("includes action reference", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).toContain("read_file");
    expect(result).toContain("search_files");
    expect(result).toContain("search_content");
    expect(result).toContain("done");
    // Should NOT include write actions
    expect(result).not.toContain("write_file:");
    expect(result).not.toContain("edit_file:");
  });

  // ── Feedback Rework Mode ────────────────────────────────────────────

  it("uses feedback rework brief when unapplied feedback present", () => {
    const result = buildIntakePrompt(
      makeContext({
        feedbackRounds: [
          { stage: "demo", comments: ["Fix the naming convention"], applied: false },
        ],
        prNumber: 42,
      }),
    );
    expect(result).toContain("Feedback Rework");
    expect(result).toContain("Fix the naming convention");
    expect(result).toContain("#42");
    // Should NOT contain regular task instructions
    expect(result).not.toContain("taking on a new assignment");
  });

  it("uses normal mode when no feedback rounds present", () => {
    const result = buildIntakePrompt(makeContext());
    expect(result).not.toContain("Feedback Rework");
    expect(result).toContain("taking on a new assignment");
  });

  it("uses normal mode when all feedback is already applied", () => {
    const result = buildIntakePrompt(
      makeContext({
        feedbackRounds: [{ stage: "demo", comments: ["Already fixed"], applied: true }],
        prNumber: 42,
      }),
    );
    expect(result).not.toContain("Feedback Rework");
    expect(result).toContain("taking on a new assignment");
  });
});
