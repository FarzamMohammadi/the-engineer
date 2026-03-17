import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { type ConfigBundle, loadConfigDir } from "../../config/loader.js";
import { discoverEnabledPlugins } from "../../plugins/loader.js";
import { extractErrorMessage } from "../../utils/errors.js";

import { type BootstrapResult, type ProgressCallback, bootstrap } from "../bootstrap.js";
import { type EngineerDirs, resolveSubdirs } from "../home.js";
import { getOutput } from "../output.js";
import { Spinner } from "../progress.js";
import { computeExitCode, formatDoctorResults, runPreFlightChecks } from "./doctor.js";
import { spawnBackground } from "./start-background.js";
import { DASHBOARD_PORT, launchDashboard } from "./start-dashboard.js";

interface StartOptions {
  daemon: boolean;
  verbose: boolean;
  dryRun: boolean;
}

/** Create all required directories. Throws on failure. */
function ensureDirectories(dirs: EngineerDirs): void {
  for (const dirPath of Object.values(dirs)) {
    try {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      const message = extractErrorMessage(error);
      throw new Error(`Cannot create directory "${dirPath}": ${message}. Check file permissions.`);
    }
  }
}

/** Boots the daemon. Returns exit code. */
export async function runStart(engineerHome: string, options: StartOptions): Promise<number> {
  const out = getOutput();

  // 1. Auto-create directories
  const dirs = resolveSubdirs(engineerHome);
  try {
    ensureDirectories(dirs);
  } catch (error) {
    out.error(extractErrorMessage(error));
    return 1;
  }

  // 2. Load config
  let bundle: ConfigBundle;
  try {
    const result = loadConfigDir(dirs.config);
    bundle = result.bundle;
    for (const warning of result.warnings) {
      out.warn(`${warning.file}: ${warning.message}`);
    }
  } catch (error) {
    out.error(`Config error: ${extractErrorMessage(error)}`);
    return 1;
  }

  // 3. Run pre-flight checks (doctor categories 1-6)
  let preFlightResults: ReturnType<typeof runPreFlightChecks>;
  try {
    preFlightResults = runPreFlightChecks(engineerHome);
  } catch (error) {
    out.error(`Pre-flight checks encountered an unexpected error: ${extractErrorMessage(error)}`);
    return 1;
  }
  const preFlightCode = computeExitCode(preFlightResults);

  if (preFlightCode === 1) {
    out.error("Pre-flight checks failed:");
    out.log(formatDoctorResults(preFlightResults));
    return 1;
  }

  if (preFlightCode === 2 && options.verbose) {
    out.warn("Pre-flight warnings:");
    out.log(formatDoctorResults(preFlightResults));
  }

  // 4. Dry-run mode: show what would happen and exit
  if (options.dryRun) {
    return runDryRun(engineerHome, dirs, preFlightResults);
  }

  // 5. Background mode: re-spawn as detached child
  if (options.daemon) {
    return spawnBackground(engineerHome, options.verbose);
  }

  // 6. Foreground mode: bootstrap and start
  return await runForeground(engineerHome, bundle, dirs, preFlightResults, options.verbose);
}

// ── Foreground ────────────────────────────────────────────────────────────────

async function runForeground(
  engineerHome: string,
  bundle: ConfigBundle,
  dirs: EngineerDirs,
  preFlightResults: import("./doctor.js").DoctorCategory[],
  verbose: boolean,
): Promise<number> {
  const out = getOutput();
  const spinner = new Spinner("");
  const progress: ProgressCallback = (step, status) => {
    if (status === "start") {
      spinner.update(step);
      spinner.start();
    } else if (status === "done") {
      spinner.succeed(step);
    } else {
      spinner.fail(step);
    }
  };

  // Config already loaded — report it
  progress("Configuration loaded", "done");

  // Pre-flight already passed — report it
  const totalChecks = preFlightResults.reduce((sum, category) => sum + category.checks.length, 0);
  progress(`Pre-flight: ${String(totalChecks)}/${String(totalChecks)} checks passed`, "done");

  let daemon: BootstrapResult["daemon"];
  let cleanup: BootstrapResult["cleanup"];
  let observer: BootstrapResult["observer"] | undefined;
  try {
    const result = await bootstrap({
      engineerHome,
      config: bundle,
      verbose,
      progress,
    });
    daemon = result.daemon;
    cleanup = result.cleanup;
    observer = result.observer;
  } catch (error) {
    spinner.fail("Bootstrap failed");
    out.error(`Bootstrap failed: ${extractErrorMessage(error)}`);
    return 1;
  }

  // Start dashboard alongside daemon
  const { cleanup: cleanupDashboard } = launchDashboard(dirs);

  // NOTE: Signal handlers are registered after bootstrap completes. If the process
  // receives SIGTERM/SIGINT during bootstrap, cleanup won't run. This is an accepted
  // gap — bootstrap is typically <2s, and the OS reclaims all resources on exit.
  const shutdown = async () => {
    try {
      await daemon.stop();
    } finally {
      try {
        cleanupDashboard();
      } finally {
        cleanup();
      }
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch((err) => {
      try {
        observer?.error("Shutdown failed", { err });
      } catch {
        // Observer transport may be broken during shutdown — stderr fallback below
      }
      process.stderr.write(`Shutdown failed: ${extractErrorMessage(err)}\n`);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((err) => {
      try {
        observer?.error("Shutdown failed", { err });
      } catch {
        // Observer transport may be broken during shutdown — stderr fallback below
      }
      process.stderr.write(`Shutdown failed: ${extractErrorMessage(err)}\n`);
      process.exit(1);
    });
  });

  try {
    // INVARIANT: Events published between bootstrap() return and daemon.start()
    // are persisted to DB but not delivered — subscribers register in daemon.start().
    // Accepted: no component publishes during this window.
    const startSpinner = new Spinner("Starting daemon");
    startSpinner.start();
    await daemon.start();
    startSpinner.succeed("Daemon running");
    const warRoomUrl = `http://localhost:${String(DASHBOARD_PORT)}`;
    out.blank();
    out.success(`The Engineer is ready. War Room: ${warRoomUrl}`);
  } catch (error) {
    out.error(`Startup failed: ${extractErrorMessage(error)}`);
    try {
      await daemon.stop();
    } catch (stopError) {
      process.stderr.write(
        `Warning: cleanup failed during startup error: ${extractErrorMessage(stopError)}\n`,
      );
    }
    cleanupDashboard();
    cleanup();
    return 1;
  }

  return 0;
}

// ── Dry Run ──────────────────────────────────────────────────────────────────

function runDryRun(
  _engineerHome: string,
  dirs: EngineerDirs,
  preFlightResults: import("./doctor.js").DoctorCategory[],
): number {
  const out = getOutput();
  const totalChecks = preFlightResults.reduce((sum, category) => sum + category.checks.length, 0);
  const enabledPlugins = discoverEnabledPlugins(dirs.plugins);
  const criticalCount = enabledPlugins.filter((plugin) => plugin.manifest.critical).length;

  if (out.mode === "json") {
    out.data({
      config: { dir: dirs.config },
      database: {
        path: join(dirs.data, "engineer.db"),
        exists: existsSync(join(dirs.data, "engineer.db")),
      },
      plugins: enabledPlugins.map((plugin) => ({
        id: plugin.manifest.id,
        type: plugin.manifest.type,
        critical: plugin.manifest.critical,
      })),
      preflight: { total: totalChecks, passed: totalChecks, categories: preFlightResults },
    });
    return 0;
  }

  out.blank();
  out.heading("Dry Run — The Engineer would start with:");
  out.blank();
  out.keyValue("Config", `${dirs.config}`);
  out.keyValue("Database", join(dirs.data, "engineer.db"));
  out.keyValue(
    "Plugins",
    `${String(enabledPlugins.length)} plugins (${String(criticalCount)} critical)`,
  );
  out.keyValue("Pre-flight", `${String(totalChecks)}/${String(totalChecks)} checks passed`);

  out.blank();
  out.log("  Plugin loading order:");
  for (const [index, plugin] of enabledPlugins.entries()) {
    const label = plugin.manifest.critical ? "CRITICAL" : "non-critical";
    out.log(`    ${String(index + 1)}. ${plugin.manifest.id} (${plugin.manifest.type}) — ${label}`);
  }

  out.blank();
  out.success("Everything looks good. Run without --dry-run to start.");
  return 0;
}
