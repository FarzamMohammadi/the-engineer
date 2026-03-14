import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ConfigBundle, loadConfigDir } from "../../config/loader.js";
import { discoverPlugins } from "../../core/registry/discovery.js";
import { startDashboard } from "../../dashboard/index.js";
import { type ProgressCallback, bootstrap } from "../bootstrap.js";
import { type EngineerDirs, resolveSubdirs } from "../home.js";
import { getOutput } from "../output.js";
import { Spinner } from "../progress.js";
import { computeExitCode, formatDoctorResults, runPreFlightChecks } from "./doctor.js";

const DASHBOARD_PORT = 3847;

interface StartOptions {
  daemon: boolean;
  verbose: boolean;
  dryRun: boolean;
}

/** Boots the daemon. Returns exit code. */
export async function runStart(engineerHome: string, options: StartOptions): Promise<number> {
  const out = getOutput();

  // 1. Auto-create directories
  const dirs = resolveSubdirs(engineerHome);
  for (const dirPath of Object.values(dirs)) {
    mkdirSync(dirPath, { recursive: true });
  }

  // 2. Load config
  let bundle: ConfigBundle | undefined;
  try {
    const result = loadConfigDir(dirs.config);
    bundle = result.bundle;
    for (const w of result.warnings) {
      out.warn(`${w.file}: ${w.message}`);
    }
  } catch (error) {
    out.error(`Config error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (!bundle) {
    out.error("Config loading failed unexpectedly.");
    return 1;
  }

  // 3. Run pre-flight checks (doctor categories 1-6)
  const preFlightResults = runPreFlightChecks(engineerHome);
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

  // 6. Foreground mode: bootstrap and start with progress indicators
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
  const totalChecks = preFlightResults.reduce((sum, c) => sum + c.checks.length, 0);
  progress(`Pre-flight: ${String(totalChecks)}/${String(totalChecks)} checks passed`, "done");

  const { daemon, cleanup } = await bootstrap(engineerHome, bundle, options.verbose, progress);

  // 7. Start dashboard alongside daemon
  const { cleanup: cleanupDashboard } = launchDashboard(dirs);

  // Signal handlers for graceful shutdown
  const shutdown = async () => {
    await daemon.stop();
    cleanupDashboard();
    cleanup();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch(() => {
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch(() => {
      process.exit(1);
    });
  });

  try {
    const startSpinner = new Spinner("Starting daemon");
    startSpinner.start();
    await daemon.start();
    startSpinner.succeed("Daemon running");
    const warRoomUrl = `http://localhost:${String(DASHBOARD_PORT)}`;
    out.blank();
    out.success(`The Engineer is ready. War Room: ${warRoomUrl}`);
  } catch (error) {
    out.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    cleanupDashboard();
    cleanup();
    return 1;
  }

  return 0;
}

// ── Dry Run ──────────────────────────────────────────────────────────────────

function runDryRun(
  engineerHome: string,
  dirs: EngineerDirs,
  preFlightResults: import("./doctor.js").DoctorCategory[],
): number {
  const out = getOutput();
  const totalChecks = preFlightResults.reduce((sum, c) => sum + c.checks.length, 0);
  const discovered = discoverPlugins([join(engineerHome, "plugins")]);
  const criticalCount = discovered.filter((p) => p.manifest.critical).length;

  if (out.mode === "json") {
    out.data({
      config: { dir: dirs.config },
      database: {
        path: join(dirs.data, "engineer.db"),
        exists: existsSync(join(dirs.data, "engineer.db")),
      },
      plugins: discovered.map((p) => ({
        id: p.manifest.id,
        type: p.manifest.type,
        critical: p.manifest.critical,
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
    `${String(discovered.length)} plugins (${String(criticalCount)} critical)`,
  );
  out.keyValue("Pre-flight", `${String(totalChecks)}/${String(totalChecks)} checks passed`);

  out.blank();
  out.log("  Plugin loading order:");
  for (const [i, p] of discovered.entries()) {
    const label = p.manifest.critical ? "CRITICAL" : "non-critical";
    out.log(`    ${String(i + 1)}. ${p.manifest.id} (${p.manifest.type}) — ${label}`);
  }

  out.blank();
  out.success("Everything looks good. Run without --dry-run to start.");
  return 0;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function launchDashboard(dirs: EngineerDirs): { cleanup: () => void } {
  const out = getOutput();
  const dbPath = join(dirs.data, "engineer.db");
  const pidPath = join(dirs.run, "dashboard.pid");
  let handle: { close: () => void } | null = null;

  if (existsSync(dbPath)) {
    try {
      handle = startDashboard({ dbPath, tracesDir: dirs.traces, runDir: dirs.run }, DASHBOARD_PORT);
      writeFileSync(pidPath, String(process.pid), "utf8");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      out.warn(`Dashboard failed to start: ${msg}`);
    }
  }

  return {
    cleanup() {
      handle?.close();
      try {
        unlinkSync(pidPath);
      } catch {
        // already removed
      }
    },
  };
}

function spawnBackground(engineerHome: string, verbose: boolean): number {
  const out = getOutput();
  const args = [process.argv[1] ?? "engineer", "start", "--home", engineerHome];
  if (verbose) {
    args.push("--verbose");
  }
  // Don't pass --daemon to child — it should run in foreground within the detached process

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  out.success(`The Engineer started in background (PID ${child.pid}).`);
  out.log("  Use 'engineer status' to check, 'engineer shutdown' to stop.");
  return 0;
}
