import chalk from "chalk";

// ── Types ────────────────────────────────────────────────────────────────────

export type OutputMode = "human" | "json" | "quiet";

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
 * 2. --quiet flag → "quiet" mode
 * 3. Default → "human" mode
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
  private clr(fn: (s: string) => string, text: string): string {
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
    process.stdout.write(`${this.clr(chalk.green, "✓")} ${message}\n`);
  }

  /** Print a warning with yellow prefix (human mode). */
  warn(message: string): void {
    if (this.mode !== "human") {
      return;
    }
    process.stdout.write(`${this.clr(chalk.yellow, "⚠")} ${message}\n`);
  }

  /** Print an error with red prefix. Works in human + quiet modes. JSON mode outputs structured error. */
  error(message: string): void {
    if (this.mode === "json") {
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      return;
    }
    process.stderr.write(`${this.clr(chalk.red, "✗")} ${message}\n`);
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
    process.stdout.write(`  ${this.clr(chalk.dim, padded)} ${value}\n`);
  }

  /** Print a table from an array of objects (human mode). */
  table(rows: Record<string, string | number | boolean>[]): void {
    if (this.mode !== "human" || rows.length === 0) {
      return;
    }

    const firstRow = rows[0];
    if (!firstRow) {
      return;
    }
    const keys = Object.keys(firstRow);
    const widths = new Map<string, number>();

    // Calculate column widths (header + all values)
    for (const key of keys) {
      let max = key.length;
      for (const row of rows) {
        const len = String(row[key] ?? "").length;
        if (len > max) {
          max = len;
        }
      }
      widths.set(key, max);
    }

    const w = (k: string) => widths.get(k) ?? 0;

    // Header
    const header = keys.map((k) => this.clr(chalk.bold, k.padEnd(w(k)))).join("  ");
    process.stdout.write(`  ${header}\n`);

    // Separator
    const sep = keys.map((k) => "─".repeat(w(k))).join("──");
    process.stdout.write(`  ${this.clr(chalk.dim, sep)}\n`);

    // Rows
    for (const row of rows) {
      const line = keys.map((k) => String(row[k] ?? "").padEnd(w(k))).join("  ");
      process.stdout.write(`  ${line}\n`);
    }
  }

  /** Output structured data. JSON mode: prints JSON. Human mode: prints formatted. */
  data(obj: unknown): void {
    if (this.mode === "quiet") {
      return;
    }
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
export function _resetOutput(): void {
  instance = undefined;
}
