import { describe, expect, it } from "vitest";

import { BUILTIN_PLUGINS, describeSecretAcquisition, findSecretAcquisition } from "../../../src/plugins/builtin.js";
import type { PluginRequirement } from "../../../src/schemas/adapters.js";

// A token-shaped string is a long run of url-safe credential characters. The
// acquisition fields are STATIC PUBLIC pointers (URLs, scope names, a how-to line) —
// asserting none of them looks like a secret enforces the Trust Through Restraint
// contract at the data, not just in a comment.
const TOKEN_SHAPED = /\b(?:gh[a-z]_|xox[a-z]-|[A-Za-z0-9_-]{32,})\b/;

describe("findSecretAcquisition", () => {
  it("resolves GITHUB_TOKEN to its single-sourced acquisition metadata", () => {
    const acquisition = findSecretAcquisition("GITHUB_TOKEN");
    expect(acquisition?.acquireUrl).toBe("https://github.com/settings/tokens");
    expect(acquisition?.scopes).toEqual(["repo"]);
    expect(acquisition?.instructions).toContain("personal access token");
  });

  it("resolves TELEGRAM_BOT_TOKEN to its acquisition metadata", () => {
    const acquisition = findSecretAcquisition("TELEGRAM_BOT_TOKEN");
    expect(acquisition?.acquireUrl).toBe("https://t.me/BotFather");
    expect(acquisition?.instructions).toContain("BotFather");
  });

  it("returns null for an env var with no acquisition metadata", () => {
    expect(findSecretAcquisition("UNDECLARED_SECRET_XYZ")).toBeNull();
  });

  it("resolves GITHUB_TOKEN deterministically though three manifests declare it", () => {
    // github-trigger, github-comm, and github-hosting all require GITHUB_TOKEN.
    // Single-sourcing the requirement means every declaration carries identical text,
    // so first-match resolution can never depend on manifest order.
    const githubTokenTexts = new Set<string>();
    for (const { manifest } of BUILTIN_PLUGINS) {
      for (const req of manifest.requirements) {
        if (req.type === "env" && req.name === "GITHUB_TOKEN") {
          githubTokenTexts.add(JSON.stringify({ url: req.acquire_url, scopes: req.scopes, instr: req.instructions }));
        }
      }
    }
    expect(githubTokenTexts.size).toBe(1);
    expect(describeSecretAcquisition("GITHUB_TOKEN")).toContain("https://github.com/settings/tokens");
  });
});

describe("describeSecretAcquisition", () => {
  it("renders instructions, scopes, and URL into one line", () => {
    const line = describeSecretAcquisition("GITHUB_TOKEN");
    expect(line).toContain("personal access token");
    expect(line).toContain("scopes: repo");
    expect(line).toContain("https://github.com/settings/tokens");
  });

  it("returns null (never the literal 'undefined') for an unknown var", () => {
    const line = describeSecretAcquisition("UNDECLARED_SECRET_XYZ");
    expect(line).toBeNull();
  });
});

describe("acquisition metadata Trust Through Restraint contract", () => {
  it("carries no secret-shaped content on any builtin manifest", () => {
    for (const { field, value } of collectAcquisitionStrings()) {
      expect(value, field).not.toMatch(TOKEN_SHAPED);
    }
  });
});

/** Every acquisition string an `env` requirement exposes, labelled by its source field. */
function collectAcquisitionStrings(): Array<{ field: string; value: string }> {
  return BUILTIN_PLUGINS.flatMap(({ manifest }) =>
    manifest.requirements.filter((req) => req.type === "env").flatMap(requirementAcquisitionStrings),
  );
}

/** The labelled acquisition strings carried by one env requirement. */
function requirementAcquisitionStrings(req: PluginRequirement): Array<{ field: string; value: string }> {
  const entries: Array<{ field: string; value: string }> = [];
  if (req.acquire_url) {
    entries.push({ field: `acquire_url for ${req.name}`, value: req.acquire_url });
  }
  if (req.instructions) {
    entries.push({ field: `instructions for ${req.name}`, value: req.instructions });
  }
  for (const scope of req.scopes ?? []) {
    entries.push({ field: `scope on ${req.name}`, value: scope });
  }
  return entries;
}
