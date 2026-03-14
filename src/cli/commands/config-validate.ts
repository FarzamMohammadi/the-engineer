import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfigSafe } from "../../config/loader.js";
import {
  DaemonConfigSchema,
  OrchestratorConfigSchema,
  PeopleConfigSchema,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../../schemas/config.js";
import { resolveSubdirs } from "../home.js";
import { getOutput } from "../output.js";

interface ConfigFileEntry {
  name: string;
  schema: Parameters<typeof loadConfigSafe>[1];
}

const CONFIG_FILES: ConfigFileEntry[] = [
  { name: "daemon.yaml", schema: DaemonConfigSchema },
  { name: "orchestrator.yaml", schema: OrchestratorConfigSchema },
  { name: "safety.yaml", schema: SafetyConfigSchema },
  { name: "workspace.yaml", schema: WorkspaceConfigSchema },
  { name: "people.yaml", schema: PeopleConfigSchema },
];

/** Validates all config files and reports results per-file. Returns exit code. */
export function runConfigValidate(engineerHome: string): number {
  const out = getOutput();
  const dirs = resolveSubdirs(engineerHome);
  const configDir = dirs.config;

  if (!existsSync(configDir)) {
    out.error(`Config directory not found: ${configDir}`);
    out.log(`  Run: engineer init --home ${engineerHome}`);
    return 1;
  }

  let hasErrors = false;
  const fileResults: Array<{ name: string; status: string; message?: string }> = [];

  for (const { name, schema } of CONFIG_FILES) {
    const filePath = join(configDir, name);

    if (!existsSync(filePath)) {
      fileResults.push({ name, status: "missing" });
      continue;
    }

    const result = loadConfigSafe(filePath, schema);
    if (result.ok) {
      fileResults.push({ name, status: "valid" });
    } else {
      hasErrors = true;
      fileResults.push({ name, status: "error", message: result.error.message });
    }
  }

  if (out.mode === "json") {
    out.data({ valid: !hasErrors, files: fileResults });
    return hasErrors ? 1 : 0;
  }

  displayResults(out, fileResults, hasErrors);
  return hasErrors ? 1 : 0;
}

function displayResults(
  out: import("../output.js").Output,
  fileResults: Array<{ name: string; status: string; message?: string }>,
  hasErrors: boolean,
): void {
  out.log("  Validating config files:\n");

  for (const file of fileResults) {
    if (file.status === "missing") {
      out.warn(`${file.name}: not found (defaults will be used)`);
    } else if (file.status === "valid") {
      out.success(`${file.name}: valid`);
    } else {
      out.error(`${file.name}: ${file.message}`);
    }
  }

  out.blank();
  if (hasErrors) {
    out.log("  Some config files have errors.");
  } else {
    out.log("  All config files valid.");
  }
}
