import { join } from "node:path";

import { Command } from "commander";
import ms from "ms";

import { loadConfigDir } from "../config/loader.js";
import { runConfigMigrate } from "./commands/config-migrate.js";
import { runConfigValidate } from "./commands/config-validate.js";
import { runCreatePlugin } from "./commands/create-plugin.js";
import { runDashboard } from "./commands/dashboard.js";
import { computeExitCode, formatDoctorResults, runAllChecks } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runInstall } from "./commands/install.js";
import { runLogs } from "./commands/logs.js";
import { runPrepare } from "./commands/prepare.js";
import { runSetup } from "./commands/setup.js";
import { runShutdown } from "./commands/shutdown.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runWhy } from "./commands/why.js";
import { resolveEngineerHome, resolveSubdirs } from "./home.js";
import { type OutputMode, createOutput, getOutput } from "./output.js";

export const VERSION = "0.0.1";

/** Parse a duration string ("30s", "1m") or raw millisecond number. */
function parseDuration(value: string): number {
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && asNumber > 0) {
    return asNumber;
  }
  const parsed = ms(value as ms.StringValue);
  if (parsed === undefined || parsed <= 0) {
    throw new Error(`Invalid duration: "${value}". Use e.g. "30s", "1m", or a number in ms.`);
  }
  return parsed;
}

export const program = new Command()
  .name("engineer")
  .description("The Engineer — Autonomous Software Engineering Agent")
  .version(VERSION)
  .option("--home <path>", "Override ENGINEER_HOME directory")
  .option("--config-dir <path>", "Override config directory (default: $ENGINEER_HOME/config)")
  .option("--verbose", "Enable debug logging")
  .option("--json", "Output in JSON format");

// Initialize Output singleton and apply global overrides before any command runs
program.hook("preAction", () => {
  const globals = program.opts<{ json?: boolean; configDir?: string }>();
  const mode: OutputMode = globals.json ? "json" : "human";
  createOutput({ mode });
  if (globals.configDir) {
    process.env["ENGINEER_CONFIG_DIR"] = globals.configDir;
  }
});

// ── start ────────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the daemon")
  .option("--daemon", "Run in background")
  .option("--dry-run", "Validate config and show what would happen without starting")
  .action(async (options: { daemon?: boolean; dryRun?: boolean }) => {
    const globals = program.opts<{ home?: string; verbose?: boolean }>();
    const home = resolveEngineerHome(globals.home);
    const code = await runStart(home, {
      daemon: options.daemon ?? false,
      verbose: globals.verbose ?? false,
      dryRun: options.dryRun ?? false,
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── shutdown ─────────────────────────────────────────────────────────────────

program
  .command("shutdown")
  .description("Shut down the daemon and all subsidiary processes")
  .option("--timeout <duration>", "Shutdown timeout (e.g. 30s, 1m)", "30s")
  .action(async (options: { timeout: string }) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = await runShutdown(home, parseDuration(options.timeout));
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show daemon status and task queue")
  .action(() => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runStatus(home);
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── logs ─────────────────────────────────────────────────────────────────────

program
  .command("logs")
  .description("View daemon log output")
  .option("--json", "Show raw JSON instead of pretty-printed output")
  .option("--lines <n>", "Number of lines to show", "50")
  .option("--follow", "Follow mode — stream new entries")
  .action((options: { json?: boolean; lines: string; follow?: boolean }) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runLogs(home, {
      json: options.json ?? false,
      lines: Number.parseInt(options.lines, 10),
      follow: options.follow ?? false,
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── prepare ──────────────────────────────────────────────────────────────────

program
  .command("prepare")
  .description("Scaffold a seed/ directory with config templates for local customization")
  .option("--force", "Overwrite existing seed files")
  .action((options: { force?: boolean }) => {
    const seedDir = join(process.cwd(), "seed");
    const seedExampleDir = join(process.cwd(), "seed-example");
    runPrepare(seedDir, { force: options.force ?? false, seedExampleDir });
  });

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description(
    "Create directory structure and config files from templates (for experienced users or CI)",
  )
  .option("--force", "Overwrite existing config files")
  .option("--all-plugins", "Install all available plugins without prompting")
  .action(async (options: { force?: boolean; allPlugins?: boolean }) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const seedDir = join(process.cwd(), "seed");
    await runInit(home, {
      force: options.force ?? false,
      seedDir,
      allPlugins: options.allPlugins ?? false,
    });
  });

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Run health checks on the system")
  .action(() => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const dirs = resolveSubdirs(home);
    const out = getOutput();

    // Try to load config for risky config checks (category 11)
    let bundle: import("../config/loader.js").ConfigBundle | undefined;
    try {
      const result = loadConfigDir(dirs.config);
      bundle = result.bundle;
    } catch {
      // Config loading failed — skip category 11, other checks still run
    }

    const categories = runAllChecks(home, bundle);
    const code = computeExitCode(categories);

    if (out.mode === "json") {
      out.data({ checks: categories, exitCode: code });
    } else {
      out.log(formatDoctorResults(categories));
    }

    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── install ──────────────────────────────────────────────────────────────────

program
  .command("install")
  .description("Generate OS service configuration (launchd/systemd)")
  .action(() => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runInstall(home);
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── dashboard ───────────────────────────────────────────────────────────────

program
  .command("dashboard")
  .description("Open the War Room dashboard")
  .option("--port <port>", "HTTP port", "3847")
  .option("--open", "Open browser automatically")
  .action(async (options: { port: string; open?: boolean }) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const dirs = resolveSubdirs(home);
    await runDashboard(dirs, {
      port: Number.parseInt(options.port, 10),
      open: options.open ?? false,
    });
  });

// ── why ──────────────────────────────────────────────────────────────────────

program
  .command("why <task-id>")
  .description("Explain why a task is in its current state")
  .action((taskId: string) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runWhy(home, taskId);
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── setup ────────────────────────────────────────────────────────────────────

program
  .command("setup")
  .description("Interactive first-run setup wizard (recommended for new users)")
  .action(async () => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = await runSetup(home);
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── config (subcommand) ──────────────────────────────────────────────────────

const configCmd = program.command("config").description("Configuration management");

configCmd
  .command("validate")
  .description("Validate all config files")
  .action(() => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runConfigValidate(home);
    if (code !== 0) {
      process.exitCode = code;
    }
  });

configCmd
  .command("migrate")
  .description("Migrate config files to the current version")
  .action(() => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runConfigMigrate(home);
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── create-plugin ─────────────────────────────────────────────────────────────

program
  .command("create-plugin <name>")
  .description("Scaffold a new plugin")
  .requiredOption("--type <type>", "Adapter type (trigger, communication, llm, tool, git_hosting)")
  .option("--dir <dir>", "Output directory", process.cwd())
  .action((name: string, options: { type: string; dir: string }) => {
    const code = runCreatePlugin(name, options.type, options.dir);
    if (code !== 0) {
      process.exitCode = code;
    }
  });
