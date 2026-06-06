// ── Bundled Plugin Docs Generator ────────────────────────────────────────────
// Renders src/cli/bundled/plugin-docs.ts from docs/plugins/**/*.md so the bundle
// is a derived artifact, never hand-maintained. Run via `pnpm run docs:bundle`;
// CI verifies the committed file matches a fresh render (no drift).
//
// Content is emitted with JSON.stringify, so backticks, ${...}, and nested code
// fences in the source markdown are escaped correctly by construction — there is
// no escape logic to get wrong.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_PLUGINS_DIR = join(REPO_ROOT, "docs", "plugins");
const OUTPUT_FILE = join(REPO_ROOT, "src", "cli", "bundled", "plugin-docs.ts");

/** A bundled doc entry: a repo-relative POSIX path and the source file's exact bytes. */
interface BundledDoc {
  readonly relativePath: string;
  readonly content: string;
}

/** Render the bundle from source docs and write it to disk. */
function generateBundledDocs(): void {
  const docs = collectPluginDocs();
  if (docs.length === 0) {
    throw new Error(`Found no .md files under "${DOCS_PLUGINS_DIR}" — refusing to write an empty bundle`);
  }
  writeFileSync(OUTPUT_FILE, renderModule(docs), { encoding: "utf8" });
  process.stdout.write(
    `Rendered ${String(docs.length)} docs from docs/plugins/ into ${relative(REPO_ROOT, OUTPUT_FILE)}\n`,
  );
}

/** Read every markdown file under docs/plugins/, sorted by path for deterministic output. */
function collectPluginDocs(): BundledDoc[] {
  return listMarkdownFiles(DOCS_PLUGINS_DIR)
    .map((absolutePath) => ({
      relativePath: toPosixRelative(absolutePath),
      content: readFileSync(absolutePath, "utf8"),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Recursively list absolute paths of every .md file under a directory. */
function listMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Convert an absolute path to a repo-relative path with forward slashes (stable across OSes). */
function toPosixRelative(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split(sep).join("/");
}

/** Build the full TypeScript module source. */
function renderModule(docs: BundledDoc[]): string {
  return `// ── Plugin Documentation (GENERATED) ─────────────────────────────────────────
// AUTO-GENERATED from docs/plugins/**/*.md by scripts/gen-bundled-docs.ts.
// Do not edit by hand. Run \`pnpm run docs:bundle\` to regenerate; CI fails on drift.
// Bundled so first-run setup can write per-plugin docs into ~/.engineer/docs/.

export interface PluginDoc {
  readonly relativePath: string;
  readonly content: string;
}

export const ALL_PLUGIN_DOCS: readonly PluginDoc[] = ${JSON.stringify(docs, null, 2)};
`;
}

generateBundledDocs();
