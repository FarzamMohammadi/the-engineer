// Architecture boundary guard — see tests/architecture/README.md.
// Enforces the SEMANTIC half of Plugin Opacity: no platform name leaks into src/core/. Its sibling
// tier-import-rules.test.ts enforces the structural half (the three-tier import graph), which cannot see a
// hardcoded channel because a string literal crosses no import boundary — which is exactly how a hardcoded
// channel once slipped into Core.
//
// ── Two-tier detection (and why) ─────────────────────────────────────────────
// Core surface is not just code values; it is also PROSE. The agent's self-model is markdown baked into a
// Core .ts module (self-model.generated.ts, generated from self-model/*.md). A vendor name sitting in the
// MIDDLE of a prose string ("...take a GitHub issue and ship it...") is a real opacity leak, yet a guard
// that only looks for a quote IMMEDIATELY followed by the name (a value like `channel === "github"`) walks
// right past it. That is the exact class of leak this guard now closes. But widening every name to "match
// anywhere" would false-positive on ordinary English, because some vendor names are also common words ("git
// history stays linear", "cut some slack"). So names are split into two tiers:
//
//   • UNAMBIGUOUS — github, gitlab, bitbucket, gitea, telegram, jira. Never legitimate English words, so a
//     whole-word match ANYWHERE in Core source (a code value OR prose) is always a leak. This tier is what
//     catches the baked self-model case.
//   • COMMON-WORD — linear, slack, discord. Legitimate English in ordinary prose, so matching them anywhere
//     would misfire. They keep the narrower "used as a value" match: a quote opening the string literal
//     immediately followed by the name (`channel === "slack"`). A value is a hardcode; the bare word in
//     prose is not.
//
// Both tiers strip comments first and match case-insensitively. \b word boundaries keep "gitea" from firing
// inside an unrelated token and "linear" from firing inside "nonlinear".

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
//
// UNAMBIGUOUS_PLATFORMS are not real English words, so they are forbidden as a whole word ANYWHERE in Core —
// in a code value or in prose (the baked self-model). COMMON_WORD_PLATFORMS double as ordinary English, so
// they are forbidden only when used as a value (quote-anchored), never as a bare prose word.
const UNAMBIGUOUS_PLATFORMS = ["github", "gitlab", "bitbucket", "gitea", "telegram", "jira"] as const;
const COMMON_WORD_PLATFORMS = ["linear", "slack", "discord"] as const;

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
 * platform names in real code or prose count toward a violation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The forbidden platform names that leak into this source (comments excluded). Two-tier match:
 * unambiguous vendor names anywhere (code value or prose), common-word vendor names only as a value.
 */
function platformLiteralsIn(source: string): string[] {
  const code = stripComments(source);
  const unambiguous = UNAMBIGUOUS_PLATFORMS.filter((platform) => new RegExp(`\\b${platform}\\b`, "i").test(code));
  const commonWord = COMMON_WORD_PLATFORMS.filter((platform) =>
    new RegExp(`${QUOTE_CLASS}${platform}\\b`, "i").test(code),
  );
  return [...unambiguous, ...commonWord];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("plugin opacity", () => {
  it("detects a hardcoded platform name but ignores one that only appears in a comment", () => {
    // Self-check: the guard catches a vendor name used as a value, and ignores a JSDoc example.
    expect(platformLiteralsIn('if (contact.channel === "github") return true;')).toEqual(["github"]);
    expect(platformLiteralsIn('// idempotency key shape: "github:issue:owner/repo:42"')).toEqual([]);
  });

  it("catches an unambiguous vendor name embedded in a Core prose string — the baked self-model leak", () => {
    // The exact class that slipped: a vendor name in the MIDDLE of a prose string, not opening it.
    expect(platformLiteralsIn('const persona = "...take a GitHub issue and ship it...";')).toEqual(["github"]);
  });

  it("does not false-positive on common English words that happen to be vendor names", () => {
    // Common-word vendor names are legit prose; only a value (quote-anchored) is a hardcode.
    expect(platformLiteralsIn('const note = "the git history stays linear";')).toEqual([]);
    expect(platformLiteralsIn('const note = "cut some slack when reviewing";')).toEqual([]);
  });

  it("still catches a common-word vendor name used as a value", () => {
    expect(platformLiteralsIn('if (contact.channel === "slack") return true;')).toEqual(["slack"]);
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
