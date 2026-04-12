import type { ChildProcess } from "node:child_process";

/** Grace period before SIGKILL after SIGTERM (ms). */
export const KILL_GRACE_MS = 5000;

/**
 * Kill a child process gracefully: SIGTERM first, then SIGKILL after grace period.
 *
 * Uses `child.exitCode` (not `child.killed`) to determine if the process is still
 * alive — `child.killed` is set to `true` after any successful `kill()` call,
 * regardless of whether the process actually exited.
 *
 * Safe to call on already-dead processes (`child.kill()` returns false but does not throw).
 */
export function killProcess(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
}
