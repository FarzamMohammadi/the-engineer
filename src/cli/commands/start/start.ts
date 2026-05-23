import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadEnvFile, writeEnvFile } from "../../../config/env.js";
import type { ConfigBundle } from "../../../config/loader.js";
import { loadConfigDir } from "../../../config/loader.js";
import { DaemonAlreadyRunningError } from "../../../core/daemon/errors.js";
import { discoverEnabledPlugins } from "../../../plugins/loader.js";
import { sanitizeErrorMessage } from "../../../utils/sanitize.js";
import { registerSecretEnvVars } from "../../../utils/secret-registry.js";

import type { EngineerDirectories } from "../../home.js";
import { resolveDirectories } from "../../home.js";
import { getOutput } from "../../output.js";
import { Spinner } from "../../progress.js";
import { findResolvedEnvVars, needsSetup, runFirstTimeSetup } from "../../setup/setup.js";
import type { DoctorCategory } from "../doctor.js";
import { computeExitCode, formatDoctorResults, runPreFlightChecks } from "../doctor.js";
import { spawnBackground } from "./background.js";
import type { BootstrapResult, ProgressCallback } from "./bootstrap.js";
import { bootstrap } from "./bootstrap.js";
import { DASHBOARD_PORT, launchDashboard } from "./dashboard.js";
import { registerShutdownHandlers } from "./shutdown.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Options controlling how the daemon starts (foreground/background, dry-run, seeded setup). */
interface StartOptions {
  readonly daemon: boolean;
  readonly verbose: boolean;
  readonly dryRun: boolean;
  readonly seedPath?: string | undefined;
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/** Boots the daemon. Returns exit code. */
export async function runStart(engineerHome: string, options: StartOptions): Promise<number> {
  const out = getOutput();
  const dirs = resolveDirectories(engineerHome);

  // 0. First-run detection — TTY guard + setup BEFORE anything else
  const setupResult = await handleFirstRunSetup(engineerHome, options);
  if (setupResult !== null) {
    return setupResult;
  }

  // 1. Load .env before config resolution (existing env vars take precedence)
  loadEnvFile(engineerHome);

  // 1b. Scan config files once for ${VAR} refs already resolvable from the shell env.
  const discoveredVars = findResolvedEnvVars(dirs.config);

  // 1c. Persist them to .env so the daemon always has them, even without the shell export.
  captureEnvVarsToFile(engineerHome, discoveredVars);

  // 1d. Register them as secrets for sanitization. Replaces the former hardcoded
  //     SECRET_ENV_VARS list — Core discovers secrets dynamically from what plugins
  //     declare in their ${VAR} config references.
  registerSecretEnvVars(Object.keys(discoveredVars));

  // 2. Auto-create directories (idempotent — may already exist after setup)
  try {
    ensureDirectories(dirs);
  } catch (error) {
    out.error(sanitizeErrorMessage(error));
    return 1;
  }

  // 3. Load config (AFTER setup has written config files)
  const configResult = loadConfig(dirs);
  if ("exitCode" in configResult) {
    return configResult.exitCode;
  }
  const { bundle } = configResult;

  // 4. Run pre-flight checks
  let preFlightResults: DoctorCategory[];
  try {
    preFlightResults = runPreFlightChecks(engineerHome);
  } catch (error) {
    out.error(`Pre-flight checks encountered an unexpected error: ${sanitizeErrorMessage(error)}`);
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

  // 5. Dry-run mode: show what would happen and exit
  if (options.dryRun) {
    return runDryRun(engineerHome, dirs, preFlightResults);
  }

  // 6. Background mode: re-spawn as detached child
  if (options.daemon) {
    return spawnBackground(engineerHome, options.verbose);
  }

  // 7. Foreground mode: bootstrap and start
  return await runForeground(engineerHome, bundle, dirs, preFlightResults, options.verbose);
}

// ── Foreground ───────────────────────────────────────────────────────────────

async function runForeground(
  engineerHome: string,
  bundle: ConfigBundle,
  dirs: EngineerDirectories,
  preFlightResults: DoctorCategory[],
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
  let startupHints: BootstrapResult["hints"] = [];
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
    startupHints = result.hints;

    // Log pre-bootstrap steps that ran before the observer existed
    observer.debug("Configuration loaded", { configDir: dirs.config });
    observer.debug("Config summary", {
      logLevel: bundle.daemon.logging.level,
      maxConcurrent: bundle.daemon.max_concurrent,
      tickIntervalMs: bundle.daemon.tick_interval_ms,
      autoMergeDefault: bundle.safety.merge.auto_merge_after_approval.default,
    });
    observer.debug("Pre-flight checks passed", {
      categories: preFlightResults.length,
      totalChecks,
    });
  } catch (error) {
    spinner.fail("Bootstrap failed");
    out.error(`Bootstrap failed: ${sanitizeErrorMessage(error)}`);
    out.log("  Run 'engineer doctor' to diagnose common issues.");
    return 1;
  }

  // Start dashboard alongside daemon
  const { cleanup: cleanupDashboard } = launchDashboard(dirs, observer);

  // NOTE: Signal handlers are registered after bootstrap completes. If the process
  // receives SIGTERM/SIGINT during bootstrap, cleanup won't run. This is an accepted
  // gap — bootstrap is typically <2s, and the OS reclaims all resources on exit.
  registerShutdownHandlers({
    daemon,
    observer,
    cleanup() {
      try {
        cleanupDashboard();
      } finally {
        cleanup();
      }
    },
  });

  try {
    // INVARIANT: Events published between bootstrap() return and daemon.start()
    // are persisted to DB but not delivered — subscribers register in daemon.start().
    // Accepted: no component publishes during this window.
    const startSpinner = new Spinner("Starting daemon");
    startSpinner.start();
    await daemon.start();
    startSpinner.succeed("Daemon running");
    const dashboardUrl = `http://localhost:${String(DASHBOARD_PORT)}`;
    observer.info("The Engineer is ready", { engineerHome, dashboardUrl });
    out.blank();
    out.success(`The Engineer is ready. Dashboard: ${dashboardUrl}`);

    if (startupHints.length > 0) {
      out.blank();
      out.log("  Startup hints:");
      for (const hint of startupHints) {
        out.log(`    ${hint.pluginName}: ${hint.message}`);
      }
    }

    out.blank();
    out.log("  ────────────────────────────────────────");
    out.log("  Startup complete. Daemon running in foreground.");
    out.blank();
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      const pidHint = error.existingPid != null ? ` (PID: ${String(error.existingPid)})` : "";
      out.error(`The Engineer is already running${pidHint}.`);
      out.log("  Use 'engineer stop' to stop it, or 'engineer status' to check.");
      cleanupDashboard();
      cleanup();
      return 1;
    }
    observer.recordError(error, { operation: "daemon-start", component: "cli" });
    out.error(`Startup failed: ${sanitizeErrorMessage(error)}`);
    try {
      await daemon.stop();
    } catch (stopError) {
      process.stderr.write(`Warning: cleanup failed during startup error: ${sanitizeErrorMessage(stopError)}\n`);
    }
    cleanupDashboard();
    cleanup();
    return 1;
  }

  return 0;
}

// ── Dry Run ──────────────────────────────────────────────────────────────────

function runDryRun(_engineerHome: string, dirs: EngineerDirectories, preFlightResults: DoctorCategory[]): number {
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
  out.keyValue("Plugins", `${String(enabledPlugins.length)} plugins (${String(criticalCount)} critical)`);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Handle first-run setup if needed. Returns exit code or null to continue. */
async function handleFirstRunSetup(engineerHome: string, options: StartOptions): Promise<number | null> {
  const out = getOutput();

  if (!needsSetup(engineerHome)) {
    return null;
  }

  if (!(options.seedPath || process.stdin.isTTY)) {
    out.error("First-run setup requires an interactive terminal.");
    out.log("  Run 'engineer start' in a terminal first, or provide --seed <path>.");
    return 1;
  }

  const completed = await runFirstTimeSetup({
    engineerHome,
    seedPath: options.seedPath,
    dryRun: options.dryRun,
  });
  if (!completed) {
    out.log("Setup cancelled. Run 'engineer start' to try again.");
    return 0;
  }
  if (options.dryRun) {
    return 0;
  }

  return null;
}

/** Load config bundle from disk. Returns bundle or exit code on failure. */
function loadConfig(dirs: EngineerDirectories): { bundle: ConfigBundle } | { exitCode: number } {
  const out = getOutput();
  try {
    const result = loadConfigDir(dirs.config);
    for (const warning of result.warnings) {
      out.warn(`${warning.file}: ${warning.message}`);
    }
    return { bundle: result.bundle };
  } catch (error) {
    out.error(`Config error: ${sanitizeErrorMessage(error)}`);
    out.log("  Run 'engineer doctor' to diagnose.");
    return { exitCode: 1 };
  }
}

/** Create all required directories. Throws on failure. */
function ensureDirectories(dirs: EngineerDirectories): void {
  for (const dirPath of Object.values(dirs)) {
    try {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      throw new Error(`Cannot create directory "${dirPath}": ${message}. Check file permissions.`, {
        cause: error,
      });
    }
  }
}

/** Persist resolved env vars to .env so the daemon always has them (merge). */
function captureEnvVarsToFile(engineerHome: string, vars: Record<string, string>): void {
  if (Object.keys(vars).length > 0) {
    writeEnvFile(engineerHome, vars);
  }
}
