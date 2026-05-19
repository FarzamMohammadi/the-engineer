import chalk from "chalk";

// ── Types ────────────────────────────────────────────────────────────────────

/** Output rendering mode: human-readable text or structured JSON. */
export type OutputMode = "human" | "json";

/** Construction options for the {@link Output} singleton. */
export interface OutputOptions {
  /** Force a specific mode. Default: "human". */
  mode?: OutputMode;
  /** Force color on/off. Auto-detected if not set. */
  color?: boolean;
}

// ── Output Class ─────────────────────────────────────────────────────────────

/**
 * CLI output controller.
 *
 * Mode detection (in order of precedence):
 * 1. --json flag → "json" mode
 * 2. Default → "human" mode
 *
 * Color detection:
 * 1. NO_COLOR env var (any value) → colors off (https://no-color.org/)
 * 2. FORCE_COLOR env var → colors on
 * 3. stdout.isTTY → colors on if TTY, off if pipe
 */
export class Output {
  readonly mode: OutputMode;
  readonly color: boolean;

  constructor(options?: OutputOptions) {
    this.mode = options?.mode ?? "human";
    this.color = options?.color ?? detectColor();
  }

  /** Apply color function only when color is enabled. */
  private colorize(fn: (s: string) => string, text: string): string {
    return this.color ? fn(text) : text;
  }

  /** Print a line (human mode only). */
  log(message: string): void {
    if (this.mode !== "human") {
      return;
    }
    process.stdout.write(`${message}\n`);
  }

  /** Print a success message with green checkmark (human mode). */
  success(message: string): void {
    if (this.mode !== "human") {
      return;
    }
    process.stdout.write(`${this.colorize(chalk.green, "✓")} ${message}\n`);
  }

  /** Print a warning with yellow prefix (human mode). */
  warn(message: string): void {
    if (this.mode !== "human") {
      return;
    }
    process.stdout.write(`${this.colorize(chalk.yellow, "⚠")} ${message}\n`);
  }

  /** Print an error with red prefix (human mode). JSON mode outputs structured error. */
  error(message: string): void {
    if (this.mode === "json") {
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      return;
    }
    process.stderr.write(`${this.colorize(chalk.red, "✗")} ${message}\n`);
  }

  /** Print a heading with bold/underline (human mode). */
  heading(message: string): void {
    if (this.mode !== "human") {
      return;
    }
    const styled = this.color ? chalk.bold.underline(message) : message;
    process.stdout.write(`${styled}\n`);
  }

  /** Print a key-value pair with aligned formatting (human mode). */
  keyValue(key: string, value: string): void {
    if (this.mode !== "human") {
      return;
    }
    const padded = `${key}:`.padEnd(16);
    process.stdout.write(`  ${this.colorize(chalk.dim, padded)} ${value}\n`);
  }

  /** Output structured data as JSON (both human and json modes). */
  data(obj: unknown): void {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  }

  /** Print a blank line (human mode only). */
  blank(): void {
    if (this.mode !== "human") {
      return;
    }
    process.stdout.write("\n");
  }
}

// ── Color Detection ──────────────────────────────────────────────────────────

function detectColor(): boolean {
  if ("NO_COLOR" in process.env) {
    return false;
  }
  if ("FORCE_COLOR" in process.env) {
    return true;
  }
  return process.stdout.isTTY === true;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let instance: Output | undefined;

/** Create a global Output instance. Called once at CLI startup. */
export function createOutput(options?: OutputOptions): Output {
  instance = new Output(options);
  return instance;
}

/** Get the current Output instance. Creates a default if not initialized. */
export function getOutput(): Output {
  if (!instance) {
    instance = new Output();
  }
  return instance;
}

/** Reset the singleton. For testing only. */
export function resetOutput(): void {
  instance = undefined;
}
