import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { FeedbackRound } from "../../../schemas/task.js";
import type { RepoContext } from "./context.js";
import {
  buildKnowledgeSection,
  buildRRPIROverview,
  buildRepoOverview,
  buildTaskBrief,
  section,
  wrapUntrustedContent,
} from "./format.js";
import { buildSkillsSection } from "./skills.js";

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
  /** Absolute path to skills directory for on-demand reading by the CLI. */
  skillsDir: string;
  /** Unapplied feedback rounds from PR review (rework mode). */
  feedbackRounds?: FeedbackRound[] | undefined;
  /** True when research was skipped for a trivial task. */
  skipResearch?: boolean;
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
  parts.push(buildRRPIROverview("Implementation", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorPhasesSection(ctx.thoughtsDir, ctx.skipResearch));

  // 3. What YOU Need To Do
  parts.push(buildInstructions());

  // 4. Where To Put Your Work
  parts.push(buildOutputSection(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContext(ctx));

  // 6. Skills
  const skills = buildSkillsSection("execution", ctx.skillsDir);
  if (skills) {
    parts.push(skills);
  }

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildPriorPhasesSection(thoughtsDir: string, skipResearch?: boolean): string {
  if (skipResearch) {
    return section(
      "What Happened Before You",
      [
        "Two phases have completed (research was skipped for this trivial task):",
        "",
        `1. **Plan (your primary guide):** \`${thoughtsDir}/planning/plan.md\` — the implementation plan with phases, checkboxes, risks, and test strategy.`,
        `2. **Requirements:** \`${thoughtsDir}/requirements/requirements.md\` — full task context and gathered requirements.`,
        "",
        "Read plan.md first — it is your implementation guide. Read requirements.md for full context if needed.",
      ].join("\n"),
    );
  }

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
      "   - **If session-result.json already has values (not placeholders),** this is a resumed session. Re-evaluate plan.md and the current state of the codebase before continuing — checked `[x]` boxes indicate prior progress, but verify the work is sound before moving forward.",
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
      "6. **Update documentation.** A code change without a corresponding doc update is unfinished work. If the codebase has documentation that covers the behavior you changed, update it in the same step — not later.",
      "",
      "7. **Commit at meaningful checkpoints.** Each commit should represent a logical unit of work with passing tests.",
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
  parts.push(buildRepoOverview(ctx.repoContext));

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return parts.join("\n\n");
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
