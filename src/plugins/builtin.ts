import type { BaseAdapter } from "../adapters/base.js";
import type { PluginManifest } from "../schemas/adapters.js";
import { AdapterTypes, PluginManifestSchema } from "../schemas/adapters.js";
import { GitHubCommPlugin } from "./communication/github-comm/github-comm.js";
import { TelegramCommPlugin } from "./communication/telegram-comm/telegram-comm.js";
import { GitHubHostingPlugin } from "./git-hosting/github-hosting/github-hosting.js";
import { ClaudeCodeLLMPlugin } from "./llm/claude-code-llm/claude-code-llm.js";
import { GeminiCliLLMPlugin } from "./llm/gemini-cli-llm/gemini-cli-llm.js";
import { OpenCodeLLMPlugin } from "./llm/opencode-llm/opencode-llm.js";
import { GitHubTriggerPlugin } from "./trigger/github-trigger/github-trigger.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Registration record for a built-in plugin — its manifest, factory, and optional setup prompt. */
export interface BuiltinPlugin {
  manifest: PluginManifest;
  create: () => BaseAdapter;
  /**
   * Optional interactive config prompt for guided setup.
   * Called during first-run setup for plugins that need user-specific values
   * beyond secrets (${VAR} refs handled by promptForSecrets).
   * Returns config key-value pairs to merge INTO the template.
   */
  promptForConfig?: () => Promise<Record<string, unknown>>;
}

// ── Manifests ───────────────────────────────────────────────────────────────

const manifests = [
  {
    id: "github-trigger",
    type: AdapterTypes.trigger,
    version: "1.0.0",
    name: "GitHub Trigger",
    description: "Polls GitHub for assigned issues and PR reviews",
    critical: true,
    requirements: [{ type: "env", name: "GITHUB_TOKEN" }],
    combined_with: ["github-comm", "github-hosting"],
    entry: "builtin",
    adapter_meta: { poll_interval: "30s" },
    contributes: { events: ["trigger.new_event", "trigger.pr_review"] },
  },
  {
    id: "claude-code-llm",
    type: AdapterTypes.llm,
    version: "1.0.0",
    name: "Claude Code CLI",
    description: "LLM reasoning via Claude Code CLI process",
    critical: true,
    requirements: [{ type: "binary", name: "claude" }],
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "opencode-llm",
    type: AdapterTypes.llm,
    version: "1.0.0",
    name: "OpenCode CLI",
    description: "Multi-provider LLM reasoning via OpenCode CLI process",
    critical: true,
    requirements: [{ type: "binary", name: "opencode" }],
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "gemini-cli-llm",
    type: AdapterTypes.llm,
    version: "1.0.0",
    name: "Gemini CLI",
    description: "LLM reasoning via Google Gemini CLI process",
    critical: true,
    requirements: [{ type: "binary", name: "gemini" }],
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "github-comm",
    type: AdapterTypes.communication,
    version: "1.0.0",
    name: "GitHub Communication",
    description: "Posts comments and manages labels on GitHub issues/PRs",
    critical: false,
    requirements: [{ type: "env", name: "GITHUB_TOKEN" }],
    combined_with: ["github-trigger", "github-hosting"],
    entry: "builtin",
    adapter_meta: { capabilities: ["send", "sync", "ticket_management"], channel: "github" },
    contributes: { events: ["comm.message_sent"] },
  },
  {
    id: "telegram-comm",
    type: AdapterTypes.communication,
    version: "1.0.0",
    name: "Telegram Communication",
    description: "Sends notifications via Telegram bot",
    critical: false,
    requirements: [{ type: "env", name: "TELEGRAM_BOT_TOKEN" }],
    entry: "builtin",
    adapter_meta: { capabilities: ["send"], channel: "telegram" },
    contributes: { events: ["comm.message_sent"] },
    startup_hints: [
      "Each person in People Directory must send /start to the Telegram bot before The Engineer can reach them via Telegram.",
    ],
  },
  {
    id: "github-hosting",
    type: AdapterTypes.git_hosting,
    version: "1.0.0",
    name: "GitHub Hosting",
    description: "PR lifecycle management via GitHub API",
    critical: true,
    requirements: [{ type: "env", name: "GITHUB_TOKEN" }],
    combined_with: ["github-trigger", "github-comm"],
    entry: "builtin",
    adapter_meta: { action_classes: ["git-remote", "merge"] },
    contributes: { events: ["git.pr_opened", "git.pr_updated", "git.pr_merged"] },
  },
] as const;

// Validate all manifests at import time
const validatedManifests = manifests.map((manifest) => PluginManifestSchema.parse(manifest));

// ── Setup Prompt Functions ───────────────────────────────────────────────────
// Plugins that need interactive user input during guided setup declare a prompt
// function here. Uses dynamic import so @inquirer/prompts is only loaded during setup.

const OWNER_SLASH_NAME = /^[^/]+\/[^/]+$/;

const promptFunctions: Record<string, () => Promise<Record<string, unknown>>> = {
  "github-trigger": async () => {
    const { input } = await import("@inquirer/prompts");
    const repoInput = await input({
      message: "Repo to watch (owner/name):",
      validate: (v: string) => OWNER_SLASH_NAME.test(v.trim()) || "Format: owner/name",
    });
    const parts = repoInput.trim().split("/");
    return { repos: [{ owner: parts[0] ?? "", name: parts[1] ?? "" }] };
  },
};

// ── Factory map (id → constructor) ──────────────────────────────────────────

const factories: Record<string, () => BaseAdapter> = {
  "github-trigger": () => new GitHubTriggerPlugin(),
  "claude-code-llm": () => new ClaudeCodeLLMPlugin(),
  "opencode-llm": () => new OpenCodeLLMPlugin(),
  "gemini-cli-llm": () => new GeminiCliLLMPlugin(),
  "github-comm": () => new GitHubCommPlugin(),
  "telegram-comm": () => new TelegramCommPlugin(),
  "github-hosting": () => new GitHubHostingPlugin(),
};

// ── Exports ─────────────────────────────────────────────────────────────────

/** All built-in plugins, schema-validated at import time, ready to register. */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = validatedManifests.map((manifest) => {
  const base: BuiltinPlugin = {
    manifest,
    create: factories[manifest.id] as () => BaseAdapter,
  };
  const promptFn = promptFunctions[manifest.id];
  if (promptFn) {
    base.promptForConfig = promptFn;
  }
  return base;
});
