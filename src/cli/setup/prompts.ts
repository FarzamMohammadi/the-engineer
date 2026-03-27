import { checkbox, confirm, input, select } from "@inquirer/prompts";

import type { BuiltinPlugin } from "../../plugins/builtin.js";
import { getOutput } from "../output.js";
import type { AdapterTypeConfig, DetectionResult, GuidedSetupResult } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function checkRequirementsMet(
  plugin: { requirements: ReadonlyArray<{ type: string; name: string }> },
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
  }
  return true;
}

function isCombinedWith(plugin: BuiltinPlugin, alreadySelected: readonly string[]): boolean {
  const combinedWith = plugin.manifest.combined_with;
  if (!combinedWith || combinedWith.length === 0) {
    return false;
  }
  return alreadySelected.some((id) => combinedWith.includes(id));
}

function formatPluginChoice(plugin: BuiltinPlugin, detected: boolean): string {
  return detected ? `${plugin.manifest.name} (detected)` : plugin.manifest.name;
}

// ── Detection Summary ────────────────────────────────────────────────────────

function showDetectionSummary(detection: DetectionResult): void {
  const out = getOutput();
  out.log("  Detected:");
  for (const [name, path] of Object.entries(detection.binaries)) {
    const status = path ? `found (${path})` : "not found";
    out.log(`    ${name.padEnd(22)} ${status}`);
  }
  for (const name of detection.envVars) {
    out.log(`    ${name.padEnd(22)} found`);
  }
  if (detection.gitRemote) {
    out.log(
      `    ${"Current repo".padEnd(22)} ${detection.gitRemote.owner}/${detection.gitRemote.name}`,
    );
  }
  out.blank();
}

// ── Per-Adapter-Type Prompts ─────────────────────────────────────────────────

async function promptSingleSelect(
  config: AdapterTypeConfig,
  typePlugins: readonly BuiltinPlugin[],
  detection: DetectionResult,
  alreadySelected: readonly string[],
): Promise<string[]> {
  const choices = typePlugins.map((p) => {
    const detected = checkRequirementsMet(p.manifest, detection);
    const combined = isCombinedWith(p, alreadySelected);
    let name = formatPluginChoice(p, detected);
    if (combined) {
      name += " (recommended)";
    }
    return { name, value: p.manifest.id };
  });

  // Pre-select: combined_with match first, then detected, then first
  const combined = typePlugins.find((p) => isCombinedWith(p, alreadySelected));
  const detected = typePlugins.find((p) => checkRequirementsMet(p.manifest, detection));
  const defaultValue = combined?.manifest.id ?? detected?.manifest.id ?? choices[0]?.value;

  const selected = await select({
    message: config.label,
    choices,
    default: defaultValue,
  });

  return [selected];
}

async function promptMultiSelect(
  config: AdapterTypeConfig,
  typePlugins: readonly BuiltinPlugin[],
  detection: DetectionResult,
  alreadySelected: readonly string[],
): Promise<string[]> {
  const choices = typePlugins.map((p) => {
    const detected = checkRequirementsMet(p.manifest, detection);
    const combined = isCombinedWith(p, alreadySelected);
    const preChecked = detected || combined;
    return {
      name: formatPluginChoice(p, detected),
      value: p.manifest.id,
      checked: preChecked,
    };
  });

  const selected = await checkbox({
    message: config.label,
    choices,
    required: config.required,
  });

  return selected;
}

function promptForAdapterType(
  config: AdapterTypeConfig,
  typePlugins: readonly BuiltinPlugin[],
  detection: DetectionResult,
  alreadySelected: readonly string[],
): Promise<string[]> {
  if (config.selectionMode === "single") {
    return promptSingleSelect(config, typePlugins, detection, alreadySelected);
  }
  return promptMultiSelect(config, typePlugins, detection, alreadySelected);
}

// ── Per-Plugin Config ────────────────────────────────────────────────────────

async function configureSelectedPlugins(
  selectedPlugins: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const configs: Record<string, Record<string, unknown>> = {};

  // GitHub token — shared across all selected github-* plugins
  const githubPlugins = selectedPlugins.filter((id) => id.startsWith("github-"));
  if (githubPlugins.length > 0) {
    const tokenRef = "${GITHUB_TOKEN}";
    for (const id of githubPlugins) {
      configs[id] = { github_token: tokenRef };
    }
  }

  // GitHub trigger repos
  if (selectedPlugins.includes("github-trigger")) {
    const repos = await promptForRepos();
    const triggerConfig = configs["github-trigger"];
    if (triggerConfig) {
      triggerConfig["repos"] = repos;
    }
  }

  // Telegram config
  if (selectedPlugins.includes("telegram-comm")) {
    configs["telegram-comm"] = {
      bot_token: "${TELEGRAM_BOT_TOKEN}",
      chat_id: "${TELEGRAM_CHAT_ID}",
    };
  }

  return configs;
}

async function promptForRepos(): Promise<Array<{ owner: string; name: string }>> {
  const repoInput = await input({
    message: "Repo to watch (owner/name):",
    validate: (v) => /^[^/]+\/[^/]+$/.test(v.trim()) || "Format: owner/name",
  });
  const parts = repoInput.trim().split("/");
  return [{ owner: parts[0] ?? "", name: parts[1] ?? "" }];
}

// ── Warnings ─────────────────────────────────────────────────────────────────

function showSelectionWarnings(
  selectedPlugins: readonly string[],
  plugins: readonly BuiltinPlugin[],
): void {
  const out = getOutput();
  const selectedTypes = new Set(
    plugins.filter((p) => selectedPlugins.includes(p.manifest.id)).map((p) => p.manifest.type),
  );

  if (!selectedTypes.has("trigger")) {
    out.warn("No trigger plugin selected. The Engineer will start but won't pick up tasks.");
  }
  if (!selectedTypes.has("llm")) {
    out.warn("No LLM plugin selected. The Engineer cannot reason without an LLM.");
  }
  if (!selectedTypes.has("communication")) {
    out.warn("No communication plugin selected. The Engineer won't send notifications.");
  }
  if (!selectedTypes.has("git_hosting")) {
    out.warn("No git hosting plugin selected. The Engineer won't create PRs.");
  }
}

// ── Main Flow ────────────────────────────────────────────────────────────────

/**
 * Run the guided first-run setup flow. One prompt per adapter type.
 * Returns null if user cancels (Ctrl+C or declines confirmation).
 */
export async function runGuidedSetup(
  detection: DetectionResult,
  plugins: readonly BuiltinPlugin[],
  adapterConfigs: readonly AdapterTypeConfig[],
): Promise<GuidedSetupResult | null> {
  const out = getOutput();

  try {
    showDetectionSummary(detection);

    // Per-adapter-type selection, sorted by setupOrder
    const sorted = [...adapterConfigs].sort((a, b) => a.setupOrder - b.setupOrder);
    const allSelected: string[] = [];

    for (const config of sorted) {
      const typePlugins = plugins.filter((p) => p.manifest.type === config.type);
      if (typePlugins.length === 0) {
        continue;
      }

      const selected = await promptForAdapterType(config, typePlugins, detection, allSelected);
      allSelected.push(...selected);
    }

    // Warnings for gaps
    showSelectionWarnings(allSelected, plugins);

    // Per-plugin config (tokens, repos, etc.)
    const pluginConfigs = await configureSelectedPlugins(allSelected);

    // Summary
    out.blank();
    out.log("  Selected plugins:");
    for (const id of allSelected) {
      const plugin = plugins.find((p) => p.manifest.id === id);
      if (plugin) {
        out.log(`    ${plugin.manifest.name}`);
      }
    }
    out.blank();
    out.log("  Safety: conservative (default)");
    out.blank();

    const proceed = await confirm({
      message: "Start with these settings?",
      default: true,
    });

    if (!proceed) {
      return null;
    }

    return { selectedPlugins: allSelected, pluginConfigs };
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return null;
    }
    throw error;
  }
}
