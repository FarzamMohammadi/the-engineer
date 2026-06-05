import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DoctorCategory,
  checkConfigFiles,
  checkDataDirectory,
  checkDatabase,
  checkNodeRuntime,
  checkPeopleDirectory,
  checkPluginManifests,
  checkRequiredSecrets,
  checkRiskyConfig,
  checkTelemetry,
  checkWorkspace,
  computeExitCode,
  formatDoctorResults,
  runAllChecks,
  runPreFlightChecks,
} from "../../../../src/cli/commands/doctor.js";
import type { ProbeFetch } from "../../../../src/cli/commands/start/telemetry.js";
import { createOutput, resetOutput } from "../../../../src/cli/output.js";
import { TimeoutStageActions } from "../../../../src/schemas/config.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  createOutput({ mode: "json" });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  resetOutput();
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
    for (const name of ["daemon.yaml", "orchestrator.yaml", "safety.yaml", "workspace.yaml", "people.yaml"]) {
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

// ── Category 7: Workspace ─────────────────────────────────────────────────

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

// ── Category 9: Risky Config ──────────────────────────────────────────────

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

  it("warns when data_lifecycle.interval_ms is under 1 minute", () => {
    const bundle = makeSafeBundle();
    bundle.daemon.data_lifecycle.interval_ms = 5_000;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Data lifecycle interval");
    expect(warn?.status).toBe("warn");
    expect(warn?.remedy).toContain("1m");
  });

  it("does not warn about data lifecycle interval with safe defaults", () => {
    const bundle = makeSafeBundle();
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Data lifecycle interval");
    expect(warn).toBeUndefined();
  });

  it("warns when retention max_age_days is under 7", () => {
    const bundle = makeSafeBundle();
    bundle.daemon.data_lifecycle.retention.events.max_age_days = 3;
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Data retention: events");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("3");
  });

  it("does not warn about retention with safe defaults", () => {
    const bundle = makeSafeBundle();
    const result = checkRiskyConfig(bundle);
    const retentionWarns = result.checks.filter((c) => c.label.startsWith("Data retention"));
    expect(retentionWarns).toHaveLength(0);
  });

  it("warns when blocked escalation stages are not in chronological order", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.blocked.stages = [
      {
        name: "escalation",
        after_ms: 172_800_000,
        action: TimeoutStageActions.escalation_alert,
        repeat: null,
        repeat_interval_ms: null,
      },
      {
        name: "reminder",
        after_ms: 14_400_000,
        action: TimeoutStageActions.send_reminder,
        repeat: true,
        repeat_interval_ms: 14_400_000,
      },
    ];
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Escalation stage order");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("chronological");
  });

  it("does not warn about stage order when stages are chronological", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.blocked.stages = [
      {
        name: "reminder",
        after_ms: 14_400_000,
        action: TimeoutStageActions.send_reminder,
        repeat: true,
        repeat_interval_ms: 14_400_000,
      },
      {
        name: "escalation",
        after_ms: 172_800_000,
        action: TimeoutStageActions.escalation_alert,
        repeat: null,
        repeat_interval_ms: null,
      },
    ];
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Escalation stage order");
    expect(warn).toBeUndefined();
  });

  it("warns when no escalation_alert stage is configured", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.blocked.stages = [
      {
        name: "reminder",
        after_ms: 14_400_000,
        action: TimeoutStageActions.send_reminder,
        repeat: true,
        repeat_interval_ms: 14_400_000,
      },
      {
        name: "self_unblock",
        after_ms: 28_800_000,
        action: TimeoutStageActions.evaluate_self_unblock,
        repeat: null,
        repeat_interval_ms: null,
      },
    ];
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Escalation endpoint");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("never be auto-failed");
  });

  it("does not warn about escalation endpoint when escalation_alert stage exists", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.blocked.stages = [
      {
        name: "escalation",
        after_ms: 172_800_000,
        action: TimeoutStageActions.escalation_alert,
        repeat: null,
        repeat_interval_ms: null,
      },
    ];
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Escalation endpoint");
    expect(warn).toBeUndefined();
  });

  it("does not warn about escalation when stages array is empty", () => {
    const bundle = makeSafeBundle();
    bundle.safety.response_timeout.blocked.stages = [];
    const result = checkRiskyConfig(bundle);
    const warn = result.checks.find((c) => c.label === "Escalation endpoint");
    expect(warn).toBeUndefined();
  });
});

// ── Telemetry ─────────────────────────────────────────────────────────────

describe("checkTelemetry", () => {
  const reachableFetch: ProbeFetch = vi.fn().mockResolvedValue({ ok: false });
  const unreachableFetch: ProbeFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

  it("passes (informational) when telemetry is disabled, without probing", async () => {
    const probe = vi.fn() as unknown as ProbeFetch;
    const result = await checkTelemetry(
      { enabled: false, endpoint: "http://localhost:4318", ui_base: "http://localhost:16686" },
      probe,
    );
    expect(result.category).toBe("Telemetry");
    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.message).toContain("Disabled");
    expect(probe).not.toHaveBeenCalled();
  });

  it("passes when telemetry is on and the backend answers", async () => {
    const result = await checkTelemetry(
      { enabled: true, endpoint: "http://localhost:4318", ui_base: "http://localhost:16686" },
      reachableFetch,
    );
    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.message).toContain("http://localhost:4318");
  });

  it("warns (never fails) when telemetry is on but the backend is unreachable", async () => {
    const result = await checkTelemetry(
      { enabled: true, endpoint: "http://localhost:4318", ui_base: "http://localhost:16686" },
      unreachableFetch,
    );
    const check = result.checks[0];
    expect(check?.status).toBe("warn");
    expect(result.checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("names the consequence and includes the install pointer when unreachable", async () => {
    const result = await checkTelemetry(
      { enabled: true, endpoint: "http://localhost:4318", ui_base: "http://localhost:16686" },
      unreachableFetch,
    );
    const check = result.checks[0];
    // Consequence: spans go nowhere.
    expect(check?.message).toContain("dropped");
    // Install pointer (OS-aware, single-sourced from start/telemetry).
    expect(check?.remedy).toBeDefined();
    expect(check?.remedy).toContain("no trace backend is reachable");
  });

  it("falls back to schema defaults (off) when no config is provided", async () => {
    const probe = vi.fn() as unknown as ProbeFetch;
    const result = await checkTelemetry(undefined, probe);
    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.message).toContain("Disabled");
    expect(probe).not.toHaveBeenCalled();
  });
});

// ── People Directory ──────────────────────────────────────────────────────

describe("checkPeopleDirectory", () => {
  function makeOwner(contacts: Array<{ channel: string; handle: string }>) {
    return {
      id: "owner",
      name: "Owner",
      roles: ["owner"],
      contacts,
    };
  }

  function enableCommPlugin(id: string): void {
    const pluginDir = join(tempDir, "config", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, `${id}.yaml`), "# enabled", "utf8");
  }

  it("warns when no owner is configured", () => {
    const result = checkPeopleDirectory([], tempDir);
    expect(result.category).toBe("People Directory");
    expect(result.checks.find((c) => c.label === "Owner")?.status).toBe("warn");
  });

  it("passes when the owner's channels are all deliverable", () => {
    enableCommPlugin("telegram-comm");
    const result = checkPeopleDirectory([makeOwner([{ channel: "telegram", handle: "@o" }])], tempDir);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("pass");
  });

  it("warns that only the owner is reached when extra people are configured", () => {
    enableCommPlugin("telegram-comm");
    const reviewer = { ...makeOwner([]), id: "alice", roles: ["reviewer"] };
    const result = checkPeopleDirectory([makeOwner([{ channel: "telegram", handle: "@o" }]), reviewer], tempDir);
    expect(result.checks.some((c) => c.label === "Single-user" && c.status === "warn")).toBe(true);
  });

  it("warns when an owner channel has no installed comm plugin", () => {
    const result = checkPeopleDirectory([makeOwner([{ channel: "telegram", handle: "@o" }])], tempDir);
    expect(result.checks.find((c) => c.label === 'Channel "telegram"')?.status).toBe("warn");
  });
});

// ── Aggregation ───────────────────────────────────────────────────────────

describe("computeExitCode", () => {
  it("returns 0 when all pass", () => {
    const cats: DoctorCategory[] = [{ category: "Test", checks: [{ label: "ok", status: "pass", message: "good" }] }];
    expect(computeExitCode(cats)).toBe(0);
  });

  it("returns 1 when any fail", () => {
    const cats: DoctorCategory[] = [
      { category: "Test", checks: [{ label: "bad", status: "fail", message: "broken" }] },
    ];
    expect(computeExitCode(cats)).toBe(1);
  });

  it("returns 2 when warnings only", () => {
    const cats: DoctorCategory[] = [{ category: "Test", checks: [{ label: "meh", status: "warn", message: "iffy" }] }];
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
  it("omits config-dependent categories without a bundle", () => {
    const names = runAllChecks(tempDir).map((c) => c.category);
    expect(names).not.toContain("People Directory");
    expect(names).not.toContain("Risky Config Warnings");
  });

  it("adds People Directory and Risky Config categories with a bundle", () => {
    const names = runAllChecks(tempDir, makeSafeBundle()).map((c) => c.category);
    expect(names).toContain("People Directory");
    expect(names).toContain("Risky Config Warnings");
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
      shutdown_timeout_ms: 30000,
      trigger_poll_interval_ms: 30000,
      response_poll_interval_ms: 5000,
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
          events: { max_age_days: 90 },
          observations: { max_age_days: 90 },
          journal_entries: { max_age_days: 90 },
          checkpoints: { max_age_days: 90 },
        },
      },
      workspace_reaper: { enabled: true, interval_ms: 3_600_000 },
      database: { cache_size_mb: 64 },
      subscriber_warn_threshold_ms: 50,
      notification_suppress_window_ms: 300_000,
      notification_retry: { interval_ms: 30_000, max_attempts: 120, max_age_ms: 3_600_000 },
      review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3, max_blocker_reentries: 3 },
      retry_policy: {
        crash: { backoff_minutes: [1, 5, 15, 30, 30], max_attempts: 5 },
        agent_unavailable: { backoff_minutes: [2, 5, 10, 15, 15], max_attempts: 5 },
      },
      evaluation: { enabled: false },
      telemetry: { enabled: false, endpoint: "http://localhost:4318", ui_base: "http://localhost:16686" },
    },
    orchestrator: {} as ReturnType<typeof import("../../../../src/schemas/config.js").OrchestratorConfigSchema.parse>,
    workspace: {} as ReturnType<typeof import("../../../../src/schemas/config.js").WorkspaceConfigSchema.parse>,
    safety: {
      cost_limits: {
        per_task: { cost_usd: null },
        daily: { cost_usd: null },
        monthly: { cost_usd: null },
        providers: {},
      },
      scope: {
        repos: { allowed: null },
        branches: { create_pattern: "engineer/.*", push_to: ["engineer/*"], merge_to: ["main"] },
        files: { exclude_patterns: [".env*"] },
        external: { allowed_domains: null },
      },
      autonomy: { decisions: {}, repo_overrides: {} },
      response_timeout: {
        blocked: {
          stages: [] as Array<{
            name: string;
            after_ms: number;
            action: "send_reminder" | "evaluate_self_unblock" | "escalation_alert";
            repeat: boolean | null;
            repeat_interval_ms: number | null;
          }>,
        },
        review_pending: { reminder_after_ms: 86400000, repeat_interval_ms: 86400000 },
      },
      merge: {
        auto_merge_after_approval: { default: false, repos: {} },
        enable_comment_approval: false,
        exclude_thoughts_on_merge: false,
      },
    },
    people: [],
  };
}
