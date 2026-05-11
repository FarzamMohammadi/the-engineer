import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../../../src/core/event-bus/index.js";
import { Registry } from "../../../src/core/registry/index.js";
import { createInMemoryDatabase } from "../../../src/db/database.js";
import type { DatabaseHandle } from "../../../src/db/database.js";
import type { BuiltinPlugin } from "../../../src/plugins/builtin.js";
import type { PluginManifest } from "../../../src/schemas/adapters.js";
import { PluginManifestSchema } from "../../../src/schemas/adapters.js";
import { FakeTriggerPlugin } from "../../helpers/fake-plugins/fake-trigger/index.js";
import { createTestObserverFacade } from "../../helpers/test-observer-facade.js";

// Mock BUILTIN_PLUGINS so we control what plugins are "discovered"
vi.mock("../../../src/plugins/builtin.js", () => ({
  // Start empty — each test populates via setTestPlugins()
  BUILTIN_PLUGINS: [] as BuiltinPlugin[],
}));

import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { discoverEnabledPlugins, loadBuiltinPlugins } from "../../../src/plugins/loader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const CRITICAL_REGISTRATION_ERROR = /Critical plugin "critical-trigger" failed to register/;
const CRITICAL_CREATE_ERROR = /Critical plugin "broken-trigger" failed to create/;
const CRITICAL_CONFIG_ERROR = /Failed to load config for critical plugin/;
const PLUGIN_DIR_UNREADABLE = /Cannot read plugin config directory/;

function makeManifest(overrides: Partial<PluginManifest>): PluginManifest {
  return PluginManifestSchema.parse({
    id: "test-plugin",
    type: "trigger",
    version: "1.0.0",
    name: "Test Plugin",
    description: "A test plugin",
    ...overrides,
  });
}

function setTestPlugins(plugins: BuiltinPlugin[]): void {
  // Mutate the mocked array in-place
  (BUILTIN_PLUGINS as BuiltinPlugin[]).length = 0;
  (BUILTIN_PLUGINS as BuiltinPlugin[]).push(...plugins);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("loadBuiltinPlugins", () => {
  let dbHandle: DatabaseHandle;
  let registry: Registry;
  let observer: ReturnType<typeof createTestObserverFacade>;
  let tmpDir: string;

  beforeEach(() => {
    dbHandle = createInMemoryDatabase();
    const eventBus = new EventBus(dbHandle.db, {
      observer: createTestObserverFacade("event-bus"),
    });
    observer = createTestObserverFacade("plugin-loader");
    registry = new Registry({
      eventBus,
      observer: createTestObserverFacade("registry"),
      healthCheckIntervalMs: 60_000,
      healthCheckTimeoutMs: 1_000,
      consecutiveFailuresThreshold: 3,
    });
    tmpDir = mkdtempSync(join(tmpdir(), "loader-test-"));
  });

  afterEach(() => {
    registry.stopHealthCheckLoop();
    dbHandle.close();
    setTestPlugins([]);
  });

  it("throws when critical plugin registration fails (duplicate ID)", async () => {
    const manifest = makeManifest({ id: "critical-trigger", critical: true });
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => new FakeTriggerPlugin(),
    };
    setTestPlugins([plugin]);

    // Enable the plugin via config file
    writeFileSync(join(tmpDir, "critical-trigger.yaml"), "enabled: true");

    // Pre-register with the same ID to cause duplicate
    registry.register(manifest, new FakeTriggerPlugin());

    await expect(loadBuiltinPlugins(registry, tmpDir, observer)).rejects.toThrow(CRITICAL_REGISTRATION_ERROR);
  });

  it("continues when non-critical plugin registration fails (duplicate ID)", async () => {
    const manifest = makeManifest({ id: "optional-trigger", critical: false });
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => new FakeTriggerPlugin(),
    };
    setTestPlugins([plugin]);

    // Enable the plugin via config file
    writeFileSync(join(tmpDir, "optional-trigger.yaml"), "enabled: true");

    // Pre-register with the same ID to cause duplicate
    registry.register(manifest, new FakeTriggerPlugin());

    // Should not throw — warn and continue
    const result = await loadBuiltinPlugins(registry, tmpDir, observer);
    expect(result.loaded).toEqual([]);
    expect(result.failed).toEqual([{ id: "optional-trigger", reason: "initialization failed" }]);
  });

  it("loads and initializes a plugin successfully", async () => {
    const manifest = makeManifest({ id: "good-trigger", critical: false });
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => new FakeTriggerPlugin(),
    };
    setTestPlugins([plugin]);

    // Enable via config file
    writeFileSync(join(tmpDir, "good-trigger.yaml"), "poll_interval: 10s");

    await loadBuiltinPlugins(registry, tmpDir, observer);

    // Plugin should be registered and initialized
    const pluginInfo = registry.getPlugin("trigger", "good-trigger");
    expect(pluginInfo).not.toBeNull();
  });

  it("throws with cause when critical plugin create() fails", async () => {
    const manifest = makeManifest({ id: "broken-trigger", critical: true });
    const originalError = new Error("Constructor exploded");
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => {
        throw originalError;
      },
    };
    setTestPlugins([plugin]);
    writeFileSync(join(tmpDir, "broken-trigger.yaml"), "enabled: true");

    await expect(loadBuiltinPlugins(registry, tmpDir, observer)).rejects.toThrow(CRITICAL_CREATE_ERROR);

    try {
      await loadBuiltinPlugins(registry, tmpDir, observer);
    } catch (error) {
      expect((error as Error).cause).toBe(originalError);
    }
  });

  it("continues when non-critical plugin create() fails", async () => {
    const brokenManifest = makeManifest({ id: "broken-trigger", critical: false });
    const goodManifest = makeManifest({ id: "good-trigger", critical: false });
    setTestPlugins([
      {
        manifest: brokenManifest,
        create: () => {
          throw new Error("Constructor exploded");
        },
      },
      {
        manifest: goodManifest,
        create: () => new FakeTriggerPlugin(),
      },
    ]);
    writeFileSync(join(tmpDir, "broken-trigger.yaml"), "enabled: true");
    writeFileSync(join(tmpDir, "good-trigger.yaml"), "enabled: true");

    await loadBuiltinPlugins(registry, tmpDir, observer);

    // Broken plugin skipped, good plugin loaded
    expect(registry.getPlugin("trigger", "broken-trigger")).toBeNull();
    expect(registry.getPlugin("trigger", "good-trigger")).not.toBeNull();
  });

  it("preserves cause chain when critical plugin config loading fails", async () => {
    const manifest = makeManifest({ id: "bad-config", critical: true });
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => new FakeTriggerPlugin(),
    };
    setTestPlugins([plugin]);
    writeFileSync(join(tmpDir, "bad-config.yaml"), ":\ninvalid: [");

    try {
      await loadBuiltinPlugins(registry, tmpDir, observer);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(CRITICAL_CONFIG_ERROR);
      expect((error as Error).cause).toBeDefined();
    }
  });

  it("skips plugins without config files", async () => {
    const manifest = makeManifest({ id: "no-config", critical: false });
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => new FakeTriggerPlugin(),
    };
    setTestPlugins([plugin]);

    // No config file created — plugin should be skipped (not enabled)
    await loadBuiltinPlugins(registry, tmpDir, observer);

    const pluginInfo = registry.getPlugin("trigger", "no-config");
    expect(pluginInfo).toBeNull();
  });

  it("merges shared config by adapter type into plugin config", async () => {
    const manifest = makeManifest({ id: "comm-plugin", type: "communication", critical: false });
    const instance = new FakeTriggerPlugin(); // reuse — only init config capture matters
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => instance,
    };
    setTestPlugins([plugin]);

    writeFileSync(join(tmpDir, "comm-plugin.yaml"), "bot_token: abc123");

    await loadBuiltinPlugins(registry, tmpDir, observer, {
      communication: { people: [{ name: "Alice" }] },
    });

    const config = instance.getInitConfig();
    expect(config).not.toBeNull();
    expect(config!["bot_token"]).toBe("abc123");
    expect(config!["people"]).toEqual([{ name: "Alice" }]);
  });

  it("does not apply shared config to plugins of a different type", async () => {
    const manifest = makeManifest({ id: "trigger-plugin", type: "trigger", critical: false });
    const instance = new FakeTriggerPlugin();
    const plugin: BuiltinPlugin = {
      manifest,
      create: () => instance,
    };
    setTestPlugins([plugin]);

    writeFileSync(join(tmpDir, "trigger-plugin.yaml"), "poll_interval: 10s");

    await loadBuiltinPlugins(registry, tmpDir, observer, {
      communication: { people: [{ name: "Alice" }] },
    });

    const config = instance.getInitConfig();
    expect(config).not.toBeNull();
    expect(config!["people"]).toBeUndefined();
  });
});

describe("discoverEnabledPlugins", () => {
  it("returns empty array for non-existent directory", () => {
    const result = discoverEnabledPlugins("/nonexistent/path");
    expect(result).toEqual([]);
  });

  it("throws descriptive error when directory is unreadable", () => {
    // On macOS/Linux, /proc or a restricted directory will throw EACCES
    // Use a path that exists but cannot be read as a directory
    const filePath = join(mkdtempSync(join(tmpdir(), "discover-test-")), "not-a-dir");
    writeFileSync(filePath, "content");
    expect(() => discoverEnabledPlugins(filePath)).toThrow(PLUGIN_DIR_UNREADABLE);
  });
});
