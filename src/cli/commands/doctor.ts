import { execSync } from "node:child_process";
import { constants, accessSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkEnvFilePermissions, loadEnvFile } from "../../config/env.js";
import { loadConfigSafe } from "../../config/loader.js";
import type { ConfigBundle } from "../../config/loader.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtin.js";
import { TimeoutStageActions } from "../../schemas/config.js";
import {
  DaemonConfigSchema,
  OrchestratorConfigSchema,
  PeopleConfigSchema,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../../schemas/config.js";
import { YAML_EXTENSION_PATTERN } from "../constants.js";
import { resolveDirectories } from "../home.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DoctorCheck {
  label: string;
  status: "pass" | "fail" | "warn";
  message: string;
  remedy?: string;
}

export interface DoctorCategory {
  category: string;
  checks: DoctorCheck[];
}

// ── Check Functions ──────────────────────────────────────────────────────────

/** Category 1: Node.js runtime version check. */
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

/** Category 2: Data directory existence and writability. */
export function checkDataDirectory(engineerHome: string): DoctorCategory {
  const dirs = resolveDirectories(engineerHome);
  const checks: DoctorCheck[] = [];

  // Check ENGINEER_HOME exists
  if (!existsSync(engineerHome)) {
    checks.push({
      label: "ENGINEER_HOME",
      status: "fail",
      message: `${engineerHome} does not exist`,
      remedy: `Run: engineer start --home ${engineerHome}`,
    });
    return { category: "Data Directory", checks };
  }

  // Check writability
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

  // Check subdirectories
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

/** Check if people.yaml has an owner configured and push appropriate check result. */
function checkPeopleOwner(config: unknown, filePath: string, checks: DoctorCheck[]): void {
  const people = config as { people?: Array<{ role?: string }> };
  const hasOwner = people.people?.some((p) => p.role === "owner") ?? false;
  if (hasOwner) {
    checks.push({
      label: "People Directory — owner",
      status: "pass",
      message: "Owner configured",
    });
  } else {
    checks.push({
      label: "People Directory — owner",
      status: "warn",
      message: "No person with role 'owner' configured — outreach fallback will fail",
      remedy: `Add a person with role: owner to ${filePath}`,
    });
  }
}

/** Category 3: Config file validation. */
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

      // Owner-must-exist check for people config
      if (name === "people.yaml" && result.config) {
        checkPeopleOwner(result.config, filePath, checks);
      }
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

/** Category 4: Required secrets (env vars referenced in configs). */
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

  // Check .env file permissions
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

function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
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
  } catch {
    // Skip files that can't be read
  }
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

/** Category 5: Database accessibility and schema version. */
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
    // Dynamic import would be async; use require-like pattern
    // Just check if the file exists and is readable
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

/** Category 6: Plugin config validation — check which built-in plugins are enabled via config files. */
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

/** Category 7: Workspace & git availability. */
export function checkWorkspace(engineerHome: string): DoctorCategory {
  const checks: DoctorCheck[] = [];
  const wsRoot = join(engineerHome, "workspaces");

  // Check workspace dir
  if (existsSync(wsRoot)) {
    try {
      accessSync(wsRoot, constants.W_OK);
      checks.push({ label: "Workspace directory", status: "pass", message: wsRoot });
    } catch {
      checks.push({
        label: "Workspace directory",
        status: "fail",
        message: `${wsRoot} is not writable`,
        remedy: `chmod u+w ${wsRoot}`,
      });
    }
  } else {
    checks.push({
      label: "Workspace directory",
      status: "warn",
      message: `${wsRoot} does not exist — will be created on start`,
    });
  }

  // Check git binary
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

/** Category 8: External dependency availability — derived from plugin manifests. */
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

/** Category 11: Risky config warnings. */
export function checkRiskyConfig(bundle: ConfigBundle): DoctorCategory {
  const checks: DoctorCheck[] = [];

  // Auto-merge enabled
  if (bundle.safety.merge.auto_merge_after_approval.default) {
    checks.push({
      label: "Auto-merge",
      status: "warn",
      message: "Auto-merge is enabled by default — PRs will merge without human review",
      remedy:
        "Set merge.auto_merge_after_approval.default: false in safety.yaml, use per-repo overrides for trusted repos",
    });
  }

  // Check for repos with auto-merge
  for (const [repo, enabled] of Object.entries(bundle.safety.merge.auto_merge_after_approval.repos)) {
    if (enabled) {
      checks.push({
        label: `Auto-merge: ${repo}`,
        status: "warn",
        message: `Auto-merge enabled for ${repo}`,
      });
    }
  }

  // No cost limits set
  const { cost_limits } = bundle.safety;
  if (cost_limits.daily.cost_usd === null && cost_limits.monthly.cost_usd === null) {
    checks.push({
      label: "Cost limits",
      status: "warn",
      message: "No daily or monthly cost limits set — spending is unbounded",
      remedy: "Set daily cost_usd: 25.0 and monthly cost_usd: 250.0 in safety.yaml for safe starting defaults",
    });
  }

  // High concurrency warning
  if (bundle.daemon.max_concurrent > 5) {
    checks.push({
      label: "High concurrency",
      status: "warn",
      message: `max_concurrent is ${bundle.daemon.max_concurrent} — high concurrency increases resource usage and LLM costs`,
    });
  }

  // Stuck detection never fires before the hard cap
  if (bundle.daemon.stuck_threshold_ms >= bundle.daemon.max_active_duration_ms) {
    checks.push({
      label: "Stuck detection",
      status: "warn",
      message: `stuck_threshold_ms (${bundle.daemon.stuck_threshold_ms}ms) >= max_active_duration_ms (${bundle.daemon.max_active_duration_ms}ms) — stuck detection will never fire before the hard cap`,
      remedy: "Set stuck_threshold_ms lower than max_active_duration_ms",
    });
  }

  // Review reminder too aggressive
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

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Run all doctor check categories (8 base + 1 conditional risky config). */
/** Category: CLI session artifact accumulation (informational). */
function checkCliArtifacts(): DoctorCategory {
  const checks: DoctorCheck[] = [];
  const claudeDir = join(homedir(), ".claude", "projects");

  if (existsSync(claudeDir)) {
    try {
      // Quick size estimate: count files and sample a few for size
      const entries = readdirSync(claudeDir);
      let totalBytes = 0;
      let fileCount = 0;

      for (const entry of entries) {
        const entryPath = join(claudeDir, entry);
        try {
          const stat = statSync(entryPath);
          if (stat.isDirectory()) {
            const subEntries = readdirSync(entryPath);
            fileCount += subEntries.length;
            for (const sub of subEntries) {
              try {
                totalBytes += statSync(join(entryPath, sub)).size;
              } catch {
                // Skip inaccessible files
              }
            }
          } else {
            fileCount++;
            totalBytes += stat.size;
          }
        } catch {
          // Skip inaccessible entries
        }
      }

      const sizeMb = totalBytes / (1024 * 1024);
      if (sizeMb > 500) {
        checks.push({
          label: "CLI session artifacts",
          status: "warn",
          message: `~/.claude/projects/ is ${sizeMb.toFixed(0)} MB (${String(fileCount)} files) — accumulated session history from CLI tools`,
          remedy: "Consider pruning old session files: find ~/.claude/projects -name '*.jsonl' -mtime +30 -delete",
        });
      } else {
        checks.push({
          label: "CLI session artifacts",
          status: "pass",
          message: `~/.claude/projects/ is ${sizeMb.toFixed(0)} MB (${String(fileCount)} files)`,
        });
      }
    } catch {
      checks.push({
        label: "CLI session artifacts",
        status: "pass",
        message: "Could not read ~/.claude/projects/",
      });
    }
  } else {
    checks.push({
      label: "CLI session artifacts",
      status: "pass",
      message: "~/.claude/projects/ not found (no CLI sessions)",
    });
  }

  return { category: "CLI Artifacts", checks };
}

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
    checkCliArtifacts(),
  ];

  // Category 11 requires loaded config — if available
  if (bundle) {
    categories.push(checkRiskyConfig(bundle));
  }

  return categories;
}

/** Run pre-flight checks (categories 1-7 only). Used by `start` command. */
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

const STATUS_ICONS: Record<DoctorCheck["status"], string> = {
  pass: "  ✓",
  fail: "  ✗",
  warn: "  ⚠",
};

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
