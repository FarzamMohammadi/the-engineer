import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveSubdirs } from "../home.js";
import { ALL_TEMPLATES } from "../templates.js";

interface InitOptions {
  force: boolean;
}

/** Creates ~/.engineer/ directory structure and template config files. */
export function runInit(engineerHome: string, options: InitOptions): void {
  const dirs = resolveSubdirs(engineerHome);

  // Create all directories
  const dirPaths = [dirs.config, dirs.plugins, dirs.data, dirs.logs, dirs.run, dirs.workspaces];
  for (const dirPath of dirPaths) {
    mkdirSync(dirPath, { recursive: true });
    console.log(`  Created ${dirPath}/`);
  }

  console.log("");
  console.log("  Generated config files:");

  // Write template files
  for (const template of ALL_TEMPLATES) {
    const filePath = join(engineerHome, template.relativePath);

    if (existsSync(filePath) && !options.force) {
      console.log(`    ${template.relativePath} (exists, skipped)`);
      continue;
    }

    // Ensure parent directory exists (for nested plugin configs)
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, template.content, "utf8");
    console.log(`    ${template.relativePath}`);
  }

  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Edit config files:  $EDITOR ${dirs.plugins}/github-trigger.yaml`);
  console.log("    2. Set env variables:  export GITHUB_TOKEN=ghp_...");
  console.log(`    3. Validate setup:     engineer doctor --home ${engineerHome}`);
  console.log(`    4. Start:              engineer start --home ${engineerHome}`);
}
