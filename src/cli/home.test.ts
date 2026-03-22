import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDirectories, resolveEngineerHome } from "./home.js";

describe("resolveEngineerHome", () => {
  const originalEnv = process.env["ENGINEER_HOME"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["ENGINEER_HOME"];
    } else {
      process.env["ENGINEER_HOME"] = originalEnv;
    }
  });

  it("returns flag value when provided", () => {
    process.env["ENGINEER_HOME"] = "/from-env";
    expect(resolveEngineerHome("/from-flag")).toBe("/from-flag");
  });

  it("returns ENGINEER_HOME env var when no flag", () => {
    process.env["ENGINEER_HOME"] = "/from-env";
    expect(resolveEngineerHome()).toBe("/from-env");
  });

  it("returns ~/.engineer when no flag and no env var", () => {
    delete process.env["ENGINEER_HOME"];
    expect(resolveEngineerHome()).toBe(join(homedir(), ".engineer"));
  });

  it("prefers flag over env var", () => {
    process.env["ENGINEER_HOME"] = "/from-env";
    expect(resolveEngineerHome("/from-flag")).toBe("/from-flag");
  });

  it("ignores empty string flag (falsy)", () => {
    process.env["ENGINEER_HOME"] = "/from-env";
    expect(resolveEngineerHome("")).toBe("/from-env");
  });
});

describe("resolveDirectories", () => {
  it("returns all standard subdirectory paths", () => {
    const dirs = resolveDirectories("/home/user/.engineer");
    expect(dirs.config).toBe("/home/user/.engineer/config");
    expect(dirs.plugins).toBe("/home/user/.engineer/config/plugins");
    expect(dirs.data).toBe("/home/user/.engineer/data");
    expect(dirs.logs).toBe("/home/user/.engineer/logs");
    expect(dirs.run).toBe("/home/user/.engineer/run");
    expect(dirs.workspaces).toBe("/home/user/.engineer/workspaces");
  });

  it("handles trailing slash in input", () => {
    const dirs = resolveDirectories("/tmp/test");
    expect(dirs.config).toBe("/tmp/test/config");
  });
});
