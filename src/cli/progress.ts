import { getOutput } from "./output.js";

// ── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const CLEAR_LINE = "\x1B[2K\r";

/**
 * Spinner for indeterminate progress.
 * Writes to stderr so stdout remains clean for piping/JSON.
 * No-op if not a TTY or in json mode.
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
    const displayMessage = message ?? this.message;
    process.stderr.write(`${CLEAR_LINE}  \x1B[32m✓\x1B[0m ${displayMessage}\n`);
  }

  /** Stop with a failure message. */
  fail(message?: string): void {
    this.clearInterval();
    if (this.silent) {
      return;
    }
    const displayMessage = message ?? this.message;
    process.stderr.write(`${CLEAR_LINE}  \x1B[31m✗\x1B[0m ${displayMessage}\n`);
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
