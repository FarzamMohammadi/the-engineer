import { sanitizeErrorMessage } from "../../../utils/sanitize.js";

/** Dependencies required for shutdown signal handling. */
interface ShutdownDependencies {
  readonly daemon: { stop(): Promise<void> };
  readonly observer?: {
    info(message: string, data?: Record<string, unknown>): void;
    recordError(error: unknown, context: Record<string, unknown>): void;
  };
  readonly cleanup: () => void;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Register SIGTERM/SIGINT handlers for APE-proof graceful shutdown. */
export function registerShutdownHandlers(dependencies: ShutdownDependencies): void {
  const { daemon, observer, cleanup } = dependencies;
  let shutdownInProgress = false;
  let cleanedUp = false;

  function runCleanup(): void {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    cleanup();
  }

  function handleShutdownSignal(): void {
    if (shutdownInProgress) {
      process.stderr.write("\nForced shutdown — exiting immediately.\n");
      runCleanup();
      process.exit(1);
    }
    shutdownInProgress = true;

    const forceExitTimer = setTimeout(() => {
      process.stderr.write("\nShutdown timed out — force exiting.\n");
      runCleanup();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    observer?.info("Shutdown signal received, stopping daemon...");
    daemon
      .stop()
      .catch((err) => {
        try {
          observer?.recordError(err, { operation: "shutdown", component: "cli" });
        } catch {
          // Observer transport may be broken during shutdown
        }
        process.stderr.write(`Shutdown error: ${sanitizeErrorMessage(err)}\n`);
      })
      .finally(() => {
        clearTimeout(forceExitTimer);
        runCleanup();
        observer?.info("Shutdown complete");
        process.exit(0);
      });
  }

  process.on("SIGTERM", handleShutdownSignal);
  process.on("SIGINT", handleShutdownSignal);
}
