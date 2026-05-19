import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startDashboard } from "../../../dashboard/index.js";
import { sanitizeErrorMessage } from "../../../utils/sanitize.js";
import type { EngineerDirectories } from "../../home.js";
import { getOutput } from "../../output.js";

export const DASHBOARD_PORT = 3847;

/** Launch the dashboard alongside the daemon. */
export function launchDashboard(dirs: EngineerDirectories): { cleanup: () => void } {
  const out = getOutput();
  const dbPath = join(dirs.data, "engineer.db");
  const pidPath = join(dirs.run, "dashboard.pid");
  let dashboardHandle: { close: () => void } | null = null;

  if (existsSync(dbPath)) {
    try {
      dashboardHandle = startDashboard({ dbPath, tracesDir: dirs.traces, runDir: dirs.run }, DASHBOARD_PORT);
      writeFileSync(pidPath, String(process.pid), "utf8");
    } catch (error) {
      out.warn(`Dashboard failed to start: ${sanitizeErrorMessage(error)}`);
    }
  }

  return {
    cleanup() {
      dashboardHandle?.close();
      try {
        unlinkSync(pidPath);
      } catch {
        // already removed
      }
    },
  };
}
