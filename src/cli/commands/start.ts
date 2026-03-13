import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ConfigBundle, loadConfigDir } from "../../config/loader.js";
import { startDashboard } from "../../dashboard/index.js";
import { bootstrap } from "../bootstrap.js";
import { type EngineerDirs, resolveSubdirs } from "../home.js";
import { computeExitCode, formatDoctorResults, runPreFlightChecks } from "./doctor.js";

const DASHBOARD_PORT = 3847;

interface StartOptions {
  daemon: boolean;
  verbose: boolean;
}

/** Boots the daemon. Returns exit code. */
export async function runStart(engineerHome: string, options: StartOptions): Promise<number> {
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
      console.log(`  Warning: ${w.file}: ${w.message}`);
    }
  } catch (error) {
    console.error(`  Config error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (!bundle) {
    console.error("  Config loading failed unexpectedly.");
    return 1;
  }

  // 3. Run pre-flight checks (doctor categories 1-6)
  const preFlightResults = runPreFlightChecks(engineerHome);
  const preFlightCode = computeExitCode(preFlightResults);

  if (preFlightCode === 1) {
    console.error("  Pre-flight checks failed:");
    console.error(formatDoctorResults(preFlightResults));
    return 1;
  }

  if (preFlightCode === 2 && options.verbose) {
    console.log("  Pre-flight warnings:");
    console.log(formatDoctorResults(preFlightResults));
  }

  // 4. Background mode: re-spawn as detached child
  if (options.daemon) {
    return spawnBackground(engineerHome, options.verbose);
  }

  // 5. Foreground mode: bootstrap and start
  const { daemon, cleanup } = await bootstrap(engineerHome, bundle, options.verbose);

  // 6. Start dashboard alongside daemon
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
    console.log("  Starting The Engineer...");
    await daemon.start();
    const warRoomUrl = `http://localhost:${String(DASHBOARD_PORT)}`;
    console.log(`  Engineer started. Access the War Room at: ${warRoomUrl}`);
  } catch (error) {
    console.error(`  Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    cleanupDashboard();
    cleanup();
    return 1;
  }

  // Daemon.start() returns after the tick loop is set up — process stays alive
  // via the setInterval in the daemon. We just wait here.
  return 0;
}

function launchDashboard(dirs: EngineerDirs): { cleanup: () => void } {
  const dbPath = join(dirs.data, "engineer.db");
  const pidPath = join(dirs.run, "dashboard.pid");
  let handle: { close: () => void } | null = null;

  if (existsSync(dbPath)) {
    try {
      handle = startDashboard({ dbPath, tracesDir: dirs.traces, runDir: dirs.run }, DASHBOARD_PORT);
      writeFileSync(pidPath, String(process.pid), "utf8");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  Dashboard failed to start: ${msg}`);
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

  console.log(`  The Engineer started in background (PID ${child.pid}).`);
  console.log("  Use 'engineer status' to check, 'engineer shutdown' to stop.");
  return 0;
}
