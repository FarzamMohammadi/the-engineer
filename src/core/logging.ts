import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";

/** Component tags for child loggers (Decision #110). */
export type ComponentTag =
  | "daemon"
  | "registry"
  | "orchestrator"
  | "task-engine"
  | "safety"
  | "session-memory"
  | "workspace-manager"
  | "event-bus"
  | "people-directory"
  | "config"
  | "cli";

/** Logging config shape from DaemonConfigSchema. */
export interface LoggingConfig {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  dir: string;
  max_size_bytes: number;
  max_files: number;
  console: boolean;
}

/**
 * Create a root pino logger with rolling file transport (Decision #110-111).
 *
 * Uses pino-roll for daily rotation with size cap. Log directory is resolved
 * relative to engineerHome unless an absolute path is given.
 */
export function createLogger(config: LoggingConfig, engineerHome: string): Logger {
  const resolvedDir = isAbsolute(config.dir) ? config.dir : join(engineerHome, config.dir);
  try {
    mkdirSync(resolvedDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `Failed to create log directory "${resolvedDir}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
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

  const transport = pino.transport({ targets });

  return pino(
    {
      level: config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );
}

/** Create a child logger tagged with a component name. */
export function createChildLogger(parent: Logger, component: ComponentTag): Logger {
  return parent.child({ component });
}

/** Create a silent logger for tests (no output). */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}
