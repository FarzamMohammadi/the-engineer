import type { BaseAdapter } from "../adapters/base.js";
import { type PluginManifest, PluginManifestSchema } from "../schemas/adapters.js";
import { GitHubCommPlugin } from "./communication/github-comm/github-comm.js";
import { TelegramCommPlugin } from "./communication/telegram-comm/telegram-comm.js";
import { GitHubHostingPlugin } from "./git-hosting/github-hosting/github-hosting.js";
import { ClaudeCodeLLMPlugin } from "./llm/claude-code-llm/claude-code-llm.js";
import { GeminiCliLLMPlugin } from "./llm/gemini-cli-llm/gemini-cli-llm.js";
import { OpenCodeLLMPlugin } from "./llm/opencode-llm/opencode-llm.js";
import { BashToolPlugin } from "./tool/bash-tool/bash-tool.js";
import { GitHubTriggerPlugin } from "./trigger/github-trigger/github-trigger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BuiltinPlugin {
  manifest: PluginManifest;
  create: () => BaseAdapter;
}

// ── Manifests ───────────────────────────────────────────────────────────────

const manifests = [
  {
    id: "github-trigger",
    type: "trigger",
    version: "1.0.0",
    name: "GitHub Trigger",
    description: "Polls GitHub for assigned issues and PR reviews",
    critical: true,
    enabled: true,
    entry: "builtin",
    adapter_meta: { poll_interval: "30s" },
    contributes: { events: ["trigger.new_event", "trigger.pr_review"] },
  },
  {
    id: "claude-code-llm",
    type: "llm",
    version: "1.0.0",
    name: "Claude Code CLI",
    description: "LLM reasoning via Claude Code CLI process",
    critical: true,
    enabled: true,
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "opencode-llm",
    type: "llm",
    version: "1.0.0",
    name: "OpenCode CLI",
    description: "Multi-provider LLM reasoning via OpenCode CLI process",
    critical: true,
    enabled: false,
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "gemini-cli-llm",
    type: "llm",
    version: "1.0.0",
    name: "Gemini CLI",
    description: "LLM reasoning via Google Gemini CLI process",
    critical: true,
    enabled: false,
    entry: "builtin",
    adapter_meta: { provider_type: "cli" },
    contributes: { events: ["cost.incurred"] },
  },
  {
    id: "bash-tool",
    type: "tool",
    version: "1.0.0",
    name: "Bash Shell Tool",
    description: "Execute shell commands in task workspace",
    critical: true,
    enabled: true,
    entry: "builtin",
    adapter_meta: { action_classes: ["read", "write", "test", "git-local"] },
    contributes: { config_keys: ["bash_tool"] },
  },
  {
    id: "github-comm",
    type: "communication",
    version: "1.0.0",
    name: "GitHub Communication",
    description: "Posts comments and manages labels on GitHub issues/PRs",
    critical: false,
    enabled: true,
    entry: "builtin",
    adapter_meta: { capabilities: ["send", "sync", "issue_management"] },
    contributes: { events: ["comm.message_sent"] },
  },
  {
    id: "telegram-comm",
    type: "communication",
    version: "1.0.0",
    name: "Telegram Communication",
    description: "Sends notifications via Telegram bot",
    critical: false,
    enabled: true,
    entry: "builtin",
    adapter_meta: { capabilities: ["send"] },
    contributes: { events: ["comm.message_sent"] },
  },
  {
    id: "github-hosting",
    type: "git_hosting",
    version: "1.0.0",
    name: "GitHub Hosting",
    description: "PR lifecycle management via GitHub API",
    critical: true,
    enabled: true,
    entry: "builtin",
    adapter_meta: { action_classes: ["git-remote", "merge"] },
    contributes: { events: ["git.pr_opened", "git.pr_updated", "git.pr_merged"] },
  },
] as const;

// Validate all manifests at import time
const validatedManifests = manifests.map((manifest) => PluginManifestSchema.parse(manifest));

// ── Factory map (id → constructor) ──────────────────────────────────────────

const factories: Record<string, () => BaseAdapter> = {
  "github-trigger": () => new GitHubTriggerPlugin(),
  "claude-code-llm": () => new ClaudeCodeLLMPlugin(),
  "opencode-llm": () => new OpenCodeLLMPlugin(),
  "gemini-cli-llm": () => new GeminiCliLLMPlugin(),
  "bash-tool": () => new BashToolPlugin(),
  "github-comm": () => new GitHubCommPlugin(),
  "telegram-comm": () => new TelegramCommPlugin(),
  "github-hosting": () => new GitHubHostingPlugin(),
};

// ── Exports ─────────────────────────────────────────────────────────────────

export const BUILTIN_PLUGINS: BuiltinPlugin[] = validatedManifests.map((manifest) => ({
  manifest,
  create: factories[manifest.id] as () => BaseAdapter,
}));
