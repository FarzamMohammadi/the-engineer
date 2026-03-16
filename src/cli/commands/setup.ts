import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { confirm, input, select } from "@inquirer/prompts";
import { stringify as yamlStringify } from "yaml";

import { resolveSubdirs } from "../home.js";
import { getOutput } from "../output.js";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

// ── Types ────────────────────────────────────────────────────────────────────

interface SetupAnswers {
  home: string;
  repos: string[];
  llmProvider: string;
  telegramEnabled: boolean;
  safetyLevel: "conservative" | "balanced" | "autonomous";
}

// ── Safety Presets ───────────────────────────────────────────────────────────
// Field names must match SafetyConfigSchema in src/schemas/config.ts exactly.
// Zod strips unknown keys, so wrong names silently become defaults.

const SAFETY_PRESETS = {
  conservative: {
    cost_limits: {
      api: {
        per_task: { cost_usd: 1.0 },
        daily: { cost_usd: 10.0 },
        monthly: { cost_usd: 100.0 },
      },
    },
    merge: { auto_merge_after_approval: { default: false } },
  },
  balanced: {
    cost_limits: {
      api: {
        per_task: { cost_usd: 5.0 },
        daily: { cost_usd: 50.0 },
        monthly: { cost_usd: 500.0 },
      },
    },
    merge: { auto_merge_after_approval: { default: false } },
  },
  autonomous: {
    cost_limits: {
      api: {
        per_task: { cost_usd: 20.0 },
        daily: { cost_usd: 200.0 },
        monthly: { cost_usd: 2000.0 },
      },
    },
    merge: { auto_merge_after_approval: { default: true } },
  },
} as const;

// ── Command ──────────────────────────────────────────────────────────────────

/** Interactive first-run setup wizard. Returns exit code. */
export async function runSetup(engineerHome: string): Promise<number> {
  const out = getOutput();

  // 1. Welcome
  out.blank();
  out.heading("The Engineer — Setup Wizard");
  out.blank();
  out.log("  This wizard will help you configure The Engineer.");
  out.log("  It creates config files but never stores secrets on disk.");
  out.blank();

  try {
    // 2. Home directory
    const home = await input({
      message: "Engineer home directory:",
      default: engineerHome,
    });

    // 3. GitHub token guidance
    out.blank();
    out.log("  GitHub Access:");
    out.log("  The Engineer needs a GitHub Personal Access Token (PAT) with these scopes:");
    out.log("    - repo (full access to repositories)");
    out.log("    - read:org (read organization membership)");
    out.blank();
    out.log("  Set it as an environment variable:");
    out.log("    export GITHUB_TOKEN=ghp_your_token_here");
    out.blank();

    await confirm({ message: "I understand — continue?", default: true });

    // 4. Repos
    const reposInput = await input({
      message: "Repositories to monitor (comma-separated owner/repo):",
      validate: (val) => {
        if (!val.trim()) {
          return "At least one repository is required.";
        }
        const repos = val.split(",").map((r) => r.trim());
        for (const repo of repos) {
          if (!REPO_PATTERN.test(repo)) {
            return `Invalid repo format: "${repo}". Use owner/repo.`;
          }
        }
        return true;
      },
    });
    const repos = reposInput.split(",").map((r) => r.trim());

    // 5. LLM provider
    const llmProvider = await select({
      message: "LLM provider:",
      choices: [{ value: "claude-code", name: "Claude Code CLI (default)" }],
    });

    // 6. Telegram
    const telegramEnabled = await confirm({
      message: "Enable Telegram notifications?",
      default: false,
    });

    if (telegramEnabled) {
      out.blank();
      out.log("  Telegram Setup:");
      out.log("  1. Create a bot via @BotFather on Telegram");
      out.log("  2. Set environment variables:");
      out.log("     export TELEGRAM_BOT_TOKEN=your_bot_token");
      out.log("     export TELEGRAM_CHAT_ID=your_chat_id");
      out.blank();
      await confirm({ message: "I understand — continue?", default: true });
    }

    // 7. Safety level
    const safetyLevel = await select({
      message: "Safety level:",
      choices: [
        {
          value: "conservative" as const,
          name: "Conservative — Human review required, low cost limits",
        },
        {
          value: "balanced" as const,
          name: "Balanced — Supervised autonomy, moderate limits",
        },
        {
          value: "autonomous" as const,
          name: "Autonomous — Full autonomy, higher limits",
        },
      ],
    });

    const answers: SetupAnswers = {
      home,
      repos,
      llmProvider,
      telegramEnabled,
      safetyLevel,
    };

    // 8. Generate config
    const created = await generateConfigs(answers);

    // 9. Summary
    out.blank();
    out.heading("Setup Complete");
    out.blank();
    out.log("  Created files:");
    for (const file of created) {
      out.success(file);
    }
    out.blank();
    out.log("  Next steps:");
    out.log("    1. Set environment variables (GITHUB_TOKEN, etc.)");
    out.log("    2. Run:  engineer doctor");
    out.log("    3. Run:  engineer start");

    return 0;
  } catch (error) {
    // User cancelled (Ctrl+C)
    if (error instanceof Error && error.message.includes("User force closed")) {
      out.blank();
      out.log("  Setup cancelled.");
      return 0;
    }
    out.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ── Config Generation ────────────────────────────────────────────────────────

async function generateConfigs(answers: SetupAnswers): Promise<string[]> {
  const _out = getOutput();
  const dirs = resolveSubdirs(answers.home);
  const created: string[] = [];

  // Ensure directories exist
  mkdirSync(dirs.config, { recursive: true });
  mkdirSync(dirs.plugins, { recursive: true });

  // Daemon config
  const daemonPath = join(dirs.config, "daemon.yaml");
  await writeConfigIfOk(
    daemonPath,
    {
      tick_interval_ms: 30000,
      max_concurrent: 2,
      plugins: {
        health_check_interval_ms: 60000,
        health_check_timeout_ms: 5000,
        consecutive_failures_threshold: 3,
      },
    },
    created,
  );

  // Safety config
  const safetyPath = join(dirs.config, "safety.yaml");
  await writeConfigIfOk(safetyPath, SAFETY_PRESETS[answers.safetyLevel], created);

  // Workspace config (field names match WorkspaceConfigSchema)
  const workspacePath = join(dirs.config, "workspace.yaml");
  await writeConfigIfOk(
    workspacePath,
    {
      workspace_root: dirs.workspaces,
      branch_prefix: "engineer/",
      default_base_branch: "main",
      pr: { default_merge_strategy: "squash", delete_branch_after_merge: true },
      cleanup: { preserve_branch_on_failure: true, preserve_branch_on_cancel: false },
    },
    created,
  );

  // People config (field names match PersonSchema: id, name, roles, contacts[{channel, handle}])
  const peoplePath = join(dirs.config, "people.yaml");
  const contacts: Array<{ channel: string; handle: string }> = [
    { channel: "github", handle: "your-github-username" },
  ];
  if (answers.telegramEnabled) {
    contacts.push({ channel: "telegram", handle: "${TELEGRAM_CHAT_ID}" });
  }
  await writeConfigIfOk(
    peoplePath,
    {
      people: [
        {
          id: "owner",
          name: "Project Owner",
          roles: ["owner"],
          contacts,
          preferences: { notification_level: "milestones" },
        },
      ],
    },
    created,
  );

  // GitHub trigger plugin config (field names match GitHubTriggerConfigSchema)
  const triggerPath = join(dirs.plugins, "github-trigger.yaml");
  await writeConfigIfOk(
    triggerPath,
    {
      github_token: "${GITHUB_TOKEN}",
      repos: answers.repos.map((r) => ({ owner: r.split("/")[0], name: r.split("/")[1] })),
    },
    created,
  );

  // GitHub comm plugin config (field names match GitHubCommConfigSchema)
  const commPath = join(dirs.plugins, "github-comm.yaml");
  await writeConfigIfOk(
    commPath,
    {
      github_token: "${GITHUB_TOKEN}",
    },
    created,
  );

  // GitHub hosting plugin config (field names match GitHubHostingConfigSchema)
  const hostingPath = join(dirs.plugins, "github-hosting.yaml");
  await writeConfigIfOk(
    hostingPath,
    {
      github_token: "${GITHUB_TOKEN}",
    },
    created,
  );

  // Claude Code LLM plugin config
  const llmPath = join(dirs.plugins, "claude-code-llm.yaml");
  await writeConfigIfOk(
    llmPath,
    {
      model: "claude-sonnet-4-20250514",
    },
    created,
  );

  // Telegram plugin config (if enabled)
  if (answers.telegramEnabled) {
    const telegramPath = join(dirs.plugins, "telegram-comm.yaml");
    await writeConfigIfOk(
      telegramPath,
      {
        bot_token: "${TELEGRAM_BOT_TOKEN}",
        default_chat_id: "${TELEGRAM_CHAT_ID}",
      },
      created,
    );
  }

  return created;
}

async function writeConfigIfOk(
  filePath: string,
  content: Record<string, unknown>,
  created: string[],
): Promise<void> {
  if (existsSync(filePath)) {
    const overwrite = await confirm({
      message: `${filePath} already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      return;
    }
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, yamlStringify(content), "utf8");
  created.push(filePath);
}
