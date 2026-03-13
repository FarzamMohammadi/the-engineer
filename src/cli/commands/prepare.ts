import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SEED_TEMPLATES } from "../templates.js";

interface PrepareOptions {
  force: boolean;
  seedExampleDir: string;
}

/** Scaffolds a seed/ directory with fully documented config files for the user to customize. */
export function runPrepare(seedDir: string, options: PrepareOptions): void {
  console.log("");
  console.log("  Preparing seed directory for local configuration...");
  console.log("");

  const hasSeedExample = existsSync(options.seedExampleDir);

  mkdirSync(seedDir, { recursive: true });

  let created = 0;
  let skipped = 0;

  for (const template of SEED_TEMPLATES) {
    const filePath = join(seedDir, template.relativePath);

    if (existsSync(filePath) && !options.force) {
      console.log(`    ${template.relativePath} (exists, skipped)`);
      skipped++;
      continue;
    }

    // Prefer seed-example/ file over built-in template
    let content = template.content;
    let source = "template";
    const seedExamplePath = join(options.seedExampleDir, template.relativePath);
    if (hasSeedExample && existsSync(seedExamplePath)) {
      content = readFileSync(seedExamplePath, "utf8");
      source = "seed-example";
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    console.log(`    ${template.relativePath} (${source})`);
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
  console.log(`    1. Review configs:      ls ${seedDir}/config/`);
  if (hasSeedExample) {
    console.log("    2. Or use seed-example/ as a working reference");
  }
  console.log("    3. Fill in your values: repos, handles, tokens");
  console.log("    4. Run:                 engineer init");
  console.log("    5. Start:               engineer start");
  console.log("");
  console.log("  The seed/ directory is gitignored — your secrets stay local.");
  console.log("  Every future `engineer init` will use these configs automatically.");
}
