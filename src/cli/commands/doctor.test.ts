import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetOutput, createOutput } from "../output.js";
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
  createOutput({ mode: "quiet" });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetOutput();
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
  it("warns when no plugins installed", () => {
    // No plugins in tempDir/plugins/ → returns a warning
    const result = checkPluginManifests(tempDir);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.some((c) => c.status === "warn")).toBe(true);
  });
});

// ── Category 7 & 8: Connectivity stubs ────────────────────────────────────

describe("checkGitHubConnectivity", () => {
  it("returns warn when no token in env", () => {
    const originalToken = process.env["GITHUB_TOKEN"];
    // biome-ignore lint/performance/noDelete: delete is required for process.env
    delete process.env["GITHUB_TOKEN"];
    try {
      const result = checkGitHubConnectivity();
      expect(result.checks[0]?.status).toBe("warn");
      expect(result.checks[0]?.message).toContain("No GitHub token found");
    } finally {
      if (originalToken !== undefined) {
        process.env["GITHUB_TOKEN"] = originalToken;
      }
    }
  });

  it("returns pass when GITHUB_TOKEN is set", () => {
    const originalToken = process.env["GITHUB_TOKEN"];
    process.env["GITHUB_TOKEN"] = "ghp_test1234567890";
    try {
      const result = checkGitHubConnectivity();
      expect(result.checks[0]?.status).toBe("pass");
      expect(result.checks[0]?.message).toContain("GITHUB_TOKEN set");
    } finally {
      if (originalToken !== undefined) {
        process.env["GITHUB_TOKEN"] = originalToken;
      } else {
        // biome-ignore lint/performance/noDelete: delete is required for process.env
        delete process.env["GITHUB_TOKEN"];
      }
    }
  });
});

describe("checkTelegramConnectivity", () => {
  it("returns warn when no token in env", () => {
    const originalToken = process.env["TELEGRAM_BOT_TOKEN"];
    const originalChatId = process.env["TELEGRAM_CHAT_ID"];
    // biome-ignore lint/performance/noDelete: delete is required for process.env
    delete process.env["TELEGRAM_BOT_TOKEN"];
    // biome-ignore lint/performance/noDelete: delete is required for process.env
    delete process.env["TELEGRAM_CHAT_ID"];
    try {
      const result = checkTelegramConnectivity();
      const tokenCheck = result.checks.find((c) => c.label === "Telegram bot token");
      expect(tokenCheck?.status).toBe("warn");
      expect(tokenCheck?.message).toContain("No Telegram bot token found");
    } finally {
      if (originalToken !== undefined) {
        process.env["TELEGRAM_BOT_TOKEN"] = originalToken;
      }
      if (originalChatId !== undefined) {
        process.env["TELEGRAM_CHAT_ID"] = originalChatId;
      }
    }
  });

  it("returns pass when TELEGRAM_BOT_TOKEN is set", () => {
    const originalToken = process.env["TELEGRAM_BOT_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = "123456:ABC-DEF1234ghIkl-zyx57W2v";
    try {
      const result = checkTelegramConnectivity();
      const tokenCheck = result.checks.find((c) => c.label === "Telegram bot token (env)");
      expect(tokenCheck?.status).toBe("pass");
      expect(tokenCheck?.message).toContain("TELEGRAM_BOT_TOKEN set");
    } finally {
      if (originalToken !== undefined) {
        process.env["TELEGRAM_BOT_TOKEN"] = originalToken;
      } else {
        // biome-ignore lint/performance/noDelete: delete is required for process.env
        delete process.env["TELEGRAM_BOT_TOKEN"];
      }
    }
  });

  it("checks TELEGRAM_CHAT_ID separately", () => {
    const originalChatId = process.env["TELEGRAM_CHAT_ID"];
    process.env["TELEGRAM_CHAT_ID"] = "-1001234567890";
    try {
      const result = checkTelegramConnectivity();
      const chatIdCheck = result.checks.find((c) => c.label === "Telegram chat ID (env)");
      expect(chatIdCheck?.status).toBe("pass");
    } finally {
      if (originalChatId !== undefined) {
        process.env["TELEGRAM_CHAT_ID"] = originalChatId;
      } else {
        // biome-ignore lint/performance/noDelete: delete is required for process.env
        delete process.env["TELEGRAM_CHAT_ID"];
      }
    }
  });

  it("warns when TELEGRAM_CHAT_ID is missing", () => {
    const originalChatId = process.env["TELEGRAM_CHAT_ID"];
    // biome-ignore lint/performance/noDelete: delete is required for process.env
    delete process.env["TELEGRAM_CHAT_ID"];
    try {
      const result = checkTelegramConnectivity();
      const chatIdCheck = result.checks.find((c) => c.label === "Telegram chat ID");
      expect(chatIdCheck?.status).toBe("warn");
    } finally {
      if (originalChatId !== undefined) {
        process.env["TELEGRAM_CHAT_ID"] = originalChatId;
      }
    }
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
    bundle.safety.merge.auto_merge_after_approval.default = true;
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

  it("warns when max_concurrent exceeds 5", () => {
    const bundle = makeSafeBundle();
    bundle.daemon.max_concurrent = 10;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "High concurrency");
    expect(warn?.status).toBe("warn");
  });

  it("warns when stuck_threshold_ms >= max_active_duration_ms", () => {
    const bundle = makeSafeBundle();
    bundle.daemon.stuck_threshold_ms = bundle.daemon.max_active_duration_ms;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Stuck detection");
    expect(warn?.status).toBe("warn");
  });

  it("warns when aging_cap <= aging_increment", () => {
    const bundle = makeSafeBundle();
    bundle.daemon.aging_cap = 5;
    bundle.daemon.aging_increment = 5;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Priority aging");
    expect(warn?.status).toBe("warn");
  });

  it("does not warn about scheduling with safe defaults", () => {
    const bundle = makeSafeBundle();
    const result = checkRiskyConfig(bundle);
    const schedulingLabels = ["High concurrency", "Stuck detection", "Priority aging"];
    const schedulingWarns = result.checks.filter((c) => schedulingLabels.includes(c.label));
    expect(schedulingWarns).toHaveLength(0);
  });

  it("includes remedy on auto-merge warning", () => {
    const bundle = makeSafeBundle();
    bundle.safety.merge.auto_merge_after_approval.default = true;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Auto-merge");
    expect(warn?.remedy).toBeDefined();
    expect(warn?.remedy).toContain("per-repo");
  });

  it("includes remedy on cost limits warning", () => {
    const bundle = makeSafeBundle();
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Cost limits");
    expect(warn?.remedy).toBeDefined();
    expect(warn?.remedy).toContain("25.0");
  });

  it("warns when review_pending.reminder_after_ms is under 1 hour", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.review_pending.reminder_after_ms = 600_000; // 10 minutes
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Review reminders");
    expect(warn?.status).toBe("warn");
    expect(warn?.remedy).toContain("1h");
  });

  it("does not warn when review_pending.reminder_after_ms is 1 hour or more", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.review_pending.reminder_after_ms = 3_600_000;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Review reminders");
    expect(warn).toBeUndefined();
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
  it("runs exactly 7 categories", () => {
    const results = runPreFlightChecks(tempDir);
    expect(results).toHaveLength(7);
  });
});

describe("runAllChecks", () => {
  it("runs 10 categories without bundle", () => {
    const results = runAllChecks(tempDir);
    expect(results).toHaveLength(10);
  });

  it("runs 11 categories with bundle", () => {
    const results = runAllChecks(tempDir, makeSafeBundle());
    expect(results).toHaveLength(11);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makeSafeBundle() {
  return {
    version: 1,
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
        dirs: [],
        health_check_interval_ms: 60000,
        health_check_timeout_ms: 5000,
        consecutive_failures_threshold: 3,
      },
      data_lifecycle: {
        enabled: true,
        interval_ms: 3_600_000,
        retention: {
          events: { max_age_days: 90, max_count: null },
          observations: { max_age_days: 90, max_count: null },
          journal_entries: { max_age_days: 90, max_count: null },
          checkpoints: { max_age_days: 90, max_count: null },
        },
        vacuum_on_cleanup: true,
      },
      database: { cache_size_mb: 64 },
      subscriber_warn_threshold_ms: 50,
      review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3 },
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
      merge: { auto_merge_after_approval: { default: false, repos: {} } },
    },
    people: [],
  };
}
