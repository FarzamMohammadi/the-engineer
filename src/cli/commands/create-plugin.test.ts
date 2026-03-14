import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { PluginManifestSchema } from "../../schemas/adapters.js";
import { scaffoldPlugin } from "./create-plugin.js";

// ── Constants ─────────────────────────────────────────────────────────────

const ALREADY_EXISTS_RE = /already exists/;

// ── Helpers ───────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `create-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("scaffoldPlugin", () => {
  // ── File generation ──────────────────────────────────────────────────

  it("creates all expected files", () => {
    scaffoldPlugin({ name: "my-trigger", type: "trigger", outputDir: tempDir });

    const pluginDir = join(tempDir, "my-trigger");
    expect(existsSync(join(pluginDir, "engineer.plugin.yaml"))).toBe(true);
    expect(existsSync(join(pluginDir, "index.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "my-trigger.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "config.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "my-trigger.test.ts"))).toBe(true);
  });

  it("returns list of created file paths", () => {
    const files = scaffoldPlugin({ name: "my-tool", type: "tool", outputDir: tempDir });

    expect(files).toHaveLength(5);
    expect(files.some((f) => f.endsWith("engineer.plugin.yaml"))).toBe(true);
    expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("my-tool.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("config.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("my-tool.test.ts"))).toBe(true);
  });

  // ── Correct adapter ──────────────────────────────────────────────────

  it.each([
    ["trigger", "TriggerAdapter"],
    ["communication", "CommunicationAdapter"],
    ["llm", "LLMAdapter"],
    ["tool", "ToolAdapter"],
    ["git_hosting", "GitHostingAdapter"],
  ] as const)("generates class extending %s base adapter → %s", (type, baseClass) => {
    scaffoldPlugin({ name: `test-${type}`, type, outputDir: tempDir });

    const pluginContent = readFileSync(join(tempDir, `test-${type}`, `test-${type}.ts`), "utf-8");
    expect(pluginContent).toContain(`extends ${baseClass}`);
  });

  // ── Valid TypeScript ──────────────────────────────────────────────────

  it("generated code contains valid TypeScript imports", () => {
    scaffoldPlugin({ name: "my-plugin", type: "trigger", outputDir: tempDir });

    const indexContent = readFileSync(join(tempDir, "my-plugin", "index.ts"), "utf-8");
    expect(indexContent).toContain("import type");
    expect(indexContent).toContain("export function createPlugin()");

    const configContent = readFileSync(join(tempDir, "my-plugin", "config.ts"), "utf-8");
    expect(configContent).toContain("import { z } from");
    expect(configContent).toContain("z.object(");
  });

  // ── Manifest validity ─────────────────────────────────────────────────

  it("generated manifest passes PluginManifestSchema validation", () => {
    scaffoldPlugin({ name: "valid-plugin", type: "communication", outputDir: tempDir });

    const yamlContent = readFileSync(
      join(tempDir, "valid-plugin", "engineer.plugin.yaml"),
      "utf-8",
    );
    const parsed = parseYaml(yamlContent) as Record<string, unknown>;
    const result = PluginManifestSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("valid-plugin");
      expect(result.data.type).toBe("communication");
      expect(result.data.version).toBe("0.1.0");
    }
  });

  // ── Error on existing directory ────────────────────────────────────────

  it("throws if plugin directory already exists", () => {
    scaffoldPlugin({ name: "dupe", type: "trigger", outputDir: tempDir });

    expect(() => scaffoldPlugin({ name: "dupe", type: "trigger", outputDir: tempDir })).toThrow(
      ALREADY_EXISTS_RE,
    );
  });

  // ── PascalCase naming ──────────────────────────────────────────────────

  it("converts kebab-case name to PascalCase for class", () => {
    scaffoldPlugin({ name: "my-awesome-trigger", type: "trigger", outputDir: tempDir });

    const content = readFileSync(
      join(tempDir, "my-awesome-trigger", "my-awesome-trigger.ts"),
      "utf-8",
    );
    expect(content).toContain("class MyAwesomeTriggerPlugin");
  });
});
