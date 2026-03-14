import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetOutput, createOutput } from "../output.js";
import { runConfigValidate } from "./config-validate.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "config-validate-test-"));
  createOutput({ mode: "quiet" });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetOutput();
  vi.restoreAllMocks();
});

describe("runConfigValidate", () => {
  it("returns 1 when config directory does not exist", () => {
    const code = runConfigValidate(join(tempDir, "nonexistent"));
    expect(code).toBe(1);
  });

  it("returns 0 with valid empty config files", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    for (const name of [
      "daemon.yaml",
      "orchestrator.yaml",
      "safety.yaml",
      "workspace.yaml",
      "people.yaml",
    ]) {
      writeFileSync(join(configDir, name), "# empty", "utf8");
    }
    const code = runConfigValidate(tempDir);
    expect(code).toBe(0);
  });

  it("returns 1 with invalid config", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "daemon.yaml"), "tick_interval_ms: -1", "utf8");
    writeFileSync(join(configDir, "orchestrator.yaml"), "# ok", "utf8");
    writeFileSync(join(configDir, "safety.yaml"), "# ok", "utf8");
    writeFileSync(join(configDir, "workspace.yaml"), "# ok", "utf8");
    writeFileSync(join(configDir, "people.yaml"), "# ok", "utf8");
    const code = runConfigValidate(tempDir);
    expect(code).toBe(1);
  });

  it("reports missing files as warnings (not failures)", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    // Only create some files
    writeFileSync(join(configDir, "daemon.yaml"), "# ok", "utf8");
    const code = runConfigValidate(tempDir);
    // Missing files get warnings but don't cause failure
    expect(code).toBe(0);
  });
});
