import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import ms from "ms";

import { loadEnvFile } from "../config/env.js";
import type { ConfigBundle } from "../config/loader.js";
import { loadConfigDir } from "../config/loader.js";
import { computeExitCode, formatDoctorResults, runAllChecks } from "./commands/doctor.js";
import { runLogs } from "./commands/logs.js";
import { runRetry } from "./commands/retry.js";
import { runStart } from "./commands/start/index.js";
import { runStatus } from "./commands/status.js";
import { runStop } from "./commands/stop.js";
import { runWhy } from "./commands/why.js";
import { resolveDirectories, resolveEngineerHome } from "./home.js";
import type { OutputMode } from "./output.js";
import { createOutput, getOutput } from "./output.js";

/**
 * Resolve the CLI version from package.json. Single source of truth — never duplicate.
 * Walks up from this module's directory until it finds the project's own package.json,
 * which works for both source (`src/cli/index.ts`) and bundled (`dist/index.mjs`) layouts.
 */
function resolveVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "the-engineer" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // package.json not here (or unreadable) — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "unknown";
}

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
  .version(resolveVersion())
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
  .option("--seed <path>", "Seed directory for non-interactive setup (contains plugins/ and configs/)")
  .action(async (options: { daemon?: boolean; dryRun?: boolean; seed?: string }) => {
    const globals = program.opts<{ home?: string; verbose?: boolean }>();
    const home = resolveEngineerHome(globals.home);
    const code = await runStart(home, {
      daemon: options.daemon ?? false,
      verbose: globals.verbose ?? false,
      dryRun: options.dryRun ?? false,
      seedPath: options.seed,
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  });

// ── stop ─────────────────────────────────────────────────────────────────────

program
  .command("stop")
  .description("Stop the daemon and all subsidiary processes")
  .option("--timeout <duration>", "Shutdown timeout (e.g. 30s, 1m)", "30s")
  .action(async (options: { timeout: string }) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = await runStop(home, parseDuration(options.timeout));
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

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Run health checks on the system")
  .action(() => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const dirs = resolveDirectories(home);
    const out = getOutput();

    // Load .env before config resolution (matches startup behavior)
    loadEnvFile(home);

    // Try to load config for risky config checks (category 9)
    let bundle: ConfigBundle | undefined;
    try {
      const result = loadConfigDir(dirs.config);
      bundle = result.bundle;
    } catch {
      // Config loading failed — other checks still run, but the user should know
      // category 9 (risky config warnings) was skipped.
      if (out.mode !== "json") {
        out.warn("Config loading failed — skipping risky-config checks. Other categories still run.");
      }
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

// ── retry ─────────────────────────────────────────────────────────────────────

program
  .command("retry <task-id>")
  .description("Retry a blocked task (transitions blocked → queued)")
  .action((taskId: string) => {
    const globals = program.opts<{ home?: string }>();
    const home = resolveEngineerHome(globals.home);
    const code = runRetry(home, taskId);
    if (code !== 0) {
      process.exitCode = code;
    }
  });
