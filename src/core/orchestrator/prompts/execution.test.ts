import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildExecutionPrompt } from "./execution.js";

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

describe("buildExecutionPrompt", () => {
  const minimalCtx = {
    task: { title: "Test task", description: "A test" },
    repoContext: null,
    repoKnowledge: [],
    userKnowledge: [],
    thoughtsDir: "/tmp/thoughts",
    skillsDir: resolveSkillsDir(),
  };

  it("should include skills section with path reference in execution prompt", () => {
    const result = buildExecutionPrompt(minimalCtx);
    expect(result).toContain("## Skills");
    expect(result).toContain("### Skill: commit");
    expect(result).toContain("commit/SKILL.md");
    // Content must NOT be inlined
    expect(result).not.toContain("Grouping Priority");
  });

  it("should not include expert-panel-review skill in execution prompt", () => {
    const result = buildExecutionPrompt(minimalCtx);
    expect(result).not.toContain("expert-panel-review");
  });
});
