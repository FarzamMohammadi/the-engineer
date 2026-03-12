/**
 * Dashboard entry point — starts HTTP server.
 */
import { serve } from "@hono/node-server";

import { createDashboardApp } from "./server.js";
import type { DashboardConfig } from "./server.js";

export type { DashboardConfig } from "./server.js";

export function startDashboard(config: DashboardConfig, port: number): { close: () => void } {
  const { app, db } = createDashboardApp(config);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log("\n  The Engineer — War Room Dashboard");
    console.log(`  http://localhost:${String(info.port)}\n`);
  });

  return {
    close() {
      db.close();
      server.close();
    },
  };
}
