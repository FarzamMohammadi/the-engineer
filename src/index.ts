#!/usr/bin/env node
import { program } from "./cli/index.js";

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
