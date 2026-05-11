import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkEnvFilePermissions,
  loadEnvFile,
  parseEnvFile,
  serializeEnvFile,
  writeEnvFile,
} from "../../../src/config/env.js";

// ── parseEnvFile ─────────────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses KEY=VALUE", () => {
    expect(parseEnvFile("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("parses multiple lines", () => {
    expect(parseEnvFile("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  it("skips comments", () => {
    expect(parseEnvFile("# comment\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  it("skips blank lines", () => {
    expect(parseEnvFile("\n\nFOO=bar\n\n")).toEqual({ FOO: "bar" });
  });

  it("strips double quotes", () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  it("strips single quotes", () => {
    expect(parseEnvFile("FOO='hello world'")).toEqual({ FOO: "hello world" });
  });

  it("handles equals sign in value", () => {
    expect(parseEnvFile("FOO=a=b=c")).toEqual({ FOO: "a=b=c" });
  });

  it("handles empty value", () => {
    expect(parseEnvFile("FOO=")).toEqual({ FOO: "" });
  });

  it("ignores lines without equals", () => {
    expect(parseEnvFile("NOEQ")).toEqual({});
  });
});

// ── serializeEnvFile ─────────────────────────────────────────────────────────

describe("serializeEnvFile", () => {
  it("serializes simple values", () => {
    const result = serializeEnvFile({ FOO: "bar" });
    expect(result).toContain("FOO=bar");
  });

  it("quotes values with spaces", () => {
    const result = serializeEnvFile({ FOO: "hello world" });
    expect(result).toContain('FOO="hello world"');
  });

  it("adds header comment", () => {
    const result = serializeEnvFile({ A: "1" });
    expect(result).toMatch(/^#/);
  });

  it("round-trips with parseEnvFile", () => {
    const original = { GITHUB_TOKEN: "ghp_abc123", CHAT_ID: "12345" };
    const serialized = serializeEnvFile(original);
    const parsed = parseEnvFile(serialized);
    expect(parsed).toEqual(original);
  });
});

// ── loadEnvFile ──────────────────────────────────────────────────────────────

describe("loadEnvFile", () => {
  let tmpHome: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "engineer-env-test-"));
    // Save original env
    originalEnv["TEST_LOAD_VAR"] = process.env["TEST_LOAD_VAR"];
    originalEnv["TEST_EXISTING_VAR"] = process.env["TEST_EXISTING_VAR"];
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    // Restore original env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("loads vars into process.env", () => {
    writeFileSync(join(tmpHome, ".env"), "TEST_LOAD_VAR=loaded_value", { mode: 0o600 });
    delete process.env["TEST_LOAD_VAR"];

    const loaded = loadEnvFile(tmpHome);

    expect(process.env["TEST_LOAD_VAR"]).toBe("loaded_value");
    expect(loaded.has("TEST_LOAD_VAR")).toBe(true);
  });

  it("does not overwrite existing env vars", () => {
    writeFileSync(join(tmpHome, ".env"), "TEST_EXISTING_VAR=from_file", { mode: 0o600 });
    process.env["TEST_EXISTING_VAR"] = "from_env";

    const loaded = loadEnvFile(tmpHome);

    expect(process.env["TEST_EXISTING_VAR"]).toBe("from_env");
    expect(loaded.has("TEST_EXISTING_VAR")).toBe(false);
  });

  it("returns empty set if file does not exist", () => {
    const loaded = loadEnvFile(tmpHome);
    expect(loaded.size).toBe(0);
  });
});

// ── writeEnvFile ─────────────────────────────────────────────────────────────

describe("writeEnvFile", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "engineer-env-test-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates file with 0o600 permissions", () => {
    writeEnvFile(tmpHome, { TOKEN: "secret" });
    const filePath = join(tmpHome, ".env");
    expect(existsSync(filePath)).toBe(true);
    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("writes key=value content", () => {
    writeEnvFile(tmpHome, { MY_TOKEN: "abc123" });
    const content = readFileSync(join(tmpHome, ".env"), "utf8");
    expect(content).toContain("MY_TOKEN=abc123");
  });

  it("merges with existing file", () => {
    writeEnvFile(tmpHome, { A: "1" });
    writeEnvFile(tmpHome, { B: "2" });
    const content = readFileSync(join(tmpHome, ".env"), "utf8");
    expect(content).toContain("A=1");
    expect(content).toContain("B=2");
  });

  it("overwrites existing key with new value", () => {
    writeEnvFile(tmpHome, { A: "old" });
    writeEnvFile(tmpHome, { A: "new" });
    const parsed = parseEnvFile(readFileSync(join(tmpHome, ".env"), "utf8"));
    expect(parsed["A"]).toBe("new");
  });
});

// ── checkEnvFilePermissions ──────────────────────────────────────────────────

describe("checkEnvFilePermissions", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "engineer-env-test-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null for correct permissions (0o600)", () => {
    writeFileSync(join(tmpHome, ".env"), "TOKEN=x", { mode: 0o600 });
    expect(checkEnvFilePermissions(tmpHome)).toBeNull();
  });

  it("returns warning for world-readable (0o644)", () => {
    writeFileSync(join(tmpHome, ".env"), "TOKEN=x", { mode: 0o644 });
    const warning = checkEnvFilePermissions(tmpHome);
    expect(warning).toContain("permissive");
  });

  it("returns null if file does not exist", () => {
    expect(checkEnvFilePermissions(tmpHome)).toBeNull();
  });
});
