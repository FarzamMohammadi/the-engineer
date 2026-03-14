import { getOutput } from "./output.js";

// ── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const CLEAR_LINE = "\x1B[2K\r";

/**
 * Spinner for indeterminate progress.
 * Writes to stderr so stdout remains clean for piping/JSON.
 * No-op if not a TTY or in json/quiet mode.
 */
export class Spinner {
  private message: string;
  private frameIndex = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly silent: boolean;

  constructor(message: string, silent?: boolean) {
    this.message = message;
    this.silent = silent ?? detectSilent();
  }

  /** Start the spinner animation. */
  start(): void {
    if (this.silent || this.intervalId !== null) {
      return;
    }
    this.intervalId = setInterval(() => {
      const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
      process.stderr.write(`${CLEAR_LINE}  ${frame} ${this.message}`);
      this.frameIndex++;
    }, SPINNER_INTERVAL_MS);
  }

  /** Update the spinner message. */
  update(message: string): void {
    this.message = message;
  }

  /** Stop with a success message. */
  succeed(message?: string): void {
    this.clearInterval();
    if (this.silent) {
      return;
    }
    const msg = message ?? this.message;
    process.stderr.write(`${CLEAR_LINE}  \x1B[32m✓\x1B[0m ${msg}\n`);
  }

  /** Stop with a failure message. */
  fail(message?: string): void {
    this.clearInterval();
    if (this.silent) {
      return;
    }
    const msg = message ?? this.message;
    process.stderr.write(`${CLEAR_LINE}  \x1B[31m✗\x1B[0m ${msg}\n`);
  }

  /** Stop the spinner without a status message. */
  stop(): void {
    this.clearInterval();
    if (this.silent) {
      return;
    }
    process.stderr.write(CLEAR_LINE);
  }

  private clearInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// ── ProgressBar ──────────────────────────────────────────────────────────────

const BAR_WIDTH = 30;

/**
 * Progress bar for determinate progress.
 * Writes to stderr. No-op if not a TTY or in json/quiet mode.
 */
export class ProgressBar {
  private readonly total: number;
  private current = 0;
  private readonly message: string;
  private readonly silent: boolean;

  constructor(total: number, message: string, silent?: boolean) {
    this.total = total;
    this.message = message;
    this.silent = silent ?? detectSilent();
  }

  /** Increment progress by `amount` (default 1). */
  tick(amount = 1): void {
    this.current = Math.min(this.current + amount, this.total);
    if (this.silent) {
      return;
    }
    this.render();
  }

  /** Complete the progress bar. */
  complete(): void {
    this.current = this.total;
    if (this.silent) {
      return;
    }
    this.render();
    process.stderr.write("\n");
  }

  private render(): void {
    const ratio = this.total > 0 ? this.current / this.total : 1;
    const filled = Math.round(ratio * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
    const pct = Math.round(ratio * 100);
    process.stderr.write(`${CLEAR_LINE}  ${bar} ${String(pct)}% ${this.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectSilent(): boolean {
  if (!process.stderr.isTTY) {
    return true;
  }
  try {
    const mode = getOutput().mode;
    return mode !== "human";
  } catch {
    return false;
  }
}
