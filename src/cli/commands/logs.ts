import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pinoPretty from "pino-pretty";

import { getOutput } from "../output.js";

interface LogsOptions {
  readonly json: boolean;
  readonly lines: number;
  readonly follow: boolean;
}

/** Displays log output. Returns exit code. */
export function runLogs(engineerHome: string, options: LogsOptions): number {
  const out = getOutput();
  const logFile = findLogFile(engineerHome);

  if (!logFile) {
    if (out.mode === "json") {
      out.data({ logFile: null, logsDir: join(engineerHome, "logs") });
    } else {
      out.log("  No log file found.");
      out.log(`  Logs are stored in ${join(engineerHome, "logs")}/`);
    }
    return 0;
  }

  if (options.follow) {
    return runFollowMode(logFile, options);
  }

  return runStaticMode(logFile, options);
}

/** Finds the most recent log file in the logs directory. */
function findLogFile(engineerHome: string): string | null {
  const logsDir = join(engineerHome, "logs");
  if (!existsSync(logsDir)) {
    return null;
  }

  // pino-roll strips the extension, then produces: engineer.[date].<N>.log
  // e.g. engineer.1.log, engineer.2.log, engineer.2025-05-27.1.log
  const files = readdirSync(logsDir)
    .filter((f) => f.startsWith("engineer.") && f.endsWith(".log"))
    .sort()
    .reverse();

  return files.length > 0 ? join(logsDir, files[0] as string) : null;
}

/** Read the last N lines from a file. */
function readLastLines(filePath: string, lineCount: number): string[] {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-lineCount);
}

function runStaticMode(logFile: string, options: LogsOptions): number {
  const lines = readLastLines(logFile, options.lines);

  if (options.json) {
    writeRawLines(lines);
    return 0;
  }

  formatWithPinoPretty(lines);
  return 0;
}

function runFollowMode(logFile: string, options: LogsOptions): number {
  const out = getOutput();
  const tailArgs = ["-f", "-n", String(options.lines), logFile];

  if (options.json) {
    // Raw JSON follow
    const tail = spawn("tail", tailArgs, { stdio: "inherit" });
    tail.on("error", (err) => {
      out.error(`Failed to tail log file: ${err.message}`);
    });
    return 0;
  }

  const tail = spawn("tail", tailArgs, { stdio: ["inherit", "pipe", "inherit"] });
  const pretty = pinoPretty();

  if (tail.stdout) {
    tail.stdout.pipe(pretty).pipe(process.stdout);
  }

  tail.on("error", (err) => out.error(`Failed to tail log file: ${err.message}`));

  // Follow mode keeps the process running — return 0 (won't actually reach this)
  return 0;
}

/** Write raw NDJSON log lines directly to stdout, preserving their existing encoding. */
function writeRawLines(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

function formatWithPinoPretty(lines: string[]): void {
  const pretty = pinoPretty();
  for (const line of lines) {
    pretty.write(`${line}\n`);
  }
  pretty.end();
}
