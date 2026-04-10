import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { Phase } from "../../../schemas/orchestrator.js";
import { Phases } from "../../../schemas/orchestrator.js";
import { section } from "./format.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Skills that the orchestrator can inject into phase prompts. */
export type SkillName = "commit" | "expert-panel-review";

// ── Phase-to-Skill Mapping ──────────────────────────────────────────────────

/** Which skills are relevant to each RRPIR phase. */
const SKILL_PHASE_MAP: Record<Phase, SkillName[]> = {
  [Phases.requirements_gathering]: [],
  [Phases.research]: [],
  [Phases.planning]: [],
  [Phases.execution]: ["commit"],
  [Phases.self_review]: ["commit", "expert-panel-review"],
  [Phases.demo_prep]: [],
  [Phases.integration]: ["commit"],
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the skills section for a given RRPIR phase.
 *
 * Returns a formatted section containing absolute path references to all
 * skills relevant to the phase, or null if no skills apply. The CLI reads
 * skill files on demand from these paths — content is never inlined.
 *
 * @param phase - The RRPIR phase to build skills for.
 * @param skillsDir - Absolute path to the skills directory (e.g., `{workspace_root}/skills/`).
 */
export function buildSkillsSection(phase: Phase, skillsDir: string): string | null {
  const skillNames = SKILL_PHASE_MAP[phase];
  if (skillNames.length === 0) {
    return null;
  }

  const blocks: string[] = [];
  for (const name of skillNames) {
    const block = buildSkillPathBlock(name, skillsDir);
    if (block) {
      blocks.push(block);
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return section(
    "Skills",
    [
      "You MUST read the following skill files before proceeding. Use your Read tool to load each file.",
      "",
      ...blocks,
    ].join("\n"),
  );
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Build a path-reference block for a single skill.
 *
 * Lists the SKILL.md path and any persona file paths found in the
 * `personas/` subdirectory. Returns null on any error (logs a warning).
 */
function buildSkillPathBlock(skillName: SkillName, skillsDir: string): string | null {
  try {
    const skillDir = join(skillsDir, skillName);
    const skillPath = join(skillDir, "SKILL.md");
    const lines = [
      `### Skill: ${skillName}`,
      "",
      `Read this skill's instructions from: \`${skillPath}\``,
    ];

    // Discover persona files if present
    const personasDir = join(skillDir, "personas");
    try {
      const personaFiles = readdirSync(personasDir)
        .filter((f) => f.endsWith(".md"))
        .sort();

      if (personaFiles.length > 0) {
        lines.push("", "Also read these persona files:");
        for (const file of personaFiles) {
          lines.push(`- \`${join(personasDir, file)}\``);
        }
      }
    } catch {
      // No personas directory — not an error, just no personas to list
    }

    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[skills] Failed to build paths for skill "${skillName}": ${message}`);
    return null;
  }
}
