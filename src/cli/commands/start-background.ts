import { spawn } from "node:child_process";
import { getOutput } from "../output.js";

/** Spawn the daemon as a detached background process. Returns exit code. */
export function spawnBackground(engineerHome: string, verbose: boolean): number {
  const out = getOutput();
  const args = [process.argv[1] ?? "engineer", "start", "--home", engineerHome];
  if (verbose) {
    args.push("--verbose");
  }
  // Don't pass --daemon to child — it should run in foreground within the detached process

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", (err: Error) => {
    // Best-effort — parent process may already be exiting
    out.error(`Background process error: ${err.message}`);
  });

  if (!child.pid) {
    out.error("Failed to spawn background process.");
    return 1;
  }

  child.unref();

  // Sanity check — if the child already crashed (e.g., immediate bootstrap failure), warn
  try {
    process.kill(child.pid, 0);
  } catch {
    out.warn("Background process may have exited immediately. Use 'engineer status' to verify.");
    return 1;
  }

  out.success(`The Engineer started in background (PID ${String(child.pid)}).`);
  out.log("  Use 'engineer status' to verify startup, 'engineer shutdown' to stop.");
  return 0;
}
