import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { getOutput } from "../output.js";
import { isProcessRunning, readPidFile } from "../pid.js";

/**
 * Waits for a process to exit, polling every 200ms.
 * Returns true if the process exited, false on timeout.
 */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 200;

  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollInterval);
    });
  }

  return !isProcessRunning(pid);
}

/** Shuts down the daemon and all subsidiary processes. Returns exit code. */
export async function runShutdown(engineerHome: string, timeoutMs: number): Promise<number> {
  const out = getOutput();
  const pid = readPidFile(engineerHome);

  if (pid === null || !isProcessRunning(pid)) {
    out.log("  The Engineer is not running.");
    cleanupAll(engineerHome);
    return 0;
  }

  out.log(`  Stopping The Engineer (PID ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    out.log("  Process already exited.");
    cleanupAll(engineerHome);
    return 0;
  }

  const exited = await waitForProcessExit(pid, timeoutMs);

  if (exited) {
    out.log("  The Engineer stopped.");
  } else {
    out.warn(`Process did not exit within ${timeoutMs}ms.`);
    out.log(`  PID ${pid} may still be running.`);
  }

  cleanupAll(engineerHome);

  return exited ? 0 : 1;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
// Add new subsidiary processes here as they're introduced.

/** Stops all subsidiary processes (dashboard, future services). */
function cleanupAll(engineerHome: string): void {
  stopByPidFile(engineerHome, "dashboard.pid", "Dashboard");
  // Future: stopByPidFile(engineerHome, "webhook-server.pid", "Webhook server");
}

/** Generic: read a PID file, kill the process, remove the file. */
function stopByPidFile(engineerHome: string, filename: string, label: string): void {
  const out = getOutput();
  const pidPath = join(engineerHome, "run", filename);

  if (!existsSync(pidPath)) {
    return;
  }

  try {
    const content = readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(content, 10);

    if (!Number.isNaN(pid) && pid > 0 && isProcessRunning(pid)) {
      process.kill(pid, "SIGTERM");
      out.log(`  ${label} stopped (PID ${String(pid)}).`);
    }

    unlinkSync(pidPath);
  } catch {
    // PID file stale or already cleaned up
  }
}
