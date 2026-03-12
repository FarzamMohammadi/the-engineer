import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveSubdirs } from "../home.js";
import { ALL_EXAMPLE_TEMPLATES, ALL_TEMPLATES } from "../templates.js";

interface InitOptions {
  force: boolean;
}

/** Creates ~/.engineer/ directory structure and template config files. */
export function runInit(engineerHome: string, options: InitOptions): void {
  const dirs = resolveSubdirs(engineerHome);

  // Create all directories
  const dirPaths = [
    dirs.config,
    dirs.plugins,
    dirs.data,
    dirs.logs,
    dirs.run,
    dirs.workspaces,
    dirs.traces,
    dirs.examples,
  ];
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

  // Write example templates (always overwrite — they're references, not user-edited)
  console.log("");
  console.log("  Example templates (full reference with all fields documented):");
  for (const example of ALL_EXAMPLE_TEMPLATES) {
    const filePath = join(engineerHome, example.relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, example.content, "utf8");
    console.log(`    ${example.relativePath}`);
  }

  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Browse examples:    ls ${dirs.examples}/`);
  console.log(`    2. Edit config files:  $EDITOR ${dirs.plugins}/github-trigger.yaml`);
  console.log("    3. Set env variables:  export GITHUB_TOKEN=ghp_...");
  console.log("    4. Validate setup:     engineer doctor");
  console.log("    5. Start:              engineer start");
}
