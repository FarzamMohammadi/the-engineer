import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADAPTER_TYPE_CONFIGS,
  detectEnvironment,
  generateConfigFiles,
  needsSetup,
  parseGitRemote,
  writeConfigFiles,
  writePluginDocs,
} from "../../../../src/cli/setup/setup.js";
import { BUILTIN_PLUGINS } from "../../../../src/plugins/builtin.js";
import { AdapterTypeSchema } from "../../../../src/schemas/adapters.js";

// ── detectEnvironment ────────────────────────────────────────────────────────

describe("detectEnvironment", () => {
  it("detects all binaries found", () => {
    const result = detectEnvironment({}, { claude: "/usr/bin/claude" }, null);
    expect(result.binaries["claude"]).toBe("/usr/bin/claude");
  });

  it("detects no binaries found", () => {
    const result = detectEnvironment({}, { claude: null, opencode: null }, null);
    expect(result.binaries["claude"]).toBeNull();
    expect(result.binaries["opencode"]).toBeNull();
  });

  it("detects present env vars", () => {
    const result = detectEnvironment({ GITHUB_TOKEN: "ghp_abc123", TELEGRAM_BOT_TOKEN: "bot:token" }, {}, null);
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
    const output = "origin\tgit@github.com:owner/repo.git (fetch)\norigin\tgit@github.com:owner/repo.git (push)\n";
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
    const files = generateConfigFiles(["claude-code-llm", "github-trigger"], {});
    const pluginFiles = files.filter((f) => f.relativePath.startsWith("config/plugins/"));
    const pluginPaths = pluginFiles.map((f) => f.relativePath);
    expect(pluginPaths).toContain("config/plugins/claude-code-llm.yaml");
    expect(pluginPaths).toContain("config/plugins/github-trigger.yaml");
  });

  it("does not generate plugin config for unselected plugins", () => {
    const files = generateConfigFiles(["claude-code-llm"], {});
    const pluginFiles = files.filter((f) => f.relativePath.startsWith("config/plugins/"));
    const pluginPaths = pluginFiles.map((f) => f.relativePath);
    expect(pluginPaths).not.toContain("config/plugins/github-trigger.yaml");
    expect(pluginPaths).not.toContain("config/plugins/telegram-comm.yaml");
  });

  it("merges user-provided config with template (preserving ${VAR} refs)", () => {
    const files = generateConfigFiles(["github-trigger"], {
      "github-trigger": {
        repos: [{ owner: "test", name: "repo" }],
      },
    });
    const triggerFile = files.find((f) => f.relativePath === "config/plugins/github-trigger.yaml");
    expect(triggerFile).toBeDefined();
    // User-provided repos should be present
    expect(triggerFile?.content).toContain("test");
    // Template's ${GITHUB_TOKEN} ref should be preserved via merge
    expect(triggerFile?.content).toContain("GITHUB_TOKEN");
  });

  it("user config overrides template values for same key", () => {
    const files = generateConfigFiles(["github-trigger"], {
      "github-trigger": {
        github_token: "literal-token",
        repos: [{ owner: "test", name: "repo" }],
      },
    });
    const triggerFile = files.find((f) => f.relativePath === "config/plugins/github-trigger.yaml");
    expect(triggerFile).toBeDefined();
    expect(triggerFile?.content).toContain("literal-token");
  });

  it("generates example templates", () => {
    const files = generateConfigFiles([], {});
    const examples = files.filter((f) => f.relativePath.startsWith("example-templates/"));
    expect(examples.length).toBeGreaterThan(0);
  });

  it("generates plugin documentation files", () => {
    const files = generateConfigFiles([], {});
    const docs = files.filter((f) => f.relativePath.startsWith("docs/plugins/"));
    // 4 adapter READMEs + 7 plugin docs = 11
    expect(docs.length).toBe(11);
  });

  it("generates plugin docs for every adapter type", () => {
    const files = generateConfigFiles([], {});
    const docs = files.filter((f) => f.relativePath.startsWith("docs/plugins/"));
    const types = ["trigger", "llm", "communication", "git-hosting"];
    for (const type of types) {
      const readme = docs.find((f) => f.relativePath === `docs/plugins/${type}/README.md`);
      expect(readme, `missing README for ${type}`).toBeDefined();
    }
  });

  it("creates fallback config for plugins without user config or template", () => {
    const files = generateConfigFiles(["some-custom-plugin"], {});
    const customFile = files.find((f) => f.relativePath === "config/plugins/some-custom-plugin.yaml");
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

// ── promptForConfig ─────────────────────────────────────────────────────────

describe("promptForConfig on builtin plugins", () => {
  it("github-trigger has a promptForConfig function", () => {
    const trigger = BUILTIN_PLUGINS.find((p) => p.manifest.id === "github-trigger");
    expect(trigger?.promptForConfig).toBeDefined();
    expect(typeof trigger?.promptForConfig).toBe("function");
  });

  it("plugins with all-default configs do not have promptForConfig", () => {
    const allDefaultPlugins = ["claude-code-llm", "opencode-llm", "gemini-cli-llm"];
    for (const id of allDefaultPlugins) {
      const plugin = BUILTIN_PLUGINS.find((p) => p.manifest.id === id);
      expect(plugin?.promptForConfig).toBeUndefined();
    }
  });

  it("plugins whose required fields are ${VAR} refs do not have promptForConfig", () => {
    const varRefPlugins = ["telegram-comm", "github-comm", "github-hosting"];
    for (const id of varRefPlugins) {
      const plugin = BUILTIN_PLUGINS.find((p) => p.manifest.id === id);
      expect(plugin?.promptForConfig).toBeUndefined();
    }
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

// ── findUnresolvedEnvVars ────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import { findUnresolvedEnvVars } from "../../../../src/cli/setup/setup.js";

describe("findUnresolvedEnvVars", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "env-scan-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no ${VAR} references exist", () => {
    writeFileSync(join(tmpDir, "test.yaml"), "key: value\nfoo: bar\n");
    expect(findUnresolvedEnvVars(tmpDir)).toEqual([]);
  });

  it("returns missing vars when ${VAR} references are unresolved", () => {
    writeFileSync(join(tmpDir, "test.yaml"), 'token: "${MISSING_TOKEN_XYZ}"\nchat_id: "${MISSING_CHAT_ID_XYZ}"\n');
    const result = findUnresolvedEnvVars(tmpDir);
    expect(result).toContain("MISSING_TOKEN_XYZ");
    expect(result).toContain("MISSING_CHAT_ID_XYZ");
  });

  it("does not return vars that are set in process.env", () => {
    const varName = `TEST_ENV_VAR_${Date.now()}`;
    process.env[varName] = "some-value";
    try {
      writeFileSync(join(tmpDir, "test.yaml"), `token: "\${${varName}}"\n`);
      expect(findUnresolvedEnvVars(tmpDir)).toEqual([]);
    } finally {
      delete process.env[varName];
    }
  });

  it("scans subdirectories recursively", () => {
    const subDir = join(tmpDir, "plugins");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "plugin.yaml"), 'key: "${DEEP_MISSING_VAR_XYZ}"\n');
    expect(findUnresolvedEnvVars(tmpDir)).toContain("DEEP_MISSING_VAR_XYZ");
  });

  it("returns empty array when config dir does not exist", () => {
    expect(findUnresolvedEnvVars("/nonexistent/path/xyz")).toEqual([]);
  });

  it("deduplicates vars referenced in multiple files", () => {
    writeFileSync(join(tmpDir, "a.yaml"), 'x: "${DUPE_VAR_XYZ}"\n');
    writeFileSync(join(tmpDir, "b.yaml"), 'y: "${DUPE_VAR_XYZ}"\n');
    const result = findUnresolvedEnvVars(tmpDir);
    expect(result.filter((v) => v === "DUPE_VAR_XYZ")).toHaveLength(1);
  });
});

// ── generateConfigFiles with people ──────────────────────────────────────────

describe("generateConfigFiles with people", () => {
  it("generates people.yaml from wizard data instead of template", () => {
    const people = [
      {
        id: "farzam",
        name: "Farzam",
        roles: ["owner"],
        contacts: [{ channel: "telegram", handle: "FarzamMohammadi" }],
      },
    ];
    const files = generateConfigFiles([], {}, people);
    const peopleFile = files.find((f) => f.relativePath === "config/people.yaml");
    expect(peopleFile).toBeDefined();
    expect(peopleFile!.content).toContain("farzam");
    expect(peopleFile!.content).toContain("FarzamMohammadi");
    expect(peopleFile!.content).toContain("telegram");
    expect(peopleFile!.content).not.toContain("your_telegram_username");
  });

  it("uses template when no people data provided", () => {
    const files = generateConfigFiles([], {});
    const peopleFile = files.find((f) => f.relativePath === "config/people.yaml");
    expect(peopleFile).toBeDefined();
    // Template has placeholder values
    expect(peopleFile!.content).toContain("your_telegram_username");
  });
});

// ── writePluginDocs ─────────────────────────────────────────────────────────

describe("writePluginDocs", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "engineer-docs-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes all 11 plugin doc files", () => {
    writePluginDocs(tmpHome);
    const types = ["trigger", "llm", "communication", "git-hosting"];
    for (const type of types) {
      expect(existsSync(join(tmpHome, `docs/plugins/${type}/README.md`))).toBe(true);
    }
  });

  it("writes per-plugin docs for every builtin plugin", () => {
    writePluginDocs(tmpHome);
    for (const plugin of BUILTIN_PLUGINS) {
      const type = plugin.manifest.type.replace(/_/g, "-");
      const docPath = join(tmpHome, `docs/plugins/${type}/${plugin.manifest.id}.md`);
      expect(existsSync(docPath), `missing doc for ${plugin.manifest.id}`).toBe(true);
    }
  });

  it("writes docs with 0o644 permissions (readable)", () => {
    writePluginDocs(tmpHome);
    const stat = statSync(join(tmpHome, "docs/plugins/trigger/README.md"));
    expect(stat.mode & 0o777).toBe(0o644);
  });

  it("doc files contain markdown content", () => {
    writePluginDocs(tmpHome);
    const content = readFileSync(join(tmpHome, "docs/plugins/trigger/README.md"), "utf8");
    expect(content).toContain("# ");
    expect(content.length).toBeGreaterThan(100);
  });
});

// ── pluginDocPath / adapterDocPath ──────────────────────────────────────────

import { adapterDocPath, pluginDocPath } from "../../../../src/cli/setup/prompts.js";

describe("doc path conventions", () => {
  it("pluginDocPath follows convention", () => {
    expect(pluginDocPath("/home/.engineer", "trigger", "github-trigger")).toBe(
      "/home/.engineer/docs/plugins/trigger/github-trigger.md",
    );
  });

  it("adapterDocPath follows convention", () => {
    expect(adapterDocPath("/home/.engineer", "llm")).toBe("/home/.engineer/docs/plugins/llm/README.md");
  });

  it("pluginDocPath normalizes git_hosting to git-hosting", () => {
    expect(pluginDocPath("/home/.engineer", "git_hosting", "github-hosting")).toBe(
      "/home/.engineer/docs/plugins/git-hosting/github-hosting.md",
    );
  });

  it("every builtin plugin has a matching doc in ALL_PLUGIN_DOCS", async () => {
    const { ALL_PLUGIN_DOCS } = await import("../../../../src/cli/plugin-docs.js");
    for (const plugin of BUILTIN_PLUGINS) {
      const type = plugin.manifest.type.replace(/_/g, "-");
      const expectedPath = `docs/plugins/${type}/${plugin.manifest.id}.md`;
      const doc = ALL_PLUGIN_DOCS.find((d: { relativePath: string }) => d.relativePath === expectedPath);
      expect(doc, `missing bundled doc for ${plugin.manifest.id}`).toBeDefined();
    }
  });
});

// ── adapter_meta.channel on comm plugins ─────────────────────────────────────

describe("comm plugin manifests declare channel", () => {
  it("every communication plugin has adapter_meta.channel", () => {
    const commPlugins = BUILTIN_PLUGINS.filter((p) => p.manifest.type === "communication");
    expect(commPlugins.length).toBeGreaterThan(0);
    for (const plugin of commPlugins) {
      const channel = plugin.manifest.adapter_meta["channel"];
      expect(channel, `${plugin.manifest.id} must declare adapter_meta.channel`).toBeTruthy();
      expect(typeof channel).toBe("string");
    }
  });

  it("telegram-comm declares channel 'telegram'", () => {
    const telegram = BUILTIN_PLUGINS.find((p) => p.manifest.id === "telegram-comm");
    expect(telegram).toBeDefined();
    expect(telegram!.manifest.adapter_meta["channel"]).toBe("telegram");
  });

  it("github-comm declares channel 'github'", () => {
    const github = BUILTIN_PLUGINS.find((p) => p.manifest.id === "github-comm");
    expect(github).toBeDefined();
    expect(github!.manifest.adapter_meta["channel"]).toBe("github");
  });
});
