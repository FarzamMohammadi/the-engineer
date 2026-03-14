import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkbox } from "@inquirer/prompts";
import { parse as parseYaml } from "yaml";

import type { PluginManifest } from "../../schemas/adapters.js";
import type { EngineerDirs } from "../home.js";
import { resolveSubdirs } from "../home.js";
import { type Output, getOutput } from "../output.js";
import { ALL_EXAMPLE_TEMPLATES, ALL_TEMPLATES, type TemplateFile } from "../templates.js";

export interface InitOptions {
  force: boolean;
  seedDir: string;
  /** Skip interactive prompts and install all plugins. Used by tests and --all-plugins flag. */
  allPlugins?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_CONFIG_RE = /config\/plugins\/(.+)\.yaml$/;

// ── Plugin Source Resolution ────────────────────────────────────────────────

interface AvailablePlugin {
  manifest: PluginManifest;
  sourceDir: string;
}

/**
 * Find available plugins from src/plugins/ relative to the CLI source.
 * In dev (tsx): this file is at src/cli/commands/, plugins at src/plugins/.
 * After build (tsdown): this file is at dist/, plugins at dist/plugins/ (copied by build).
 */
function scanAvailablePlugins(): AvailablePlugin[] {
  const pluginsRoot = resolve(THIS_DIR, "..", "..", "plugins");
  if (!existsSync(pluginsRoot)) {
    return [];
  }

  const results: AvailablePlugin[] = [];
  scanPluginDir(pluginsRoot, results);
  return results;
}

function scanPluginDir(dir: string, results: AvailablePlugin[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanPluginDir(fullPath, results);
    } else if (entry.name === "engineer.plugin.yaml") {
      parseAndAddManifest(fullPath, dir, results);
    }
  }
}

function parseAndAddManifest(manifestPath: string, dir: string, results: AvailablePlugin[]): void {
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = parseYaml(raw) as PluginManifest;
    if (manifest.id && manifest.type && manifest.enabled !== false) {
      results.push({ manifest, sourceDir: dir });
    }
  } catch {
    // Skip invalid manifests
  }
}

// ── Plugin Selection ────────────────────────────────────────────────────────

async function selectPlugins(available: AvailablePlugin[]): Promise<AvailablePlugin[]> {
  const typePriority: Record<string, number> = {
    trigger: 1,
    llm: 2,
    tool: 3,
    git_hosting: 4,
    communication: 5,
  };

  const choices = available
    .map((p) => ({
      name: `${p.manifest.name} — ${p.manifest.description}`,
      value: p.manifest.id,
      checked: true,
      _type: p.manifest.type,
    }))
    .sort((a, b) => (typePriority[a._type] ?? 99) - (typePriority[b._type] ?? 99));

  const selectedIds = await checkbox({
    message: "Select plugins to install:",
    choices,
  });

  return available.filter((p) => selectedIds.includes(p.manifest.id));
}

// ── Plugin Installation ─────────────────────────────────────────────────────

function installPlugins(
  selected: AvailablePlugin[],
  installedPluginsDir: string,
  force: boolean,
): string[] {
  const installed: string[] = [];

  for (const plugin of selected) {
    const destDir = join(installedPluginsDir, plugin.manifest.id);

    if (existsSync(destDir) && !force) {
      installed.push(`${plugin.manifest.id} (exists, skipped)`);
      continue;
    }

    mkdirSync(destDir, { recursive: true });
    cpSync(plugin.sourceDir, destDir, {
      recursive: true,
      filter: (src) => !src.endsWith(".test.ts"),
    });
    installed.push(plugin.manifest.id);
  }

  return installed;
}

// ── Template Writing ────────────────────────────────────────────────────────

function writeTemplates(
  out: Output,
  engineerHome: string,
  templates: TemplateFile[],
  installedPluginIds: Set<string>,
  seedDir: string,
  hasSeed: boolean,
  force: boolean,
): void {
  for (const template of templates) {
    if (shouldSkipPluginConfig(template.relativePath, installedPluginIds)) {
      continue;
    }

    const filePath = join(engineerHome, template.relativePath);
    if (existsSync(filePath) && !force) {
      out.log(`    ${template.relativePath} (exists, skipped)`);
      continue;
    }

    const seedPath = join(seedDir, template.relativePath);
    const fromSeed = hasSeed && existsSync(seedPath);
    const content = fromSeed ? readFileSync(seedPath, "utf8") : template.content;
    const source = fromSeed ? "from seed" : "template";

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    out.log(`    ${template.relativePath} (${source})`);
  }
}

function shouldSkipPluginConfig(relativePath: string, installedIds: Set<string>): boolean {
  const match = PLUGIN_CONFIG_RE.exec(relativePath);
  if (!match) {
    return false;
  }
  const pluginId = match[1];
  return pluginId !== undefined && !installedIds.has(pluginId);
}

function writeExamples(out: Output, engineerHome: string): void {
  for (const example of ALL_EXAMPLE_TEMPLATES) {
    const filePath = join(engineerHome, example.relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, example.content, "utf8");
    out.log(`    ${example.relativePath}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

/** Creates ~/.engineer/ directory structure, prompts for plugin selection, and generates config files. */
export async function runInit(engineerHome: string, options: InitOptions): Promise<void> {
  const out = getOutput();
  const dirs = resolveSubdirs(engineerHome);
  const hasSeed = existsSync(options.seedDir);

  createDirectories(out, dirs);
  const installedPluginIds = await discoverAndInstallPlugins(out, dirs, options);

  if (hasSeed) {
    out.blank();
    out.log(`  Seed directory found: ${options.seedDir}`);
  }

  out.blank();
  out.log("  Generated config files:");
  writeTemplates(
    out,
    engineerHome,
    ALL_TEMPLATES,
    installedPluginIds,
    options.seedDir,
    hasSeed,
    options.force,
  );

  out.blank();
  out.log("  Example templates (full reference with all fields documented):");
  writeExamples(out, engineerHome);

  out.blank();
  out.log("  Next steps:");
  if (!hasSeed) {
    out.log("    0. Run `engineer prepare` to create a reusable seed directory");
  }
  out.log(`    1. Browse examples:    ls ${dirs.examples}/`);
  out.log(`    2. Edit config files:  $EDITOR ${dirs.plugins}/github-trigger.yaml`);
  out.log("    3. Set env variables:  export GITHUB_TOKEN=ghp_...");
  out.log("    4. Validate setup:     engineer doctor");
  out.log("    5. Start:              engineer start");
}

function createDirectories(out: Output, dirs: EngineerDirs): void {
  const dirPaths = [
    dirs.config,
    dirs.plugins,
    dirs.installedPlugins,
    dirs.data,
    dirs.logs,
    dirs.run,
    dirs.workspaces,
    dirs.traces,
    dirs.examples,
  ];
  for (const dirPath of dirPaths) {
    mkdirSync(dirPath, { recursive: true });
    out.log(`  Created ${dirPath}/`);
  }
}

const TYPE_LABELS: Record<string, string> = {
  trigger: "Trigger (event sources)",
  communication: "Communication (notifications)",
  llm: "LLM (reasoning engine)",
  tool: "Tool (action execution)",
  git_hosting: "Git Hosting (PR lifecycle)",
};

async function discoverAndInstallPlugins(
  out: Output,
  dirs: EngineerDirs,
  options: InitOptions,
): Promise<Set<string>> {
  out.blank();
  const available = scanAvailablePlugins();

  if (available.length === 0) {
    out.warn("  No plugins found. Plugins can be added later to ~/.engineer/plugins/");
    return new Set();
  }

  out.log(`  Found ${String(available.length)} available plugins:`);
  for (const p of available) {
    const typeLabel = TYPE_LABELS[p.manifest.type] ?? p.manifest.type;
    const critical = p.manifest.critical ? " [CRITICAL]" : "";
    out.log(`    ${p.manifest.id} (${typeLabel})${critical}`);
  }
  out.blank();

  const selected = options.allPlugins ? available : await selectPlugins(available);
  const installed = installPlugins(selected, dirs.installedPlugins, options.force);
  out.blank();
  out.log("  Installed plugins:");
  for (const id of installed) {
    out.log(`    ${id}`);
  }

  return new Set(
    readdirSync(dirs.installedPlugins, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
}
