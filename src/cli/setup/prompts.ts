import { confirm, input, select } from "@inquirer/prompts";

import type { BuiltinPlugin } from "../../plugins/builtin.js";
import { getOutput } from "../output.js";

/** Matches DetectionResult from setup.ts — duplicated to avoid circular import. */
interface DetectionInput {
  binaries: Record<string, string | null>;
  envVars: Set<string>;
  gitRemote: { owner: string; name: string } | null;
}

/** Check if all of a plugin's requirements are met. */
function checkRequirementsMet(
  plugin: { requirements: ReadonlyArray<{ type: string; name: string }> },
  detection: DetectionInput,
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

interface GuidedSetupResult {
  selectedPlugins: string[];
  pluginConfigs: Record<string, Record<string, unknown>>;
}

/**
 * Run the guided first-run setup flow. Thin interactive layer.
 * Returns null if user cancels (Ctrl+C or declines confirmation).
 */
export async function runGuidedSetup(
  detection: DetectionInput,
  plugins: readonly BuiltinPlugin[],
): Promise<GuidedSetupResult | null> {
  const out = getOutput();

  try {
    // Show detection results
    out.log("  Detected:");
    for (const [name, path] of Object.entries(detection.binaries)) {
      const status = path ? `found (${path})` : "not found";
      out.log(`    ${name.padEnd(20)} ${status}`);
    }
    for (const envName of ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
      const status = detection.envVars.has(envName) ? "found" : "not found";
      out.log(`    ${envName.padEnd(20)} ${status}`);
    }
    if (detection.gitRemote) {
      out.log(`    Current repo         ${detection.gitRemote.owner}/${detection.gitRemote.name}`);
    }
    out.blank();

    // Step 1: LLM selection (single-select)
    const llmPlugins = plugins.filter((p) => p.manifest.type === "llm");
    const detectedLlms = llmPlugins.filter((p) => checkRequirementsMet(p.manifest, detection));

    let selectedLlm = "";
    if (detectedLlms.length === 0) {
      out.warn("No LLM CLI detected on PATH. The Engineer needs an LLM to work.");
      out.log("  Install one of: claude, opencode, gemini");
      selectedLlm = await select({
        message: "Which AI do you use?",
        choices: llmPlugins.map((p) => ({ name: p.manifest.name, value: p.manifest.id })),
      });
    } else if (detectedLlms.length === 1) {
      const [detected] = detectedLlms;
      if (detected) {
        selectedLlm = detected.manifest.id;
        out.log(`  LLM: ${detected.manifest.name} (auto-detected)`);
      }
    } else {
      selectedLlm = await select({
        message: "Multiple LLM CLIs found. Which one do you use?",
        choices: detectedLlms.map((p) => ({ name: p.manifest.name, value: p.manifest.id })),
      });
    }

    // Step 2-3: Task source + code hosting (GitHub only today)
    const hasGitHub = detection.envVars.has("GITHUB_TOKEN");
    const githubPlugins = hasGitHub ? ["github-trigger", "github-comm", "github-hosting"] : [];

    if (hasGitHub) {
      out.log("  GitHub: enabled (trigger, communication, hosting)");
    } else {
      out.warn("GITHUB_TOKEN not found. GitHub plugins will be skipped.");
      out.log("  To fix: export GITHUB_TOKEN=ghp_... and restart.");
    }

    // Step 4: Communication
    const hasTelegram =
      detection.envVars.has("TELEGRAM_BOT_TOKEN") && detection.envVars.has("TELEGRAM_CHAT_ID");
    const telegramPlugins = hasTelegram ? ["telegram-comm"] : [];
    if (hasTelegram) {
      out.log("  Telegram: enabled");
    }

    // Bash tool — always included if bash is found
    const hasBash = detection.binaries["bash"] != null;
    const bashPlugins = hasBash ? ["bash-tool"] : [];

    // Assemble selection
    const selectedPlugins = [selectedLlm, ...githubPlugins, ...telegramPlugins, ...bashPlugins];

    // Step 5: Per-plugin config (only required fields without defaults)
    const pluginConfigs: Record<string, Record<string, unknown>> = {};

    // GitHub plugins share the token
    if (hasGitHub) {
      const tokenRef = "${GITHUB_TOKEN}";
      pluginConfigs["github-trigger"] = { github_token: tokenRef };
      pluginConfigs["github-comm"] = { github_token: tokenRef };
      pluginConfigs["github-hosting"] = { github_token: tokenRef };

      // Repos — detect from git remote or ask
      let repos: Array<{ owner: string; name: string }>;
      if (detection.gitRemote) {
        const { owner, name } = detection.gitRemote;
        const useDetected = await confirm({
          message: `Watch repo ${owner}/${name}?`,
          default: true,
        });
        if (useDetected) {
          repos = [{ owner, name }];
        } else {
          const repoInput = await input({
            message: "Repo to watch (owner/name):",
            validate: (v) => /^[^/]+\/[^/]+$/.test(v.trim()) || "Format: owner/name",
          });
          const parts = repoInput.trim().split("/");
          repos = [{ owner: parts[0] ?? "", name: parts[1] ?? "" }];
        }
      } else {
        const repoInput = await input({
          message: "Repo to watch (owner/name):",
          validate: (v) => /^[^/]+\/[^/]+$/.test(v.trim()) || "Format: owner/name",
        });
        const parts = repoInput.trim().split("/");
        repos = [{ owner: parts[0] ?? "", name: parts[1] ?? "" }];
      }
      const triggerConfig = pluginConfigs["github-trigger"];
      if (triggerConfig) {
        triggerConfig["repos"] = repos;
      }
    }

    // Telegram config
    if (hasTelegram) {
      pluginConfigs["telegram-comm"] = {
        bot_token: "${TELEGRAM_BOT_TOKEN}",
        chat_id: "${TELEGRAM_CHAT_ID}",
      };
    }

    // Warnings
    if (!selectedPlugins.includes("github-trigger")) {
      out.blank();
      out.warn("No trigger plugin enabled. The Engineer will start but won't pick up tasks.");
    }

    // Step 6: Confirmation
    out.blank();
    out.log("  Safety: conservative (default)");
    out.blank();

    const proceed = await confirm({
      message: "Start with these settings?",
      default: true,
    });

    if (!proceed) return null;

    return { selectedPlugins, pluginConfigs };
  } catch (error) {
    // Handle Ctrl+C (ExitPromptError from @inquirer/prompts)
    if (error instanceof Error && error.name === "ExitPromptError") {
      return null;
    }
    throw error;
  }
}
