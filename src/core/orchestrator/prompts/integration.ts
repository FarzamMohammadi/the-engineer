import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { RepoContext } from "./context.js";
import {
  formatActionReference,
  formatKnowledge,
  formatOutputSchema,
  formatPriorPhaseOutput,
  section,
} from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Summary of a completed child task for the integration phase. */
export interface ChildTaskSummary {
  child_id: string;
  child_title: string;
  branch: string;
  test_status: string;
  files_changed: string[];
}

/** Context needed to build the integration phase prompt. */
export interface IntegrationPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  executionOutput: Record<string, unknown> | null;
  selfReviewOutput: Record<string, unknown> | null;
  childSummaries: ChildTaskSummary[];
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the integration phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildIntegrationPrompt(ctx: IntegrationPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Child Task Summaries
  parts.push(buildChildSummariesSection(ctx.childSummaries));

  // 3. Parent Execution Summary
  parts.push(buildExecutionSection(ctx.executionOutput));

  // 4. Parent Review Assessment
  parts.push(buildReviewSection(ctx.selfReviewOutput));

  // 5. Repository
  const repoSection = buildRepoOverview(ctx.repoContext);
  if (repoSection) {
    parts.push(repoSection);
  }

  // 6. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 7. Phase Instructions
  parts.push(buildIntegrationInstructions());

  // 8. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 20 iterations. Use them to verify each child's output, run integration tests, and resolve any conflicts. Nothing ships until integration is verified.",
    ),
  );

  // 9. Output Schema + Action Reference
  parts.push(section("Output Requirements", formatOutputSchema("integration")));
  parts.push(
    section(
      "Actions",
      formatActionReference([
        "read_file",
        "write_file",
        "edit_file",
        "search_files",
        "search_content",
        "run_command",
        "done",
      ]),
    ),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: IntegrationPromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];
  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }
  return section("Task", lines.join("\n"));
}

function buildChildSummariesSection(children: ChildTaskSummary[]): string {
  if (children.length === 0) {
    return section(
      "Child Tasks",
      "No child tasks to integrate. Verify the changes from the parent task's own execution.",
    );
  }

  const lines = [`${String(children.length)} child task(s) to integrate:`];

  for (const child of children) {
    lines.push("");
    lines.push(`### ${child.child_title} (${child.child_id})`);
    lines.push(`- Branch: ${child.branch}`);
    lines.push(`- Test status: ${child.test_status}`);
    if (child.files_changed.length > 0) {
      lines.push("- Files changed:");
      for (const f of child.files_changed) {
        lines.push(`  - ${f}`);
      }
    }
  }

  return section("Child Tasks", lines.join("\n"));
}

function buildExecutionSection(executionOutput: Record<string, unknown> | null): string {
  if (!executionOutput) {
    return section(
      "Parent Execution",
      "No parent-level execution was performed. Focus on integrating child task outputs.",
    );
  }
  return section("Parent Execution", formatPriorPhaseOutput("execution", executionOutput));
}

function buildReviewSection(selfReviewOutput: Record<string, unknown> | null): string {
  if (!selfReviewOutput) {
    return section("Parent Review", "No parent-level review was performed.");
  }
  return section("Parent Review", formatPriorPhaseOutput("self_review", selfReviewOutput));
}

function buildRepoOverview(repoContext: RepoContext | null): string | null {
  if (!repoContext?.gitBranch) {
    return null;
  }
  return section("Repository", `Branch: ${repoContext.gitBranch}`);
}

function buildKnowledgeSection(
  repoKnowledge: KnowledgeEntry[],
  userKnowledge: KnowledgeEntry[],
): string | null {
  const repoFormatted = formatKnowledge(repoKnowledge);
  const userFormatted = formatKnowledge(userKnowledge);

  if (!(repoFormatted || userFormatted)) {
    return null;
  }

  const parts: string[] = [];
  if (repoFormatted) {
    parts.push("Repository knowledge:", repoFormatted);
  }
  if (userFormatted) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push("User knowledge:", userFormatted);
  }

  return section("Known Context", parts.join("\n"));
}

function buildIntegrationInstructions(): string {
  return section(
    "Instructions",
    [
      "Verify the combined output of all child tasks. Integration is about ensuring the whole is greater than the sum of its parts.",
      "",
      "1. For each child task, read the key files it changed. Verify the changes are complete and correct.",
      "",
      "2. Check for merge conflicts or integration issues across children's changes. Look for:",
      "   - Overlapping file modifications",
      "   - Incompatible API changes between children",
      "   - Missing shared dependencies or type updates",
      "   - Broken cross-references between modules",
      "",
      "3. Run integration tests that exercise the combined changes. Use run_command to execute tests.",
      "",
      "4. If conflicts are found, resolve them. Use edit_file for surgical fixes, write_file for new integration code.",
      "",
      "5. Run the full test suite to verify no regressions across the entire codebase.",
      "",
      "6. Document everything: which children were verified, what tests were run, what conflicts were found and how they were resolved.",
    ].join("\n"),
  );
}
