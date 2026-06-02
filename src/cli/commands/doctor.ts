import { execSync } from "node:child_process";
import { constants, accessSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checkEnvFilePermissions, loadEnvFile } from "../../config/env.js";
import { loadConfigSafe } from "../../config/loader.js";
import type { ConfigBundle } from "../../config/loader.js";
import type { PeopleDirectoryWarning } from "../../core/people-directory/index.js";
import { inspectPeopleDirectory } from "../../core/people-directory/index.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtin.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import { TimeoutStageActions } from "../../schemas/config.js";
import {
  DaemonConfigSchema,
  OrchestratorConfigSchema,
  PeopleConfigSchema,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../../schemas/config.js";
import type { TelemetryConfig } from "../../schemas/config.js";
import { TelemetryConfigSchema } from "../../schemas/config.js";
import { YAML_EXTENSION_PATTERN } from "../constants.js";
import { resolveDirectories } from "../home.js";
import { type ProbeFetch, probeEndpointReachable, traceInstallPointer } from "./start/telemetry.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of a single health check: status, human-readable message, and optional remedy. */
export interface DoctorCheck {
  readonly label: string;
  readonly status: "pass" | "fail" | "warn";
  readonly message: string;
  readonly remedy?: string;
}

/** A group of related health checks, named by the area of the system being verified. */
export interface DoctorCategory {
  readonly category: string;
  readonly checks: DoctorCheck[];
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Run every doctor check category. Categories needing loaded config are added only when a bundle is provided. */
export function runAllChecks(engineerHome: string, bundle?: ConfigBundle): DoctorCategory[] {
  const dirs = resolveDirectories(engineerHome);
  const categories: DoctorCategory[] = [
    checkNodeRuntime(),
    checkDataDirectory(engineerHome),
    checkConfigFiles(dirs.config),
    checkRequiredSecrets(dirs.config),
    checkDatabase(engineerHome),
    checkPluginManifests(engineerHome),
    checkWorkspace(engineerHome),
    checkExternalDependencies(),
  ];

  // These categories read loaded config — only added when a bundle is available
  if (bundle) {
    categories.push(checkPeopleDirectory(bundle.people, engineerHome));
    categories.push(checkRiskyConfig(bundle));
  }

  return categories;
}

/** Run the pre-flight checks `engineer start` uses before bootstrap — the subset that needs no loaded config bundle. */
export function runPreFlightChecks(engineerHome: string): DoctorCategory[] {
  const dirs = resolveDirectories(engineerHome);
  return [
    checkNodeRuntime(),
    checkDataDirectory(engineerHome),
    checkConfigFiles(dirs.config),
    checkRequiredSecrets(dirs.config),
    checkDatabase(engineerHome),
    checkPluginManifests(engineerHome),
    checkExternalDependencies(),
  ];
}

/** Compute exit code from doctor results: 0=pass, 1=fail, 2=warnings only. */
export function computeExitCode(categories: DoctorCategory[]): number {
  let hasFail = false;
  let hasWarn = false;

  for (const category of categories) {
    for (const check of category.checks) {
      if (check.status === "fail") {
        hasFail = true;
      }
      if (check.status === "warn") {
        hasWarn = true;
      }
    }
  }

  if (hasFail) {
    return 1;
  }
  if (hasWarn) {
    return 2;
  }
  return 0;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<DoctorCheck["status"], string> = {
  pass: "  ✓",
  fail: "  ✗",
  warn: "  ⚠",
};

/** Format doctor results for terminal output. */
export function formatDoctorResults(categories: DoctorCategory[]): string {
  const lines: string[] = [];

  for (const category of categories) {
    lines.push(`\n  ${category.category}`);
    for (const check of category.checks) {
      lines.push(...formatCheck(check));
    }
  }

  lines.push(exitCodeSummary(computeExitCode(categories)));

  return lines.join("\n");
}

function formatCheck(check: DoctorCheck): string[] {
  const icon = STATUS_ICONS[check.status];
  const lines = [`  ${icon} ${check.label}: ${check.message}`];
  if (check.remedy) {
    lines.push(`      → ${check.remedy}`);
  }
  return lines;
}

function exitCodeSummary(exitCode: number): string {
  if (exitCode === 0) {
    return "\n  All checks passed.";
  }
  if (exitCode === 1) {
    return "\n  Some checks failed.";
  }
  return "\n  Warnings detected.";
}

// ── Check: Node Runtime ──────────────────────────────────────────────────────

/** Node.js runtime version check. */
export function checkNodeRuntime(): DoctorCategory {
  const version = process.version;
  const major = Number.parseInt(version.slice(1).split(".")[0] ?? "0", 10);

  const checks: DoctorCheck[] = [
    major >= 22
      ? { label: "Node.js version", status: "pass", message: `${version} (>= 22 required)` }
      : {
          label: "Node.js version",
          status: "fail",
          message: `${version} — Node.js 22+ required`,
          remedy: "Install Node.js 22 or later: https://nodejs.org",
        },
  ];
  return { category: "Node.js Runtime", checks };
}

// ── Check: Data Directory ────────────────────────────────────────────────────

/** Data directory existence and writability. */
export function checkDataDirectory(engineerHome: string): DoctorCategory {
  const dirs = resolveDirectories(engineerHome);
  const checks: DoctorCheck[] = [];

  if (!existsSync(engineerHome)) {
    checks.push({
      label: "ENGINEER_HOME",
      status: "fail",
      message: `${engineerHome} does not exist`,
      remedy: `Run: engineer start --home ${engineerHome}`,
    });
    return { category: "Data Directory", checks };
  }

  try {
    accessSync(engineerHome, constants.W_OK);
    checks.push({ label: "ENGINEER_HOME writable", status: "pass", message: engineerHome });
  } catch {
    checks.push({
      label: "ENGINEER_HOME writable",
      status: "fail",
      message: `${engineerHome} is not writable`,
      remedy: `Check permissions: chmod u+w ${engineerHome}`,
    });
  }

  for (const [name, dirPath] of Object.entries(dirs)) {
    if (existsSync(dirPath)) {
      checks.push({ label: `${name}/ exists`, status: "pass", message: dirPath });
    } else {
      checks.push({
        label: `${name}/ exists`,
        status: "warn",
        message: `${dirPath} missing — will be created on start`,
      });
    }
  }

  return { category: "Data Directory", checks };
}

// ── Check: Config Files ──────────────────────────────────────────────────────

/** Config file validation — every core YAML parses and passes its schema. */
export function checkConfigFiles(configDir: string): DoctorCategory {
  const checks: DoctorCheck[] = [];

  const configs = [
    { name: "daemon.yaml", schema: DaemonConfigSchema },
    { name: "orchestrator.yaml", schema: OrchestratorConfigSchema },
    { name: "safety.yaml", schema: SafetyConfigSchema },
    { name: "workspace.yaml", schema: WorkspaceConfigSchema },
    { name: "people.yaml", schema: PeopleConfigSchema },
  ] as const;

  for (const { name, schema } of configs) {
    const filePath = join(configDir, name);
    if (!existsSync(filePath)) {
      checks.push({
        label: name,
        status: "warn",
        message: `${name} not found — defaults will be used`,
      });
      continue;
    }
    const result = loadConfigSafe(filePath, schema);
    if (result.ok) {
      checks.push({ label: name, status: "pass", message: "Valid" });
    } else {
      checks.push({
        label: name,
        status: "fail",
        message: result.error.message,
        remedy: `Edit ${filePath} and fix the reported errors`,
      });
    }
  }

  return { category: "Config Files", checks };
}

// ── Check: Required Secrets ──────────────────────────────────────────────────

/** Required secrets — env vars referenced in configs resolve, and .env permissions are safe. */
export function checkRequiredSecrets(configDir: string): DoctorCategory {
  const checks: DoctorCheck[] = [];
  const envVarPattern = /\$\{([^}]+)\}/g;

  if (!existsSync(configDir)) {
    checks.push({
      label: "Config directory",
      status: "warn",
      message: "No config directory found",
    });
    return { category: "Required Secrets", checks };
  }

  // Load .env so checks match runtime behavior
  const engineerHome = join(configDir, "..");
  loadEnvFile(engineerHome);

  const permWarning = checkEnvFilePermissions(engineerHome);
  if (permWarning) {
    checks.push({
      label: ".env permissions",
      status: "warn",
      message: permWarning,
      remedy: `chmod 600 ${join(engineerHome, ".env")}`,
    });
  } else if (existsSync(join(engineerHome, ".env"))) {
    checks.push({
      label: ".env file",
      status: "pass",
      message: "Found with correct permissions (0600)",
    });
  }

  const missingVars = new Set<string>();
  const foundVars = new Set<string>();

  scanDirForEnvVars(configDir, envVarPattern, missingVars, foundVars);

  for (const varName of foundVars) {
    checks.push({ label: varName, status: "pass", message: "Set" });
  }
  for (const varName of missingVars) {
    checks.push({
      label: varName,
      status: "fail",
      message: `Environment variable ${varName} is not set`,
      remedy: `Add ${varName}=<value> to ~/.engineer/.env, or export ${varName}=<value>`,
    });
  }

  if (foundVars.size === 0 && missingVars.size === 0) {
    checks.push({
      label: "Environment variables",
      status: "pass",
      message: "No env var references found in configs",
    });
  }

  return { category: "Required Secrets", checks };
}

function scanDirForEnvVars(dir: string, pattern: RegExp, missing: Set<string>, found: Set<string>): void {
  if (!existsSync(dir)) {
    return;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      scanDirForEnvVars(join(dir, entry.name), pattern, missing, found);
      continue;
    }
    if (!isYamlFile(entry.name)) {
      continue;
    }
    extractEnvVarsFromFile(join(dir, entry.name), pattern, missing, found);
  }
}

function extractEnvVarsFromFile(filePath: string, pattern: RegExp, missing: Set<string>, found: Set<string>): void {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const match of content.matchAll(pattern)) {
      const varName = match[1];
      if (!varName) {
        continue;
      }
      if (process.env[varName] !== undefined) {
        found.add(varName);
      } else {
        missing.add(varName);
      }
    }
  } catch (error) {
    // An unreadable config silently hides its env var references — and the doctor
    // would then report all-green for a config the daemon can't actually load. Surface it.
    process.stderr.write(
      `doctor: could not read ${filePath} while scanning for env vars (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
}

function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

// ── Check: Database ──────────────────────────────────────────────────────────

/** Database accessibility check. */
export function checkDatabase(engineerHome: string): DoctorCategory {
  const dbPath = join(engineerHome, "data", "engineer.db");
  const checks: DoctorCheck[] = [];

  if (!existsSync(dbPath)) {
    checks.push({
      label: "Database file",
      status: "warn",
      message: "Database not found — will be created on first start",
    });
    return { category: "Database", checks };
  }

  try {
    accessSync(dbPath, constants.R_OK | constants.W_OK);
    checks.push({ label: "Database accessible", status: "pass", message: dbPath });
  } catch {
    checks.push({
      label: "Database accessible",
      status: "fail",
      message: `Cannot access ${dbPath}`,
      remedy: `Check file permissions on ${dbPath}`,
    });
  }

  return { category: "Database", checks };
}

// ── Check: Plugin Manifests ──────────────────────────────────────────────────

/** Plugin config validation — which built-in plugins are enabled via config files. */
export function checkPluginManifests(engineerHome: string): DoctorCategory {
  const checks: DoctorCheck[] = [];
  const pluginConfigDir = join(engineerHome, "config", "plugins");

  if (!existsSync(pluginConfigDir)) {
    checks.push({
      label: "Plugin configs",
      status: "warn",
      message: "No plugin config directory found — run 'engineer start' for first-run setup",
      remedy: "Run 'engineer start' to set up plugins",
    });
    return { category: "Plugins", checks };
  }

  const configFiles = readdirSync(pluginConfigDir).filter((filename) => filename.endsWith(".yaml"));

  if (configFiles.length === 0) {
    checks.push({
      label: "Plugin configs",
      status: "warn",
      message: "No plugin configs found — no plugins will be loaded",
      remedy: "Run 'engineer start' to enable plugins",
    });
  } else {
    for (const file of configFiles) {
      const pluginId = file.replace(YAML_EXTENSION_PATTERN, "");
      checks.push({ label: pluginId, status: "pass", message: "Config present (enabled)" });
    }
  }

  return { category: "Plugins", checks };
}

// ── Check: Workspace ─────────────────────────────────────────────────────────

/** Workspace & git availability. */
export function checkWorkspace(engineerHome: string): DoctorCategory {
  const checks: DoctorCheck[] = [];
  const workspaceRoot = join(engineerHome, "workspaces");

  if (existsSync(workspaceRoot)) {
    try {
      accessSync(workspaceRoot, constants.W_OK);
      checks.push({ label: "Workspace directory", status: "pass", message: workspaceRoot });
    } catch {
      checks.push({
        label: "Workspace directory",
        status: "fail",
        message: `${workspaceRoot} is not writable`,
        remedy: `chmod u+w ${workspaceRoot}`,
      });
    }
  } else {
    checks.push({
      label: "Workspace directory",
      status: "warn",
      message: `${workspaceRoot} does not exist — will be created on start`,
    });
  }

  try {
    const gitVersion = execSync("git --version", { encoding: "utf8" }).trim();
    checks.push({ label: "Git binary", status: "pass", message: gitVersion });
  } catch {
    checks.push({
      label: "Git binary",
      status: "fail",
      message: "git is not available",
      remedy: "Install git: https://git-scm.com",
    });
  }

  return { category: "Workspace", checks };
}

// ── Check: External Dependencies ─────────────────────────────────────────────

/** External dependency availability — derived from plugin manifests. */
export function checkExternalDependencies(): DoctorCategory {
  const checks: DoctorCheck[] = [];

  // Derive binary requirements from plugin manifests (no hardcoded list)
  const binaryRequirements = new Set<string>();
  for (const plugin of BUILTIN_PLUGINS) {
    for (const req of plugin.manifest.requirements) {
      if (req.type === "binary") {
        binaryRequirements.add(req.name);
      }
    }
  }

  for (const binaryName of binaryRequirements) {
    try {
      const version = execSync(`${binaryName} --version`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      checks.push({ label: binaryName, status: "pass", message: version });
    } catch {
      checks.push({
        label: binaryName,
        status: "warn",
        message: `${binaryName} is not available`,
        remedy: `Install ${binaryName} and ensure it is on PATH`,
      });
    }
  }

  if (binaryRequirements.size === 0) {
    checks.push({
      label: "External binaries",
      status: "pass",
      message: "No binary requirements declared by plugins",
    });
  }

  return { category: "External Dependencies", checks };
}

// ── Check: People Directory ──────────────────────────────────────────────────

/** People Directory category: single-user health — owner presence, extra people, owner-channel reachability. */
export function checkPeopleDirectory(people: ConfigBundle["people"], engineerHome: string): DoctorCategory {
  const warnings = inspectPeopleDirectory(people, availableCommChannels(engineerHome));

  if (warnings.length === 0) {
    return {
      category: "People Directory",
      checks: [{ label: "Owner", status: "pass", message: "Owner configured; all owner channels are deliverable" }],
    };
  }

  const peopleYamlPath = join(resolveDirectories(engineerHome).config, "people.yaml");
  return {
    category: "People Directory",
    checks: warnings.map((warning) => renderPeopleWarning(warning, peopleYamlPath)),
  };
}

/** Map a people-directory warning to a doctor check with a kind-specific label and remedy. */
function renderPeopleWarning(warning: PeopleDirectoryWarning, peopleYamlPath: string): DoctorCheck {
  switch (warning.kind) {
    case "no_owner":
      return {
        label: "Owner",
        status: "warn",
        message: warning.message,
        remedy: `Add a person with role: owner to ${peopleYamlPath}`,
      };
    case "multiple_people":
      return {
        label: "Single-user",
        status: "warn",
        message: warning.message,
        remedy: "v1 contacts only the owner — see docs/constraints.md",
      };
    case "unreachable_owner_channel":
      return {
        label: `Channel "${String(warning.data["channel"])}"`,
        status: "warn",
        message: warning.message,
        remedy:
          "Enable a communication plugin for this channel, or change the owner's contact in people.yaml — see docs/plugins/",
      };
    default: {
      const unhandled: never = warning.kind;
      throw new Error(`Unhandled people-directory warning kind "${String(unhandled)}"`);
    }
  }
}

/**
 * Channels that enabled, send-capable built-in communication plugins can deliver.
 * Doctor sees bundled plugins only; the daemon validates the live registry at startup.
 */
function availableCommChannels(engineerHome: string): Set<string> {
  const enabled = enabledPluginIds(engineerHome);
  const channels = new Set<string>();
  for (const { manifest } of BUILTIN_PLUGINS) {
    if (manifest.type !== AdapterTypes.communication || !enabled.has(manifest.id)) {
      continue;
    }
    const capabilities = manifest.adapter_meta["capabilities"];
    const channel = manifest.adapter_meta["channel"];
    if (Array.isArray(capabilities) && capabilities.includes("send") && typeof channel === "string") {
      channels.add(channel);
    }
  }
  return channels;
}

/** IDs of plugins enabled by the presence of a config file under config/plugins/. */
function enabledPluginIds(engineerHome: string): Set<string> {
  const pluginConfigDir = join(engineerHome, "config", "plugins");
  if (!existsSync(pluginConfigDir)) {
    return new Set();
  }
  const ids = readdirSync(pluginConfigDir)
    .filter((filename) => filename.endsWith(".yaml"))
    .map((filename) => filename.replace(YAML_EXTENSION_PATTERN, ""));
  return new Set(ids);
}

// ── Check: Risky Config ──────────────────────────────────────────────────────

/** Risky config category: warnings for dangerous or incoherent settings. */
export function checkRiskyConfig(bundle: ConfigBundle): DoctorCategory {
  const checks: DoctorCheck[] = [];

  if (bundle.safety.merge.auto_merge_after_approval.default) {
    checks.push({
      label: "Auto-merge",
      status: "warn",
      message: "Auto-merge is enabled by default — PRs will merge without human review",
      remedy:
        "Set merge.auto_merge_after_approval.default: false in safety.yaml, use per-repo overrides for trusted repos",
    });
  }

  for (const [repo, enabled] of Object.entries(bundle.safety.merge.auto_merge_after_approval.repos)) {
    if (enabled) {
      checks.push({
        label: `Auto-merge: ${repo}`,
        status: "warn",
        message: `Auto-merge enabled for ${repo}`,
      });
    }
  }

  const { cost_limits } = bundle.safety;
  if (cost_limits.daily.cost_usd === null && cost_limits.monthly.cost_usd === null) {
    checks.push({
      label: "Cost limits",
      status: "warn",
      message: "No daily or monthly cost limits set — spending is unbounded",
      remedy: "Set daily cost_usd: 25.0 and monthly cost_usd: 250.0 in safety.yaml for safe starting defaults",
    });
  }

  if (bundle.daemon.max_concurrent > 5) {
    checks.push({
      label: "High concurrency",
      status: "warn",
      message: `max_concurrent is ${bundle.daemon.max_concurrent} — high concurrency increases resource usage and agent costs`,
    });
  }

  if (bundle.daemon.stuck_threshold_ms >= bundle.daemon.max_active_duration_ms) {
    checks.push({
      label: "Stuck detection",
      status: "warn",
      message: `stuck_threshold_ms (${bundle.daemon.stuck_threshold_ms}ms) >= max_active_duration_ms (${bundle.daemon.max_active_duration_ms}ms) — stuck detection will never fire before the hard cap`,
      remedy: "Set stuck_threshold_ms lower than max_active_duration_ms",
    });
  }

  const reminderAfterMs = bundle.safety.response_timeout.review_pending.reminder_after_ms;
  if (reminderAfterMs < 3_600_000) {
    checks.push({
      label: "Review reminders",
      status: "warn",
      message: `review_pending.reminder_after_ms is ${String(reminderAfterMs)}ms (${String(Math.round(reminderAfterMs / 60_000))}min) — reminders under 1 hour may overwhelm reviewers`,
      remedy: "Set review_pending.reminder_after_ms to at least '1h' in safety.yaml",
    });
  }

  checkDataLifecycleCoherence(bundle, checks);
  checkEscalationCoherence(bundle.safety.response_timeout.blocked.stages, checks);

  if (checks.length === 0) {
    checks.push({
      label: "Configuration",
      status: "pass",
      message: "No risky configuration detected",
    });
  }

  return { category: "Risky Config Warnings", checks };
}

function checkDataLifecycleCoherence(bundle: ConfigBundle, checks: DoctorCheck[]): void {
  const { data_lifecycle } = bundle.daemon;
  if (!data_lifecycle.enabled) {
    return;
  }

  if (data_lifecycle.interval_ms < 60_000) {
    checks.push({
      label: "Data lifecycle interval",
      status: "warn",
      message: `data_lifecycle.interval_ms is ${String(data_lifecycle.interval_ms)}ms — cleanup interval under 1 minute may cause excessive I/O`,
      remedy: "Set data_lifecycle.interval_ms to at least '1m' in daemon.yaml",
    });
  }

  for (const [table, retention] of Object.entries(data_lifecycle.retention)) {
    if (retention.max_age_days < 7) {
      checks.push({
        label: `Data retention: ${table}`,
        status: "warn",
        message: `data_lifecycle.retention.${table}.max_age_days is ${String(retention.max_age_days)} — retention under 7 days may delete data for in-progress tasks`,
        remedy: `Set data_lifecycle.retention.${table}.max_age_days to at least 7 in daemon.yaml`,
      });
    }
  }
}

function checkEscalationCoherence(
  stages: Array<{ name: string; after_ms: number; action: string }>,
  checks: DoctorCheck[],
): void {
  if (stages.length > 1) {
    for (let i = 1; i < stages.length; i++) {
      const prev = stages[i - 1];
      const curr = stages[i];
      if (prev && curr && curr.after_ms < prev.after_ms) {
        checks.push({
          label: "Escalation stage order",
          status: "warn",
          message: `Blocked escalation stage "${curr.name}" (${String(curr.after_ms)}ms) fires before "${prev.name}" (${String(prev.after_ms)}ms) — stages should be in chronological order`,
          remedy: "Reorder response_timeout.blocked.stages in safety.yaml so after_ms values are ascending",
        });
        break;
      }
    }
  }

  if (stages.length > 0 && !stages.some((s) => s.action === TimeoutStageActions.escalation_alert)) {
    checks.push({
      label: "Escalation endpoint",
      status: "warn",
      message: "No escalation_alert stage in response_timeout.blocked.stages — blocked tasks will never be auto-failed",
      remedy: "Add a stage with action: escalation_alert to response_timeout.blocked.stages in safety.yaml",
    });
  }
}

// ── Check: Telemetry ─────────────────────────────────────────────────────────

/**
 * Telemetry (OTLP trace export) category. Informational and non-blocking: when
 * telemetry is off, that is a clean pass; when it is on, we localhost-probe the
 * configured OTLP endpoint and WARN (never fail) if no backend answers, naming
 * the consequence (spans go nowhere) and pointing at the install fix. The probe
 * is short-timeout + total-catch (reused from the start command) so a missing or
 * slow backend never stalls `engineer doctor`. No GitHub fetch — the backend is a
 * local lens the user brings, not a dependency we resolve over the network.
 *
 * Async because it makes one bounded network probe; appended after the synchronous
 * categories in the doctor action rather than inside {@link runAllChecks}. When the
 * config bundle failed to load, the caller omits `telemetry` and we fall back to
 * schema defaults (off) so the category still reports.
 */
export async function checkTelemetry(telemetry?: TelemetryConfig, probeFetch?: ProbeFetch): Promise<DoctorCategory> {
  const resolved = telemetry ?? TelemetryConfigSchema.parse({});
  if (!resolved.enabled) {
    return {
      category: "Telemetry",
      checks: [
        {
          label: "Trace export",
          status: "pass",
          message: "Disabled — no traces exported (set daemon telemetry.enabled: true to opt in)",
        },
      ],
    };
  }

  const reachable = await probeEndpointReachable(resolved.endpoint, probeFetch);
  if (reachable) {
    return {
      category: "Telemetry",
      checks: [
        {
          label: "Trace backend",
          status: "pass",
          message: `Reachable at ${resolved.endpoint}`,
        },
      ],
    };
  }

  return {
    category: "Telemetry",
    checks: [
      {
        label: "Trace backend",
        status: "warn",
        message: `Telemetry is on but no OTLP backend answered at ${resolved.endpoint} — spans will be dropped until one is reachable`,
        remedy: traceInstallPointer(),
      },
    ],
  };
}
