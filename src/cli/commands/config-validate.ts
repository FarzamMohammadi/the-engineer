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
  const dirs = resolveSubdirs(engineerHome);
  const configDir = dirs.config;

  if (!existsSync(configDir)) {
    console.log(`  Config directory not found: ${configDir}`);
    console.log(`  Run: engineer init --home ${engineerHome}`);
    return 1;
  }

  let hasErrors = false;
  console.log("  Validating config files:\n");

  for (const { name, schema } of CONFIG_FILES) {
    const filePath = join(configDir, name);

    if (!existsSync(filePath)) {
      console.log(`  ⚠ ${name}: not found (defaults will be used)`);
      continue;
    }

    const result = loadConfigSafe(filePath, schema);
    if (result.ok) {
      console.log(`  ✓ ${name}: valid`);
    } else {
      hasErrors = true;
      console.log(`  ✗ ${name}: ${result.error.message}`);
    }
  }

  console.log("");
  if (hasErrors) {
    console.log("  Some config files have errors.");
    return 1;
  }
  console.log("  All config files valid.");
  return 0;
}
