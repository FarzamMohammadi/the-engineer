import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import type { PluginManifest } from "../../schemas/adapters.js";
import type { IObserver } from "../observer/facade.js";
import {
  type DiscoveredManifest,
  MANIFEST_FILENAME,
  SEMVER_REGEX,
  TYPE_PRIORITY,
  discoverPlugins,
  orderByTypePriority,
  validateDiscoveredPlugins,
} from "./discovery.js";

// ── Top-level regex constants ───────────────────────────────────────────
const DUPLICATE_PLUGIN_ID_RE = /duplicate plugin ID/;
const INVALID_VERSION_RE = /invalid version/;
const ENTRY_FILE_NOT_FOUND_RE = /entry file not found/;

// ── Helpers ────────────────────────────────────────────────────────────────

function createPluginDir(
  parentDir: string,
  name: string,
  manifest: Record<string, unknown>,
): string {
  const dir = join(parentDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILENAME), yamlStringify(manifest));
  // Create a dummy entry file
  writeFileSync(join(dir, "index.js"), "export function createPlugin() { return {}; }");
  return dir;
}

function makeManifest(overrides: Partial<PluginManifest> = {}): Record<string, unknown> {
  return {
    id: "test-plugin",
    type: "trigger",
    version: "1.0.0",
    name: "Test Plugin",
    description: "A test plugin",
    entry: "index.js",
    critical: false,
    enabled: true,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("discovery", () => {
  let tempDir: string;
  let observer: IObserver;

  beforeEach(() => {
    observer = createTestObserverFacade("registry");
    tempDir = mkdtempSync(join(tmpdir(), "registry-discovery-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("discoverPlugins", () => {
    it("discovers plugins in a directory", () => {
      createPluginDir(tempDir, "my-plugin", makeManifest({ id: "my-plugin" }));

      const result = discoverPlugins([tempDir], observer);

      expect(result).toHaveLength(1);
      expect(result[0]!.manifest.id).toBe("my-plugin");
    });

    it("discovers plugins in nested directories", () => {
      const nested = join(tempDir, "level1", "level2");
      mkdirSync(nested, { recursive: true });
      createPluginDir(nested, "deep-plugin", makeManifest({ id: "deep-plugin" }));

      const result = discoverPlugins([tempDir], observer);

      expect(result).toHaveLength(1);
      expect(result[0]!.manifest.id).toBe("deep-plugin");
    });

    it("skips disabled plugins", () => {
      createPluginDir(tempDir, "disabled", makeManifest({ id: "disabled", enabled: false }));

      const result = discoverPlugins([tempDir], observer);

      expect(result).toHaveLength(0);
    });

    it("skips nonexistent directories", () => {
      const result = discoverPlugins(["/nonexistent/path"], observer);

      expect(result).toHaveLength(0);
    });

    it("handles empty directories", () => {
      const result = discoverPlugins([tempDir], observer);

      expect(result).toHaveLength(0);
    });

    it("discovers from multiple directories", () => {
      const dir1 = join(tempDir, "dir1");
      const dir2 = join(tempDir, "dir2");
      mkdirSync(dir1);
      mkdirSync(dir2);
      createPluginDir(dir1, "p1", makeManifest({ id: "p1" }));
      createPluginDir(dir2, "p2", makeManifest({ id: "p2", type: "llm" }));

      const result = discoverPlugins([dir1, dir2], observer);

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.manifest.id).sort()).toEqual(["p1", "p2"]);
    });

    it("sets correct entryPath from manifest entry field", () => {
      const dir = createPluginDir(tempDir, "ep", makeManifest({ id: "ep", entry: "index.js" }));

      const result = discoverPlugins([tempDir], observer);

      expect(result[0]!.entryPath).toBe(join(dir, "index.js"));
    });
  });

  describe("validateDiscoveredPlugins", () => {
    it("passes for valid plugins", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "a", version: "1.0.0" }) as PluginManifest,
          dir: tempDir,
          entryPath: join(tempDir, "index.js"),
        },
      ];
      // Create the entry file
      writeFileSync(join(tempDir, "index.js"), "");

      expect(() => validateDiscoveredPlugins(discovered, observer)).not.toThrow();
    });

    it("rejects duplicate IDs", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "dup" }) as PluginManifest,
          dir: tempDir,
          entryPath: join(tempDir, "index.js"),
        },
        {
          manifest: makeManifest({ id: "dup" }) as PluginManifest,
          dir: tempDir,
          entryPath: join(tempDir, "index.js"),
        },
      ];
      writeFileSync(join(tempDir, "index.js"), "");

      expect(() => validateDiscoveredPlugins(discovered, observer)).toThrow(DUPLICATE_PLUGIN_ID_RE);
    });

    it("rejects invalid semver versions", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "bad-ver", version: "not-semver" }) as PluginManifest,
          dir: tempDir,
          entryPath: join(tempDir, "index.js"),
        },
      ];
      writeFileSync(join(tempDir, "index.js"), "");

      expect(() => validateDiscoveredPlugins(discovered, observer)).toThrow(INVALID_VERSION_RE);
    });

    it("rejects missing entry files", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "no-entry" }) as PluginManifest,
          dir: tempDir,
          entryPath: join(tempDir, "nonexistent.js"),
        },
      ];

      expect(() => validateDiscoveredPlugins(discovered, observer)).toThrow(
        ENTRY_FILE_NOT_FOUND_RE,
      );
    });
  });

  describe("orderByTypePriority", () => {
    it("sorts by type priority", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "t", type: "trigger" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
        {
          manifest: makeManifest({ id: "c", type: "communication" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
        {
          manifest: makeManifest({ id: "l", type: "llm" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
      ];

      const ordered = orderByTypePriority(discovered);

      expect(ordered.map((d) => d.manifest.type)).toEqual(["communication", "llm", "trigger"]);
    });

    it("breaks ties alphabetically by ID", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "z-plugin", type: "tool" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
        {
          manifest: makeManifest({ id: "a-plugin", type: "tool" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
      ];

      const ordered = orderByTypePriority(discovered);

      expect(ordered.map((d) => d.manifest.id)).toEqual(["a-plugin", "z-plugin"]);
    });

    it("does not mutate the input array", () => {
      const discovered: DiscoveredManifest[] = [
        {
          manifest: makeManifest({ id: "b", type: "trigger" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
        {
          manifest: makeManifest({ id: "a", type: "communication" }) as PluginManifest,
          dir: "",
          entryPath: "",
        },
      ];

      const ordered = orderByTypePriority(discovered);

      expect(ordered).not.toBe(discovered);
      expect(discovered[0]!.manifest.id).toBe("b");
    });
  });

  describe("constants", () => {
    it("exports TYPE_PRIORITY with all adapter types", () => {
      expect(TYPE_PRIORITY).toEqual({
        communication: 1,
        llm: 2,
        tool: 3,
        git_hosting: 4,
        trigger: 5,
      });
    });

    it("exports SEMVER_REGEX that matches valid versions", () => {
      expect(SEMVER_REGEX.test("1.0.0")).toBe(true);
      expect(SEMVER_REGEX.test("1.2.3-beta.1")).toBe(true);
      expect(SEMVER_REGEX.test("not-valid")).toBe(false);
    });

    it("exports MANIFEST_FILENAME", () => {
      expect(MANIFEST_FILENAME).toBe("engineer.plugin.yaml");
    });
  });
});
