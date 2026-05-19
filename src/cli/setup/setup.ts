import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { loadEnvFile, writeEnvFile } from "../../config/env.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtin.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import { resolveDirectories } from "../home.js";
import { getOutput } from "../output.js";
import { ALL_PLUGIN_DOCS } from "../plugin-docs.js";
import { ALL_EXAMPLE_TEMPLATES, ALL_TEMPLATES } from "../templates.js";
import { detectOperatingSystem } from "./os-detection.js";
import type { AdapterTypeConfig, DetectionResult, PersonSetupEntry } from "./types.js";

export type { AdapterTypeConfig, DetectionResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A config file to be written to ENGINEER_HOME — a relative path and its content. */
export interface GeneratedFile {
  relativePath: string;
  content: string;
}

/** Options for {@link runFirstTimeSetup} — target home directory, optional seed path, optional dry-run mode. */
export interface SetupOptions {
  engineerHome: string;
  seedPath?: string;
  dryRun?: boolean;
}

// ── Adapter Type Configuration ───────────────────────────────────────────────

/** Adapter slots offered during guided setup, in `setupOrder` (LLM → trigger → git hosting → communication). */
export const ADAPTER_TYPE_CONFIGS: AdapterTypeConfig[] = [
  {
    type: AdapterTypes.llm,
    label: "Which AI do you use?",
    selectionMode: "single",
    setupOrder: 1,
    required: true,
  },
  {
    type: AdapterTypes.trigger,
    label: "Where do your tasks come from?",
    selectionMode: "single",
    setupOrder: 2,
    required: true,
  },
  {
    type: AdapterTypes.git_hosting,
    label: "Where does your code live?",
    selectionMode: "single",
    setupOrder: 3,
    required: true,
  },
  {
    type: AdapterTypes.communication,
    label: "How should The Engineer reach you?",
    selectionMode: "multi",
    setupOrder: 4,
    required: false,
  },
];

// ── Setup Orchestrator ───────────────────────────────────────────────────────

/**
 * Run first-time setup. Returns true if completed, false if user cancelled.
 * Orchestrates: detect → guide → prompt → generate → write.
 */
export async function runFirstTimeSetup(options: SetupOptions): Promise<boolean> {
  const { engineerHome, seedPath, dryRun } = options;
  const out = getOutput();

  // Ensure base directories exist (even for dry-run, so detection can work)
  const dirs = resolveDirectories(engineerHome);
  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // OS gate — before anything else
  const shouldContinue = await showOperatingSystemGate(!seedPath);
  if (!shouldContinue) {
    return false;
  }

  if (seedPath) {
    return runNonInteractiveSetup(engineerHome, seedPath, dryRun ?? false);
  }

  // Interactive mode
  out.log("  First run — detecting environment...");
  out.blank();

  // Write plugin docs before prompts so paths are clickable during selection
  writePluginDocs(engineerHome);

  const detection = runDetection();

  // Lazy import to avoid loading @inquirer/prompts unless needed
  const { runGuidedSetup } = await import("./prompts.js");
  const result = await runGuidedSetup(detection, BUILTIN_PLUGINS, ADAPTER_TYPE_CONFIGS, engineerHome);

  if (!result) {
    out.blank();
    out.log("  No configuration was written.");
    out.log(`  To configure manually, create YAML files in ${dirs.plugins}`);
    return false;
  }

  const files = generateConfigFiles(result.selectedPlugins, result.pluginConfigs, result.people);

  if (dryRun) {
    out.blank();
    out.log("  Dry run — would write:");
    for (const file of files) {
      out.log(`    ${file.relativePath}`);
    }
    out.blank();
    return true;
  }

  writeConfigFiles(engineerHome, files);

  // Write secrets to .env
  if (result.secrets && Object.keys(result.secrets).length > 0) {
    writeEnvFile(engineerHome, result.secrets);
  }

  out.blank();
  out.success("Configuration written.");
  out.log(`  Config: ${dirs.config}`);
  out.blank();

  return true;
}

/**
 * Check if first-run setup is needed.
 * True if config dir doesn't exist OR plugins dir has no .yaml files.
 */
export function needsSetup(engineerHome: string): boolean {
  const dirs = resolveDirectories(engineerHome);
  if (!existsSync(dirs.config)) {
    return true;
  }
  if (!existsSync(dirs.plugins)) {
    return true;
  }
  const yamlFiles = readdirSync(dirs.plugins).filter((f) => f.endsWith(".yaml"));
  return yamlFiles.length === 0;
}

// ── Operating System Gate ────────────────────────────────────────────────────

/**
 * Display the OS detection result and gate on unsupported platforms.
 * Returns false if the user declines to proceed; true otherwise.
 */
async function showOperatingSystemGate(isInteractive: boolean): Promise<boolean> {
  const out = getOutput();
  const osInfo = detectOperatingSystem(process.platform);
  out.blank();

  if (osInfo.support === "full") {
    out.log(`  ${osInfo.message}`);
    out.blank();
    return true;
  }

  if (!isInteractive) {
    out.warn(osInfo.message);
    out.blank();
    return true;
  }

  out.log(`  ${osInfo.message}`);
  out.blank();
  const { confirm } = await import("@inquirer/prompts");
  const proceed = await confirm({
    message: osInfo.support === "preview" ? "Proceed?" : "Proceed with unsupported platform?",
    default: osInfo.support === "preview",
  });
  if (!proceed) {
    return false;
  }

  out.blank();
  return true;
}

// ── Non-Interactive Setup ────────────────────────────────────────────────────

/** Known placeholder values that indicate people.yaml was never configured. */
const PEOPLE_PLACEHOLDERS = ["your_telegram_username", "your-github-username", "Your Name"];

function runNonInteractiveSetup(engineerHome: string, seedPath: string, dryRun: boolean): boolean {
  const out = getOutput();
  const validated = validateSeedPath(seedPath);
  if (!validated) {
    return false;
  }
  const { pluginFiles } = validated;

  const configsDir = join(seedPath, "configs");
  const hasConfigs = existsSync(configsDir);

  if (dryRun) {
    out.blank();
    out.log(`  Dry run — would copy from ${seedPath}:`);
    for (const file of pluginFiles) {
      out.log(`    config/plugins/${file}`);
    }
    if (hasConfigs) {
      const configFiles = readdirSync(configsDir).filter((f) => f.endsWith(".yaml"));
      for (const file of configFiles) {
        out.log(`    config/${file} (from seed)`);
      }
    }
    out.log("  Plus any missing core configs with conservative defaults.");
    out.blank();
    return true;
  }

  writeSeedFiles(engineerHome, seedPath, pluginFiles);
  checkPeoplePlaceholders(engineerHome);

  // Post-setup validation
  const dirs = resolveDirectories(engineerHome);
  loadEnvFile(engineerHome);
  const missingVars = findUnresolvedEnvVars(dirs.config);
  if (missingVars.length > 0) {
    out.error("Seed incomplete — missing required environment variables:");
    for (const v of missingVars) {
      out.log(`    ${v}`);
    }
    out.log("  Add them to ~/.engineer/.env or set them in your environment, then restart.");
    return false;
  }

  out.success(`Seeded ${String(pluginFiles.length)} plugin config(s) from ${seedPath}`);
  return true;
}

/** Validate seed directory structure, return plugin files or null on error. */
function validateSeedPath(seedPath: string): { pluginFiles: string[]; pluginsDir: string } | null {
  const out = getOutput();

  if (!existsSync(seedPath)) {
    out.error(`Seed directory not found: ${seedPath}`);
    return null;
  }

  const pluginsDir = join(seedPath, "plugins");
  if (!existsSync(pluginsDir)) {
    out.error(`Seed directory must have a plugins/ subdirectory: ${pluginsDir}`);
    return null;
  }

  const pluginFiles = readdirSync(pluginsDir).filter((f) => f.endsWith(".yaml"));
  if (pluginFiles.length === 0) {
    out.error(`No .yaml files found in ${pluginsDir}`);
    return null;
  }

  return { pluginFiles, pluginsDir };
}

/** Copy seed plugin configs and write core/example configs. */
function writeSeedFiles(engineerHome: string, seedPath: string, pluginFiles: string[]): void {
  const pluginsDir = join(seedPath, "plugins");
  const configsDir = join(seedPath, "configs");
  const hasConfigs = existsSync(configsDir);
  const dirs = resolveDirectories(engineerHome);

  // Copy plugin configs
  for (const file of pluginFiles) {
    const content = readFileSync(join(pluginsDir, file), "utf8");
    writeSecureFile(join(dirs.plugins, file), content);
  }

  // Write core configs: seed overrides or template defaults
  const coreTemplates = ALL_TEMPLATES.filter((t) => !t.relativePath.startsWith("config/plugins/"));
  for (const template of coreTemplates) {
    const configName = template.relativePath.replace("config/", "");
    const seedFile = join(configsDir, configName);
    const fullPath = join(engineerHome, template.relativePath);
    const content = hasConfigs && existsSync(seedFile) ? readFileSync(seedFile, "utf8") : template.content;
    writeSecureFile(fullPath, content);
  }

  // Write example templates
  for (const template of ALL_EXAMPLE_TEMPLATES) {
    writeSecureFile(join(engineerHome, template.relativePath), template.content);
  }

  writePluginDocs(engineerHome);
}

/** Ensure parent dir exists, then write file with restricted permissions. */
function writeSecureFile(fullPath: string, content: string): void {
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(fullPath, content, { encoding: "utf8", mode: 0o600 });
}

/** Warn if people.yaml has placeholder values that need editing. */
function checkPeoplePlaceholders(engineerHome: string): void {
  const out = getOutput();
  const peopleConfigPath = join(engineerHome, "config", "people.yaml");
  if (!existsSync(peopleConfigPath)) {
    return;
  }
  const content = readFileSync(peopleConfigPath, "utf8");
  if (PEOPLE_PLACEHOLDERS.some((p) => content.includes(p))) {
    out.warn("people.yaml contains placeholder values — edit ~/.engineer/config/people.yaml with real contact info.");
  }
}

// ── Environment Detection ────────────────────────────────────────────────────

const DETECTION_TIMEOUT_MS = 5_000;
const WHITESPACE_RE = /\s+/;
const HTTPS_REMOTE_RE = /https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const SSH_REMOTE_RE = /:([^/]+)\/([^/]+?)(?:\.git)?$/;

/** Run environment detection with real I/O. Derives check list from plugin manifests. */
export function runDetection(): DetectionResult {
  // Derive what to check from plugin manifest requirements — no hardcoded lists
  const binaryNames = new Set<string>();
  const envVarNames = new Set<string>();
  for (const plugin of BUILTIN_PLUGINS) {
    for (const req of plugin.manifest.requirements) {
      if (req.type === "binary") {
        binaryNames.add(req.name);
      } else if (req.type === "env") {
        envVarNames.add(req.name);
      }
    }
  }

  const binaryPaths: Record<string, string | null> = {};
  for (const name of binaryNames) {
    binaryPaths[name] = whichBinary(name);
  }

  const envSubset: Record<string, string | undefined> = {};
  for (const name of envVarNames) {
    envSubset[name] = process.env[name];
  }

  return detectEnvironment(envSubset, binaryPaths, getGitRemoteOutput());
}

/**
 * Build a DetectionResult from pre-resolved data. Pure — no I/O.
 * Tests call this directly with fake data.
 */
export function detectEnvironment(
  env: Record<string, string | undefined>,
  binaryPaths: Record<string, string | null>,
  gitRemoteOutput: string | null,
): DetectionResult {
  const envVars = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value != null && value.trim().length > 0) {
      envVars.add(key);
    }
  }

  const binaries: Record<string, string | null> = {};
  for (const [name, path] of Object.entries(binaryPaths)) {
    binaries[name] = path;
  }

  return {
    binaries,
    envVars,
    gitRemote: gitRemoteOutput ? parseGitRemote(gitRemoteOutput) : null,
  };
}

/**
 * Parse `git remote -v` output and extract the origin remote's owner/name.
 * Returns null if origin is not found or the URL is unparseable.
 */
export function parseGitRemote(output: string): { owner: string; name: string } | null {
  // Find the "origin" remote (fetch line)
  const originLine = output.split("\n").find((line) => line.startsWith("origin") && line.includes("(fetch)"));
  if (!originLine) {
    return null;
  }

  const url = originLine.split(WHITESPACE_RE)[1];
  if (!url) {
    return null;
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(HTTPS_REMOTE_RE);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(SSH_REMOTE_RE);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  return null;
}

function whichBinary(name: string): string | null {
  try {
    return execSync(`which ${name}`, { timeout: DETECTION_TIMEOUT_MS, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function getGitRemoteOutput(): string | null {
  try {
    return execSync("git remote -v", { timeout: DETECTION_TIMEOUT_MS, encoding: "utf8" });
  } catch {
    return null;
  }
}

// ── Config Generation ────────────────────────────────────────────────────────

/**
 * Generate config files for the given plugin selection. Pure function.
 * Returns core configs (conservative defaults) + plugin configs (env var refs for secrets).
 */
export function generateConfigFiles(
  selectedPlugins: string[],
  pluginConfigs: Record<string, Record<string, unknown>>,
  people?: PersonSetupEntry[],
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Core configs from templates (non-plugin configs only)
  for (const template of ALL_TEMPLATES) {
    if (template.relativePath.startsWith("config/plugins/")) {
      continue; // Plugin configs handled below
    }
    if (template.relativePath === "config/people.yaml" && people && people.length > 0) {
      files.push({ relativePath: template.relativePath, content: generatePeopleYaml(people) });
      continue;
    }
    files.push({ relativePath: template.relativePath, content: template.content });
  }

  // Plugin configs
  for (const pluginId of selectedPlugins) {
    files.push({
      relativePath: `config/plugins/${pluginId}.yaml`,
      content: generatePluginConfigContent(pluginId, pluginConfigs),
    });
  }

  // Example templates
  for (const template of ALL_EXAMPLE_TEMPLATES) {
    files.push({ relativePath: template.relativePath, content: template.content });
  }

  // Plugin documentation
  for (const doc of ALL_PLUGIN_DOCS) {
    files.push({ relativePath: doc.relativePath, content: doc.content });
  }

  return files;
}

/**
 * Write generated config files to disk.
 * Simple writeFileSync with mode 0o600. Creates parent directories as needed.
 * Recovery from partial write: re-run `engineer start` detects missing files and reruns setup.
 */
export function writeConfigFiles(engineerHome: string, files: GeneratedFile[]): void {
  for (const file of files) {
    const fullPath = join(engineerHome, file.relativePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(fullPath, file.content, { encoding: "utf8", mode: 0o600 });
  }
}

/** Generate people.yaml content from wizard data. */
function generatePeopleYaml(people: PersonSetupEntry[]): string {
  const peopleConfig = {
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      roles: p.roles,
      contacts: p.contacts,
      preferences: { notification_level: "milestones", quiet_hours: null },
    })),
  };
  return `# People configuration\n# Hot-reloadable — changes take effect without restart.\n\n${yamlStringify(peopleConfig)}`;
}

/** Generate a single plugin config file from user config and/or template. */
function generatePluginConfigContent(pluginId: string, pluginConfigs: Record<string, Record<string, unknown>>): string {
  const userConfig = pluginConfigs[pluginId];
  const template = ALL_TEMPLATES.find((t) => t.relativePath === `config/plugins/${pluginId}.yaml`);
  const hasUserConfig = userConfig && Object.keys(userConfig).length > 0;

  if (hasUserConfig && template) {
    const templateData = (yamlParse(template.content) as Record<string, unknown>) ?? {};
    return yamlStringify({ ...templateData, ...userConfig });
  }
  if (hasUserConfig) {
    return yamlStringify(userConfig);
  }
  return template?.content ?? "# Using defaults\n";
}

// ── Env Var Scanning ─────────────────────────────────────────────────────────

const ENV_VAR_SCAN_RE = /\$\{([^}]+)\}/g;

/**
 * Scan all YAML config files for ${VAR} references and return those that
 * ARE set in process.env (with their values). Used to persist shell exports to .env.
 */
export function findResolvedEnvVars(configDir: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (!existsSync(configDir)) {
    return resolved;
  }

  scanYamlEnvVars(configDir, (varName) => {
    const value = process.env[varName];
    if (value != null && value.length > 0) {
      resolved[varName] = value;
    }
  });

  return resolved;
}

/**
 * Scan all YAML config files for ${VAR} references and return any that
 * are not set in process.env. Call AFTER loadEnvFile() so .env is loaded.
 */
export function findUnresolvedEnvVars(configDir: string): string[] {
  const missing: string[] = [];
  if (!existsSync(configDir)) {
    return missing;
  }

  scanYamlEnvVars(configDir, (varName) => {
    if ((process.env[varName] === undefined || process.env[varName] === "") && !missing.includes(varName)) {
      missing.push(varName);
    }
  });

  return missing.sort();
}

/** Recursively scan a directory for YAML files and call visitor with each ${VAR} name found. */
function scanYamlEnvVars(dir: string, visitor: (varName: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      scanYamlEnvVars(join(dir, entry.name), visitor);
      continue;
    }
    if (!(entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      continue;
    }
    const content = readFileSync(join(dir, entry.name), "utf8");
    for (const match of content.matchAll(ENV_VAR_SCAN_RE)) {
      if (match[1]) {
        visitor(match[1]);
      }
    }
  }
}

// ── Plugin Documentation ─────────────────────────────────────────────────────

/**
 * Write bundled plugin documentation to ~/.engineer/docs/.
 * Called before prompts so doc paths are clickable during selection.
 */
export function writePluginDocs(engineerHome: string): void {
  for (const doc of ALL_PLUGIN_DOCS) {
    const fullPath = join(engineerHome, doc.relativePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(fullPath, doc.content, { encoding: "utf8", mode: 0o644 });
  }
}
