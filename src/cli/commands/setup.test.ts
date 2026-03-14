import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as yamlParse } from "yaml";

import { _resetOutput, createOutput } from "../output.js";
import { runSetup } from "./setup.js";

const GHP_TOKEN_PATTERN = /ghp_[a-zA-Z0-9]+/;

// Mock @inquirer/prompts
vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  createOutput({ mode: "human", color: false });

  // Suppress stdout/stderr
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  // Reset mocks
  const prompts = await import("@inquirer/prompts");
  vi.mocked(prompts.confirm).mockResolvedValue(true);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  _resetOutput();
});

describe("runSetup", () => {
  it("generates valid YAML config files", async () => {
    const prompts = await import("@inquirer/prompts");
    vi.mocked(prompts.input)
      .mockResolvedValueOnce(tempDir) // home dir
      .mockResolvedValueOnce("owner/my-repo"); // repos
    vi.mocked(prompts.select)
      .mockResolvedValueOnce("claude-code") // LLM provider
      .mockResolvedValueOnce("balanced"); // safety level
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true) // GitHub token understood
      .mockResolvedValueOnce(false) // no Telegram
      .mockResolvedValue(true); // any remaining confirms

    const code = await runSetup(tempDir);
    expect(code).toBe(0);

    // Check daemon config
    const daemonPath = join(tempDir, "config", "daemon.yaml");
    expect(existsSync(daemonPath)).toBe(true);
    const daemonConfig = yamlParse(readFileSync(daemonPath, "utf8"));
    expect(daemonConfig.tick_interval_ms).toBe(30000);

    // Check safety config
    const safetyPath = join(tempDir, "config", "safety.yaml");
    expect(existsSync(safetyPath)).toBe(true);
    const safetyConfig = yamlParse(readFileSync(safetyPath, "utf8"));
    expect(safetyConfig.autonomy_level).toBe("supervised");

    // Check trigger plugin config
    const triggerPath = join(tempDir, "config", "plugins", "github-trigger.yaml");
    expect(existsSync(triggerPath)).toBe(true);
    const triggerConfig = yamlParse(readFileSync(triggerPath, "utf8"));
    expect(triggerConfig.repos).toHaveLength(1);
    expect(triggerConfig.repos[0].owner).toBe("owner");
    expect(triggerConfig.repos[0].repo).toBe("my-repo");
  });

  it("does not store secrets in config files", async () => {
    const prompts = await import("@inquirer/prompts");
    vi.mocked(prompts.input).mockResolvedValueOnce(tempDir).mockResolvedValueOnce("owner/repo");
    vi.mocked(prompts.select)
      .mockResolvedValueOnce("claude-code")
      .mockResolvedValueOnce("conservative");
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true) // GitHub token
      .mockResolvedValueOnce(false) // no Telegram
      .mockResolvedValue(true);

    await runSetup(tempDir);

    // Read all config files and check no real secrets
    const triggerPath = join(tempDir, "config", "plugins", "github-trigger.yaml");
    const content = readFileSync(triggerPath, "utf8");
    // Should reference env var placeholder, not contain actual token
    expect(content).toContain("${GITHUB_TOKEN}");
    expect(content).not.toMatch(GHP_TOKEN_PATTERN);
  });

  it("validates repo format", async () => {
    const prompts = await import("@inquirer/prompts");
    // The input mock's validate function is called by inquirer
    // We test the validate function by extracting it
    let validateFn: ((val: string) => string | boolean | Promise<string | boolean>) | undefined;
    vi.mocked(prompts.input).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test mock type coercion
      (opts: any) => {
        if (opts.validate) {
          validateFn = opts.validate;
        }
        return Promise.resolve("owner/repo");
      },
    );

    vi.mocked(prompts.select)
      .mockResolvedValueOnce("claude-code")
      .mockResolvedValueOnce("balanced");
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    await runSetup(tempDir);

    // The second input call is for repos — it should have a validate function
    expect(validateFn).toBeDefined();
    expect(validateFn?.("owner/repo")).toBe(true);
    expect(validateFn?.("owner/repo, other/repo2")).toBe(true);
    expect(typeof validateFn?.("invalid-format")).toBe("string"); // error message
    expect(typeof validateFn?.("")).toBe("string"); // empty
  });

  it("maps safety level to correct config values", async () => {
    const prompts = await import("@inquirer/prompts");
    vi.mocked(prompts.input).mockResolvedValueOnce(tempDir).mockResolvedValueOnce("owner/repo");
    vi.mocked(prompts.select)
      .mockResolvedValueOnce("claude-code")
      .mockResolvedValueOnce("autonomous");
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await runSetup(tempDir);

    const safetyPath = join(tempDir, "config", "safety.yaml");
    const safetyConfig = yamlParse(readFileSync(safetyPath, "utf8"));
    expect(safetyConfig.autonomy_level).toBe("autonomous");
    expect(safetyConfig.auto_merge).toBe(true);
    expect(safetyConfig.max_cost_per_task_usd).toBe(20);
  });

  it("generates Telegram config when enabled", async () => {
    const prompts = await import("@inquirer/prompts");
    vi.mocked(prompts.input).mockResolvedValueOnce(tempDir).mockResolvedValueOnce("owner/repo");
    vi.mocked(prompts.select)
      .mockResolvedValueOnce("claude-code")
      .mockResolvedValueOnce("balanced");
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true) // GitHub understood
      .mockResolvedValueOnce(true) // Enable Telegram
      .mockResolvedValueOnce(true) // Telegram understood
      .mockResolvedValue(true); // any overwrite confirms

    await runSetup(tempDir);

    const telegramPath = join(tempDir, "config", "plugins", "telegram-comm.yaml");
    expect(existsSync(telegramPath)).toBe(true);
    const telegramConfig = yamlParse(readFileSync(telegramPath, "utf8"));
    expect(telegramConfig.bot_token).toBe("${TELEGRAM_BOT_TOKEN}");
  });

  it("returns 0 on user cancellation", async () => {
    const prompts = await import("@inquirer/prompts");
    vi.mocked(prompts.input).mockRejectedValue(new Error("User force closed the prompt"));

    const code = await runSetup(tempDir);
    expect(code).toBe(0);
  });
});
