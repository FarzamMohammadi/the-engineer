/**
 * Dashboard HTTP server — Hono app with read-only SQLite access.
 *
 * Runs as a separate process from the daemon. Reads from the same
 * SQLite database in WAL mode (concurrent readers are safe).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { BlobStore } from "../core/observer/index.js";
import { createObservationStore } from "../core/observer/index.js";
import { eventRoutes } from "./api/events.js";
import { messagesRoutes } from "./api/messages.js";
import { metricsRoutes } from "./api/metrics.js";
import { observationRoutes } from "./api/observations.js";
import { streamRoutes } from "./api/stream.js";
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
  writeDb: Database.Database;
} {
  // Open DB read-only (WAL mode allows concurrent readers)
  const db = new BetterSqlite3(config.dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  // Writable connection for dashboard responses (WAL supports concurrent writers)
  const writeDb = new BetterSqlite3(config.dbPath);
  writeDb.pragma("journal_mode = WAL");
  writeDb.pragma("busy_timeout = 5000");

  const blobStore = new BlobStore(config.tracesDir);
  const observationStore = createObservationStore(db, blobStore);

  const app = new Hono();

  // CORS restricted to localhost — dashboard must not be accessible from the LAN
  app.use("/*", cors({ origin: "http://localhost:3847" }));

  // Mount API routes
  app.route("/api/system", systemRoutes({ db, observationStore, runDir: config.runDir }));
  app.route("/api/tasks", taskRoutes({ db, observationStore }));
  app.route("/api/events", eventRoutes({ db }));
  app.route("/api/metrics", metricsRoutes({ db, observationStore }));
  app.route("/api/traces", traceRoutes({ observationStore }));
  app.route("/api/blob", blobRoutes({ observationStore }));
  app.route("/api/observations", observationRoutes({ observationStore }));
  app.route("/api/stream", streamRoutes({ db }));
  app.route("/api/messages", messagesRoutes({ writeDb }));

  // Open a directory in VS Code
  app.post("/api/open-explorer", async (c) => {
    const body = await c.req.json<{ path: string }>();
    const dirPath = body.path;
    if (!dirPath || typeof dirPath !== "string") {
      return c.json({ error: "Missing path" }, 400);
    }
    if (!existsSync(dirPath)) {
      return c.json({ error: "Path does not exist" }, 404);
    }
    execFile("code", [dirPath], (err) => {
      if (err) {
        console.error("Failed to open in VS Code:", err.message);
      }
    });
    return c.json({ ok: true });
  });

  // Serve static dashboard HTML
  app.get("/", (c) => {
    const htmlPath = join(import.meta.dirname, "static", "index.html");
    const html = readFileSync(htmlPath, "utf-8");
    return c.html(html);
  });

  return { app, db, writeDb };
}
