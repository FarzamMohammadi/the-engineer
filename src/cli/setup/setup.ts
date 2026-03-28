import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stringify as yamlStringify } from "yaml";

import { writeEnvFile } from "../../config/env.js";
import { BUILTIN_PLUGINS } from "../../plugins/builtin.js";
import type { PluginRequirement } from "../../schemas/adapters.js";
import { resolveDirectories } from "../home.js";
import { getOutput } from "../output.js";
import { ALL_EXAMPLE_TEMPLATES, ALL_TEMPLATES } from "../templates.js";
import type { DetectionResult } from "./types.js";
import type { AdapterTypeConfig } from "./types.js";

export type { DetectionResult } from "./types.js";
export type { AdapterTypeConfig } from "./types.js";

// ── Adapter Type Configuration ───────────────────────────────────────────────

export const ADAPTER_TYPE_CONFIGS: AdapterTypeConfig[] = [
  {
    type: "llm",
    label: "Which AI do you use?",
    selectionMode: "single",
    setupOrder: 1,
    required: true,
  },
  {
    type: "trigger",
    label: "Where do your tasks come from?",
    selectionMode: "single",
    setupOrder: 2,
    required: true,
  },
  {
    type: "git_hosting",
    label: "Where does your code live?",
    selectionMode: "single",
    setupOrder: 3,
    required: true,
  },
  {
    type: "communication",
    label: "How should The Engineer reach you?",
    selectionMode: "multi",
    setupOrder: 4,
    required: false,
  },
  {
    type: "tool",
    label: "Which tools should The Engineer use?",
    selectionMode: "multi",
    setupOrder: 5,
    required: true,
  },
];

// ── Pure Detection Functions ─────────────────────────────────────────────────

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

/** Check if all of a plugin's requirements are met by the detection result. */
export function checkRequirementsMet(
  plugin: { requirements: readonly PluginRequirement[] },
  detection: DetectionResult,
): boolean {
  for (const req of plugin.requirements) {
    if (req.type === "binary") {
      if (!detection.binaries[req.name]) {
        return false;
      }
    } else if (req.type === "env") {
      if (!detection.envVars.has(req.name)) {
        return false;
      }
    }
    // Unknown requirement types: skip gracefully (future extensibility)
  }
  return true;
}

/**
 * Parse `git remote -v` output and extract the origin remote's owner/name.
 * Returns null if origin is not found or the URL is unparseable.
 */
export function parseGitRemote(output: string): { owner: string; name: string } | null {
  // Find the "origin" remote (fetch line)
  const originLine = output
    .split("\n")
    .find((line) => line.startsWith("origin") && line.includes("(fetch)"));
  if (!originLine) return null;

  const url = originLine.split(/\s+/)[1];
  if (!url) return null;

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/[:\/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  return null;
}

// ── I/O Detection Wrapper ────────────────────────────────────────────────────

const DETECTION_TIMEOUT_MS = 5_000;

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

// ── Config Generation ────────────────────────────────────────────────────────

export interface GeneratedFile {
  relativePath: string;
  content: string;
}

/**
 * Generate config files for the given plugin selection. Pure function.
 * Returns core configs (conservative defaults) + plugin configs (env var refs for secrets).
 */
export function generateConfigFiles(
  selectedPlugins: string[],
  pluginConfigs: Record<string, Record<string, unknown>>,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Core configs from templates (non-plugin configs only)
  for (const template of ALL_TEMPLATES) {
    if (template.relativePath.startsWith("config/plugins/")) {
      continue; // Plugin configs handled below
    }
    files.push({ relativePath: template.relativePath, content: template.content });
  }

  // Plugin configs: user-provided values override templates
  for (const pluginId of selectedPlugins) {
    const userConfig = pluginConfigs[pluginId];
    if (userConfig && Object.keys(userConfig).length > 0) {
      // User provided config — use it
      files.push({
        relativePath: `config/plugins/${pluginId}.yaml`,
        content: yamlStringify(userConfig),
      });
    } else {
      // Try template, fall back to defaults comment
      const template = ALL_TEMPLATES.find(
        (t) => t.relativePath === `config/plugins/${pluginId}.yaml`,
      );
      files.push({
        relativePath: `config/plugins/${pluginId}.yaml`,
        content: template?.content ?? "# Using defaults\n",
      });
    }
  }

  // Example templates
  for (const template of ALL_EXAMPLE_TEMPLATES) {
    files.push({ relativePath: template.relativePath, content: template.content });
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

// ── First-Run Detection ──────────────────────────────────────────────────────

/**
 * Check if first-run setup is needed.
 * True if config dir doesn't exist OR plugins dir has no .yaml files.
 */
export function needsSetup(engineerHome: string): boolean {
  const dirs = resolveDirectories(engineerHome);
  if (!existsSync(dirs.config)) return true;
  if (!existsSync(dirs.plugins)) return true;
  const yamlFiles = readdirSync(dirs.plugins).filter((f) => f.endsWith(".yaml"));
  return yamlFiles.length === 0;
}

// ── Setup Orchestrator ───────────────────────────────────────────────────────

export interface SetupOptions {
  engineerHome: string;
  pluginsPath?: string;
  dryRun?: boolean;
}

/**
 * Run first-time setup. Returns true if completed, false if user cancelled.
 * Orchestrates: detect → guide → prompt → generate → write.
 */
export async function runFirstTimeSetup(options: SetupOptions): Promise<boolean> {
  const { engineerHome, pluginsPath, dryRun } = options;
  const out = getOutput();

  // Ensure base directories exist (even for dry-run, so detection can work)
  const dirs = resolveDirectories(engineerHome);
  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // Non-interactive mode: copy provided plugin configs
  if (pluginsPath) {
    return runNonInteractiveSetup(engineerHome, pluginsPath, dryRun ?? false);
  }

  // Interactive mode
  out.blank();
  out.log("  First run — auto-configuring from environment...");
  out.blank();

  const detection = runDetection();

  // Lazy import to avoid loading @inquirer/prompts unless needed
  const { runGuidedSetup } = await import("./prompts.js");
  const result = await runGuidedSetup(detection, BUILTIN_PLUGINS, ADAPTER_TYPE_CONFIGS);

  if (!result) {
    out.blank();
    out.log("  No configuration was written.");
    out.log(`  To configure manually, create YAML files in ${dirs.plugins}`);
    return false;
  }

  const files = generateConfigFiles(result.selectedPlugins, result.pluginConfigs);

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

// ── Non-Interactive Setup ────────────────────────────────────────────────────

function runNonInteractiveSetup(
  engineerHome: string,
  pluginsPath: string,
  dryRun: boolean,
): boolean {
  const out = getOutput();

  if (!existsSync(pluginsPath)) {
    out.error(`Plugin config directory not found: ${pluginsPath}`);
    return false;
  }

  const yamlFiles = readdirSync(pluginsPath).filter((f) => f.endsWith(".yaml"));
  if (yamlFiles.length === 0) {
    out.error(`No .yaml files found in ${pluginsPath}`);
    return false;
  }

  if (dryRun) {
    out.blank();
    out.log("  Dry run — would copy from ${pluginsPath}:");
    for (const file of yamlFiles) {
      out.log(`    config/plugins/${file}`);
    }
    out.log("  Plus core configs with conservative defaults.");
    out.blank();
    return true;
  }

  // Copy plugin configs
  const dirs = resolveDirectories(engineerHome);
  for (const file of yamlFiles) {
    const source = join(pluginsPath, file);
    const dest = join(dirs.plugins, file);
    const content = readFileSync(source, "utf8");
    writeFileSync(dest, content, { encoding: "utf8", mode: 0o600 });
  }

  // Write core configs with defaults
  const coreTemplates = ALL_TEMPLATES.filter((t) => !t.relativePath.startsWith("config/plugins/"));
  for (const template of coreTemplates) {
    const fullPath = join(engineerHome, template.relativePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(fullPath, template.content, { encoding: "utf8", mode: 0o600 });
  }

  out.success(`Copied ${String(yamlFiles.length)} plugin config(s) from ${pluginsPath}`);
  return true;
}
