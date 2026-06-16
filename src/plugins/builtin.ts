import type { BaseAdapter } from "../adapters/base.js";
import type { PluginManifest, PluginRequirement } from "../schemas/adapters.js";
import { AdapterTypes, PluginManifestSchema } from "../schemas/adapters.js";
import { ClaudeCodeAgentPlugin } from "./agent/claude-code-agent/claude-code-agent.js";
import { GeminiCliAgentPlugin } from "./agent/gemini-cli-agent/gemini-cli-agent.js";
import { OpenCodeAgentPlugin } from "./agent/opencode-agent/opencode-agent.js";
import { GitHubCommPlugin } from "./communication/github-comm/github-comm.js";
import { TelegramCommPlugin } from "./communication/telegram-comm/telegram-comm.js";
import { GitHubHostingPlugin } from "./git-hosting/github-hosting/github-hosting.js";
import { GitHubTriggerPlugin } from "./trigger/github-trigger/github-trigger.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Registration record for a built-in plugin — its manifest, factory, and optional setup prompt. */
export interface BuiltinPlugin {
  readonly manifest: PluginManifest;
  readonly create: () => BaseAdapter;
  /**
   * Optional interactive config prompt for guided setup.
   * Called during first-run setup for plugins that need user-specific values
   * beyond secrets (${VAR} refs handled by promptForSecrets).
   * Returns config key-value pairs to merge INTO the template.
   */
  readonly promptForConfig?: () => Promise<Record<string, unknown>>;
}

// ── Secret-Acquisition Metadata ───────────────────────────────────────────────
// Single source of truth for how the human obtains each shipped secret. These are
// STATIC PUBLIC pointers (URLs, scope names, a one-line how-to) — never a secret
// value (Trust Through Restraint). GITHUB_TOKEN is declared by three GitHub
// manifests; defining it once here keeps their acquisition text from ever diverging
// and makes the var-name → metadata lookup deterministic.

const GITHUB_TOKEN_REQUIREMENT = {
  type: "env",
  name: "GITHUB_TOKEN",
  acquire_url: "https://github.com/settings/tokens",
  scopes: ["repo"],
  instructions: "Create a GitHub personal access token",
} as const;

const TELEGRAM_BOT_TOKEN_REQUIREMENT = {
  type: "env",
  name: "TELEGRAM_BOT_TOKEN",
  acquire_url: "https://t.me/BotFather",
  instructions: "Message @BotFather on Telegram, send /newbot, and copy the bot token",
} as const;

// ── Manifests ───────────────────────────────────────────────────────────────

const manifests = [
  {
    id: "github-trigger",
    type: AdapterTypes.trigger,
    version: "1.0.0",
    name: "GitHub Trigger",
    description: "Polls GitHub for assigned issues",
    critical: true,
    requirements: [GITHUB_TOKEN_REQUIREMENT],
    combined_with: ["github-comm", "github-hosting"],
    entry: "builtin",
    poll_interval_ms: 30_000,
    adapter_meta: {},
    contributes: { events: ["trigger.new_event"] },
  },
  {
    id: "claude-code-agent",
    type: AdapterTypes.agent,
    version: "1.0.0",
    name: "Claude Code CLI",
    description: "Autonomous coding agent via Claude Code CLI process",
    critical: true,
    requirements: [{ type: "binary", name: "claude" }],
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "opencode-agent",
    type: AdapterTypes.agent,
    version: "1.0.0",
    name: "OpenCode CLI",
    description: "Multi-provider autonomous coding agent via OpenCode CLI process",
    critical: true,
    requirements: [{ type: "binary", name: "opencode" }],
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "gemini-cli-agent",
    type: AdapterTypes.agent,
    version: "1.0.0",
    name: "Gemini CLI",
    description: "Autonomous coding agent via Google Gemini CLI process",
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
    requirements: [GITHUB_TOKEN_REQUIREMENT],
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
    description: "Sends notifications and polls for replies via Telegram bot",
    critical: false,
    requirements: [TELEGRAM_BOT_TOKEN_REQUIREMENT],
    entry: "builtin",
    adapter_meta: { capabilities: ["send", "receive"], channel: "telegram" },
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
    requirements: [GITHUB_TOKEN_REQUIREMENT],
    combined_with: ["github-trigger", "github-comm"],
    entry: "builtin",
    adapter_meta: { action_classes: ["git-remote", "merge"], channel: "github" },
    contributes: { events: ["git.pr_merged"] },
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
  "claude-code-agent": () => new ClaudeCodeAgentPlugin(),
  "opencode-agent": () => new OpenCodeAgentPlugin(),
  "gemini-cli-agent": () => new GeminiCliAgentPlugin(),
  "github-comm": () => new GitHubCommPlugin(),
  "telegram-comm": () => new TelegramCommPlugin(),
  "github-hosting": () => new GitHubHostingPlugin(),
};

// ── Exports ─────────────────────────────────────────────────────────────────

/** All built-in plugins, schema-validated at import time, ready to register. */
export const BUILTIN_PLUGINS: BuiltinPlugin[] = validatedManifests.map((manifest) => {
  const promptFn = promptFunctions[manifest.id];
  return {
    manifest,
    create: factories[manifest.id] as () => BaseAdapter,
    ...(promptFn ? { promptForConfig: promptFn } : {}),
  };
});

// ── Secret-Acquisition Lookup ─────────────────────────────────────────────────

/** Acquisition metadata for a required secret — the static public pointers that lead the human to obtain it. */
export interface SecretAcquisition {
  readonly acquireUrl?: string;
  readonly scopes?: readonly string[];
  readonly instructions?: string;
}

/**
 * Find how the human obtains the env var named `varName` by scanning every built-in
 * plugin's `env` requirements (plugin-opaque — never branches on a plugin id). First
 * match by name wins; because each shipped secret's acquisition text is single-sourced,
 * the result is deterministic regardless of how many plugins declare the same var.
 * Returns null when no `env` requirement carries any acquisition metadata, so callers
 * degrade gracefully to a generic remedy instead of printing `undefined`.
 */
export function findSecretAcquisition(varName: string): SecretAcquisition | null {
  for (const { manifest } of BUILTIN_PLUGINS) {
    for (const req of manifest.requirements) {
      if (req.type === "env" && req.name === varName) {
        const acquisition = toSecretAcquisition(req);
        if (acquisition) {
          return acquisition;
        }
      }
    }
  }
  return null;
}

/** Project a requirement's acquisition fields into a SecretAcquisition, or null when it declares none. */
function toSecretAcquisition(req: PluginRequirement): SecretAcquisition | null {
  if (req.acquire_url === undefined && req.scopes === undefined && req.instructions === undefined) {
    return null;
  }
  return {
    ...(req.acquire_url !== undefined ? { acquireUrl: req.acquire_url } : {}),
    ...(req.scopes !== undefined ? { scopes: req.scopes } : {}),
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
  };
}

/**
 * Render an acquisition into one human-and-agent-readable line, or null when no
 * acquisition metadata exists for `varName`. Single-sourced so doctor remedies and
 * setup's missing-secret report read identically; callers append it after their own
 * generic remedy when present and keep the generic remedy alone when it is null.
 */
export function describeSecretAcquisition(varName: string): string | null {
  const acquisition = findSecretAcquisition(varName);
  if (!acquisition) {
    return null;
  }
  const parts: string[] = [];
  if (acquisition.instructions) {
    parts.push(acquisition.instructions);
  }
  if (acquisition.scopes && acquisition.scopes.length > 0) {
    parts.push(`scopes: ${acquisition.scopes.join(", ")}`);
  }
  if (acquisition.acquireUrl) {
    parts.push(acquisition.acquireUrl);
  }
  return parts.length > 0 ? parts.join(" — ") : null;
}
