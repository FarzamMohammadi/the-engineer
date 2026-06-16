// Architecture boundary guard — see tests/architecture/README.md.
// Enforces the STRUCTURAL three-tier import rules by walking every file's import graph: adapters never
// import Core, Core never imports plugins or test code, and the SDK barrel never re-exports Core internals.
// This is the structural half of Plugin Opacity; its sibling plugin-opacity.test.ts enforces the semantic
// half (no platform-name literal in src/core/), which an import-graph walk cannot detect.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ── Constants ────────────────────────────────────────────────────────────────

const SRC_ROOT = resolve(process.cwd(), "src");
const STATIC_IMPORT_RE = /from\s+["']([^"']+)["']/;
const DYNAMIC_IMPORT_RE = /import\(["']([^"']+)["']\)/;
const JS_EXT_RE = /\.js$/;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively find all .ts files (excluding .test.ts and .d.ts) */
function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSourceFiles(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract import paths from a TypeScript file.
 * Matches both `import ... from "..."` and `import("...")`.
 */
function extractImports(filePath: string): Array<{ path: string; line: number }> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const imports: Array<{ path: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const staticMatch = STATIC_IMPORT_RE.exec(line);
    if (staticMatch?.[1]) {
      imports.push({ path: staticMatch[1], line: i + 1 });
    }

    const dynamicMatch = DYNAMIC_IMPORT_RE.exec(line);
    if (dynamicMatch?.[1]) {
      imports.push({ path: dynamicMatch[1], line: i + 1 });
    }
  }

  return imports;
}

/**
 * Determine which tier a file belongs to based on its path.
 * Returns "core", "adapters", or null (for schemas and other shared code).
 */
function getTier(filePath: string): "core" | "adapters" | null {
  const rel = relative(SRC_ROOT, filePath);
  if (rel.startsWith("core/")) {
    return "core";
  }
  if (rel.startsWith("adapters/")) {
    return "adapters";
  }
  return null;
}

/**
 * Check if an import path resolves to a specific tier.
 */
function getImportTier(importPath: string, fromFile: string): "core" | "adapters" | "schemas" | "external" | null {
  // External packages (no relative path)
  if (!(importPath.startsWith(".") || importPath.startsWith("/"))) {
    return "external";
  }

  // Resolve relative to the importing file
  const dir = dirname(fromFile);
  const resolved = resolve(dir, importPath.replace(JS_EXT_RE, ".ts"));
  const rel = relative(SRC_ROOT, resolved);

  if (rel.startsWith("core/")) {
    return "core";
  }
  if (rel.startsWith("adapters/")) {
    return "adapters";
  }
  if (rel.startsWith("schemas/")) {
    return "schemas";
  }
  return null;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("three-tier import rules", () => {
  const sourceFiles = findSourceFiles(SRC_ROOT);

  it("found source files to analyze", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("adapter files never import from core", () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      if (getTier(file) !== "adapters") {
        continue;
      }

      const imports = extractImports(file);
      for (const imp of imports) {
        const importTier = getImportTier(imp.path, file);
        if (importTier === "core") {
          const rel = relative(SRC_ROOT, file);
          violations.push(`${rel}:${String(imp.line)} imports from core: ${imp.path}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("adapter files only import from schemas and externals", () => {
    const violations: string[] = [];
    const allowedTiers = new Set(["schemas", "adapters", "external", null]);

    for (const file of sourceFiles) {
      if (getTier(file) !== "adapters") {
        continue;
      }

      const imports = extractImports(file);
      for (const imp of imports) {
        const importTier = getImportTier(imp.path, file);
        if (!allowedTiers.has(importTier)) {
          const rel = relative(SRC_ROOT, file);
          violations.push(`${rel}:${String(imp.line)} imports from ${String(importTier)}: ${imp.path}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("core files never import from test helpers or plugins", () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      if (getTier(file) !== "core") {
        continue;
      }

      const imports = extractImports(file);
      for (const imp of imports) {
        if (imp.path.includes("test/") || imp.path.includes("tests/") || imp.path.includes("fake-plugin")) {
          const rel = relative(SRC_ROOT, file);
          violations.push(`${rel}:${String(imp.line)} imports test code: ${imp.path}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("core components can import from schemas and other core", () => {
    let coreImportsSchemas = false;

    for (const file of sourceFiles) {
      if (getTier(file) !== "core") {
        continue;
      }

      const imports = extractImports(file);
      for (const imp of imports) {
        if (getImportTier(imp.path, file) === "schemas") {
          coreImportsSchemas = true;
          break;
        }
      }
      if (coreImportsSchemas) {
        break;
      }
    }

    expect(coreImportsSchemas).toBe(true);
  });

  it("SDK boundary barrel (adapters/index.ts) does not export core internals", () => {
    const indexFile = join(SRC_ROOT, "adapters", "index.ts");
    const imports = extractImports(indexFile);

    for (const imp of imports) {
      const importTier = getImportTier(imp.path, indexFile);
      expect(importTier).not.toBe("core");
    }
  });
});
