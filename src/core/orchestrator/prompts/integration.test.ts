import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIntegrationPrompt } from "./integration.js";

function resolveSkillsDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let current = thisDir;
  const root = resolve("/");

  while (current !== root) {
    try {
      readFileSync(join(current, "package.json"), "utf-8");
      return join(current, "resources", "skills");
    } catch {
      current = dirname(current);
    }
  }

  return join(resolve(thisDir, "../../../.."), "resources", "skills");
}

describe("buildIntegrationPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    thoughtsDir: "/tmp/thoughts",
    skillsDir: resolveSkillsDir(),
    childSummaries: [],
  };

  it("should include skills section with path reference in integration prompt", () => {
    const result = buildIntegrationPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Grouping Priority");
  });

  it("should not include expert-panel-review skill in integration prompt", () => {
    const result = buildIntegrationPrompt(minimalCtx);
    expect(result).not.toContain("expert-panel-review");
  });
});
