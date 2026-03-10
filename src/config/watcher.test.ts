import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createConfigWatcher } from "./watcher.js";

// ── Test Schema ──────────────────────────────────────────────────────────────────

const TestConfigSchema = z.object({
  timeout_ms: z.number().int().positive().default(5_000),
  enabled: z.boolean().default(true),
  label: z.string().default("default"),
});

// ── Helpers ──────────────────────────────────────────────────────────────────────

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-watcher-test-"));
  configPath = path.join(tmpDir, "test-config.yaml");
  // Create initial config file — watcher needs a file to watch
  fs.writeFileSync(configPath, "timeout_ms: 5000\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function waitForCallback<T>(timeoutMs = 2000): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => {
    // biome-ignore lint/style/noNonNullAssertion: reject is assigned in the Promise constructor
    reject!(new Error(`Callback not called within ${timeoutMs}ms`));
  }, timeoutMs);
  // Clear timeout when promise resolves to avoid dangling timers
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op catch for cleanup timer
  promise.then(() => clearTimeout(timer)).catch(() => {});
  // biome-ignore lint/style/noNonNullAssertion: resolve is assigned in the Promise constructor
  return { promise, resolve: resolve! };
}

// Small delay to let fs.watch() initialize before writing
const waitForWatcherReady = () => new Promise((resolve) => setTimeout(resolve, 50));

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("createConfigWatcher", () => {
  it("calls onChange with valid config after file change", async () => {
    const { promise, resolve } = waitForCallback<unknown>();
    const handle = createConfigWatcher(configPath, TestConfigSchema, (result) => {
      resolve(result);
    });

    try {
      await waitForWatcherReady();
      fs.writeFileSync(configPath, "timeout_ms: 10000\n");

      const result = await promise;
      expect(result).toEqual({
        ok: true,
        config: { timeout_ms: 10_000, enabled: true, label: "default" },
      });
    } finally {
      handle.stop();
    }
  });

  it("calls onChange with error for invalid config", async () => {
    const { promise, resolve } = waitForCallback<unknown>();
    const handle = createConfigWatcher(configPath, TestConfigSchema, (result) => {
      resolve(result);
    });

    try {
      await waitForWatcherReady();
      fs.writeFileSync(configPath, "timeout_ms: -1\n");

      const result = await promise;
      expect(result).toHaveProperty("ok", false);
      if (typeof result === "object" && result !== null && "ok" in result && !result.ok) {
        expect(result).toHaveProperty("error");
      }
    } finally {
      handle.stop();
    }
  });

  it("debounces rapid writes into a single callback", async () => {
    const calls: unknown[] = [];
    const { promise, resolve } = waitForCallback<void>();

    const handle = createConfigWatcher(configPath, TestConfigSchema, (result) => {
      calls.push(result);
      // After first callback, give a bit of time to see if more arrive
      setTimeout(() => {
        resolve();
      }, 200);
    });

    try {
      await waitForWatcherReady();
      // Rapid writes — should be debounced into one callback
      fs.writeFileSync(configPath, "timeout_ms: 1000\n");
      fs.writeFileSync(configPath, "timeout_ms: 2000\n");
      fs.writeFileSync(configPath, "timeout_ms: 3000\n");

      await promise;

      // Should only have received one callback (the debounced one)
      expect(calls).toHaveLength(1);
      const result = calls[0];
      if (typeof result === "object" && result !== null && "ok" in result && result.ok) {
        expect(result).toHaveProperty("config");
        const config = (result as { ok: true; config: { timeout_ms: number } }).config;
        // The final write should be the one that gets loaded
        expect(config.timeout_ms).toBe(3_000);
      }
    } finally {
      handle.stop();
    }
  });

  it("stop() prevents further callbacks", async () => {
    const calls: unknown[] = [];
    const handle = createConfigWatcher(configPath, TestConfigSchema, (result) => {
      calls.push(result);
    });

    // Stop immediately
    handle.stop();

    // Write to the file
    fs.writeFileSync(configPath, "timeout_ms: 9999\n");

    // Wait enough time for debounce + callback
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });

    expect(calls).toHaveLength(0);
  });

  it("stop() is idempotent", () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op callback for stop test
    const handle = createConfigWatcher(configPath, TestConfigSchema, () => {});
    handle.stop();
    // Second call should not throw
    expect(() => {
      handle.stop();
    }).not.toThrow();
  });

  it("stop() clears pending debounce timers", async () => {
    const calls: unknown[] = [];
    const handle = createConfigWatcher(configPath, TestConfigSchema, (result) => {
      calls.push(result);
    });

    // Trigger a change (starts debounce timer)
    fs.writeFileSync(configPath, "timeout_ms: 7777\n");

    // Stop before debounce fires (debounce is 500ms)
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    handle.stop();

    // Wait for what would have been the debounce period
    await new Promise((resolve) => {
      setTimeout(resolve, 600);
    });

    // Callback should never have been called
    expect(calls).toHaveLength(0);
  });
});
