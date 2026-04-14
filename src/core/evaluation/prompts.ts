import type { EvaluationSnapshot } from "./types.js";

// ── Session 1: Blind Plan ────────────────────────────────────────────────────

export function buildBlindPlanSystemPrompt(): string {
  return `You are a senior software engineer at the top of your craft. You think in systems, you ship clean code, and you never act without understanding the problem first.

You are about to receive a task. Your job is to plan how YOU would approach it — step by step, with the same rigor you'd apply to production work.

IMPORTANT: You have READ-ONLY access to this codebase. Do NOT modify any files. Do NOT create any files in the repository. You may only read, search, and explore.

You will write your plan to a file OUTSIDE the repository (path provided below). That is the ONLY file you may create or write to.

REMINDER: You have READ-ONLY access to the repository. Do NOT modify any repository files.`;
}

export function buildBlindPlanPrompt(snapshot: EvaluationSnapshot): string {
  return `## The Task

**${snapshot.taskTitle}**

${snapshot.taskDescription ?? "(No description provided)"}

## Repository

${snapshot.repo}, base branch: ${snapshot.baseBranch}

## Your Assignment

Plan how you would implement this task from scratch. Be thorough:

1. **Explore the codebase.** Understand the architecture, patterns, conventions, and relevant files. Use search, read files, check package.json, explore directory structure. Take your time — thoroughness here determines plan quality.

2. **Understand the problem.** What exactly needs to change? What are the edge cases? What could go wrong?

3. **Design your approach.** What files would you create or modify? In what order? What patterns would you follow? What would you test?

4. **Write your plan** to \`${snapshot.evaluationDir}/blind-plan.md\`. Structure it as:
   - **Understanding**: What the task requires (in your own words)
   - **Codebase Analysis**: Key files, patterns, and conventions discovered
   - **Approach**: Step-by-step implementation plan with file paths
   - **Testing Strategy**: What you'd test and how
   - **Risks**: What could go wrong and how you'd mitigate it

Be specific. Name files. Describe changes. This plan should be detailed enough that another engineer could execute it.

REMINDER: You have READ-ONLY access to the repository. Write ONLY to \`${snapshot.evaluationDir}/blind-plan.md\`. Do NOT modify any repository files.`;
}

// ── Session 2: Comparison & Verdict ──────────────────────────────────────────

export function buildComparisonSystemPrompt(personaContent: string): string {
  return `You are a senior engineering evaluator. Your previous session planned how you would approach a task — without knowing someone else had already done it. Now you will compare your plan against the actual implementation by an autonomous AI engineering agent called "The Engineer."

Your evaluation standard is defined by this persona — the ideal engineer The Engineer aspires to be:

---
${personaContent}
---

Evaluate against that standard. Be honest. If the implementation is excellent, say so — do not manufacture criticism to appear thorough. If it's flawed, explain specifically what's wrong and why. Do not soften genuine problems to be polite. The goal is accurate assessment, not forced feedback.

IMPORTANT: You have READ-ONLY access to this codebase. Do NOT modify any files in the repository. Write ONLY to the evaluation directory specified below.

REMINDER: You have READ-ONLY access. Do NOT modify any repository files.`;
}

export function buildComparisonPrompt(snapshot: EvaluationSnapshot): string {
  const thoughtsSections = formatThoughtsFiles(snapshot.thoughtsFiles);

  return `## Your Blind Plan

Read your plan from Session 1: \`${snapshot.evaluationDir}/blind-plan.md\`

## The Engineer's Work

The Engineer (an autonomous AI agent) completed this same task. Here is everything it produced:

### Trigger Details
- **Task:** ${snapshot.taskTitle}
- **Description:** ${snapshot.taskDescription ?? "(No description provided)"}
- **Repository:** ${snapshot.repo}
- **Branch:** ${snapshot.branch} (base: ${snapshot.baseBranch})

### Commit History
\`\`\`
${snapshot.commitLog || "(No commits)"}
\`\`\`

### Git Changes (full diff)
\`\`\`diff
${snapshot.gitDiff || "(No changes)"}
\`\`\`

### The Engineer's Thought Process

The Engineer works through a multi-phase pipeline: Requirements Gathering → Research → Planning → Implementation → Review. All of its thinking is captured in these files:

${thoughtsSections}

## Your Evaluation Task

Compare your blind plan against The Engineer's actual output. Assess all commits and changes on the branch. Write your verdict to \`${snapshot.evaluationDir}/verdict.md\` with this structure:

### 1. Approach Comparison
How does The Engineer's approach compare to your blind plan?
- Where did it make the same choices? Different ones?
- Were its choices better, equivalent, or worse than yours? Be specific.

### 2. Requirements Fidelity
Did The Engineer build what was asked? Not more, not less?
- Scope accuracy (did it stay on target?)
- Requirements interpretation (reasonable? creative? wrong?)

### 3. Implementation Quality
Evaluate the actual code changes against what a 5/5 engineer (per the persona) would produce:
- **Correctness:** Does it work? Edge cases handled?
- **Simplicity:** Simplest approach that works? Unnecessary complexity?
- **Codebase Fit:** Matches existing patterns, conventions, naming?
- **Testing:** Adequate coverage? Right things tested?
- **Error Handling:** Failures visible and propagated?

### 4. Process Quality
Evaluate The Engineer's thinking process (from the thoughts/ files):
- Requirements gathering: Thorough? Right questions asked?
- Research: Sufficient codebase exploration? Key files found?
- Planning: Considered alternatives? Chose wisely?
- Self-review: Caught real issues? Or rubber-stamp?

### 5. Overall Verdict
Rate 1-5 and explain:
- **1/5**: Fundamentally broken — wrong approach, missing requirements, would not ship
- **2/5**: Significant issues — works partially, major gaps or quality problems
- **3/5**: Acceptable — meets requirements, some room for improvement
- **4/5**: Strong — clean, well-reasoned, minor improvements possible
- **5/5**: Exceptional — the simplest correct solution, executed with craft and care. What a true 5/5 engineer (per the persona) would produce.

State clearly: **Who did it better — you or The Engineer?** And what specifically would make this a 5/5?

### 6. Key Takeaways
- Top 1-3 strengths (be specific — what exactly was done well?)
- Top 1-3 areas for improvement (be specific — what exactly should change and why?)
- If The Engineer did everything a 5/5 engineer would do, say so plainly. Don't force criticism.

Write ONLY to \`${snapshot.evaluationDir}/verdict.md\`. Do NOT modify any repository files.`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatThoughtsFiles(files: Map<string, string>): string {
  if (files.size === 0) {
    return "(No thoughts files found)";
  }

  const sections: string[] = [];
  for (const [path, content] of files) {
    sections.push(`#### \`${path}\`\n\`\`\`markdown\n${content}\n\`\`\``);
  }
  return sections.join("\n\n");
}
