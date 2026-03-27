import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILTIN_PLUGINS } from "../../plugins/builtin.js";
import { AdapterTypeSchema } from "../../schemas/adapters.js";
import {
  ADAPTER_TYPE_CONFIGS,
  checkRequirementsMet,
  detectEnvironment,
  generateConfigFiles,
  needsSetup,
  parseGitRemote,
  writeConfigFiles,
} from "./setup.js";

// ── detectEnvironment ────────────────────────────────────────────────────────

describe("detectEnvironment", () => {
  it("detects all binaries found", () => {
    const result = detectEnvironment({}, { claude: "/usr/bin/claude", bash: "/bin/bash" }, null);
    expect(result.binaries["claude"]).toBe("/usr/bin/claude");
    expect(result.binaries["bash"]).toBe("/bin/bash");
  });

  it("detects no binaries found", () => {
    const result = detectEnvironment({}, { claude: null, opencode: null }, null);
    expect(result.binaries["claude"]).toBeNull();
    expect(result.binaries["opencode"]).toBeNull();
  });

  it("detects present env vars", () => {
    const result = detectEnvironment(
      { GITHUB_TOKEN: "ghp_abc123", TELEGRAM_BOT_TOKEN: "bot:token" },
      {},
      null,
    );
    expect(result.envVars.has("GITHUB_TOKEN")).toBe(true);
    expect(result.envVars.has("TELEGRAM_BOT_TOKEN")).toBe(true);
  });

  it("treats empty string env vars as absent", () => {
    const result = detectEnvironment({ GITHUB_TOKEN: "", TELEGRAM_BOT_TOKEN: "   " }, {}, null);
    expect(result.envVars.has("GITHUB_TOKEN")).toBe(false);
    expect(result.envVars.has("TELEGRAM_BOT_TOKEN")).toBe(false);
  });

  it("treats undefined env vars as absent", () => {
    const result = detectEnvironment({ GITHUB_TOKEN: undefined }, {}, null);
    expect(result.envVars.has("GITHUB_TOKEN")).toBe(false);
  });

  it("parses git remote from output", () => {
    const gitOutput =
      "origin\tgit@github.com:FarzamMohammadi/the-engineer.git (fetch)\norigin\tgit@github.com:FarzamMohammadi/the-engineer.git (push)\n";
    const result = detectEnvironment({}, {}, gitOutput);
    expect(result.gitRemote).toEqual({ owner: "FarzamMohammadi", name: "the-engineer" });
  });

  it("returns null git remote when no output", () => {
    const result = detectEnvironment({}, {}, null);
    expect(result.gitRemote).toBeNull();
  });
});

// ── parseGitRemote ───────────────────────────────────────────────────────────

describe("parseGitRemote", () => {
  it("parses SSH format", () => {
    const output =
      "origin\tgit@github.com:owner/repo.git (fetch)\norigin\tgit@github.com:owner/repo.git (push)\n";
    expect(parseGitRemote(output)).toEqual({ owner: "owner", name: "repo" });
  });

  it("parses HTTPS format", () => {
    const output =
      "origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com/owner/repo.git (push)\n";
    expect(parseGitRemote(output)).toEqual({ owner: "owner", name: "repo" });
  });

  it("strips .git suffix", () => {
    const output = "origin\tgit@github.com:owner/repo.git (fetch)\n";
    const result = parseGitRemote(output);
    expect(result?.name).toBe("repo");
  });

  it("handles repo without .git suffix", () => {
    const output = "origin\thttps://github.com/owner/repo (fetch)\n";
    expect(parseGitRemote(output)).toEqual({ owner: "owner", name: "repo" });
  });

  it("picks origin from multiple remotes", () => {
    const output = [
      "upstream\tgit@github.com:upstream-org/repo.git (fetch)",
      "upstream\tgit@github.com:upstream-org/repo.git (push)",
      "origin\tgit@github.com:my-fork/repo.git (fetch)",
      "origin\tgit@github.com:my-fork/repo.git (push)",
    ].join("\n");
    expect(parseGitRemote(output)).toEqual({ owner: "my-fork", name: "repo" });
  });

  it("returns null when no origin remote", () => {
    const output = "upstream\tgit@github.com:org/repo.git (fetch)\n";
    expect(parseGitRemote(output)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseGitRemote("")).toBeNull();
  });

  it("returns null for malformed output", () => {
    expect(parseGitRemote("not a valid git remote output")).toBeNull();
  });
});

// ── checkRequirementsMet ─────────────────────────────────────────────────────

describe("checkRequirementsMet", () => {
  const detection = detectEnvironment(
    { GITHUB_TOKEN: "ghp_test" },
    { claude: "/usr/bin/claude", bash: "/bin/bash", opencode: null },
    null,
  );

  it("returns true when all binary requirements met", () => {
    expect(
      checkRequirementsMet({ requirements: [{ type: "binary", name: "claude" }] }, detection),
    ).toBe(true);
  });

  it("returns false when binary requirement not met", () => {
    expect(
      checkRequirementsMet({ requirements: [{ type: "binary", name: "opencode" }] }, detection),
    ).toBe(false);
  });

  it("returns true when env requirement met", () => {
    expect(
      checkRequirementsMet({ requirements: [{ type: "env", name: "GITHUB_TOKEN" }] }, detection),
    ).toBe(true);
  });

  it("returns false when env requirement not met", () => {
    expect(
      checkRequirementsMet(
        { requirements: [{ type: "env", name: "TELEGRAM_BOT_TOKEN" }] },
        detection,
      ),
    ).toBe(false);
  });

  it("returns true when no requirements", () => {
    expect(checkRequirementsMet({ requirements: [] }, detection)).toBe(true);
  });

  it("returns false when any requirement not met (mixed)", () => {
    expect(
      checkRequirementsMet(
        {
          requirements: [
            { type: "binary", name: "claude" },
            { type: "env", name: "NONEXISTENT" },
          ],
        },
        detection,
      ),
    ).toBe(false);
  });

  it("skips unknown requirement types gracefully", () => {
    expect(
      checkRequirementsMet(
        {
          requirements: [
            { type: "binary", name: "claude" },
            { type: "port" as "binary", name: "5432" },
          ],
        },
        detection,
      ),
    ).toBe(true);
  });
});

// ── generateConfigFiles ──────────────────────────────────────────────────────

describe("generateConfigFiles", () => {
  it("generates core config files", () => {
    const files = generateConfigFiles([], {});
    const coreFiles = files.filter(
      (f) => f.relativePath.startsWith("config/") && !f.relativePath.startsWith("config/plugins/"),
    );
    expect(coreFiles.length).toBeGreaterThanOrEqual(4);
    const paths = coreFiles.map((f) => f.relativePath);
    expect(paths).toContain("config/daemon.yaml");
    expect(paths).toContain("config/safety.yaml");
    expect(paths).toContain("config/workspace.yaml");
    expect(paths).toContain("config/people.yaml");
  });

  it("generates plugin config for selected plugins", () => {
    const files = generateConfigFiles(["claude-code-llm", "bash-tool"], {});
    const pluginFiles = files.filter((f) => f.relativePath.startsWith("config/plugins/"));
    const pluginPaths = pluginFiles.map((f) => f.relativePath);
    expect(pluginPaths).toContain("config/plugins/claude-code-llm.yaml");
    expect(pluginPaths).toContain("config/plugins/bash-tool.yaml");
  });

  it("does not generate plugin config for unselected plugins", () => {
    const files = generateConfigFiles(["claude-code-llm"], {});
    const pluginFiles = files.filter((f) => f.relativePath.startsWith("config/plugins/"));
    const pluginPaths = pluginFiles.map((f) => f.relativePath);
    expect(pluginPaths).not.toContain("config/plugins/github-trigger.yaml");
    expect(pluginPaths).not.toContain("config/plugins/telegram-comm.yaml");
  });

  it("uses user-provided config values over templates", () => {
    const files = generateConfigFiles(["github-trigger"], {
      "github-trigger": {
        github_token: "${GITHUB_TOKEN}",
        repos: [{ owner: "test", name: "repo" }],
      },
    });
    const triggerFile = files.find((f) => f.relativePath === "config/plugins/github-trigger.yaml");
    expect(triggerFile).toBeDefined();
    expect(triggerFile?.content).toContain("GITHUB_TOKEN");
    expect(triggerFile?.content).toContain("test");
  });

  it("generates example templates", () => {
    const files = generateConfigFiles([], {});
    const examples = files.filter((f) => f.relativePath.startsWith("example-templates/"));
    expect(examples.length).toBeGreaterThan(0);
  });

  it("creates fallback config for plugins without user config or template", () => {
    const files = generateConfigFiles(["some-custom-plugin"], {});
    const customFile = files.find(
      (f) => f.relativePath === "config/plugins/some-custom-plugin.yaml",
    );
    expect(customFile).toBeDefined();
    expect(customFile?.content).toContain("Using defaults");
  });
});

// ── writeConfigFiles ─────────────────────────────────────────────────────────

describe("writeConfigFiles", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "engineer-test-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes files with 0o600 permissions", () => {
    const files = [{ relativePath: "config/test.yaml", content: "key: value\n" }];
    writeConfigFiles(tmpHome, files);
    const filePath = join(tmpHome, "config/test.yaml");
    expect(existsSync(filePath)).toBe(true);
    const stat = statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates parent directories", () => {
    const files = [{ relativePath: "config/plugins/deep/nested.yaml", content: "test\n" }];
    writeConfigFiles(tmpHome, files);
    expect(existsSync(join(tmpHome, "config/plugins/deep/nested.yaml"))).toBe(true);
  });

  it("writes correct content", () => {
    const content = "github_token: '${GITHUB_TOKEN}'\n";
    writeConfigFiles(tmpHome, [{ relativePath: "config/plugins/test.yaml", content }]);
    const written = readFileSync(join(tmpHome, "config/plugins/test.yaml"), "utf8");
    expect(written).toBe(content);
  });
});

// ── needsSetup ───────────────────────────────────────────────────────────────

describe("needsSetup", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "engineer-test-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns true when config dir does not exist", () => {
    expect(needsSetup(tmpHome)).toBe(true);
  });

  it("returns true when plugins dir is empty", () => {
    mkdirSync(join(tmpHome, "config", "plugins"), { recursive: true });
    expect(needsSetup(tmpHome)).toBe(true);
  });

  it("returns true when plugins dir has no .yaml files", () => {
    const pluginsDir = join(tmpHome, "config", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const { writeFileSync: wfs } = require("node:fs");
    wfs(join(pluginsDir, "readme.txt"), "not a yaml file");
    expect(needsSetup(tmpHome)).toBe(true);
  });

  it("returns false when plugins dir has .yaml files", () => {
    const pluginsDir = join(tmpHome, "config", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const { writeFileSync: wfs } = require("node:fs");
    wfs(join(pluginsDir, "claude-code-llm.yaml"), "# config");
    expect(needsSetup(tmpHome)).toBe(false);
  });
});

// ── ADAPTER_TYPE_CONFIGS ─────────────────────────────────────────────────────

describe("ADAPTER_TYPE_CONFIGS", () => {
  it("has an entry for every AdapterType value", () => {
    const schemaValues = AdapterTypeSchema.options;
    const configTypes = ADAPTER_TYPE_CONFIGS.map((c) => c.type);
    for (const value of schemaValues) {
      expect(configTypes).toContain(value);
    }
  });

  it("every config entry maps to an adapter type with at least one plugin", () => {
    for (const config of ADAPTER_TYPE_CONFIGS) {
      const plugins = BUILTIN_PLUGINS.filter((p) => p.manifest.type === config.type);
      expect(plugins.length).toBeGreaterThan(0);
    }
  });

  it("has unique setupOrder values", () => {
    const orders = ADAPTER_TYPE_CONFIGS.map((c) => c.setupOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("communication is the only non-required type", () => {
    const optional = ADAPTER_TYPE_CONFIGS.filter((c) => !c.required);
    expect(optional.length).toBe(1);
    expect(optional[0]?.type).toBe("communication");
  });
});

// ── combined_with ────────────────────────────────────────────────────────────

describe("combined_with on manifests", () => {
  it("github plugins reference each other", () => {
    const trigger = BUILTIN_PLUGINS.find((p) => p.manifest.id === "github-trigger");
    const comm = BUILTIN_PLUGINS.find((p) => p.manifest.id === "github-comm");
    const hosting = BUILTIN_PLUGINS.find((p) => p.manifest.id === "github-hosting");

    expect(trigger?.manifest.combined_with).toContain("github-comm");
    expect(trigger?.manifest.combined_with).toContain("github-hosting");
    expect(comm?.manifest.combined_with).toContain("github-trigger");
    expect(hosting?.manifest.combined_with).toContain("github-trigger");
  });

  it("non-github plugins have empty combined_with", () => {
    const nonGithub = BUILTIN_PLUGINS.filter((p) => !p.manifest.id.startsWith("github-"));
    for (const plugin of nonGithub) {
      expect(plugin.manifest.combined_with).toEqual([]);
    }
  });
});

// ── manifest-driven detection ────────────────────────────────────────────────

describe("detection derives from manifests", () => {
  it("every plugin requirement type is covered by detection", () => {
    const allRequirements = BUILTIN_PLUGINS.flatMap((p) => p.manifest.requirements);
    const binaryReqs = allRequirements.filter((r) => r.type === "binary");
    const envReqs = allRequirements.filter((r) => r.type === "env");

    // Build a detection with all binaries missing and all env vars missing
    const binaryPaths: Record<string, string | null> = {};
    for (const req of binaryReqs) {
      binaryPaths[req.name] = null;
    }
    const env: Record<string, string | undefined> = {};
    for (const req of envReqs) {
      env[req.name] = undefined;
    }

    const result = detectEnvironment(env, binaryPaths, null);

    // Every binary requirement name should appear in result.binaries
    for (const req of binaryReqs) {
      expect(req.name in result.binaries).toBe(true);
    }
    // Every env requirement name should NOT be in envVars (all undefined)
    for (const req of envReqs) {
      expect(result.envVars.has(req.name)).toBe(false);
    }
  });
});
