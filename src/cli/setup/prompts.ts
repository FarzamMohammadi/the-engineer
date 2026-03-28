import { checkbox, confirm, input, password, select } from "@inquirer/prompts";

import type { BuiltinPlugin } from "../../plugins/builtin.js";
import { getOutput } from "../output.js";
import { ALL_TEMPLATES } from "../templates.js";
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
  plugins: readonly BuiltinPlugin[],
): Promise<Record<string, Record<string, unknown>>> {
  const configs: Record<string, Record<string, unknown>> = {};

  // Plugin configs with ${VAR} references come from templates (templates.ts).
  // This function only prompts for values that templates can't provide (user-specific data).
  // Secrets (tokens) are handled by promptForSecrets() which scans ALL ${VAR} refs dynamically.

  for (const pluginId of selectedPlugins) {
    const plugin = plugins.find((p) => p.manifest.id === pluginId);
    if (plugin?.promptForConfig) {
      configs[pluginId] = await plugin.promptForConfig();
    }
  }

  return configs;
}

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Scan generated config file content for ${VAR} references and prompt for each unique secret.
 * Fully dynamic — derives vars from whatever templates + user configs produce.
 * Skips vars already set in process.env.
 */
async function promptForSecrets(fileContents: readonly string[]): Promise<Record<string, string>> {
  const out = getOutput();
  const varNames = new Set<string>();

  // Collect all ${VAR} references from all generated file content
  for (const content of fileContents) {
    ENV_VAR_PATTERN.lastIndex = 0;
    let match = ENV_VAR_PATTERN.exec(content);
    while (match) {
      if (match[1]) {
        varNames.add(match[1]);
      }
      match = ENV_VAR_PATTERN.exec(content);
    }
  }

  if (varNames.size === 0) {
    return {};
  }

  const secrets: Record<string, string> = {};
  const sorted = [...varNames].sort();

  out.blank();
  for (const varName of sorted) {
    const existing = process.env[varName];
    if (existing != null && existing.trim().length > 0) {
      out.log(`  ${varName} (already set in environment)`);
      continue;
    }

    // Use plain input for IDs, masked password for tokens/secrets
    const validate = (v: string) => v.trim().length > 0 || "Value cannot be empty";
    if (varName.endsWith("_ID")) {
      secrets[varName] = await input({ message: `${varName}:`, validate });
    } else {
      secrets[varName] = await password({ message: `${varName}:`, mask: "*", validate });
    }
  }

  return secrets;
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

    // Per-plugin config (user-specific values like repos)
    const pluginConfigs = await configureSelectedPlugins(allSelected, plugins);

    // Collect secrets — scan templates for selected plugins' ${VAR} references
    const selectedTemplateContent = ALL_TEMPLATES.filter((t) => {
      if (!t.relativePath.startsWith("config/plugins/")) {
        return false;
      }
      const pluginId = t.relativePath.replace("config/plugins/", "").replace(".yaml", "");
      return allSelected.includes(pluginId);
    }).map((t) => t.content);
    const secrets = await promptForSecrets(selectedTemplateContent);

    // Summary
    out.blank();
    out.log("  Selected plugins:");
    for (const id of allSelected) {
      const plugin = plugins.find((p) => p.manifest.id === id);
      if (plugin) {
        out.log(`    ${plugin.manifest.name}`);
      }
    }
    const secretNames = Object.keys(secrets);
    if (secretNames.length > 0) {
      out.log(`  Secrets: ${secretNames.join(", ")} (saved to ~/.engineer/.env)`);
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

    return { selectedPlugins: allSelected, pluginConfigs, secrets };
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return null;
    }
    throw error;
  }
}
