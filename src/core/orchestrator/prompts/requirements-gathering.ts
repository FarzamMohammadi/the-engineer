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
    external_ref?: { type: string; repo: string; id: string } | null;
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
        "This is a continuation. Previously, you (or a prior session) reached out for more information. People were contacted, and they may have responded.",
        "",
        "## Where to find context",
        "",
        `- **Your prior work:** \`${ctx.thoughtsDir}/requirements/requirements.md\` — read it, understand what was gathered, what questions were asked.`,
        `- **Responses received:** Check \`${ctx.thoughtsDir}/requirements/responses/\` — if people responded, their answers are here as \`.txt\` files (one per source/channel). These are the answers to questions you previously asked.`,
        `- **Your outreach:** \`${ctx.thoughtsDir}/requirements/outreach/\` — what you sent out last time.`,
        "",
        "Read everything. Incorporate what you learn into requirements.md — accumulate, do not replace. The responses directory is your primary new input. If someone answered your question, use that answer. If the answer is incomplete or raises new questions, you may reach out again.",
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
      "## Your Philosophy: Investigate Before Asking",
      "",
      '**Never assume — but not every unknown requires a human.** Before reaching out, ask yourself: "Can I determine this through my available tools?"',
      "",
      "There are three kinds of unknowns:",
      "",
      "1. **Researchable facts** — determinable through web search, codebase exploration, documentation, or logical deduction. Examples: latest version of a library, current file contents, what a config field does, how an API works. **Figure these out yourself.** Document what you found and how.",
      "",
      '2. **Reasonable inferences** — the task says "update X" and only one X exists, or the scope is self-evident from context. **Proceed with the obvious interpretation.** Document your reasoning.',
      "",
      "3. **Judgment calls** — require human intent, preference, architectural authority, or choosing between genuinely ambiguous interpretations. The task owner's opinion matters and you cannot substitute it. **Ask.**",
      "",
      "The cost of asking when you could have figured it out yourself is not zero — it delays the task and trains the team to expect an agent that cannot think independently. The cost of building the wrong thing is worse. **Default to investigating. Escalate to asking only when investigation cannot resolve the unknown.**",
      "",
      "## Your Process",
      "",
      "1. **Read the task description.** What is being asked? What is NOT said? What could mean different things?",
      "",
      "2. **Explore the codebase** to understand what exists. But code and docs found in the repo are context, not confirmed requirements — they could be outdated, aspirational, or wrong.",
      "",
      "3. **Honestly assess: do I know what to build?** If you can't explain the expected outcome, identify what's missing — then determine whether you can resolve it through research (web search, codebase exploration) or whether it requires human input. Only reach out for the latter.",
      "",
      "4. **When you need to ask,** check the team contacts below. Match questions to the right person. Write one `.txt` file per person in the outreach directory:",
      "",
      `   \`${ctx.thoughtsDir}/requirements/outreach/{person-id}.txt\``,
      "",
      "   The filename is the person's ID from the team contacts (e.g., `farzam.txt`). The content is the full message to send — include enough context that the person can answer without reading the codebase. One file per person, even if you have multiple questions for them.",
      "",
      `5. **Write your findings** to \`${ctx.thoughtsDir}/requirements/requirements.md\` using the template in the deliverable section.`,
      "",
      "6. **Self-sufficiency test** — for each unknown, before deciding to ask a human:",
      "   - Can I answer this with a **web search**? (latest versions, API docs, standards) → Research it.",
      "   - Can I answer this by **reading the codebase**? (current behavior, file locations, patterns) → Explore it.",
      "   - Can I answer this by **reading the task description more carefully**? (scope is often stated plainly) → Re-read it.",
      "   - Does this require **human judgment** that I genuinely cannot substitute? (intent, preference, architectural direction, risk tolerance) → Ask.",
      "",
      "7. **Deciding when to block vs. proceed:**",
      "   - **Block** (signal need_more_info) when: the task owner's intent is genuinely ambiguous with multiple valid interpretations you cannot resolve through research, security or breaking-change implications require explicit sign-off, or multiple stakeholders need coordination.",
      "   - **Proceed** (signal ready) when: you can determine what to build through investigation and reasonable inference, the task is well-scoped, or you can make a defensible choice and document your reasoning.",
      "",
      "   When writing outreach files, **number your questions** so the recipient can answer each one clearly.",
      "",
      "   Signal ready when you know what to build — through explicit statement, research, or reasonable inference. Signal need_more_info only when you've exhausted investigation and the remaining unknowns require human judgment. The Engineer will read your outreach files and deliver them to each person via their preferred channel (Telegram, GitHub, etc.).",
      "",
      "8. **Update session-result.json** with your routing decision (see deliverable section below for the format).",
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
      "3. **If you need a person:** look at the team contacts below. Match the question to the right person based on their role.",
      "",
      "4. **Write outreach messages.** For each person you need to contact, create a `.txt` file:",
      "",
      `   \`${ctx.thoughtsDir}/requirements/outreach/{person-id}.txt\``,
      "",
      "   The filename is the person's ID from the team contacts (e.g., `farzam.txt`). The content is the full message — include enough context that they can answer without reading the codebase. One file per person.",
      "",
      "5. **Route:** Resolved it yourself → signal ready. Need human responses → signal need_more_info. The Engineer reads your outreach files and delivers them via each person's preferred channel (Telegram, GitHub, etc.).",
      "",
      "6. **Update session-result.json** with your routing decision (see deliverable section below for the format).",
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
      '  "summary": "<one-line summary of what you gathered>",',
      '  "complexity": "trivial" or "moderate" or "complex"',
      "}",
      "```",
      "",
      "### Complexity Assessment",
      "",
      "Set `complexity` in session-result.json based on your assessment:",
      "- **trivial** — Obvious scope, minimal changes: typo fix, config value, simple rename, docs-only edit. Research phase will be skipped — planning handles brief exploration.",
      "- **moderate** — Clear direction with some exploration needed: add a field, fix a known bug, update a single component.",
      "- **complex** — Broad scope, multiple systems, unknowns: new features, refactoring, cross-cutting changes.",
      "",
      "When in doubt, choose **moderate**.",
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
    // Include person.id — this is the filename for outreach/*.txt files
    if (contactDetails) {
      lines.push(`- **${person.id}** — ${person.name} (${roles}) — ${contactDetails}`);
    } else {
      lines.push(`- **${person.id}** — ${person.name} (${roles})`);
    }
  }

  return section("Team Contacts", lines.join("\n"));
}

/** Check if context has unapplied feedback rounds. */
function hasUnappliedFeedback(ctx: RequirementsGatheringPromptContext): boolean {
  return (ctx.feedbackRounds ?? []).some((r) => !r.applied);
}
