import { execSync } from "node:child_process";
import { constants, accessSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { readFileSync } from "node:fs";
import YAML from "yaml";

import { loadConfigSafe } from "../../config/loader.js";
import type { ConfigBundle } from "../../config/loader.js";
import { PluginManifestSchema } from "../../schemas/adapters.js";
import {
  DaemonConfigSchema,
  OrchestratorConfigSchema,
  PeopleConfigSchema,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../../schemas/config.js";
import { resolveSubdirs } from "../home.js";

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
  const dirs = resolveSubdirs(engineerHome);
  const checks: DoctorCheck[] = [];

  // Check ENGINEER_HOME exists
  if (!existsSync(engineerHome)) {
    checks.push({
      label: "ENGINEER_HOME",
      status: "fail",
      message: `${engineerHome} does not exist`,
      remedy: `Run: engineer init --home ${engineerHome}`,
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
      remedy: `export ${varName}=<value>`,
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

function extractEnvVarsFromFile(
  filePath: string,
  pattern: RegExp,
  missing: Set<string>,
  found: Set<string>,
): void {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const m of content.matchAll(pattern)) {
      const varName = m[1];
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

function scanDirForEnvVars(
  dir: string,
  pattern: RegExp,
  missing: Set<string>,
  found: Set<string>,
): void {
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

/** Category 6: Plugin manifest validation. */
export function checkPluginManifests(engineerHome: string): DoctorCategory {
  const checks: DoctorCheck[] = [];
  const pluginDirs = [join(engineerHome, "plugins"), "src/plugins"];

  let foundAny = false;

  for (const dir of pluginDirs) {
    if (!existsSync(dir)) {
      continue;
    }
    scanPluginDir(dir, checks);
    foundAny = true;
  }

  if (!foundAny) {
    checks.push({
      label: "Plugin directories",
      status: "warn",
      message: "No plugin directories found — plugins will be discovered on start",
    });
  }

  return { category: "Plugin Manifests", checks };
}

function scanNestedPlugins(subDir: string, parentName: string, checks: DoctorCheck[]): void {
  for (const sub of readdirSync(subDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) {
      continue;
    }
    const nestedManifest = join(subDir, sub.name, "engineer.plugin.yaml");
    if (existsSync(nestedManifest)) {
      validateManifest(nestedManifest, `${parentName}/${sub.name}`, checks);
    }
  }
}

function scanPluginDir(dir: string, checks: DoctorCheck[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = join(dir, entry.name, "engineer.plugin.yaml");
    if (!existsSync(manifestPath)) {
      // Check subdirectories (plugins are nested: type/name/)
      scanNestedPlugins(join(dir, entry.name), entry.name, checks);
      continue;
    }
    validateManifest(manifestPath, entry.name, checks);
  }
}

function validateManifest(manifestPath: string, pluginName: string, checks: DoctorCheck[]): void {
  try {
    const content = readFileSync(manifestPath, "utf8");
    const parsed = YAML.parse(content) as unknown;
    const result = PluginManifestSchema.safeParse(parsed);
    if (result.success) {
      checks.push({ label: pluginName, status: "pass", message: "Valid manifest" });
    } else {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      checks.push({
        label: pluginName,
        status: "fail",
        message: `Invalid manifest: ${issues}`,
        remedy: `Edit ${manifestPath}`,
      });
    }
  } catch (error) {
    checks.push({
      label: pluginName,
      status: "fail",
      message: `Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`,
      remedy: `Check ${manifestPath} is valid YAML`,
    });
  }
}

/** Category 7: GitHub connectivity — check token presence (sync, no live API call). */
export function checkGitHubConnectivity(configDir?: string): DoctorCategory {
  const checks: DoctorCheck[] = [];

  // Check GITHUB_TOKEN env var or config file
  const envToken = process.env["GITHUB_TOKEN"];
  if (envToken && envToken.length > 0) {
    checks.push({
      label: "GitHub token (env)",
      status: "pass",
      message: `GITHUB_TOKEN set (${String(envToken.length)} chars)`,
    });
  } else if (configDir) {
    // Check if any plugin config might contain a github_token
    const pluginConfigPath = join(configDir, "plugins.yaml");
    if (existsSync(pluginConfigPath)) {
      checks.push({
        label: "GitHub token",
        status: "warn",
        message: "GITHUB_TOKEN not in env — check plugins.yaml for github_token config",
        remedy: "Set GITHUB_TOKEN environment variable or configure github_token in plugins.yaml",
      });
    } else {
      checks.push({
        label: "GitHub token",
        status: "warn",
        message: "No GitHub token found in environment",
        remedy: "Set GITHUB_TOKEN environment variable",
      });
    }
  } else {
    checks.push({
      label: "GitHub token",
      status: "warn",
      message: "No GitHub token found in environment",
      remedy: "Set GITHUB_TOKEN environment variable",
    });
  }

  return { category: "GitHub Connectivity", checks };
}

/** Category 8: Telegram connectivity. */
// TODO: Phase 14c — requires TelegramCommPlugin for bot token validation
export function checkTelegramConnectivity(): DoctorCategory {
  return {
    category: "Telegram Connectivity",
    checks: [
      {
        label: "Telegram Bot",
        status: "warn",
        message: "Telegram connectivity check not yet implemented",
      },
    ],
  };
}

/** Category 9: Workspace & git availability. */
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

/** Category 10: Risky config warnings. */
export function checkRiskyConfig(bundle: ConfigBundle): DoctorCategory {
  const checks: DoctorCheck[] = [];

  // Auto-merge enabled
  if (bundle.safety.merge.auto_merge.default) {
    checks.push({
      label: "Auto-merge",
      status: "warn",
      message: "Auto-merge is enabled by default — PRs will merge without human review",
    });
  }

  // Check for repos with auto-merge
  for (const [repo, enabled] of Object.entries(bundle.safety.merge.auto_merge.repos)) {
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
  if (cost_limits.api.daily.cost_usd === null && cost_limits.api.monthly.cost_usd === null) {
    checks.push({
      label: "Cost limits",
      status: "warn",
      message: "No daily or monthly cost limits set — spending is unbounded",
    });
  }

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

/** Run all 10 doctor check categories. */
export function runAllChecks(engineerHome: string, bundle?: ConfigBundle): DoctorCategory[] {
  const dirs = resolveSubdirs(engineerHome);
  const categories: DoctorCategory[] = [
    checkNodeRuntime(),
    checkDataDirectory(engineerHome),
    checkConfigFiles(dirs.config),
    checkRequiredSecrets(dirs.config),
    checkDatabase(engineerHome),
    checkPluginManifests(engineerHome),
    checkGitHubConnectivity(dirs.config),
    checkTelegramConnectivity(),
    checkWorkspace(engineerHome),
  ];

  // Category 10 requires loaded config — if available
  if (bundle) {
    categories.push(checkRiskyConfig(bundle));
  }

  return categories;
}

/** Run pre-flight checks (categories 1-6 only). Used by `start` command. */
export function runPreFlightChecks(engineerHome: string): DoctorCategory[] {
  const dirs = resolveSubdirs(engineerHome);
  return [
    checkNodeRuntime(),
    checkDataDirectory(engineerHome),
    checkConfigFiles(dirs.config),
    checkRequiredSecrets(dirs.config),
    checkDatabase(engineerHome),
    checkPluginManifests(engineerHome),
  ];
}

/** Compute exit code from doctor results: 0=pass, 1=fail, 2=warnings only. */
export function computeExitCode(categories: DoctorCategory[]): number {
  let hasFail = false;
  let hasWarn = false;

  for (const cat of categories) {
    for (const check of cat.checks) {
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

  for (const cat of categories) {
    lines.push(`\n  ${cat.category}`);
    for (const check of cat.checks) {
      lines.push(...formatCheck(check));
    }
  }

  lines.push(exitCodeSummary(computeExitCode(categories)));

  return lines.join("\n");
}
