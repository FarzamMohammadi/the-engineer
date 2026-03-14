import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveSubdirs } from "../home.js";
import { getOutput } from "../output.js";
import { ALL_EXAMPLE_TEMPLATES, ALL_TEMPLATES } from "../templates.js";

interface InitOptions {
  force: boolean;
  seedDir: string;
}

/** Creates ~/.engineer/ directory structure and template config files. */
export function runInit(engineerHome: string, options: InitOptions): void {
  const out = getOutput();
  const dirs = resolveSubdirs(engineerHome);
  const hasSeed = existsSync(options.seedDir);

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
    out.log(`  Created ${dirPath}/`);
  }

  if (hasSeed) {
    out.blank();
    out.log(`  Seed directory found: ${options.seedDir}`);
  }

  out.blank();
  out.log("  Generated config files:");

  // Write template files — prefer seed/ over built-in templates
  for (const template of ALL_TEMPLATES) {
    const filePath = join(engineerHome, template.relativePath);

    if (existsSync(filePath) && !options.force) {
      out.log(`    ${template.relativePath} (exists, skipped)`);
      continue;
    }

    // Check seed directory first
    const seedPath = join(options.seedDir, template.relativePath);
    const fromSeed = hasSeed && existsSync(seedPath);
    const content = fromSeed ? readFileSync(seedPath, "utf8") : template.content;
    const source = fromSeed ? "from seed" : "template";

    // Ensure parent directory exists (for nested plugin configs)
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    out.log(`    ${template.relativePath} (${source})`);
  }

  // Write example templates (always overwrite — they're references, not user-edited)
  out.blank();
  out.log("  Example templates (full reference with all fields documented):");
  for (const example of ALL_EXAMPLE_TEMPLATES) {
    const filePath = join(engineerHome, example.relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, example.content, "utf8");
    out.log(`    ${example.relativePath}`);
  }

  out.blank();
  out.log("  Next steps:");
  if (!hasSeed) {
    out.log("    0. Run `engineer prepare` to create a reusable seed directory");
  }
  out.log(`    1. Browse examples:    ls ${dirs.examples}/`);
  out.log(`    2. Edit config files:  $EDITOR ${dirs.plugins}/github-trigger.yaml`);
  out.log("    3. Set env variables:  export GITHUB_TOKEN=ghp_...");
  out.log("    4. Validate setup:     engineer doctor");
  out.log("    5. Start:              engineer start");
}
