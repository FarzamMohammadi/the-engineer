import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** PID file path within ENGINEER_HOME. */
export function pidFilePath(engineerHome: string): string {
  return join(engineerHome, "run", "engineer.pid");
}

/**
 * Reads the PID from the engineer.pid file.
 * Returns the PID number or null if the file is missing/invalid.
 */
export function readPidFile(engineerHome: string): number | null {
  const filePath = pidFilePath(engineerHome);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf8").trim();
    const pid = Number.parseInt(content, 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Checks if a process with the given PID is currently running.
 * Uses signal 0 (no-op signal) to test process existence.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
