import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ALL_TEMPLATES } from "../templates.js";

interface PrepareOptions {
  force: boolean;
}

/** Scaffolds a seed/ directory with all config templates for the user to customize. */
export function runPrepare(seedDir: string, options: PrepareOptions): void {
  console.log("");
  console.log("  Preparing seed directory for local configuration...");
  console.log("");

  mkdirSync(seedDir, { recursive: true });

  let created = 0;
  let skipped = 0;

  for (const template of ALL_TEMPLATES) {
    const filePath = join(seedDir, template.relativePath);

    if (existsSync(filePath) && !options.force) {
      console.log(`    ${template.relativePath} (exists, skipped)`);
      skipped++;
      continue;
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, template.content, "utf8");
    console.log(`    ${template.relativePath}`);
    created++;
  }

  console.log("");
  if (skipped > 0) {
    console.log(`  ${created} files created, ${skipped} skipped (use --force to overwrite)`);
  } else {
    console.log(`  ${created} files created in ${seedDir}/`);
  }
  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Edit seed configs:   $EDITOR ${seedDir}/config/people.yaml`);
  console.log("    2. Fill in your real values (repos, handles, tokens)");
  console.log("    3. Run:                 engineer init");
  console.log("    4. Start:               engineer start");
  console.log("");
  console.log("  The seed/ directory is gitignored — your secrets stay local.");
  console.log("  Every future `engineer init` will use these configs automatically.");
}
