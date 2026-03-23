import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { FeedbackRound } from "../../../schemas/task.js";
import type { RepoContext } from "./context.js";
import { buildTaskBrief, formatKnowledge, section, wrapUntrustedContent } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the execution phase prompt. */
export interface ExecutionPromptContext {
  task: {
    title: string;
    description: string | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  thoughtsDir: string;
  /** Unapplied feedback rounds from PR review (rework mode). */
  feedbackRounds?: FeedbackRound[] | undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the execution phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildExecutionPrompt(ctx: ExecutionPromptContext): string {
  const parts: string[] = [];

  // 1. How The Engineer Works
  parts.push(buildRrpirOverview());

  // 2. What Happened Before You
  parts.push(buildPriorPhasesSection(ctx.thoughtsDir));

  // 3. What YOU Need To Do
  parts.push(buildInstructions());

  // 4. Where To Put Your Work
  parts.push(buildOutputSection(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildRrpirOverview(): string {
  return section(
    "How The Engineer Works",
    [
      "You are the Implementation session in a multi-phase pipeline called RRPIR:",
      "**Requirements Gathering → Research → Planning → Implementation → Review**",
      "",
      "Each phase is a separate CLI session with a fresh context window. File-based handoffs connect the phases:",
      "- Each phase reads previous phases' `.md` deliverables for context.",
      "- Each phase writes its own deliverable and updates a `session-result.json` for routing.",
      "- You have full CLI capabilities: read files, write files, search code, run commands. Use them freely.",
      "",
      "You are Implementation. Requirements have been gathered, research is done, and a plan has been written. Your job is to execute the plan — write code, run tests, ship quality.",
    ].join("\n"),
  );
}

function buildPriorPhasesSection(thoughtsDir: string): string {
  return section(
    "What Happened Before You",
    [
      "Three phases have already completed. Read their deliverables:",
      "",
      `1. **Plan (your primary guide):** \`${thoughtsDir}/planning/plan.md\` — the implementation plan with phases, checkboxes, risks, and test strategy.`,
      `2. **Research:** \`${thoughtsDir}/research/research.md\` — codebase analysis, conventions, patterns to follow.`,
      `3. **Requirements:** \`${thoughtsDir}/requirements/requirements.md\` — full task context and gathered requirements.`,
      "",
      "Read plan.md first — it is your implementation guide. Reference research.md for conventions and patterns. Read requirements.md for full context if needed.",
    ].join("\n"),
  );
}

function buildInstructions(): string {
  return section(
    "What YOU Need To Do",
    [
      "1. **Read plan.md — this is your guide.** Understand the approach, the phases, the risks.",
      "",
      "2. **Implement each phase in order.** Update checkboxes to `[x]` as you complete steps. This tracks progress and enables crash recovery.",
      "",
      "3. **Run tests after each phase.** Fix failures before moving on. The test-fix loop is what makes code actually work:",
      "   - Make changes for one phase",
      "   - Run the relevant tests",
      "   - If tests fail, read the error, fix the issue, run again",
      "   - Only move to the next phase when tests pass",
      "",
      "4. **Follow conventions from research.md.** Same coding style, test patterns, naming, directory structure.",
      "",
      '5. **If you get stuck and need input,** set `next_phase` to `"requirements_gathering"` in session-result.json. Specify what information you need and why in your summary.',
      "",
      "6. **Commit at meaningful checkpoints.** Each commit should represent a logical unit of work with passing tests.",
    ].join("\n"),
  );
}

function buildOutputSection(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      "Code changes go in the worktree normally. The plan.md checkboxes track your progress.",
      "",
      "```",
      `Session result: ${thoughtsDir}/implementation/session-result.json`,
      "```",
      "",
      "Update session-result.json with:",
      "```json",
      "{",
      '  "status": "ready" or "need_more_info" or "error",',
      '  "next_phase": "self_review" (if ready) or "requirements_gathering" (if need more info),',
      '  "summary": "<one-line summary of what you implemented>"',
      "}",
      "```",
    ].join("\n"),
  );
}

function buildTaskContext(ctx: ExecutionPromptContext): string {
  const parts: string[] = [];

  // Task brief
  parts.push(buildTaskBrief(ctx.task));

  // Feedback rounds (rework mode)
  const feedbackSection = buildFeedbackSection(ctx.feedbackRounds);
  if (feedbackSection) {
    parts.push(feedbackSection);
  }

  // Repo context
  const repoSection = buildRepoOverview(ctx.repoContext);
  if (repoSection) {
    parts.push(repoSection);
  }

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return section("The Task Context", parts.join("\n\n"));
}

function buildRepoOverview(repoContext: RepoContext | null): string | null {
  if (!repoContext) {
    return null;
  }

  const parts: string[] = [];

  if (repoContext.gitBranch) {
    parts.push(`Branch: ${repoContext.gitBranch}`);
  }

  if (repoContext.packageInfo) {
    parts.push("", repoContext.packageInfo);
  }

  if (repoContext.directoryTree) {
    parts.push("", "### File Structure", "", repoContext.directoryTree);
  }

  return parts.length > 0 ? `### Repository\n\n${parts.join("\n")}` : null;
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

  return `### Known Context\n\n${parts.join("\n")}`;
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
    "### Reviewer Feedback (MUST ADDRESS)",
    "",
    "This is a rework session. The following reviewer feedback was received during PR review. You MUST address each point:",
    "",
  ];

  for (const [i, round] of unapplied.entries()) {
    lines.push(`**Feedback Round ${String(i + 1)} (${round.stage} review):**`);
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

  return lines.join("\n");
}
