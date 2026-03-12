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

/** Context needed to build the demo-prep phase prompt. */
export interface DemoPrepPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  intakeOutput: Record<string, unknown> | null;
  planningOutput: Record<string, unknown> | null;
  executionOutput: Record<string, unknown> | null;
  selfReviewOutput: Record<string, unknown> | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the demo-prep phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildDemoPrepPrompt(ctx: DemoPrepPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx));

  // 2. Implementation Summary
  parts.push(buildExecutionSection(ctx.executionOutput));

  // 3. Review Assessment
  parts.push(buildReviewSection(ctx.selfReviewOutput));

  // 4. Original Approach (for PR narrative)
  parts.push(buildPlanSection(ctx.planningOutput));

  // 5. Repository
  parts.push(buildRepoOverview(ctx.repoContext));

  // 6. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 7. Phase Instructions
  parts.push(buildDemoPrepInstructions());

  // 8. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 10 iterations. Use them to read the final state, write the PR description, and create any demo artifacts.",
    ),
  );

  // 9. Output Schema + Action Reference
  parts.push(section("Output Requirements", formatOutputSchema("demo_prep")));
  parts.push(
    section("Actions", formatActionReference(["read_file", "write_file", "run_command", "done"])),
  );

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildTaskBrief(ctx: DemoPrepPromptContext): string {
  const lines = [`Task: ${ctx.task.title}`];
  if (ctx.task.description) {
    lines.push("", ctx.task.description);
  }
  return section("Task", lines.join("\n"));
}

function buildExecutionSection(executionOutput: Record<string, unknown> | null): string {
  if (!executionOutput) {
    return section(
      "Implementation Summary",
      "No execution summary available. Read the branch diff to understand the changes.",
    );
  }
  return section("Implementation Summary", formatPriorPhaseOutput("execution", executionOutput));
}

function buildReviewSection(selfReviewOutput: Record<string, unknown> | null): string {
  if (!selfReviewOutput) {
    return section(
      "Review Assessment",
      "No review assessment available. Assume the code is ready for demo.",
    );
  }
  return section("Review Assessment", formatPriorPhaseOutput("self_review", selfReviewOutput));
}

function buildPlanSection(planningOutput: Record<string, unknown> | null): string {
  if (!planningOutput) {
    return section(
      "Original Approach",
      "No planning context available. Describe the changes based on what you find in the code.",
    );
  }
  return section("Original Approach", formatPriorPhaseOutput("planning", planningOutput));
}

function buildRepoOverview(repoContext: RepoContext | null): string {
  if (!repoContext) {
    return section(
      "Repository",
      "No repository context available. Use read actions to explore if needed.",
    );
  }

  const parts: string[] = [];
  if (repoContext.gitBranch) {
    parts.push(`Branch: ${repoContext.gitBranch}`);
  }
  if (repoContext.packageInfo) {
    parts.push("", repoContext.packageInfo);
  }

  if (parts.length === 0) {
    return section("Repository", "Repository context available but no branch information.");
  }

  return section("Repository", parts.join("\n"));
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

function buildDemoPrepInstructions(): string {
  return section(
    "Instructions",
    [
      "Prepare demo artifacts and a comprehensive PR description. Communication quality is half an engineer's value.",
      "",
      "1. Read the final state of all changed files. Understand the full picture of what was built.",
      "",
      "2. Write a PR description that tells the full story:",
      "   - What changed and why (link back to the original task)",
      "   - Technical approach taken (reference the plan)",
      "   - How to test the changes (concrete steps a reviewer can follow)",
      "   - Any breaking changes, migration steps, or deployment notes",
      "   - Key decisions made during implementation",
      "",
      "3. Create demo artifacts appropriate to the change domain:",
      "   - Frontend: screenshots (before/after), preview URLs",
      "   - Backend: API examples, test output demonstrating behavior",
      "   - Infrastructure: config diffs, dry-run output",
      "   - Use run_command to generate artifacts (test output, screenshots, etc.)",
      "",
      "4. Push the branch and provide the PR metadata in your done result.",
    ].join("\n"),
  );
}
