#!/usr/bin/env node
import { program } from "./cli/index.js";

process.on("uncaughtException", (error) => {
  process.stderr.write(`Fatal: uncaught exception: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`Fatal: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  process.exit(1);
});

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
