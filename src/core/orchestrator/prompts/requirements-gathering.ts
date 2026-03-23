import type { Person } from "../../../schemas/adapters.js";
import type { KnowledgeEntry } from "../../../schemas/session-memory.js";
import type { FeedbackRound } from "../../../schemas/task.js";
import type { RepoContext } from "./context.js";
import { buildTaskBrief, formatKnowledge, section, wrapUntrustedContent } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context needed to build the requirements gathering prompt. */
export interface RequirementsGatheringPromptContext {
  task: {
    title: string;
    description: string | null;
    external_ref?: { type: string; repo: string; number: number } | null;
  };
  repoContext: RepoContext | null;
  repoKnowledge: KnowledgeEntry[];
  userKnowledge: KnowledgeEntry[];
  teamContacts: Person[];
  /** Full path to the thoughts directory, e.g. "thoughts/2026-03-22-issue-42" */
  thoughtsDir: string;
  /** Unapplied feedback rounds from PR review (rework mode). */
  feedbackRounds?: FeedbackRound[] | undefined;
  /** Existing PR number (rework mode). */
  prNumber?: number | undefined;
  /** True if looped back from research or another phase needing more info. */
  isRerun?: boolean;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the prompt for the requirements gathering phase (CLI-native RRPIR).
 *
 * Pure function: context in, prompt string out.
 */
export function buildRequirementsGatheringPrompt(ctx: RequirementsGatheringPromptContext): string {
  const parts: string[] = [];
  const isFeedbackRework = hasUnappliedFeedback(ctx);

  // 1. How The Engineer Works
  parts.push(buildRrpirOverview(ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorContext(ctx));

  // 3. What YOU Need To Do
  if (isFeedbackRework) {
    parts.push(buildFeedbackReworkInstructions(ctx));
  } else {
    parts.push(buildRequirementsInstructions(ctx));
  }

  // 4. Where To Put Your Work
  parts.push(buildDeliverableInstructions(ctx.thoughtsDir));

  // 5. The Task Context
  parts.push(buildTaskContextSection(ctx, isFeedbackRework));

  return parts.join("\n\n");
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildRrpirOverview(thoughtsDir: string): string {
  return section(
    "How The Engineer Works",
    [
      "You are running as part of The Engineer, an autonomous software engineering agent. The Engineer uses RRPIR methodology — Requirements Gathering, Research, Planning, Implementation, Review. Each phase is a separate CLI session. You are the Requirements Gathering session.",
      "",
      "You have full CLI capabilities: read files, write files, search code, run commands. Use them freely to explore the codebase and gather context.",
      "",
      `Your deliverable goes in \`${thoughtsDir}/requirements/requirements.md\`. After you finish, update \`${thoughtsDir}/requirements/session-result.json\` to tell The Engineer where to go next.`,
    ].join("\n"),
  );
}

function buildPriorContext(ctx: RequirementsGatheringPromptContext): string {
  if (ctx.isRerun) {
    return section(
      "What Happened Before You",
      [
        "This is a continuation. A previous phase (or a prior requirements gathering session) determined that more information was needed.",
        "",
        `Read your prior work at \`${ctx.thoughtsDir}/requirements/requirements.md\` and incorporate the new context below. Update the same file — accumulate, do not replace.`,
      ].join("\n"),
    );
  }
  return section(
    "What Happened Before You",
    "This is the first phase. No prior context exists. You are starting fresh.",
  );
}

function buildRequirementsInstructions(ctx: RequirementsGatheringPromptContext): string {
  return section(
    "What YOU Need To Do",
    [
      "Gather all context needed for this task. You are a senior engineer making sure you fully understand the ask before diving in.",
      "",
      "1. Read the task description carefully. Identify gaps, ambiguities, missing context, unstated assumptions, or conflicting constraints.",
      "",
      "2. Explore the relevant codebase areas to understand scope. Read key files if the task references specific components. Use search to find related code.",
      "",
      "3. Check the team contacts below. Determine if you need input from anyone — a PM for unclear requirements, a tech lead for architectural questions, a designer for UX decisions.",
      "",
      `4. Write your findings to \`${ctx.thoughtsDir}/requirements/requirements.md\`. Use the template provided in the deliverable section.`,
      "",
      "5. Make your routing decision:",
      '   - If you have enough context to proceed, set next_phase to "research" in session-result.json.',
      '   - If you need more information from people, document what is needed in the .md file (with PENDING answers) and set next_phase to "requirements_gathering" so The Engineer knows to reach out and loop back.',
    ].join("\n"),
  );
}

function buildFeedbackReworkInstructions(ctx: RequirementsGatheringPromptContext): string {
  const unapplied = (ctx.feedbackRounds ?? []).filter((r) => !r.applied);

  const feedbackLines: string[] = [];
  for (const [i, round] of unapplied.entries()) {
    feedbackLines.push(`### Feedback Round ${String(i + 1)} (${round.stage} review)`);
    if (round.comments.length > 0) {
      for (const comment of round.comments) {
        feedbackLines.push(`- ${wrapUntrustedContent(comment)}`);
      }
    } else {
      feedbackLines.push("- (Changes requested — no specific comments provided)");
    }
    feedbackLines.push("");
  }

  return section(
    "What YOU Need To Do",
    [
      "This task has received reviewer feedback on an existing PR. Your job is to understand the feedback and gather any additional context needed to address it.",
      "",
      `PR: #${String(ctx.prNumber ?? "unknown")}`,
      "",
      "## Reviewer Feedback to Address",
      "",
      ...feedbackLines,
      "1. Read the feedback carefully. Understand what the reviewer is asking for.",
      "",
      "2. Explore the affected area of the codebase to understand the current implementation.",
      "",
      "3. Assess the scope of changes needed:",
      "   - If the feedback is minor (typo, naming, style, small edge case), note that in your assessment.",
      "   - If the feedback requires rethinking the approach, touching multiple components, or architectural changes, assess full scope.",
      "",
      `4. Write your findings to \`${ctx.thoughtsDir}/requirements/requirements.md\`. Include the feedback and your assessment of what needs to change.`,
      "",
      "5. Do NOT decompose feedback rework — address all feedback points in a single pass.",
    ].join("\n"),
  );
}

function buildDeliverableInstructions(thoughtsDir: string): string {
  return section(
    "Where To Put Your Work",
    [
      `Deliverable: \`${thoughtsDir}/requirements/requirements.md\``,
      `Session result: \`${thoughtsDir}/requirements/session-result.json\``,
      "",
      "Update session-result.json with:",
      "```json",
      "{",
      '  "status": "ready" or "need_more_info",',
      '  "next_phase": "research" (if ready) or "requirements_gathering" (if need more info),',
      '  "summary": "<one-line summary of what you gathered>"',
      "}",
      "```",
      "",
      "Use this template for requirements.md:",
      "",
      "```markdown",
      "# Requirements: [Task Title]",
      "",
      "## Task Description",
      "[Original task from trigger source]",
      "",
      "## Gathered Context",
      "[Everything we know — from task, from codebase exploration, from responses]",
      "",
      "## Questions Asked",
      "### [Person/Role] — [Date]",
      "**Q:** [Question]",
      "**A:** [Answer, or PENDING]",
      "",
      "## Assessment",
      "[Is this enough to proceed to research? What is still unclear?]",
      "",
      "## Team Contacts Referenced",
      "- [Name] ([Role]) — [What they provided]",
      "```",
    ].join("\n"),
  );
}

function buildTaskContextSection(
  ctx: RequirementsGatheringPromptContext,
  isFeedbackRework: boolean,
): string {
  const parts: string[] = [];

  // Task brief
  if (isFeedbackRework) {
    const lines = [`Original Task: ${wrapUntrustedContent(ctx.task.title)}`];
    if (ctx.task.description) {
      lines.push(
        "",
        "## Original Task Description",
        "",
        wrapUntrustedContent(ctx.task.description),
      );
    }
    parts.push(section("The Task Context", lines.join("\n")));
  } else {
    parts.push(buildTaskBrief(ctx.task));
  }

  // Team contacts
  parts.push(buildTeamContactsSection(ctx.teamContacts));

  // Repository overview
  parts.push(buildRepoOverview(ctx.repoContext));

  // Knowledge
  const knowledge = buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge);
  if (knowledge) {
    parts.push(knowledge);
  }

  return parts.join("\n\n");
}

function buildTeamContactsSection(contacts: Person[]): string {
  if (contacts.length === 0) {
    return section("Team Contacts", "No team contacts configured.");
  }

  const lines: string[] = [];
  for (const person of contacts) {
    const roles = person.roles.join(", ");
    const contactDetails = person.contacts.map((c) => `${c.channel}: ${c.handle}`).join(", ");
    if (contactDetails) {
      lines.push(`- ${person.name} (${roles}) — ${contactDetails}`);
    } else {
      lines.push(`- ${person.name} (${roles})`);
    }
  }

  return section("Team Contacts", lines.join("\n"));
}

function buildRepoOverview(repoContext: RepoContext | null): string {
  if (!repoContext) {
    return section(
      "Repository",
      "No repository context available. Assess based on the task description and explore the codebase yourself.",
    );
  }

  const parts: string[] = [];

  if (repoContext.gitBranch) {
    parts.push(`Branch: ${repoContext.gitBranch}`);
  }

  if (repoContext.packageInfo) {
    parts.push("", repoContext.packageInfo);
  }

  if (repoContext.readme) {
    parts.push("", "### README (excerpt)", "", repoContext.readme);
  }

  if (repoContext.directoryTree) {
    parts.push("", "### File Structure", "", repoContext.directoryTree);
  }

  if (repoContext.recentCommits) {
    parts.push("", "### Recent Commits", "", repoContext.recentCommits);
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

/** Check if context has unapplied feedback rounds. */
function hasUnappliedFeedback(ctx: RequirementsGatheringPromptContext): boolean {
  return (ctx.feedbackRounds ?? []).some((r) => !r.applied);
}
