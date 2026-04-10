import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the skills directory from the repo root for tests.
 * Walks up from this file's location to find package.json, then appends resources/skills.
 */
export function resolveSkillsDir(): string {
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

  return join(resolve(thisDir, "../.."), "resources", "skills");
}
