import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type DoctorCategory,
  checkConfigFiles,
  checkDataDirectory,
  checkDatabase,
  checkGitHubConnectivity,
  checkNodeRuntime,
  checkPluginManifests,
  checkRequiredSecrets,
  checkRiskyConfig,
  checkTelegramConnectivity,
  checkWorkspace,
  computeExitCode,
  formatDoctorResults,
  runAllChecks,
  runPreFlightChecks,
} from "./doctor.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Category 1: Node.js Runtime ───────────────────────────────────────────

describe("checkNodeRuntime", () => {
  it("passes on current Node.js (22+)", () => {
    const result = checkNodeRuntime();
    expect(result.category).toBe("Node.js Runtime");
    expect(result.checks[0]?.status).toBe("pass");
  });
});

// ── Category 2: Data Directory ────────────────────────────────────────────

describe("checkDataDirectory", () => {
  it("fails when ENGINEER_HOME does not exist", () => {
    const result = checkDataDirectory("/nonexistent/path");
    expect(result.checks.some((c) => c.status === "fail")).toBe(true);
  });

  it("passes when ENGINEER_HOME exists and is writable", () => {
    const result = checkDataDirectory(tempDir);
    expect(result.checks[0]?.status).toBe("pass");
  });

  it("warns when subdirectories are missing", () => {
    const result = checkDataDirectory(tempDir);
    const warnings = result.checks.filter((c) => c.status === "warn");
    // config, plugins, data, logs, run, workspaces — all missing
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("passes when all subdirectories exist", () => {
    for (const sub of ["config", "config/plugins", "data", "logs", "run", "workspaces"]) {
      mkdirSync(join(tempDir, sub), { recursive: true });
    }
    const result = checkDataDirectory(tempDir);
    const failures = result.checks.filter((c) => c.status === "fail");
    expect(failures).toHaveLength(0);
  });
});

// ── Category 3: Config Files ──────────────────────────────────────────────

describe("checkConfigFiles", () => {
  it("warns when config files are missing", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    const result = checkConfigFiles(configDir);
    const warnings = result.checks.filter((c) => c.status === "warn");
    // All 5 configs missing
    expect(warnings.length).toBe(5);
  });

  it("passes with valid empty configs (Zod defaults)", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    // Empty YAML files → Zod defaults apply
    for (const name of [
      "daemon.yaml",
      "orchestrator.yaml",
      "safety.yaml",
      "workspace.yaml",
      "people.yaml",
    ]) {
      writeFileSync(join(configDir, name), "# empty", "utf8");
    }
    const result = checkConfigFiles(configDir);
    const passes = result.checks.filter((c) => c.status === "pass");
    expect(passes.length).toBe(5);
  });

  it("fails with invalid YAML", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "daemon.yaml"), "tick_interval_ms: not_a_number", "utf8");
    const result = checkConfigFiles(configDir);
    const failure = result.checks.find((c) => c.label === "daemon.yaml");
    expect(failure?.status).toBe("fail");
  });
});

// ── Category 4: Required Secrets ──────────────────────────────────────────

describe("checkRequiredSecrets", () => {
  it("warns when config directory does not exist", () => {
    const result = checkRequiredSecrets("/nonexistent");
    expect(result.checks[0]?.status).toBe("warn");
  });

  it("passes when no env var references exist", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.yaml"), "key: value", "utf8");
    const result = checkRequiredSecrets(configDir);
    expect(result.checks[0]?.status).toBe("pass");
  });

  it("fails when referenced env var is missing", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.yaml"), 'token: "${NONEXISTENT_SECRET_12345}"', "utf8");
    const result = checkRequiredSecrets(configDir);
    const failure = result.checks.find((c) => c.status === "fail");
    expect(failure).toBeDefined();
    expect(failure?.label).toBe("NONEXISTENT_SECRET_12345");
  });

  it("passes when referenced env var is set", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.yaml"), 'path: "${HOME}"', "utf8");
    const result = checkRequiredSecrets(configDir);
    const homeCheck = result.checks.find((c) => c.label === "HOME");
    expect(homeCheck?.status).toBe("pass");
  });
});

// ── Category 5: Database ──────────────────────────────────────────────────

describe("checkDatabase", () => {
  it("warns when database file does not exist", () => {
    const result = checkDatabase(tempDir);
    expect(result.checks[0]?.status).toBe("warn");
  });

  it("passes when database file is accessible", () => {
    mkdirSync(join(tempDir, "data"), { recursive: true });
    writeFileSync(join(tempDir, "data", "engineer.db"), "", "utf8");
    const result = checkDatabase(tempDir);
    expect(result.checks[0]?.status).toBe("pass");
  });
});

// ── Category 6: Plugin Manifests ──────────────────────────────────────────

describe("checkPluginManifests", () => {
  it("finds built-in plugins in src/plugins", () => {
    // checkPluginManifests scans both <engineerHome>/plugins and src/plugins (relative).
    // Since src/plugins now contains real built-in plugins (bash-tool, claude-code-llm),
    // it finds them and returns pass instead of warn.
    const result = checkPluginManifests(tempDir);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });
});

// ── Category 7 & 8: Connectivity stubs ────────────────────────────────────

describe("checkGitHubConnectivity", () => {
  it("returns warn stub", () => {
    const result = checkGitHubConnectivity();
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.message).toContain("not yet implemented");
  });
});

describe("checkTelegramConnectivity", () => {
  it("returns warn stub", () => {
    const result = checkTelegramConnectivity();
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.message).toContain("not yet implemented");
  });
});

// ── Category 9: Workspace ─────────────────────────────────────────────────

describe("checkWorkspace", () => {
  it("checks git binary availability", () => {
    const result = checkWorkspace(tempDir);
    const gitCheck = result.checks.find((c) => c.label === "Git binary");
    // git should be available in the test environment
    expect(gitCheck?.status).toBe("pass");
  });

  it("warns when workspace directory does not exist", () => {
    const result = checkWorkspace(tempDir);
    const wsCheck = result.checks.find((c) => c.label === "Workspace directory");
    expect(wsCheck?.status).toBe("warn");
  });
});

// ── Category 10: Risky Config ─────────────────────────────────────────────

describe("checkRiskyConfig", () => {
  it("passes with safe defaults", () => {
    const bundle = makeSafeBundle();
    const result = checkRiskyConfig(bundle);
    // No cost limits set warns, but auto-merge is off
    const autoMergeChecks = result.checks.filter((c) => c.label.startsWith("Auto-merge"));
    expect(autoMergeChecks).toHaveLength(0);
  });

  it("warns when auto-merge is enabled by default", () => {
    const bundle = makeSafeBundle();
    bundle.safety.merge.auto_merge.default = true;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Auto-merge");
    expect(warn?.status).toBe("warn");
  });

  it("warns when no cost limits are set", () => {
    const bundle = makeSafeBundle();
    const result = checkRiskyConfig(bundle);
    const costWarn = result.checks.find((c) => c.label === "Cost limits");
    expect(costWarn?.status).toBe("warn");
  });
});

// ── Aggregation ───────────────────────────────────────────────────────────

describe("computeExitCode", () => {
  it("returns 0 when all pass", () => {
    const cats: DoctorCategory[] = [
      { category: "Test", checks: [{ label: "ok", status: "pass", message: "good" }] },
    ];
    expect(computeExitCode(cats)).toBe(0);
  });

  it("returns 1 when any fail", () => {
    const cats: DoctorCategory[] = [
      { category: "Test", checks: [{ label: "bad", status: "fail", message: "broken" }] },
    ];
    expect(computeExitCode(cats)).toBe(1);
  });

  it("returns 2 when warnings only", () => {
    const cats: DoctorCategory[] = [
      { category: "Test", checks: [{ label: "meh", status: "warn", message: "iffy" }] },
    ];
    expect(computeExitCode(cats)).toBe(2);
  });

  it("fail takes precedence over warn", () => {
    const cats: DoctorCategory[] = [
      {
        category: "Test",
        checks: [
          { label: "bad", status: "fail", message: "broken" },
          { label: "meh", status: "warn", message: "iffy" },
        ],
      },
    ];
    expect(computeExitCode(cats)).toBe(1);
  });
});

describe("formatDoctorResults", () => {
  it("includes category names and check labels", () => {
    const cats: DoctorCategory[] = [
      { category: "My Category", checks: [{ label: "check1", status: "pass", message: "ok" }] },
    ];
    const output = formatDoctorResults(cats);
    expect(output).toContain("My Category");
    expect(output).toContain("check1");
    expect(output).toContain("✓");
  });

  it("includes remedy for failed checks", () => {
    const cats: DoctorCategory[] = [
      {
        category: "Fixes",
        checks: [{ label: "broken", status: "fail", message: "bad", remedy: "do this" }],
      },
    ];
    const output = formatDoctorResults(cats);
    expect(output).toContain("do this");
  });
});

describe("runPreFlightChecks", () => {
  it("runs exactly 6 categories", () => {
    const results = runPreFlightChecks(tempDir);
    expect(results).toHaveLength(6);
  });
});

describe("runAllChecks", () => {
  it("runs 9 categories without bundle", () => {
    const results = runAllChecks(tempDir);
    expect(results).toHaveLength(9);
  });

  it("runs 10 categories with bundle", () => {
    const results = runAllChecks(tempDir, makeSafeBundle());
    expect(results).toHaveLength(10);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makeSafeBundle() {
  return {
    daemon: {
      max_concurrent: 1,
      tick_interval_ms: 5000,
      preemption_threshold: 20,
      preemption_timeout_ms: 60000,
      stuck_threshold_ms: 1800000,
      max_active_duration_ms: 28800000,
      aging_threshold_ms: 86400000,
      aging_increment: 5,
      aging_interval_ms: 86400000,
      aging_cap: 75,
      shutdown_timeout_ms: 30000,
      trigger_poll_interval_ms: 30000,
      seen_keys_ttl_ms: 86400000,
      logging: {
        level: "info" as const,
        dir: "logs",
        max_size_bytes: 524288000,
        max_files: 7,
        console: false,
      },
      plugins: {
        dirs: ["src/plugins"],
        health_check_interval_ms: 60000,
        health_check_timeout_ms: 5000,
        consecutive_failures_threshold: 3,
      },
    },
    orchestrator: {} as ReturnType<
      typeof import("../../schemas/config.js").OrchestratorConfigSchema.parse
    >,
    workspace: {} as ReturnType<
      typeof import("../../schemas/config.js").WorkspaceConfigSchema.parse
    >,
    safety: {
      cost_limits: {
        api: {
          per_task: { cost_usd: null, auto_resume_on_reset: false },
          daily: { cost_usd: null, auto_resume_on_reset: false },
          monthly: { cost_usd: null, auto_resume_on_reset: false },
        },
        cli: {},
      },
      scope: {
        repos: { allowed: null },
        branches: { create_pattern: "engineer/.*", push_to: ["engineer/*"], merge_to: ["main"] },
        files: { exclude_patterns: [".env*"] },
        external: { allowed_domains: null },
      },
      autonomy: { decisions: {}, repo_overrides: {} },
      response_timeout: {
        blocked: { stages: [] },
        review_pending: { reminder_after_ms: 86400000, repeat_interval_ms: 86400000 },
      },
      merge: { auto_merge: { default: false, repos: {} } },
    },
    people: [],
  };
}
