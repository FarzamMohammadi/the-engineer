import { checkbox, confirm, input, password, select } from "@inquirer/prompts";

import type { BuiltinPlugin } from "../../plugins/builtin.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import { getOutput } from "../output.js";
import { ALL_TEMPLATES } from "../templates.js";
import type {
  AdapterTypeConfig,
  DetectionResult,
  GuidedSetupResult,
  PersonSetupEntry,
} from "./types.js";

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

/** Normalize adapter type to directory name (git_hosting → git-hosting). */
function typeToDirName(type: string): string {
  return type.replace(/_/g, "-");
}

/** Convention-derived doc path for a plugin. */
export function pluginDocPath(engineerHome: string, type: string, id: string): string {
  return `${engineerHome}/docs/plugins/${typeToDirName(type)}/${id}.md`;
}

/** Convention-derived doc path for an adapter type README. */
export function adapterDocPath(engineerHome: string, type: string): string {
  return `${engineerHome}/docs/plugins/${typeToDirName(type)}/README.md`;
}

/** Build the description shown below each choice: manifest description + both doc paths. */
function buildChoiceDescription(plugin: BuiltinPlugin, engineerHome: string): string {
  const adapterPath = adapterDocPath(engineerHome, plugin.manifest.type);
  const pluginPath = pluginDocPath(engineerHome, plugin.manifest.type, plugin.manifest.id);
  return `${plugin.manifest.description}\n  Adapter docs → ${adapterPath}\n  Plugin docs  → ${pluginPath}`;
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
  engineerHome: string,
): Promise<string[]> {
  const choices = typePlugins.map((p) => {
    const detected = checkRequirementsMet(p.manifest, detection);
    const combined = isCombinedWith(p, alreadySelected);
    let name = formatPluginChoice(p, detected);
    if (combined) {
      name += " (recommended)";
    }
    return { name, value: p.manifest.id, description: buildChoiceDescription(p, engineerHome) };
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
  engineerHome: string,
): Promise<string[]> {
  const choices = typePlugins.map((p) => {
    const detected = checkRequirementsMet(p.manifest, detection);
    const combined = isCombinedWith(p, alreadySelected);
    const preChecked = detected || combined;
    return {
      name: formatPluginChoice(p, detected),
      value: p.manifest.id,
      checked: preChecked,
      description: buildChoiceDescription(p, engineerHome),
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
  engineerHome: string,
): Promise<string[]> {
  if (config.selectionMode === "single") {
    return promptSingleSelect(config, typePlugins, detection, alreadySelected, engineerHome);
  }
  return promptMultiSelect(config, typePlugins, detection, alreadySelected, engineerHome);
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
      // Persist to .env so the daemon has it even without the shell export
      secrets[varName] = existing;
      out.log(`  ${varName} (captured from environment)`);
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

  if (!selectedTypes.has(AdapterTypes.trigger)) {
    out.warn("No trigger plugin selected. The Engineer will start but won't pick up tasks.");
  }
  if (!selectedTypes.has(AdapterTypes.llm)) {
    out.warn("No LLM plugin selected. The Engineer cannot reason without an LLM.");
  }
  if (!selectedTypes.has(AdapterTypes.communication)) {
    out.warn("No communication plugin selected. The Engineer won't send notifications.");
  }
  if (!selectedTypes.has(AdapterTypes.git_hosting)) {
    out.warn("No git hosting plugin selected. The Engineer won't create PRs.");
  }
}

// ── People Directory ────────────────────────────────────────────────────────

const WHITESPACE_PATTERN = /\s+/;
const IDENTIFIER_PATTERN = /^[a-z0-9_-]+$/;
const PEOPLE_ROLES = ["reviewer", "stakeholder", "team_member"] as const;

/**
 * Resolve comm channel names from selected plugin manifests.
 * Returns array of { channel, pluginName } for each comm plugin with a declared channel.
 */
function resolveCommChannels(
  selectedPlugins: readonly string[],
  plugins: readonly BuiltinPlugin[],
): Array<{ channel: string; pluginName: string }> {
  return plugins
    .filter(
      (p) =>
        p.manifest.type === AdapterTypes.communication && selectedPlugins.includes(p.manifest.id),
    )
    .map((p) => ({
      channel: String(p.manifest.adapter_meta["channel"] ?? p.manifest.id),
      pluginName: p.manifest.name,
    }))
    .filter((c) => c.channel.length > 0);
}

/** Prompt for a single person's details. */
async function promptForPerson(
  commChannels: Array<{ channel: string; pluginName: string }>,
  isOwner: boolean,
): Promise<PersonSetupEntry> {
  const name = await input({
    message: isOwner ? "Your name:" : "Person's name:",
    validate: (v: string) => v.trim().length > 0 || "Name cannot be empty",
  });

  const defaultId = name.trim().toLowerCase().split(WHITESPACE_PATTERN)[0] ?? "user";
  const id = await input({
    message: "Identifier (used in configs):",
    default: defaultId,
    validate: (v: string) =>
      IDENTIFIER_PATTERN.test(v.trim()) || "Lowercase alphanumeric, hyphens, underscores only",
  });

  let roles: string[];
  if (isOwner) {
    roles = ["owner"];
  } else {
    const selectedRoles = await checkbox({
      message: "Roles:",
      choices: PEOPLE_ROLES.map((r) => ({ name: r, value: r })),
      required: true,
    });
    roles = selectedRoles;
  }

  const contacts: Array<{ channel: string; handle: string }> = [];
  for (const ch of commChannels) {
    const handle = await input({
      message: `Your ${ch.pluginName} handle:`,
      validate: (v: string) => v.trim().length > 0 || "Handle cannot be empty",
    });
    contacts.push({ channel: ch.channel, handle: handle.trim() });
  }

  return { id: id.trim(), name: name.trim(), roles, contacts };
}

/** Prompt for People Directory entries (owner required, additional people optional). */
async function promptForPeople(
  selectedPlugins: readonly string[],
  plugins: readonly BuiltinPlugin[],
): Promise<PersonSetupEntry[]> {
  const out = getOutput();
  const commChannels = resolveCommChannels(selectedPlugins, plugins);

  if (commChannels.length === 0) {
    out.log("  No communication plugins selected — skipping people setup.");
    return [];
  }

  out.blank();
  out.log("  People Directory — who should The Engineer contact?");
  out.blank();

  // Owner is always required
  out.log("  Owner (required):");
  const owner = await promptForPerson(commChannels, true);
  const people: PersonSetupEntry[] = [owner];

  // Additional people (optional loop)
  let addMore = await confirm({ message: "Add another person?", default: false });
  while (addMore) {
    out.blank();
    const person = await promptForPerson(commChannels, false);
    people.push(person);
    addMore = await confirm({ message: "Add another person?", default: false });
  }

  return people;
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
  engineerHome: string,
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

      const selected = await promptForAdapterType(
        config,
        typePlugins,
        detection,
        allSelected,
        engineerHome,
      );
      allSelected.push(...selected);
    }

    // Warnings for gaps
    showSelectionWarnings(allSelected, plugins);

    // Per-plugin config (user-specific values like repos)
    const pluginConfigs = await configureSelectedPlugins(allSelected, plugins);

    // People Directory (owner required, additional people optional)
    const people = await promptForPeople(allSelected, plugins);

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
    if (people.length > 0) {
      out.log(`  People: ${people.map((p) => `${p.name} (${p.roles.join(", ")})`).join(", ")}`);
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

    return { selectedPlugins: allSelected, pluginConfigs, secrets, people };
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return null;
    }
    throw error;
  }
}
