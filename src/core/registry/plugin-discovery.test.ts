import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { discoverPlugins } from "./plugin-discovery.js";

// ── Constants ─────────────────────────────────────────────────────────────

const DUPLICATE_ID_RE = /[Dd]uplicate plugin ID "same-id"/;

// ── Test Helpers ──────────────────────────────────────────────────────────

let tempDir: string;

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `plugin-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePluginManifest(
  dir: string,
  pluginName: string,
  manifest: Record<string, unknown>,
): string {
  const pluginDir = join(dir, pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "engineer.plugin.yaml"), stringifyYaml(manifest), "utf-8");
  // Create a dummy entry file
  writeFileSync(
    join(pluginDir, "index.ts"),
    "export function createPlugin() { return {}; }",
    "utf-8",
  );
  return pluginDir;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("discoverPlugins (plugin-discovery)", () => {
  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Discovery ──────────────────────────────────────────────────────────

  it("finds plugins with valid engineer.plugin.yaml in scanned directories", () => {
    writePluginManifest(tempDir, "my-plugin", {
      id: "my-plugin",
      type: "trigger",
      version: "1.0.0",
      name: "My Plugin",
      description: "Test plugin",
    });

    const plugins = discoverPlugins({ dirs: [tempDir], includeBuiltins: false });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.id).toBe("my-plugin");
    expect(plugins[0]?.isBuiltin).toBe(false);
  });

  // ── Skip disabled ────────────────────────────────────────────────────

  it("skips plugins with enabled: false", () => {
    writePluginManifest(tempDir, "disabled-plugin", {
      id: "disabled-plugin",
      type: "trigger",
      version: "1.0.0",
      name: "Disabled Plugin",
      description: "Should be skipped",
      enabled: false,
    });
    writePluginManifest(tempDir, "enabled-plugin", {
      id: "enabled-plugin",
      type: "tool",
      version: "1.0.0",
      name: "Enabled Plugin",
      description: "Should be found",
    });

    const plugins = discoverPlugins({ dirs: [tempDir], includeBuiltins: false });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.id).toBe("enabled-plugin");
  });

  // ── Duplicate detection ──────────────────────────────────────────────

  it("throws on duplicate plugin IDs across directories", () => {
    const dir2 = createTempDir();
    try {
      writePluginManifest(tempDir, "dupe", {
        id: "same-id",
        type: "trigger",
        version: "1.0.0",
        name: "Plugin A",
        description: "First",
      });
      writePluginManifest(dir2, "dupe2", {
        id: "same-id",
        type: "tool",
        version: "1.0.0",
        name: "Plugin B",
        description: "Second",
      });

      expect(() => discoverPlugins({ dirs: [tempDir, dir2], includeBuiltins: false })).toThrow(
        DUPLICATE_ID_RE,
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  // ── Invalid manifest ─────────────────────────────────────────────────

  it("throws on malformed YAML or schema validation failure", () => {
    const pluginDir = join(tempDir, "bad-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "engineer.plugin.yaml"),
      "id: bad\n# missing required fields",
      "utf-8",
    );

    expect(() => discoverPlugins({ dirs: [tempDir], includeBuiltins: false })).toThrow();
  });

  // ── Missing entry file ────────────────────────────────────────────────

  it("includes plugins even if entry file does not exist", () => {
    const pluginDir = join(tempDir, "no-entry");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "engineer.plugin.yaml"),
      stringifyYaml({
        id: "no-entry",
        type: "trigger",
        version: "1.0.0",
        name: "No Entry",
        description: "Missing entry file",
        entry: "nonexistent.ts",
      }),
      "utf-8",
    );
    // Do NOT create the entry file

    const plugins = discoverPlugins({ dirs: [tempDir], includeBuiltins: false });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.id).toBe("no-entry");
  });

  // ── Built-in discovery ────────────────────────────────────────────────

  it("finds all 6 built-in plugins when includeBuiltins is true", () => {
    const plugins = discoverPlugins({ dirs: [], includeBuiltins: true });

    expect(plugins.length).toBe(6);

    const ids = plugins.map((p) => p.manifest.id).sort();
    expect(ids).toEqual([
      "bash-tool",
      "claude-code-llm",
      "github-comm",
      "github-hosting",
      "github-trigger",
      "telegram-comm",
    ]);

    // All should be marked as built-in
    for (const plugin of plugins) {
      expect(plugin.isBuiltin).toBe(true);
    }
  });

  // ── Nonexistent dirs ──────────────────────────────────────────────────

  it("skips nonexistent directories", () => {
    const plugins = discoverPlugins({
      dirs: ["/nonexistent/path/that/does/not/exist"],
      includeBuiltins: false,
    });

    expect(plugins).toHaveLength(0);
  });

  // ── Type priority ordering ────────────────────────────────────────────

  it("returns plugins ordered by type priority", () => {
    writePluginManifest(tempDir, "my-trigger", {
      id: "my-trigger",
      type: "trigger",
      version: "1.0.0",
      name: "Trigger",
      description: "Last",
    });
    writePluginManifest(tempDir, "my-comm", {
      id: "my-comm",
      type: "communication",
      version: "1.0.0",
      name: "Comm",
      description: "First",
    });

    const plugins = discoverPlugins({ dirs: [tempDir], includeBuiltins: false });

    expect(plugins[0]?.manifest.type).toBe("communication");
    expect(plugins[1]?.manifest.type).toBe("trigger");
  });

  // ── Contributes field ─────────────────────────────────────────────────

  it("parses the contributes field from manifests", () => {
    writePluginManifest(tempDir, "contrib-plugin", {
      id: "contrib-plugin",
      type: "trigger",
      version: "1.0.0",
      name: "Contrib Plugin",
      description: "Has contributes",
      contributes: {
        events: ["trigger.new_event"],
        commands: ["custom-cmd"],
      },
    });

    const plugins = discoverPlugins({ dirs: [tempDir], includeBuiltins: false });

    expect(plugins[0]?.manifest.contributes.events).toEqual(["trigger.new_event"]);
    expect(plugins[0]?.manifest.contributes.commands).toEqual(["custom-cmd"]);
    expect(plugins[0]?.manifest.contributes.config_keys).toEqual([]);
    expect(plugins[0]?.manifest.contributes.hooks).toEqual([]);
  });
});
