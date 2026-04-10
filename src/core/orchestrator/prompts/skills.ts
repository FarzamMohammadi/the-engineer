import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Phase } from "../../../schemas/orchestrator.js";
import { Phases } from "../../../schemas/orchestrator.js";
import { section } from "./format.js";

// ── Constants ───────────────────────────────────────────────────────────────

const HEADING_RE = /^# (.+)$/m;
const MD_EXT_RE = /\.md$/;

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
 * Returns a formatted section containing all skills relevant to the phase,
 * or null if no skills apply. Skills are read from `resources/skills/` and
 * embedded as text — no file paths are passed to the CLI.
 */
export function buildSkillsSection(phase: Phase): string | null {
  const skillNames = SKILL_PHASE_MAP[phase];
  if (skillNames.length === 0) {
    return null;
  }

  const blocks: string[] = [];
  for (const name of skillNames) {
    const content = loadSkillContent(name);
    if (content) {
      blocks.push(`### Skill: ${name}\n\n${content}`);
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return section("Skills", blocks.join("\n\n"));
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the repo root by walking up from this module's location.
 *
 * Works from both `src/` (dev via tsx) and `dist/` (built output)
 * by searching for `package.json` at each directory level.
 */
function findRepoRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let current = thisDir;
  const root = resolve("/");

  while (current !== root) {
    try {
      readFileSync(join(current, "package.json"), "utf-8");
      return current;
    } catch {
      current = dirname(current);
    }
  }

  // Fallback: relative traversal from src/core/orchestrator/prompts/
  return resolve(thisDir, "../../../..");
}

/**
 * Load skill content from `resources/skills/{skillName}/`.
 *
 * Reads SKILL.md and, if present, inlines all persona files from the
 * `personas/` subdirectory. Returns the combined content as a string.
 * Returns empty string on any read error (logs a warning, never crashes).
 */
export function loadSkillContent(skillName: SkillName): string {
  try {
    const repoRoot = findRepoRoot();
    const skillDir = join(repoRoot, "resources", "skills", skillName);

    const skillContent = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    const parts = [skillContent.trim()];

    // Inline persona files if present
    const personasDir = join(skillDir, "personas");
    try {
      const personaFiles = readdirSync(personasDir)
        .filter((f) => f.endsWith(".md"))
        .sort();

      for (const file of personaFiles) {
        try {
          const personaContent = readFileSync(join(personasDir, file), "utf-8").trim();
          const personaName = extractPersonaName(personaContent, file);
          parts.push(`## Persona: ${personaName}\n\n${personaContent}`);
        } catch {
          // Individual persona file unreadable — skip it, continue with others
        }
      }
    } catch {
      // No personas directory — not an error, just no personas to inline
    }

    return parts.join("\n\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[skills] Failed to load skill "${skillName}": ${message}`);
    return "";
  }
}

/**
 * Extract a human-readable persona name from the file content or filename.
 *
 * Looks for a top-level `# Heading` in the content. Falls back to
 * converting the filename (e.g., "technical-architect.md" -> "Technical Architect").
 */
function extractPersonaName(content: string, filename: string): string {
  const headingMatch = content.match(HEADING_RE);
  if (headingMatch?.[1]) {
    return headingMatch[1];
  }

  return filename
    .replace(MD_EXT_RE, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
