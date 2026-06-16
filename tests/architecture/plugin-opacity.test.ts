// Architecture boundary guard — see tests/architecture/README.md.
// Enforces the SEMANTIC half of Plugin Opacity: no platform name appears as a string literal anywhere in
// src/core/. Its sibling tier-import-rules.test.ts enforces the structural half (the three-tier import
// graph), which cannot see a hardcoded channel because a string literal crosses no import boundary — which
// is exactly how a hardcoded channel once slipped into Core.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ── Constants ────────────────────────────────────────────────────────────────

const CORE_ROOT = resolve(process.cwd(), "src", "core");

/** Quote characters that open a string literal — double, single, or backtick. */
const QUOTE_CLASS = "[\"'`]";

// Platform / channel names Core must never hardcode. Plugin Opacity (docs/philosophy.md): Core speaks only
// through adapter contracts and the plugin registry — it never names a specific platform, but derives every
// platform value (a channel, an id, a token) from plugin metadata or the registry by adapter type.
const FORBIDDEN_PLATFORMS = [
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "telegram",
  "slack",
  "discord",
  "jira",
  "linear",
] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively find all .ts source files under a directory (excluding tests and declarations). */
function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
 * Strip block and line comments so a platform name inside a JSDoc example — an idempotency-key shape like
 * "github:issue:owner/repo:42", or a "[JIRA-123]" decoration note — is not mistaken for a hardcode. Only
 * platform names in real code count toward a violation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The forbidden platform names that appear as a string literal in this source (comments excluded). */
function platformLiteralsIn(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN_PLATFORMS.filter((platform) => new RegExp(`${QUOTE_CLASS}${platform}\\b`, "i").test(code));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("plugin opacity", () => {
  it("detects a hardcoded platform name but ignores one that only appears in a comment", () => {
    // Self-check: the guard must actually catch a literal, and must not trip on a JSDoc example.
    expect(platformLiteralsIn('if (contact.channel === "github") return true;')).toEqual(["github"]);
    expect(platformLiteralsIn('// idempotency key shape: "github:issue:owner/repo:42"')).toEqual([]);
  });

  it("src/core names no platform in code — every platform value is derived from the registry or plugin metadata", () => {
    const violations: string[] = [];
    for (const file of findSourceFiles(CORE_ROOT)) {
      for (const platform of platformLiteralsIn(readFileSync(file, "utf-8"))) {
        violations.push(`${relative(process.cwd(), file)} hardcodes "${platform}"`);
      }
    }

    expect(
      violations,
      `Plugin Opacity violation — Core must not name a platform. Derive the value from plugin metadata (e.g. adapter_meta.channel) or the registry by adapter type:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
