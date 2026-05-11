import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigReloadResult } from "../../src/config/loader.js";
import { type WatcherHandle, createConfigWatcher } from "../../src/config/watcher.js";
import type { SafetyConfig } from "../../src/schemas/config.js";
import { SafetyConfigSchema } from "../../src/schemas/config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll until predicate returns true, or timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
}

describe("Config hot-reload (integration)", () => {
  let tmpDir: string;
  let watcher: WatcherHandle | null = null;

  function setupDir(): string {
    tmpDir = join(tmpdir(), `engineer-config-test-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("detects config file changes and reloads", async () => {
    const dir = setupDir();
    const filePath = join(dir, "safety.yaml");

    // Write initial config (matches SafetyConfigSchema: cost_limits.daily.cost_usd)
    writeFileSync(filePath, "cost_limits:\n  daily:\n    cost_usd: 10\n");

    const results: ConfigReloadResult<SafetyConfig>[] = [];

    watcher = createConfigWatcher(filePath, SafetyConfigSchema, (result) => {
      results.push(result);
    });

    // Give fs.watch time to register with the OS before modifying the file
    await sleep(200);

    // Modify the file
    writeFileSync(filePath, "cost_limits:\n  daily:\n    cost_usd: 20\n");

    // Wait for debounce (500ms) + OS file watch latency (can be slow on macOS)
    await waitFor(() => results.length > 0, 3_000);

    expect(results.length).toBeGreaterThanOrEqual(1);

    const lastResult = results[results.length - 1];
    expect(lastResult?.ok).toBe(true);
    if (lastResult?.ok) {
      expect(lastResult.config.cost_limits.daily.cost_usd).toBe(20);
    }
  });

  it("reports error on invalid YAML change", async () => {
    const dir = setupDir();
    const filePath = join(dir, "safety.yaml");

    // Write valid config (matches SafetyConfigSchema)
    writeFileSync(filePath, "cost_limits:\n  api:\n    daily:\n      cost_usd: 10\n");

    const results: ConfigReloadResult<SafetyConfig>[] = [];

    watcher = createConfigWatcher(filePath, SafetyConfigSchema, (result) => {
      results.push(result);
    });

    // Give fs.watch time to register with the OS
    await sleep(200);

    // Write invalid content
    writeFileSync(filePath, "{{invalid yaml!!");

    // Wait for debounce + OS latency
    await waitFor(() => results.length > 0, 3_000);

    const errorResults = results.filter((r) => !r.ok);
    expect(errorResults.length).toBeGreaterThanOrEqual(1);
  });
});
