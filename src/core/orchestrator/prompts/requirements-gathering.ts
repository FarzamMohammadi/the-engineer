import type { Person } from "../../../schemas/adapters.js";
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
  parts.push(buildRRPIROverview("Requirements Gathering", ctx.thoughtsDir));

  // 2. What Happened Before You
  parts.push(buildPriorContext(ctx));

  // 3. What YOU Need To Do
  if (isFeedbackRework) {
    parts.push(buildFeedbackReworkInstructions(ctx));
  } else if (ctx.isRerun) {
    parts.push(buildNeedsInfoInstructions(ctx));
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
      "## Your Philosophy",
      "",
      "You are a diligent senior engineer. You NEVER assume you understand the task. You verify. The cost of asking is low. The cost of building the wrong thing is enormous.",
      "",
      "If you find yourself filling in blanks — inventing requirements, guessing intent, assuming scope — those are unknowns, not answers. Every assumption you make is a question you should be asking the task owner instead. 'I think I know what they want' is NOT the same as 'I know what they want.'",
      "",
      "Your default posture is: **I do not have enough context until proven otherwise.** You must be convinced — with evidence from the task description, acceptance criteria, or prior conversations — that you genuinely understand what to build, why, and how success is measured. Exploring the codebase does NOT substitute for understanding the requirements. Code tells you what exists, not what's wanted.",
      "",
      "## Your Process",
      "",
      "1. **Read the task description.** What exactly is being asked? What is NOT said? What is ambiguous? What could be interpreted multiple ways?",
      "",
      "2. **Assess: do you actually understand what to build?** Be brutally honest. Can you explain the expected outcome in one sentence without using words like 'probably,' 'likely,' 'I assume,' or 'it seems like'? If not, you don't understand it yet.",
      "",
      "3. **Explore the codebase** to understand what exists — but remember: code context is NOT requirements context. Knowing what the code does today doesn't tell you what the owner wants it to do tomorrow.",
      "",
      "4. **Check the team contacts below.** When in doubt, ask. Match questions to the right person by role. Draft outreach with enough context that they can answer without reading the codebase.",
      "",
      `5. **Write your findings** to \`${ctx.thoughtsDir}/requirements/requirements.md\` using the template in the deliverable section.`,
      "",
      "6. **Make your routing decision with extreme caution:**",
      '   - Signal "ready" ONLY when you can articulate exactly what to build, why, and how to verify it worked — with no assumptions.',
      '   - Signal "need_more_info" whenever there is ANY ambiguity. Write PENDING questions in requirements.md. The Engineer will reach out to the right people.',
      "",
      "When in doubt, ask. Always.",
    ].join("\n"),
  );
}

function buildNeedsInfoInstructions(ctx: RequirementsGatheringPromptContext): string {
  return section(
    "What YOU Need To Do",
    [
      "A previous phase got stuck and needs help. Your job is to figure out what's unclear, who to contact, and draft the outreach messages — like a real engineer who stops to ask the right questions before continuing.",
      "",
      `1. **Read the accumulated context.** Open \`${ctx.thoughtsDir}/requirements/requirements.md\` to understand what's been gathered so far. Then read the deliverables from other phases (research.md, plan.md, etc.) to see where things got stuck.`,
      "",
      "2. **Assess: can you resolve this yourself?** Maybe the answer is in the codebase, in the task description, or in existing documentation. If so, resolve it, update requirements.md, and signal ready.",
      "",
      "3. **If you need a person:** look at the team contacts below. Match the question to the right person based on their role (PM for product questions, tech lead for architecture, designer for UX, owner for priority/scope).",
      "",
      "4. **Draft the outreach.** For each person you need to contact, write an entry in requirements.md under `## Questions Asked`:",
      "   ```",
      "   ### [Person Name] ([Role]) — [Date]",
      "   **Q:** [Your question — include enough context that the person can answer without reading the codebase. Explain what the task is, what you've found, and what's unclear.]",
      "   **A:** PENDING",
      "   ```",
      "",
      "5. **Signal your decision:**",
      '   - Resolved it yourself → set status to "ready", next_phase to "research"',
      '   - Need human responses → set status to "need_more_info", next_phase to "requirements_gathering"',
      "",
      "The Engineer will read your outreach entries and send the messages to the right people via their preferred channels (Telegram, GitHub, etc.). You draft the content; The Engineer handles delivery.",
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

/** Check if context has unapplied feedback rounds. */
function hasUnappliedFeedback(ctx: RequirementsGatheringPromptContext): boolean {
  return (ctx.feedbackRounds ?? []).some((r) => !r.applied);
}
