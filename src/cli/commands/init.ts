import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Separator, checkbox } from "@inquirer/prompts";
import chalk from "chalk";

import { BUILTIN_PLUGINS, type BuiltinPlugin } from "../../plugins/builtin.js";
import type { EngineerDirectories } from "../home.js";
import { resolveDirectories } from "../home.js";
import { type Output, getOutput } from "../output.js";
import { ALL_EXAMPLE_TEMPLATES, ALL_TEMPLATES, type TemplateFile } from "../templates.js";

export interface InitOptions {
  force: boolean;
  seedDir: string;
  /** Skip interactive prompts and install all plugins. Used by tests and --all-plugins flag. */
  allPlugins?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLUGIN_CONFIG_RE = /config\/plugins\/(.+)\.yaml$/;

// ── Plugin Selection ────────────────────────────────────────────────────────

const CATEGORY_ORDER: Array<{ type: string; label: string }> = [
  { type: "trigger", label: "Trigger:" },
  { type: "llm", label: "LLM Provider:" },
  { type: "tool", label: "Tool:" },
  { type: "git_hosting", label: "Git Hosting:" },
  { type: "communication", label: "Communication:" },
];

/** Single checkbox prompt — all plugins listed, grouped by category, all pre-checked. */
async function selectPlugins(available: BuiltinPlugin[]): Promise<BuiltinPlugin[]> {
  const choices: Array<{ name: string; value: string; checked: boolean } | Separator> = [];

  for (const cat of CATEGORY_ORDER) {
    const plugins = available.filter((p) => p.manifest.type === cat.type);
    if (plugins.length === 0) {
      continue;
    }
    if (choices.length > 0) {
      choices.push(new Separator(" "));
    }
    choices.push(new Separator(`  ${cat.label}`));
    for (const p of plugins) {
      choices.push({
        name: `${p.manifest.name} — ${p.manifest.description}`,
        value: p.manifest.id,
        checked: true,
      });
    }
  }

  const selectedIds = await checkbox({
    message: chalk.bold("Select plugins to enable:"),
    choices,
    required: true,
    loop: false,
  });

  return available.filter((p) => selectedIds.includes(p.manifest.id));
}

// ── Template Writing ────────────────────────────────────────────────────────

function writeTemplates(
  out: Output,
  engineerHome: string,
  templates: TemplateFile[],
  enabledPluginIds: Set<string>,
  seedDir: string,
  hasSeed: boolean,
  force: boolean,
): void {
  for (const template of templates) {
    if (shouldSkipPluginConfig(template.relativePath, enabledPluginIds)) {
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

function shouldSkipPluginConfig(relativePath: string, enabledIds: Set<string>): boolean {
  const match = PLUGIN_CONFIG_RE.exec(relativePath);
  if (!match) {
    return false;
  }
  const pluginId = match[1];
  return pluginId !== undefined && !enabledIds.has(pluginId);
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
  const dirs = resolveDirectories(engineerHome);
  const hasSeed = existsSync(options.seedDir);

  createDirectories(out, dirs);
  const enabledPluginIds = await promptAndSelectPlugins(out, options);

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
    enabledPluginIds,
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

function createDirectories(out: Output, dirs: EngineerDirectories): void {
  const dirPaths = [
    dirs.config,
    dirs.plugins,
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

async function promptAndSelectPlugins(out: Output, options: InitOptions): Promise<Set<string>> {
  out.blank();
  out.log("  ─────────────────────────────────────");
  out.blank();
  out.log(`  ${String(BUILTIN_PLUGINS.length)} built-in plugins available:`);
  for (const p of BUILTIN_PLUGINS) {
    const typeLabel = TYPE_LABELS[p.manifest.type] ?? p.manifest.type;
    const critical = p.manifest.critical ? " [CRITICAL]" : "";
    out.log(`    ${p.manifest.id} (${typeLabel})${critical}`);
  }

  out.blank();

  const selected = options.allPlugins ? BUILTIN_PLUGINS : await selectPlugins(BUILTIN_PLUGINS);
  out.blank();
  out.log("  Enabled plugins:");
  for (const p of selected) {
    out.log(`    ${p.manifest.id}`);
  }

  return new Set(selected.map((p) => p.manifest.id));
}
