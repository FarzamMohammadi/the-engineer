/**
 * `engineer dashboard` — starts the War Room dashboard as a separate HTTP server.
 *
 * Reads from the same SQLite DB in WAL mode (read-only).
 * Works independently of the daemon — can view historical data when daemon is stopped.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { startDashboard } from "../../dashboard/index.js";
import type { EngineerDirs } from "../home.js";

export interface DashboardOptions {
  port: number;
  open: boolean;
}

export async function runDashboard(dirs: EngineerDirs, options: DashboardOptions): Promise<void> {
  const dbPath = join(dirs.data, "engineer.db");

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    console.error('Run "engineer init" and "engineer start" first.');
    process.exitCode = 1;
    return;
  }

  const handle = startDashboard(
    {
      dbPath,
      tracesDir: dirs.traces,
      runDir: dirs.run,
    },
    options.port,
  );

  if (options.open) {
    const { exec } = await import("node:child_process");
    const url = `http://localhost:${String(options.port)}`;
    // macOS: open, Linux: xdg-open
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${cmd} ${url}`);
  }

  // Keep alive until Ctrl+C
  process.on("SIGINT", () => {
    console.log("\nShutting down dashboard...");
    handle.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    handle.close();
    process.exit(0);
  });
}
