import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SkillsManager } from "../../../../src/core/skills/index.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

let workspaceRoot: string;

function setup(): SkillsManager {
  workspaceRoot = mkdtempSync(join(tmpdir(), "skills-test-"));
  return new SkillsManager(workspaceRoot, createTestObserverFacade("skills"));
}

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("SkillsManager", () => {
  describe("getDir", () => {
    it("returns {workspace_root}/skills/", () => {
      const skills = setup();
      expect(skills.getDir()).toBe(join(workspaceRoot, "skills"));
    });
  });

  describe("sync", () => {
    it("copies skill files from resources/skills/ to {workspace_root}/skills/", () => {
      const skills = setup();
      skills.sync();

      const skillsDir = skills.getDir();
      expect(existsSync(join(skillsDir, "commit", "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillsDir, "expert-panel-review", "SKILL.md"))).toBe(true);
    });

    it("copies persona files for expert-panel-review", () => {
      const skills = setup();
      skills.sync();

      const personasDir = join(skills.getDir(), "expert-panel-review", "personas");
      expect(existsSync(personasDir)).toBe(true);
      const personas = readdirSync(personasDir);
      expect(personas.length).toBeGreaterThan(0);
      expect(personas.some((f) => f.endsWith(".md"))).toBe(true);
    });

    it("is idempotent — calling twice does not throw", () => {
      const skills = setup();
      skills.sync();
      expect(() => skills.sync()).not.toThrow();

      // Files still present after second call
      expect(existsSync(join(skills.getDir(), "commit", "SKILL.md"))).toBe(true);
    });
  });
});
