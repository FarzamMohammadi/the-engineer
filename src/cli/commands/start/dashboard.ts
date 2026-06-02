import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IObserver } from "../../../core/observer/facade.js";
import { startDashboard } from "../../../dashboard/index.js";
import type { TelemetryConfig } from "../../../schemas/config.js";
import { sanitizeErrorMessage } from "../../../utils/sanitize.js";
import type { EngineerDirectories } from "../../home.js";
import { getOutput } from "../../output.js";
import { TRACE_UI_URL } from "./telemetry.js";

export const DASHBOARD_PORT = 3847;

/** Launch the dashboard alongside the daemon. */
export function launchDashboard(
  dirs: EngineerDirectories,
  observer: IObserver,
  telemetry: TelemetryConfig,
): { cleanup: () => void } {
  const out = getOutput();
  const dbPath = join(dirs.data, "engineer.db");
  const pidPath = join(dirs.run, "dashboard.pid");
  let dashboardHandle: { close: () => void } | null = null;

  if (existsSync(dbPath)) {
    try {
      dashboardHandle = startDashboard(
        {
          dbPath,
          tracesDir: dirs.traces,
          runDir: dirs.run,
          observer: observer.child("dashboard"),
          // The link is shown only when export is on; the UI base is the same Jaeger v2 web-UI the start
          // output points at, kept single-sourced in telemetry.ts (distinct from the OTLP ingest endpoint).
          telemetryEnabled: telemetry.enabled,
          telemetryUiBase: TRACE_UI_URL,
        },
        DASHBOARD_PORT,
      );
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
