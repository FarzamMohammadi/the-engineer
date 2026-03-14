import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getOutput } from "../output.js";
import { SEED_TEMPLATES } from "../templates.js";

interface PrepareOptions {
  force: boolean;
  seedExampleDir: string;
}

/** Scaffolds a seed/ directory with fully documented config files for the user to customize. */
export function runPrepare(seedDir: string, options: PrepareOptions): void {
  const out = getOutput();

  out.blank();
  out.log("  Preparing seed directory for local configuration...");
  out.blank();

  const hasSeedExample = existsSync(options.seedExampleDir);

  mkdirSync(seedDir, { recursive: true });

  let created = 0;
  let skipped = 0;

  for (const template of SEED_TEMPLATES) {
    const filePath = join(seedDir, template.relativePath);

    if (existsSync(filePath) && !options.force) {
      out.log(`    ${template.relativePath} (exists, skipped)`);
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
    out.log(`    ${template.relativePath} (${source})`);
    created++;
  }

  out.blank();
  if (skipped > 0) {
    out.log(`  ${created} files created, ${skipped} skipped (use --force to overwrite)`);
  } else {
    out.log(`  ${created} files created in ${seedDir}/`);
  }
  out.blank();
  out.log("  Next steps:");
  out.log(`    1. Review configs:      ls ${seedDir}/config/`);
  if (hasSeedExample) {
    out.log("    2. Or use seed-example/ as a working reference");
  }
  out.log("    3. Fill in your values: repos, handles, tokens");
  out.log("    4. Run:                 engineer init");
  out.log("    5. Start:               engineer start");
  out.blank();
  out.log("  The seed/ directory is gitignored — your secrets stay local.");
  out.log("  Every future `engineer init` will use these configs automatically.");
}
