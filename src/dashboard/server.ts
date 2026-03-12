/**
 * Dashboard HTTP server — Hono app with read-only SQLite access.
 *
 * Runs as a separate process from the daemon. Reads from the same
 * SQLite database in WAL mode (concurrent readers are safe).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { BlobStore } from "../core/observability/blob-store.js";
import { ObservabilityStore } from "../core/observability/index.js";
import { eventRoutes } from "./api/events.js";
import { metricsRoutes } from "./api/metrics.js";
import { systemRoutes } from "./api/system.js";
import { taskRoutes } from "./api/tasks.js";
import { blobRoutes, traceRoutes } from "./api/traces.js";

export interface DashboardConfig {
  dbPath: string;
  tracesDir: string;
  runDir: string;
}

export function createDashboardApp(config: DashboardConfig): {
  app: Hono;
  db: Database.Database;
} {
  // Open DB read-only (WAL mode allows concurrent readers)
  const db = new BetterSqlite3(config.dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const blobStore = new BlobStore(config.tracesDir);
  const observability = new ObservabilityStore(db, blobStore);

  const app = new Hono();

  // CORS for local development
  app.use("/*", cors());

  // Mount API routes
  app.route("/api/system", systemRoutes({ db, observability, runDir: config.runDir }));
  app.route("/api/tasks", taskRoutes({ db, observability }));
  app.route("/api/events", eventRoutes({ db }));
  app.route("/api/metrics", metricsRoutes({ db, observability }));
  app.route("/api/traces", traceRoutes({ observability }));
  app.route("/api/blob", blobRoutes({ observability }));

  // Serve static dashboard HTML
  app.get("/", (c) => {
    const htmlPath = join(import.meta.dirname, "static", "index.html");
    const html = readFileSync(htmlPath, "utf-8");
    return c.html(html);
  });

  return { app, db };
}
