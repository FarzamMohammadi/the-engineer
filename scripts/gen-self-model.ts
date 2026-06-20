// ── Bundled Self-Model Generator ─────────────────────────────────────────────
// Renders src/core/orchestrator/prompts/self-model.generated.ts from
// src/core/orchestrator/prompts/self-model/*.md so the agent's self-model is a
// derived, build-baked artifact, never hand-maintained and never read from the
// filesystem at runtime (the build only copies .ts into dist/, so loose .md
// files would not ship — the source .md live beside the generated module).
// Run via `pnpm run self-model:bundle`; CI verifies the committed file matches a
// fresh render (no drift).
//
// Content is emitted with JSON.stringify, so backticks, ${...}, and nested code
// fences in the source markdown are escaped correctly by construction — there is
// no escape logic to get wrong.
//
// The three docs are split across two exports on purpose. The persona and
// how-i-work docs are static identity that never changes per task, so they are
// pre-concatenated into SELF_MODEL_PERSONA. The "my brief" doc (03-my-assignment)
// is kept as its own SELF_MODEL_BRIEF export because a later step injects the
// owner's live setup into it — it must be available as its own piece, not buried
// inside one pre-joined blob.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF_MODEL_DIR = join(REPO_ROOT, "src", "core", "orchestrator", "prompts", "self-model");
const OUTPUT_FILE = join(REPO_ROOT, "src", "core", "orchestrator", "prompts", "self-model.generated.ts");

// The "my brief" doc carries the per-task setup the next step injects into; it
// must land in its own export. Identified by filename so the split is explicit
// and not a positional guess.
const BRIEF_FILENAME = "03-my-assignment.md";

/** A bundled self-model doc: a repo-relative POSIX path and the source file's exact bytes. */
interface SelfModelDoc {
  readonly relativePath: string;
  readonly content: string;
}

/** Render the bundle from source docs and write it to disk. */
function generateSelfModel(): void {
  const docs = collectSelfModelDocs();
  if (docs.length === 0) {
    throw new Error(`Found no .md files under "${SELF_MODEL_DIR}" — refusing to write an empty bundle`);
  }
  const brief = docs.find((doc) => doc.relativePath.endsWith(`/${BRIEF_FILENAME}`));
  if (!brief) {
    throw new Error(`Found no "${BRIEF_FILENAME}" under "${SELF_MODEL_DIR}" — the brief export would be empty`);
  }
  const persona = docs.filter((doc) => doc !== brief);
  if (persona.length === 0) {
    throw new Error(`Found only "${BRIEF_FILENAME}" — the persona export would be empty`);
  }
  writeFileSync(OUTPUT_FILE, renderModule(persona, brief), { encoding: "utf8" });
  process.stdout.write(
    `Rendered ${String(docs.length)} self-model docs from ${relative(REPO_ROOT, SELF_MODEL_DIR)}/ into ${relative(REPO_ROOT, OUTPUT_FILE)}\n`,
  );
}

/** Read every markdown file under the self-model source dir, sorted by path for deterministic output. */
function collectSelfModelDocs(): SelfModelDoc[] {
  return listMarkdownFiles(SELF_MODEL_DIR)
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
function renderModule(persona: SelfModelDoc[], brief: SelfModelDoc): string {
  const personaContent = persona.map((doc) => doc.content).join("\n");
  return `// ── Agent Self-Model (GENERATED) ─────────────────────────────────────────────
// AUTO-GENERATED from src/core/orchestrator/prompts/self-model/*.md by scripts/gen-self-model.ts.
// Do not edit by hand. Run \`pnpm run self-model:bundle\` to regenerate; CI fails on drift.
// Baked into a .ts module (not read from disk) so the self-model ships in the bundle.
//
// SELF_MODEL_PERSONA — the static identity (persona + how-i-work), pre-joined in
// path order. SELF_MODEL_BRIEF — the "my brief" doc, kept separate because a
// later step injects the owner's live setup into it before it reaches the agent.

/** The static self-model: who the agent is and how it works. Path-ordered, pre-joined. */
export const SELF_MODEL_PERSONA: string = ${JSON.stringify(personaContent)};

/** The "my brief" doc — kept separate so live owner setup can be injected before use. */
export const SELF_MODEL_BRIEF: string = ${JSON.stringify(brief.content)};
`;
}

generateSelfModel();
