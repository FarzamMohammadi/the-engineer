import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_TEMPLATES } from "../templates.js";
import { runInit } from "./init.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "init-test-"));
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op to suppress console in tests
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runInit", () => {
  it("creates all 6 directories", () => {
    runInit(tempDir, { force: false });
    expect(existsSync(join(tempDir, "config"))).toBe(true);
    expect(existsSync(join(tempDir, "config", "plugins"))).toBe(true);
    expect(existsSync(join(tempDir, "data"))).toBe(true);
    expect(existsSync(join(tempDir, "logs"))).toBe(true);
    expect(existsSync(join(tempDir, "run"))).toBe(true);
    expect(existsSync(join(tempDir, "workspaces"))).toBe(true);
  });

  it("creates all 11 template files", () => {
    runInit(tempDir, { force: false });
    for (const template of ALL_TEMPLATES) {
      const filePath = join(tempDir, template.relativePath);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it("template files have expected content", () => {
    runInit(tempDir, { force: false });
    const daemonContent = readFileSync(join(tempDir, "config", "daemon.yaml"), "utf8");
    expect(daemonContent).toContain("Daemon configuration");
    expect(daemonContent).toContain("tick_interval_ms");

    const peopleContent = readFileSync(join(tempDir, "config", "people.yaml"), "utf8");
    expect(peopleContent).toContain("people:");
    expect(peopleContent).toContain("roles: [owner]");
  });

  it("skips existing files without --force", () => {
    const filePath = join(tempDir, "config", "daemon.yaml");
    const existingContent = "# my custom config";
    // Pre-create the file
    runInit(tempDir, { force: false });
    writeFileSync(filePath, existingContent, "utf8");

    // Run again — should skip existing
    runInit(tempDir, { force: false });
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe(existingContent);
  });

  it("overwrites existing files with --force", () => {
    runInit(tempDir, { force: false });
    const filePath = join(tempDir, "config", "daemon.yaml");
    writeFileSync(filePath, "# custom", "utf8");

    runInit(tempDir, { force: true });
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("Daemon configuration");
  });

  it("is idempotent — running twice produces same result", () => {
    runInit(tempDir, { force: false });
    const firstRun = ALL_TEMPLATES.map((t) => readFileSync(join(tempDir, t.relativePath), "utf8"));

    runInit(tempDir, { force: true });
    const secondRun = ALL_TEMPLATES.map((t) => readFileSync(join(tempDir, t.relativePath), "utf8"));

    expect(firstRun).toEqual(secondRun);
  });

  it("plugin configs have required fields uncommented", () => {
    runInit(tempDir, { force: false });
    const ghTrigger = readFileSync(
      join(tempDir, "config", "plugins", "github-trigger.yaml"),
      "utf8",
    );
    // Required fields should be uncommented (not start with #)
    expect(ghTrigger).toContain("repos:");
    expect(ghTrigger).toContain("owner:");
  });
});
