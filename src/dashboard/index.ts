/**
 * Dashboard entry point — starts HTTP server.
 */
import { serve } from "@hono/node-server";

import { createDashboardApp } from "./server.js";
import type { DashboardConfig } from "./server.js";

export type { DashboardConfig } from "./server.js";

export function startDashboard(config: DashboardConfig, port: number): { close: () => void } {
  const { app, db, writeDb } = createDashboardApp(config);

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log("\n  The Engineer — War Room Dashboard");
    console.log(`  http://localhost:${String(info.port)}\n`);
  });

  return {
    close() {
      writeDb.close();
      db.close();
      server.close();
    },
  };
}
