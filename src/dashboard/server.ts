/**
 * Dashboard HTTP server — Hono app with read-only SQLite access.
 *
 * Runs as a separate process from the daemon. Reads from the same
 * SQLite database in WAL mode (concurrent readers are safe).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { BlobStore } from "../core/observer/index.js";
import { createObservationStore } from "../core/observer/index.js";
import { errorRoutes } from "./api/errors.js";
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

  // CORS restricted to localhost — dashboard and Vite dev server
  app.use("/*", cors({ origin: ["http://localhost:3847", "http://localhost:5173"] }));

  // Mount API routes
  app.route("/api/system", systemRoutes({ db, observationStore, runDir: config.runDir }));
  app.route("/api/tasks", taskRoutes({ db, writeDb, observationStore }));
  app.route("/api/events", eventRoutes({ db }));
  app.route("/api/metrics", metricsRoutes({ db, observationStore }));
  app.route("/api/traces", traceRoutes({ observationStore }));
  app.route("/api/blob", blobRoutes({ observationStore }));
  app.route("/api/observations", observationRoutes({ observationStore }));
  app.route("/api/errors", errorRoutes({ db, observationStore }));
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

  // Serve built React SPA from dist/dashboard/
  const spaDir = resolve(import.meta.dirname, "../../dist/dashboard");

  app.get("/*", (c) => {
    const urlPath = c.req.path;

    // Try serving static assets first (JS, CSS, images)
    const assetPath = join(spaDir, urlPath);
    if (urlPath !== "/" && existsSync(assetPath)) {
      const content = readFileSync(assetPath);
      const ext = urlPath.split(".").pop() ?? "";
      const contentTypes: Record<string, string> = {
        js: "application/javascript",
        css: "text/css",
        svg: "image/svg+xml",
        png: "image/png",
        ico: "image/x-icon",
        json: "application/json",
      };
      return c.body(content, 200, {
        "Content-Type": contentTypes[ext] ?? "application/octet-stream",
      });
    }

    // SPA catch-all — serve index.html for client-side routing
    const indexPath = join(spaDir, "index.html");
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    }

    return c.text("Dashboard not built. Run: pnpm build:dashboard", 404);
  });

  return { app, db, writeDb };
}
