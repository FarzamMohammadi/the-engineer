import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetOutput, createOutput } from "../output.js";
import { ALL_TEMPLATES } from "../templates.js";
import { runInit } from "./init.js";

let tempDir: string;
const NO_SEED = () => join(tempDir, "no-seed");
const OPTS = () => ({ force: false, seedDir: NO_SEED(), allPlugins: true });

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "init-test-"));
  createOutput({ mode: "quiet" });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetOutput();
  vi.restoreAllMocks();
});

describe("runInit", () => {
  it("creates all directories including installedPlugins", async () => {
    await runInit(tempDir, OPTS());
    expect(existsSync(join(tempDir, "config"))).toBe(true);
    expect(existsSync(join(tempDir, "config", "plugins"))).toBe(true);
    expect(existsSync(join(tempDir, "plugins"))).toBe(true);
    expect(existsSync(join(tempDir, "data"))).toBe(true);
    expect(existsSync(join(tempDir, "logs"))).toBe(true);
    expect(existsSync(join(tempDir, "run"))).toBe(true);
    expect(existsSync(join(tempDir, "workspaces"))).toBe(true);
  });

  it("creates core config template files", async () => {
    await runInit(tempDir, OPTS());
    // Core configs (non-plugin) should always be created
    const coreTemplates = ALL_TEMPLATES.filter((t) => !t.relativePath.includes("config/plugins/"));
    for (const template of coreTemplates) {
      const filePath = join(tempDir, template.relativePath);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it("template files have expected content", async () => {
    await runInit(tempDir, OPTS());
    const daemonContent = readFileSync(join(tempDir, "config", "daemon.yaml"), "utf8");
    expect(daemonContent).toContain("Daemon configuration");
    expect(daemonContent).toContain("tick_interval_ms");

    const peopleContent = readFileSync(join(tempDir, "config", "people.yaml"), "utf8");
    expect(peopleContent).toContain("people:");
    expect(peopleContent).toContain("roles: [owner]");
  });

  it("skips existing files without --force", async () => {
    await runInit(tempDir, OPTS());
    const filePath = join(tempDir, "config", "daemon.yaml");
    const existingContent = "# my custom config";
    writeFileSync(filePath, existingContent, "utf8");

    // Run again — should skip existing
    await runInit(tempDir, OPTS());
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe(existingContent);
  });

  it("overwrites existing files with --force", async () => {
    await runInit(tempDir, OPTS());
    const filePath = join(tempDir, "config", "daemon.yaml");
    writeFileSync(filePath, "# custom", "utf8");

    await runInit(tempDir, { force: true, seedDir: NO_SEED(), allPlugins: true });
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("Daemon configuration");
  });

  it("installs plugins to ~/.engineer/plugins/", async () => {
    await runInit(tempDir, OPTS());
    const pluginsDir = join(tempDir, "plugins");
    expect(existsSync(pluginsDir)).toBe(true);
  });
});
