import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";

import { extractErrorMessage } from "../../utils/errors.js";

/** Component tags for child loggers (Decision #110). */
export type ComponentTag =
  | "daemon"
  | "registry"
  | "orchestrator"
  | "task-engine"
  | "safety-layer"
  | "workspace-manager"
  | "skills"
  | "event-bus"
  | "cli"
  | "action-pipeline"
  | "plugin"
  | "plugin-loader"
  | "data-lifecycle"
  | "workspace-reaper"
  | "notifications"
  | "dashboard";

/** Logging config shape from DaemonConfigSchema. */
export interface LoggingConfig {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  dir: string;
  max_size_bytes: number;
  max_files: number;
  console: boolean;
}

/** Logger with a closeable transport handle. */
export interface LoggerHandle {
  logger: Logger;
  /** Flush and close the transport worker thread. Call during shutdown. */
  close: () => void;
}

/**
 * Create a root pino logger with rolling file transport (Decision #110-111).
 *
 * Uses pino-roll for daily rotation with size cap. Log directory is resolved
 * relative to engineerHome unless an absolute path is given.
 *
 * Returns a LoggerHandle so the caller can close the transport on shutdown,
 * flushing buffered log messages and releasing the worker thread.
 */
export function createLogger(config: LoggingConfig, engineerHome: string): LoggerHandle {
  const resolvedDir = isAbsolute(config.dir) ? config.dir : join(engineerHome, config.dir);
  try {
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Failed to create log directory "${resolvedDir}": ${extractErrorMessage(error)}`, { cause: error });
  }

  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-roll",
      options: {
        file: join(resolvedDir, "engineer.log"),
        frequency: "daily",
        size: config.max_size_bytes,
        limit: { count: config.max_files },
      },
      level: config.level,
    },
  ];

  if (config.console) {
    targets.push({
      target: "pino-pretty",
      options: { destination: 1 }, // stdout
      level: config.level,
    });
  }

  let transport: ReturnType<typeof pino.transport>;
  try {
    transport = pino.transport({ targets });
  } catch (error) {
    const targetNames = targets.map((t) => t.target).join(", ");
    throw new Error(`Failed to create log transport (targets: ${targetNames}): ${extractErrorMessage(error)}`, {
      cause: error,
    });
  }

  const logger = pino(
    {
      level: config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

  return {
    logger,
    close() {
      transport.end();
    },
  };
}

/** Create a child logger tagged with a component name. */
export function createChildLogger(parent: Logger, component: ComponentTag): Logger {
  return parent.child({ component });
}

/** Create a silent logger for tests (no output, no transport to close). */
export function createSilentLogger(): LoggerHandle {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional noop — silent logger has no transport
  return { logger: pino({ level: "silent" }), close() {} };
}
