import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DaemonConfigSchema, PeopleConfigSchema, SafetyConfigSchema } from "../schemas/config.js";
import {
  ConfigError,
  EnvVarError,
  ValidationError,
  getNumberPaths,
  loadConfig,
  loadConfigDir,
  loadConfigSafe,
  parseDurations,
  resolveEnvVars,
} from "./loader.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../test/fixtures/configs");
const fixture = (name: string) => path.join(FIXTURES_DIR, name);

// Temp directory for tests that write config files
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engineer-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── resolveEnvVars ───────────────────────────────────────────────────────────────

describe("resolveEnvVars", () => {
  it("resolves a single env var in a string", () => {
    vi.stubEnv("TEST_VAR", "hello");
    const result = resolveEnvVars("${TEST_VAR}", "test.yaml");
    expect(result).toBe("hello");
  });

  it("resolves multiple env vars in one string", () => {
    vi.stubEnv("SCHEME", "https");
    vi.stubEnv("HOST", "example.com");
    const result = resolveEnvVars("${SCHEME}://${HOST}", "test.yaml");
    expect(result).toBe("https://example.com");
  });

  it("leaves strings without env vars untouched", () => {
    const result = resolveEnvVars("plain string", "test.yaml");
    expect(result).toBe("plain string");
  });

  it("throws EnvVarError for undefined env var", () => {
    // biome-ignore lint/performance/noDelete: delete is required to truly unset env vars (assignment to undefined sets the string "undefined")
    delete process.env["NONEXISTENT_VAR"];
    expect(() => resolveEnvVars("${NONEXISTENT_VAR}", "test.yaml")).toThrow(EnvVarError);
    try {
      resolveEnvVars("${NONEXISTENT_VAR}", "test.yaml");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvVarError);
      const envError = error as EnvVarError;
      expect(envError.varName).toBe("NONEXISTENT_VAR");
      expect(envError.filePath).toBe("test.yaml");
      expect(envError.message).toContain("NONEXISTENT_VAR");
    }
  });

  it("passes numbers through unchanged", () => {
    expect(resolveEnvVars(42, "test.yaml")).toBe(42);
  });

  it("passes booleans through unchanged", () => {
    expect(resolveEnvVars(true, "test.yaml")).toBe(true);
  });

  it("passes null through unchanged", () => {
    expect(resolveEnvVars(null, "test.yaml")).toBeNull();
  });

  it("recurses into objects", () => {
    vi.stubEnv("INNER_VAR", "resolved");
    const result = resolveEnvVars({ nested: { value: "${INNER_VAR}" } }, "test.yaml");
    expect(result).toEqual({ nested: { value: "resolved" } });
  });

  it("recurses into arrays", () => {
    vi.stubEnv("ARR_VAR", "item");
    const result = resolveEnvVars(["${ARR_VAR}", "plain"], "test.yaml");
    expect(result).toEqual(["item", "plain"]);
  });

  it("handles mixed nested structures", () => {
    vi.stubEnv("MIX_VAR", "x");
    const result = resolveEnvVars({ arr: [{ val: "${MIX_VAR}" }], num: 5 }, "test.yaml");
    expect(result).toEqual({ arr: [{ val: "x" }], num: 5 });
  });
});

// ── getNumberPaths ───────────────────────────────────────────────────────────────

describe("getNumberPaths", () => {
  it("returns null for string-only schema", () => {
    const schema = z.object({ name: z.string() });
    expect(getNumberPaths(schema)).toBeNull();
  });

  it("finds top-level number fields", () => {
    const schema = z.object({
      count: z.number(),
      name: z.string(),
    });
    const result = getNumberPaths(schema);
    expect(result).toEqual({
      type: "object",
      children: { count: { type: "number" } },
    });
  });

  it("unwraps ZodDefault to find numbers", () => {
    const schema = z.object({
      timeout_ms: z.number().default(5000),
      label: z.string().default("hi"),
    });
    const result = getNumberPaths(schema);
    expect(result).toEqual({
      type: "object",
      children: { timeout_ms: { type: "number" } },
    });
  });

  it("unwraps ZodNullable to find numbers", () => {
    const schema = z.object({
      limit: z.number().nullable(),
    });
    const result = getNumberPaths(schema);
    expect(result).toEqual({
      type: "object",
      children: { limit: { type: "number" } },
    });
  });

  it("finds nested number fields", () => {
    const schema = z.object({
      logging: z.object({
        max_size: z.number(),
        level: z.string(),
      }),
    });
    const result = getNumberPaths(schema);
    expect(result).toEqual({
      type: "object",
      children: {
        logging: {
          type: "object",
          children: { max_size: { type: "number" } },
        },
      },
    });
  });

  it("handles ZodRecord with number values", () => {
    const schema = z.object({
      limits: z.record(z.number()),
    });
    const result = getNumberPaths(schema);
    expect(result).toEqual({
      type: "object",
      children: {
        limits: { type: "record", valueNode: { type: "number" } },
      },
    });
  });

  it("handles ZodRecord with object values containing numbers", () => {
    const schema = z.object({
      providers: z.record(
        z.object({
          timeout_ms: z.number(),
          name: z.string(),
        }),
      ),
    });
    const result = getNumberPaths(schema);
    expect(result).toEqual({
      type: "object",
      children: {
        providers: {
          type: "record",
          valueNode: {
            type: "object",
            children: { timeout_ms: { type: "number" } },
          },
        },
      },
    });
  });

  it("works with DaemonConfigSchema (real schema)", () => {
    const result = getNumberPaths(DaemonConfigSchema);
    expect(result).not.toBeNull();
    // Should find tick_interval_ms as a number path
    if (result && result.type === "object") {
      expect(result.children["tick_interval_ms"]).toEqual({ type: "number" });
      // logging.max_size_bytes should be nested
      const logging = result.children["logging"];
      expect(logging).toBeDefined();
      if (logging && logging.type === "object") {
        expect(logging.children["max_size_bytes"]).toEqual({ type: "number" });
        // logging.level is a string (enum) — should NOT be in the tree
        expect(logging.children["level"]).toBeUndefined();
      }
    }
  });
});

// ── parseDurations ───────────────────────────────────────────────────────────────

describe("parseDurations", () => {
  const simpleSchema = z.object({
    timeout_ms: z.number().default(5000),
    label: z.string().default("default"),
  });

  it("converts duration string to milliseconds for number field", () => {
    const result = parseDurations({ timeout_ms: "4h", label: "test" }, simpleSchema);
    expect(result).toEqual({ timeout_ms: 14_400_000, label: "test" });
  });

  it("converts various duration formats", () => {
    const schema = z.object({ ms: z.number() });
    expect(parseDurations({ ms: "30s" }, schema)).toEqual({ ms: 30_000 });
    expect(parseDurations({ ms: "2m" }, schema)).toEqual({ ms: 120_000 });
    expect(parseDurations({ ms: "1d" }, schema)).toEqual({ ms: 86_400_000 });
    expect(parseDurations({ ms: "10s" }, schema)).toEqual({ ms: 10_000 });
  });

  it("leaves string fields untouched", () => {
    const result = parseDurations({ timeout_ms: 5000, label: "UTC" }, simpleSchema);
    expect(result).toEqual({ timeout_ms: 5000, label: "UTC" });
  });

  it("leaves already-number values unchanged", () => {
    const result = parseDurations({ timeout_ms: 5000 }, simpleSchema);
    expect(result).toEqual({ timeout_ms: 5000 });
  });

  it("leaves unrecognized strings for Zod to reject", () => {
    const result = parseDurations({ timeout_ms: "not-a-duration" }, simpleSchema);
    expect(result).toEqual({ timeout_ms: "not-a-duration" });
  });

  it("handles nested duration fields", () => {
    const schema = z.object({
      notification: z.object({
        suppress_window_ms: z.number().default(300_000),
        channel: z.string().default("telegram"),
      }),
    });
    const result = parseDurations(
      { notification: { suppress_window_ms: "5m", channel: "telegram" } },
      schema,
    );
    expect(result).toEqual({
      notification: { suppress_window_ms: 300_000, channel: "telegram" },
    });
  });

  it("handles z.record() fields with duration values", () => {
    const schema = z.object({
      limits: z.record(z.number()),
    });
    const result = parseDurations({ limits: { a: "10s", b: "2m" } }, schema);
    expect(result).toEqual({ limits: { a: 10_000, b: 120_000 } });
  });

  it("returns data unchanged when schema has no number fields", () => {
    const schema = z.object({ name: z.string() });
    const data = { name: "test" };
    expect(parseDurations(data, schema)).toEqual(data);
  });

  it("handles null/undefined data gracefully", () => {
    const schema = z.object({ timeout_ms: z.number() });
    expect(parseDurations(null, schema)).toBeNull();
    expect(parseDurations(undefined, schema)).toBeUndefined();
  });
});

// ── loadConfig ───────────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  it("loads valid YAML file", () => {
    const result = loadConfig(fixture("valid-daemon.yaml"), DaemonConfigSchema);
    expect(result.source).toBe("file");
    expect(result.config.tick_interval_ms).toBe(10_000);
    expect(result.config.preemption_threshold).toBe(25);
    expect(result.config.logging.level).toBe("debug");
    expect(result.config.logging.console).toBe(true);
    // Defaults for unspecified fields
    expect(result.config.preemption_timeout_ms).toBe(60_000);
    expect(result.config.shutdown_timeout_ms).toBe(30_000);
  });

  it("returns all Zod defaults for missing file", () => {
    const result = loadConfig(path.join(tmpDir, "nonexistent.yaml"), DaemonConfigSchema);
    expect(result.source).toBe("defaults");
    expect(result.config.tick_interval_ms).toBe(5_000);
    expect(result.config.preemption_threshold).toBe(20);
    expect(result.config.logging.level).toBe("info");
  });

  it("returns all Zod defaults for empty file", () => {
    const result = loadConfig(fixture("empty.yaml"), DaemonConfigSchema);
    expect(result.source).toBe("file");
    expect(result.config.tick_interval_ms).toBe(5_000);
  });

  it("applies partial overrides while keeping defaults", () => {
    const yamlPath = path.join(tmpDir, "partial.yaml");
    fs.writeFileSync(yamlPath, "tick_interval_ms: 10000\n");
    const result = loadConfig(yamlPath, DaemonConfigSchema);
    expect(result.config.tick_interval_ms).toBe(10_000);
    expect(result.config.preemption_threshold).toBe(20);
  });

  it("loads SafetyConfig with overrides", () => {
    const result = loadConfig(fixture("valid-safety.yaml"), SafetyConfigSchema);
    expect(result.config.cost_limits.api.per_task.cost_usd).toBe(5.0);
    expect(result.config.cost_limits.api.daily.cost_usd).toBe(50.0);
    expect(result.config.scope.repos.allowed).toEqual(["owner/my-app", "owner/another-repo"]);
    expect(result.config.merge.auto_merge_after_approval.repos["owner/my-app"]).toBe(true);
    expect(result.config.merge.auto_merge_after_approval.default).toBe(false);
  });

  it("resolves env vars in YAML values", () => {
    vi.stubEnv("TEST_REPO_NAME", "owner/test-repo");
    vi.stubEnv("TEST_DOMAIN", "api.example.com");
    const result = loadConfig(fixture("env-vars.yaml"), SafetyConfigSchema);
    expect(result.config.scope.repos.allowed).toEqual(["owner/test-repo"]);
    expect(result.config.scope.external.allowed_domains).toEqual(["api.example.com"]);
  });

  it("parses duration strings in YAML values", () => {
    const result = loadConfig(fixture("durations.yaml"), DaemonConfigSchema);
    expect(result.config.tick_interval_ms).toBe(10_000);
    expect(result.config.preemption_timeout_ms).toBe(120_000);
    expect(result.config.stuck_threshold_ms).toBe(1_800_000);
    expect(result.config.max_active_duration_ms).toBe(28_800_000);
    expect(result.config.shutdown_timeout_ms).toBe(60_000);
  });

  it("throws ConfigError for malformed YAML", () => {
    expect(() => loadConfig(fixture("malformed.yaml"), DaemonConfigSchema)).toThrow(ConfigError);
  });

  it("throws ValidationError for wrong types", () => {
    try {
      loadConfig(fixture("invalid-wrong-type.yaml"), DaemonConfigSchema);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.zodError).toBeDefined();
      expect(validationError.filePath).toBe(fixture("invalid-wrong-type.yaml"));
    }
  });

  it("includes duration string hint for _ms field type errors", () => {
    const yamlPath = path.join(tmpDir, "bad-ms.yaml");
    fs.writeFileSync(yamlPath, "tick_interval_ms: not-a-number\n");
    try {
      loadConfig(yamlPath, DaemonConfigSchema);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("tick_interval_ms");
      expect(msg).toContain("duration strings");
    }
  });

  it("includes valid values for enum field errors", () => {
    const yamlPath = path.join(tmpDir, "bad-enum.yaml");
    fs.writeFileSync(yamlPath, "logging:\n  level: invalid_level\n");
    try {
      loadConfig(yamlPath, DaemonConfigSchema);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const msg = (error as ValidationError).message;
      expect(msg).toContain("logging.level");
      expect(msg).toContain("valid values:");
      expect(msg).toContain("info");
    }
  });

  it("throws EnvVarError for undefined env vars", () => {
    const yamlPath = path.join(tmpDir, "bad-env.yaml");
    fs.writeFileSync(yamlPath, 'scope:\n  repos:\n    allowed:\n      - "${UNDEFINED_VAR}"\n');
    expect(() => loadConfig(yamlPath, SafetyConfigSchema)).toThrow(EnvVarError);
  });

  it("includes filePath in all error types", () => {
    const yamlPath = path.join(tmpDir, "test-path.yaml");
    fs.writeFileSync(yamlPath, "tick_interval_ms: not-valid\n");
    try {
      loadConfig(yamlPath, DaemonConfigSchema);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).filePath).toBe(yamlPath);
    }
  });
});

// ── loadConfigSafe ───────────────────────────────────────────────────────────────

describe("loadConfigSafe", () => {
  it("returns ok result for valid config", () => {
    const result = loadConfigSafe(fixture("valid-daemon.yaml"), DaemonConfigSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tick_interval_ms).toBe(10_000);
    }
  });

  it("returns error result for invalid config", () => {
    const result = loadConfigSafe(fixture("malformed.yaml"), DaemonConfigSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });

  it("returns ok result with defaults for missing file", () => {
    const result = loadConfigSafe(path.join(tmpDir, "missing.yaml"), DaemonConfigSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tick_interval_ms).toBe(5_000);
    }
  });

  it("returns error result for undefined env vars", () => {
    const yamlPath = path.join(tmpDir, "bad-env.yaml");
    fs.writeFileSync(yamlPath, 'scope:\n  repos:\n    allowed:\n      - "${NO_SUCH_VAR}"\n');
    const result = loadConfigSafe(yamlPath, SafetyConfigSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EnvVarError);
    }
  });
});

// ── PeopleConfig ─────────────────────────────────────────────────────────────────

describe("PeopleConfig loading", () => {
  it("loads people.yaml with person entries", () => {
    const result = loadConfig(fixture("valid-people.yaml"), PeopleConfigSchema);
    expect(result.config.people).toHaveLength(2);
    expect(result.config.people[0]?.id).toBe("farzam");
    expect(result.config.people[0]?.name).toBe("Farzam Mohammadi");
    expect(result.config.people[0]?.roles).toEqual(["owner", "reviewer"]);
    expect(result.config.people[0]?.contacts).toHaveLength(2);
    expect(result.config.people[0]?.preferences.notification_level).toBe("milestones");
    expect(result.config.people[0]?.preferences.quiet_hours).toBeNull();

    expect(result.config.people[1]?.id).toBe("alice");
    expect(result.config.people[1]?.preferences.quiet_hours).toEqual({
      start: "22:00",
      end: "08:00",
    });
  });

  it("returns empty array for missing people.yaml", () => {
    const result = loadConfig(path.join(tmpDir, "people.yaml"), PeopleConfigSchema);
    expect(result.source).toBe("defaults");
    expect(result.config.people).toEqual([]);
  });

  it("returns empty array for empty people.yaml", () => {
    const result = loadConfig(fixture("empty.yaml"), PeopleConfigSchema);
    expect(result.config.people).toEqual([]);
  });
});

// ── loadConfigDir ────────────────────────────────────────────────────────────────

describe("loadConfigDir", () => {
  it("loads all configs from directory with defaults for missing files", () => {
    // Empty dir — all files missing, all defaults
    const result = loadConfigDir(tmpDir);
    expect(result.bundle.daemon.tick_interval_ms).toBe(5_000);
    expect(result.bundle.orchestrator.fast_path.enabled).toBe(true);
    expect(result.bundle.workspace.branch_prefix).toBe("engineer/");
    expect(result.bundle.safety.merge.auto_merge_after_approval.default).toBe(false);
    expect(result.bundle.people).toEqual([]);
  });

  it("returns warnings for missing safety.yaml", () => {
    const result = loadConfigDir(tmpDir);
    const safetyWarning = result.warnings.find((w) => w.file === "safety.yaml");
    expect(safetyWarning).toBeDefined();
    expect(safetyWarning?.message).toContain("conservative defaults");
  });

  it("returns warnings for missing people.yaml", () => {
    const result = loadConfigDir(tmpDir);
    const peopleWarning = result.warnings.find((w) => w.file === "people.yaml");
    expect(peopleWarning).toBeDefined();
    expect(peopleWarning?.message).toContain("no people configured");
  });

  it("does not warn when safety.yaml exists", () => {
    fs.copyFileSync(fixture("valid-safety.yaml"), path.join(tmpDir, "safety.yaml"));
    const result = loadConfigDir(tmpDir);
    const safetyWarning = result.warnings.find((w) => w.file === "safety.yaml");
    expect(safetyWarning).toBeUndefined();
  });

  it("loads mixed present and missing config files", () => {
    fs.copyFileSync(fixture("valid-daemon.yaml"), path.join(tmpDir, "daemon.yaml"));
    fs.copyFileSync(fixture("valid-safety.yaml"), path.join(tmpDir, "safety.yaml"));
    const result = loadConfigDir(tmpDir);
    // daemon from file
    expect(result.bundle.daemon.tick_interval_ms).toBe(10_000);
    // orchestrator from defaults (missing file)
    expect(result.bundle.orchestrator.fast_path.enabled).toBe(true);
    // safety from file
    expect(result.bundle.safety.cost_limits.api.per_task.cost_usd).toBe(5.0);
    // No safety warning
    expect(result.warnings.find((w) => w.file === "safety.yaml")).toBeUndefined();
    // People warning (missing)
    expect(result.warnings.find((w) => w.file === "people.yaml")).toBeDefined();
  });

  it("throws on invalid config file", () => {
    fs.copyFileSync(fixture("malformed.yaml"), path.join(tmpDir, "daemon.yaml"));
    expect(() => loadConfigDir(tmpDir)).toThrow(ConfigError);
  });

  it("uses ENGINEER_CONFIG_DIR env var when no argument provided", () => {
    vi.stubEnv("ENGINEER_CONFIG_DIR", tmpDir);
    const result = loadConfigDir();
    expect(result.bundle.daemon.tick_interval_ms).toBe(5_000);
  });

  it("loads people from people.yaml", () => {
    fs.copyFileSync(fixture("valid-people.yaml"), path.join(tmpDir, "people.yaml"));
    const result = loadConfigDir(tmpDir);
    expect(result.bundle.people).toHaveLength(2);
    expect(result.bundle.people[0]?.id).toBe("farzam");
  });
});
