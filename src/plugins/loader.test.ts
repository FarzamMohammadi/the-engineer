import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeTriggerPlugin } from "../../test/helpers/fake-plugins/fake-trigger/index.js";
import { createTestObserverFacade } from "../../test/helpers/test-observer-facade.js";
import { EventBus } from "../core/event-bus/index.js";
import { Registry } from "../core/registry/index.js";
import { createInMemoryDatabase } from "../db/database.js";
import type { DatabaseHandle } from "../db/database.js";
import type { PluginManifest } from "../schemas/adapters.js";
import { PluginManifestSchema } from "../schemas/adapters.js";
import type { BuiltinPlugin } from "./builtin.js";

// Mock BUILTIN_PLUGINS so we control what plugins are "discovered"
vi.mock("./builtin.js", () => ({
  // Start empty — each test populates via setTestPlugins()
  BUILTIN_PLUGINS: [] as BuiltinPlugin[],
}));

import { BUILTIN_PLUGINS } from "./builtin.js";
import { loadBuiltinPlugins } from "./loader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const CRITICAL_REGISTRATION_ERROR = /Critical plugin "critical-trigger" failed to register/;

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

    await expect(loadBuiltinPlugins(registry, tmpDir, observer)).rejects.toThrow(
      CRITICAL_REGISTRATION_ERROR,
    );
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
    await expect(loadBuiltinPlugins(registry, tmpDir, observer)).resolves.toBeUndefined();
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
});
