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

/** Stops the daemon by sending SIGTERM and waiting for exit. Returns exit code. */
export async function runStop(engineerHome: string, timeoutMs: number): Promise<number> {
  const pid = readPidFile(engineerHome);

  if (pid === null || !isProcessRunning(pid)) {
    console.log("  The Engineer is not running.");
    return 0;
  }

  console.log(`  Stopping The Engineer (PID ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log("  Process already exited.");
    return 0;
  }

  const exited = await waitForProcessExit(pid, timeoutMs);

  if (exited) {
    console.log("  The Engineer stopped.");
    return 0;
  }

  console.log(`  Warning: Process did not exit within ${timeoutMs}ms.`);
  console.log(`  PID ${pid} may still be running.`);
  return 1;
}
