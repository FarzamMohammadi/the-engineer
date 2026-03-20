import { Phases } from "../../../schemas/orchestrator.js";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { FeedbackRound } from "../../../schemas/task.js";
import type { RepoContext } from "./context.js";
import {
  buildTaskBrief,
  formatActionReference,
  formatKnowledge,
  formatOutputSchema,
  formatPriorPhaseOutput,
  section,
  wrapUntrustedContent,
} from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the execution phase prompt. */
export interface ExecutionPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  intakeOutput: Record<string, unknown> | null;
  researchOutput: Record<string, unknown> | null;
  planningOutput: Record<string, unknown> | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  /** Unapplied feedback rounds from PR review (rework mode). */
  feedbackRounds?: FeedbackRound[] | undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the initial prompt for the execution phase.
 *
 * Pure function: context in, prompt string out.
 */
export function buildExecutionPrompt(ctx: ExecutionPromptContext): string {
  const parts: string[] = [];

  // 1. Task Brief
  parts.push(buildTaskBrief(ctx.task));

  // 2. Plan (primary guide)
  parts.push(buildPlanSection(ctx.planningOutput));

  // 3. Research Context (conventions, patterns)
  parts.push(buildResearchSection(ctx.researchOutput));

  // 4. Repository (minimal with plan, detailed without)
  const repoSection = buildRepoOverview(ctx.repoContext, ctx.planningOutput !== null);
  if (repoSection) {
    parts.push(repoSection);
  }

  // 5. Known Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  // 5b. Reviewer Feedback (rework mode)
  const feedbackSection = buildFeedbackSection(ctx.feedbackRounds);
  if (feedbackSection) {
    parts.push(feedbackSection);
  }

  // 6. Phase Instructions
  parts.push(buildExecutionInstructions());

  // 7. Execution Strategy (adapts to complexity)
  parts.push(buildExecutionStrategy(ctx.intakeOutput));

  // 8. Iteration Budget
  parts.push(
    section(
      "Iteration Budget",
      "You have up to 25 iterations. This is your execution budget — use it to write code, run tests, and fix issues. Prioritize getting tests passing over writing more code. Quality over quantity.",
    ),
  );

  // 9. Output Schema
  parts.push(section("Output Requirements", formatOutputSchema(Phases.execution)));

  // 10. Action Reference
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

function buildPlanSection(planningOutput: Record<string, unknown> | null): string {
  if (!planningOutput) {
    return section(
      "Plan",
      "No plan available. Implement changes based on the task description, following existing codebase conventions.",
    );
  }
  return section("Plan", formatPriorPhaseOutput(Phases.planning, planningOutput));
}

function buildResearchSection(researchOutput: Record<string, unknown> | null): string {
  if (!researchOutput) {
    return section(
      "Research Context",
      "No research context available. Follow existing patterns you find in the codebase.",
    );
  }
  return section("Research Context", formatPriorPhaseOutput(Phases.research, researchOutput));
}

function buildRepoOverview(repoContext: RepoContext | null, hasPlan: boolean): string | null {
  if (!repoContext) {
    return null;
  }

  const lines: string[] = [];
  if (repoContext.gitBranch) {
    lines.push(`Branch: ${repoContext.gitBranch}`);
  }

  // When there's a plan, keep it minimal — the LLM can explore freely.
  // When fast-path (no plan/research), include more context so the LLM knows
  // what files exist and can make changes without prior exploration.
  if (!hasPlan) {
    if (repoContext.packageInfo) {
      lines.push("", repoContext.packageInfo);
    }
    if (repoContext.directoryTree) {
      lines.push("", "### File Structure", "", repoContext.directoryTree);
    }
  }

  return lines.length > 0 ? section("Repository", lines.join("\n")) : null;
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

function buildExecutionInstructions(): string {
  return section(
    "Instructions",
    [
      "Implement the plan. Write clean, tested code that follows the conventions identified in research.",
      "",
      "1. Start with foundation changes — types, interfaces, schemas, or any code that other changes depend on.",
      "",
      "2. Implement the core logic. Follow the plan's file_changes list, but adapt if you discover something the plan didn't anticipate. Use edit_file for surgical changes to existing files, write_file for new files.",
      "",
      "3. Write tests alongside the code. Every behavior change needs a test. Follow the test patterns from research — same assertion style, same file naming, same describe/it structure.",
      "",
      "4. Run tests after each meaningful change (run_command). Fix failures immediately before moving on. The test-fix loop is what makes code actually work:",
      "   - Make a change",
      "   - Run the relevant tests",
      "   - If tests fail, read the error, fix the issue, run again",
      "   - Only move to the next change when tests pass",
      "",
      "5. When all changes are implemented and tests pass, run the full relevant test suite to check for regressions.",
      "",
      "6. Stage and commit at meaningful checkpoints. Each commit should represent a logical unit of work with passing tests.",
    ].join("\n"),
  );
}

function buildExecutionStrategy(intakeOutput: Record<string, unknown> | null): string {
  const complexity = (intakeOutput?.["complexity"] as string) ?? "moderate";

  if (complexity === "trivial" || complexity === "simple") {
    return section(
      "Execution Strategy",
      [
        "This is a simple change. Follow this sequence:",
        "1. Read the relevant file(s) to understand the current code",
        "2. Use edit_file or write_file to make the change",
        "3. Verify the change works (run tests or build if applicable)",
        "4. Only then say done with files_changed listing what you modified",
        "",
        "IMPORTANT: You MUST read and modify actual files before reporting done. Do NOT say done without making changes.",
      ].join("\n"),
    );
  }

  if (complexity === "complex" || complexity === "epic") {
    return section(
      "Execution Strategy",
      [
        "This is a complex implementation. Work through the plan's file_changes in dependency order:",
        "1. Foundation first (types, schemas, interfaces).",
        "2. Core logic next (the main implementation).",
        "3. Tests after each logical group.",
        "4. Integration and regression tests last.",
        "If you hit an unexpected obstacle, adapt the approach but stay aligned with the plan's intent.",
      ].join("\n"),
    );
  }

  // Moderate (default)
  return section(
    "Execution Strategy",
    "Follow the plan methodically. Implement, test, fix, commit. If a test keeps failing, re-read the relevant code to understand what you're missing before trying more fixes.",
  );
}

function buildFeedbackSection(feedbackRounds?: FeedbackRound[]): string | null {
  if (!feedbackRounds) {
    return null;
  }
  const unapplied = feedbackRounds.filter((r) => !r.applied);
  if (unapplied.length === 0) {
    return null;
  }

  const lines = [
    "The following reviewer feedback was received during PR review. You MUST address each point:",
    "",
  ];

  for (const [i, round] of unapplied.entries()) {
    lines.push(`### Feedback Round ${String(i + 1)} (${round.stage} review)`);
    if (round.comments.length > 0) {
      for (const comment of round.comments) {
        lines.push(`- ${wrapUntrustedContent(comment)}`);
      }
    } else {
      lines.push("- (Changes requested — review the PR discussion for details)");
    }
    lines.push("");
  }

  lines.push("After addressing all feedback, verify your changes compile and pass tests.");

  return section("Reviewer Feedback (MUST ADDRESS)", lines.join("\n"));
}
