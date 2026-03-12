import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import {
  formatActionReference,
  formatKnowledge,
  formatOutputSchema,
  formatPriorPhaseOutput,
  section,
} from "./format.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: "k-001",
    scope: "repo",
    repo_scope: "owner/repo",
    domain: "conventions",
    key: "test naming",
    body: "Tests use describe/it blocks with descriptive names",
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("formatActionReference", () => {
  it("lists only the requested actions", () => {
    const result = formatActionReference(["read_file", "done"]);
    expect(result).toContain("read_file");
    expect(result).toContain("done");
    expect(result).not.toContain("write_file");
    expect(result).not.toContain("run_command");
  });

  it("includes params descriptions", () => {
    const result = formatActionReference(["search_content"]);
    expect(result).toContain("regex");
    expect(result).toContain("glob");
  });

  it("handles empty actions array", () => {
    const result = formatActionReference([]);
    expect(result).toBe("Available actions:");
  });

  it("preserves action order", () => {
    const result = formatActionReference(["run_command", "read_file"]);
    const runIndex = result.indexOf("run_command");
    const readIndex = result.indexOf("read_file");
    expect(runIndex).toBeLessThan(readIndex);
  });
});

describe("formatOutputSchema", () => {
  it("returns intake schema with all required fields", () => {
    const result = formatOutputSchema("intake_analysis");
    expect(result).toContain("complexity");
    expect(result).toContain("estimated_phases");
    expect(result).toContain("ambiguities");
    expect(result).toContain("fast_path");
    expect(result).toContain("decomposition_likely");
  });

  it("returns research schema with all required fields", () => {
    const result = formatOutputSchema("research");
    expect(result).toContain("relevant_files");
    expect(result).toContain("relevant_modules");
    expect(result).toContain("conventions");
    expect(result).toContain("existing_patterns");
    expect(result).toContain("dependencies");
  });

  it("returns a schema for every phase", () => {
    const phases = [
      "intake_analysis",
      "research",
      "planning",
      "execution",
      "self_review",
      "demo_prep",
      "integration",
    ] as const;
    for (const phase of phases) {
      const result = formatOutputSchema(phase);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe("formatPriorPhaseOutput", () => {
  it("formats intake output as readable text", () => {
    const data = {
      complexity: "moderate",
      estimated_phases: ["intake_analysis", "research", "planning", "execution"],
      ambiguities: ["Which API version?", "Error handling approach unclear"],
      fast_path: false,
      decomposition_likely: false,
    };
    const result = formatPriorPhaseOutput("intake_analysis", data);
    expect(result).toContain("Complexity: moderate");
    expect(result).toContain("Which API version?");
    expect(result).toContain("Fast path: no");
  });

  it("formats research output as readable text", () => {
    const data = {
      relevant_files: ["src/index.ts", "src/utils.ts"],
      relevant_modules: ["core", "utils"],
      conventions: [],
      existing_patterns: ["Factory pattern for test helpers"],
      dependencies: ["zod", "vitest"],
    };
    const result = formatPriorPhaseOutput("research", data);
    expect(result).toContain("src/index.ts");
    expect(result).toContain("Factory pattern for test helpers");
    expect(result).toContain("zod");
  });

  it("formats execution output with files and test results", () => {
    const data = {
      files_changed: ["src/index.ts", "src/utils.ts"],
      tests_written: ["src/index.test.ts"],
      test_results: { passed: 5, failed: 1, skipped: 0 },
      build_status: "failing",
    };
    const result = formatPriorPhaseOutput("execution", data);
    expect(result).toContain("Execution Results:");
    expect(result).toContain("src/index.ts");
    expect(result).toContain("src/index.test.ts");
    expect(result).toContain("5 passed, 1 failed, 0 skipped");
    expect(result).toContain("Build status: failing");
  });

  it("handles execution output with empty arrays", () => {
    const data = {
      files_changed: [],
      tests_written: [],
      test_results: { passed: 0, failed: 0, skipped: 0 },
      build_status: "passing",
    };
    const result = formatPriorPhaseOutput("execution", data);
    expect(result).toContain("Execution Results:");
    expect(result).toContain("Build status: passing");
    expect(result).not.toContain("Files changed:");
    expect(result).not.toContain("Tests written:");
  });

  it("formats self_review output with findings and quality", () => {
    const data = {
      quality_assessment: "needs_work",
      findings: [
        { type: "logic", file: "src/index.ts", description: "Missing null check", fixed: true },
        { type: "style", file: "src/utils.ts", description: "Inconsistent naming", fixed: false },
      ],
      refactoring_applied: ["Extracted validation helper"],
    };
    const result = formatPriorPhaseOutput("self_review", data);
    expect(result).toContain("Self-Review Results:");
    expect(result).toContain("Quality assessment: needs_work");
    expect(result).toContain("[logic] src/index.ts: Missing null check (fixed: yes)");
    expect(result).toContain("[style] src/utils.ts: Inconsistent naming (fixed: no)");
    expect(result).toContain("Extracted validation helper");
  });

  it("handles self_review output with empty arrays", () => {
    const data = {
      quality_assessment: "ship_it",
      findings: [],
      refactoring_applied: [],
    };
    const result = formatPriorPhaseOutput("self_review", data);
    expect(result).toContain("Quality assessment: ship_it");
    expect(result).not.toContain("Findings:");
    expect(result).not.toContain("Refactoring applied:");
  });

  it("formats demo_prep output with PR and artifacts", () => {
    const data = {
      pr_number: 42,
      pr_description: "Add pagination to the user listing API",
      artifacts: [
        { type: "screenshot", location: "/tmp/before-after.png", permanent: true },
        { type: "tui", location: "/tmp/demo-tui", permanent: false },
      ],
    };
    const result = formatPriorPhaseOutput("demo_prep", data);
    expect(result).toContain("Demo Prep Results:");
    expect(result).toContain("PR #42:");
    expect(result).toContain("pagination");
    expect(result).toContain("[screenshot] /tmp/before-after.png (permanent: yes)");
    expect(result).toContain("[tui] /tmp/demo-tui (permanent: no)");
  });

  it("handles demo_prep output with empty artifacts", () => {
    const data = {
      pr_number: 1,
      pr_description: "Simple fix",
      artifacts: [],
    };
    const result = formatPriorPhaseOutput("demo_prep", data);
    expect(result).toContain("PR #1:");
    expect(result).not.toContain("Artifacts:");
  });

  it("formats planning output with approach and file changes", () => {
    const data = {
      approach: "Add offset-based pagination",
      file_changes: [
        { file: "src/routes/users.ts", change_type: "modify", description: "Add page params" },
        { file: "src/routes/users.test.ts", change_type: "create", description: "Add tests" },
      ],
      risks: [{ risk: "Breaking consumers", mitigation: "Default values" }],
      decomposition_plan: null,
    };
    const result = formatPriorPhaseOutput("planning", data);
    expect(result).toContain("Approach: Add offset-based pagination");
    expect(result).toContain("[modify] src/routes/users.ts: Add page params");
    expect(result).toContain("[create] src/routes/users.test.ts: Add tests");
    expect(result).toContain("Breaking consumers");
    expect(result).toContain("Default values");
  });

  it("handles planning output with empty arrays", () => {
    const data = {
      approach: "Simple fix",
      file_changes: [],
      risks: [],
      decomposition_plan: null,
    };
    const result = formatPriorPhaseOutput("planning", data);
    expect(result).toContain("Approach: Simple fix");
    expect(result).not.toContain("File changes:");
    expect(result).not.toContain("Risks:");
  });

  it("formats planning output with decomposition", () => {
    const data = {
      approach: "Split into subtasks",
      file_changes: [],
      risks: [],
      decomposition_plan: { children: ["task-1", "task-2"] },
    };
    const result = formatPriorPhaseOutput("planning", data);
    expect(result).toContain("Decomposition:");
    expect(result).toContain("task-1");
  });

  it("handles empty arrays gracefully", () => {
    const data = {
      complexity: "trivial",
      estimated_phases: [],
      ambiguities: [],
      fast_path: true,
      decomposition_likely: false,
    };
    const result = formatPriorPhaseOutput("intake_analysis", data);
    expect(result).toContain("Complexity: trivial");
    expect(result).not.toContain("Ambiguities:");
  });
});

describe("formatKnowledge", () => {
  it("returns empty string for no entries", () => {
    expect(formatKnowledge([])).toBe("");
  });

  it("formats entries with domain, key, body, and confidence", () => {
    const entries = [makeKnowledgeEntry()];
    const result = formatKnowledge(entries);
    expect(result).toContain("[conventions]");
    expect(result).toContain("test naming");
    expect(result).toContain("describe/it blocks");
    expect(result).toContain("observed");
  });

  it("formats multiple entries as separate lines", () => {
    const entries = [
      makeKnowledgeEntry({ key: "style", body: "Uses Biome for linting" }),
      makeKnowledgeEntry({
        domain: "patterns",
        key: "factory",
        body: "Factory functions everywhere",
      }),
    ];
    const result = formatKnowledge(entries);
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
  });
});

describe("section", () => {
  it("wraps content with markdown heading", () => {
    const result = section("Repository Overview", "Some content here");
    expect(result).toBe("## Repository Overview\n\nSome content here");
  });
});
