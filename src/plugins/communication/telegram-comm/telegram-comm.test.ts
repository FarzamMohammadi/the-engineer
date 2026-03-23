import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommunicationContractSuite } from "../../../../test/helpers/contract-suites/communication-contract.js";
import type { FormattedMessage, PluginManifest, Target } from "../../../schemas/adapters.js";
import { TelegramCommPlugin } from "./telegram-comm.js";
import { classifyTelegramError, escapeMarkdownV2 } from "./telegram-comm.js";

// ── Mock Bot ─────────────────────────────────────────────────────────────────

function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({
        message_id: 42,
        chat: { id: -1001234567890 },
        date: 1700000000,
        text: "Task picked up",
      }),
      getMe: vi.fn().mockResolvedValue({
        id: 7654321,
        is_bot: true,
        first_name: "TheEngineer",
        username: "the_engineer_bot",
      }),
    },
  };
}

const MANIFEST: PluginManifest = {
  id: "telegram-comm",
  type: "communication",
  version: "1.0.0",
  name: "Telegram Communication",
  description: "Sends notifications via Telegram bot",
  config_schema: {},
  critical: false,
  enabled: true,
  entry: "index.ts",
  adapter_meta: { capabilities: ["send"] },
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
};

const VALID_CONFIG = {
  bot_token: "123456:ABC-DEF1234ghIkl-zyx57W2v",
  chat_id: "-1001234567890",
};
const INVALID_CONFIG = {};

const TARGET: Target = { user_id: "farzam", channel: "-1001234567890" };
const MESSAGE: FormattedMessage = {
  content: "Task picked up",
  metadata: { task_id: "task-1", type: "notification" },
};

// ── Contract Suite ───────────────────────────────────────────────────────────

runCommunicationContractSuite(
  () => {
    const plugin = new TelegramCommPlugin();
    const mock = createMockBot();
    const origInit = plugin["doInitialize"].bind(plugin);
    plugin["doInitialize"] = async (config: Record<string, unknown>) => {
      const result = await origInit(config);
      if (result.success) {
        (plugin as unknown as { bot: unknown }).bot = mock;
      }
      return result;
    };
    return plugin;
  },
  {
    validConfig: VALID_CONFIG,
    invalidConfig: INVALID_CONFIG,
    manifest: MANIFEST,
    target: TARGET,
    message: MESSAGE,
  },
);

// ── Plugin-Specific Tests ────────────────────────────────────────────────────

describe("TelegramCommPlugin", () => {
  let plugin: TelegramCommPlugin;
  let mockBot: ReturnType<typeof createMockBot>;

  beforeEach(async () => {
    plugin = new TelegramCommPlugin();
    plugin.manifest = MANIFEST;
    mockBot = createMockBot();
    await plugin.initialize(VALID_CONFIG);
    (plugin as unknown as { bot: unknown }).bot = mockBot;
  });

  describe("hasCapability()", () => {
    it("reports send capability", () => {
      expect(plugin.hasCapability("send")).toBe(true);
    });

    it("reports receive capability", () => {
      expect(plugin.hasCapability("receive")).toBe(true);
    });

    it("does not report sync capability", () => {
      expect(plugin.hasCapability("sync")).toBe(false);
    });

    it("does not report issue_management capability", () => {
      expect(plugin.hasCapability("issue_management")).toBe(false);
    });
  });

  describe("formatMessage()", () => {
    it("formats notification with bold Info prefix (MarkdownV2)", () => {
      const result = plugin.formatMessage("Test", "notification");
      expect(result).toContain("*Info*");
      expect(result).toContain("Test");
    });

    it("formats question with bold Question prefix", () => {
      const result = plugin.formatMessage("What?", "question");
      expect(result).toContain("*Question*");
    });

    it("formats status_response with bold Status prefix", () => {
      const result = plugin.formatMessage("All good", "status_response");
      expect(result).toContain("*Status*");
    });

    it("formats milestone with bold Milestone prefix", () => {
      const result = plugin.formatMessage("Done!", "milestone");
      expect(result).toContain("*Milestone*");
    });

    it("formats alert with bold Alert prefix", () => {
      const result = plugin.formatMessage("Warning!", "alert");
      expect(result).toContain("*Alert*");
    });

    it("escapes MarkdownV2 special characters in content", () => {
      const result = plugin.formatMessage("file_name.ts [test]", "notification");
      expect(result).toContain("file\\_name\\.ts \\[test\\]");
    });

    it("formats with HTML when parse_mode is HTML", async () => {
      const htmlPlugin = new TelegramCommPlugin();
      htmlPlugin.manifest = MANIFEST;
      await htmlPlugin.initialize({
        ...VALID_CONFIG,
        parse_mode: "HTML",
      });
      const result = htmlPlugin.formatMessage("Test <b>bold</b>", "notification");
      expect(result).toContain("<b>Info</b>");
      expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
    });

    it("formats with legacy Markdown when parse_mode is Markdown", async () => {
      const mdPlugin = new TelegramCommPlugin();
      mdPlugin.manifest = MANIFEST;
      await mdPlugin.initialize({
        ...VALID_CONFIG,
        parse_mode: "Markdown",
      });
      const result = mdPlugin.formatMessage("Test_content", "notification");
      expect(result).toContain("*Info*");
      // Legacy Markdown does not escape underscores
      expect(result).toContain("Test_content");
    });
  });

  describe("sendMessage()", () => {
    it("sends via bot.api.sendMessage with correct params", async () => {
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(true);
      expect(result.message_id).toBe("42");
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith("-1001234567890", MESSAGE.content, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    });

    it("uses target.channel when provided", async () => {
      const customTarget: Target = { user_id: "farzam", channel: "999888777" };
      await plugin.sendMessage(customTarget, MESSAGE);
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
        "999888777",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("falls back to config.chat_id when target.channel is null", async () => {
      const nullTarget: Target = { user_id: "farzam", channel: null };
      await plugin.sendMessage(nullTarget, MESSAGE);
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
        "-1001234567890",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("returns error on auth failure (401)", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error("Unauthorized"), { error_code: 401 }),
      );
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("auth_failed");
    });

    it("returns error on not found (404)", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error("Chat not found"), { error_code: 404 }),
      );
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("not_found");
    });

    it("returns error on rate limit (429) with retry_after", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error("Too Many Requests"), {
          error_code: 429,
          parameters: { retry_after: 30 },
        }),
      );
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("rate_limited");
      expect(result.error?.retryable).toBe(true);
      expect(result.error?.retry_after_ms).toBe(30000);
    });

    it("returns error on server error (500)", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(
        Object.assign(new Error("Internal Server Error"), { error_code: 500 }),
      );
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("network_error");
      expect(result.error?.retryable).toBe(true);
    });

    it("returns error on unknown error", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(new Error("Connection refused"));
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("network_error");
    });
  });

  describe("healthCheck()", () => {
    it("returns healthy with bot username", async () => {
      const status = await plugin.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.message).toContain("@the_engineer_bot");
      expect(status.details).toEqual({ username: "the_engineer_bot", id: 7654321 });
    });

    it("returns unhealthy on API error", async () => {
      mockBot.api.getMe.mockRejectedValueOnce(new Error("Network timeout"));
      const status = await plugin.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.message).toContain("Network timeout");
    });

    it("handles bot without username", async () => {
      mockBot.api.getMe.mockResolvedValueOnce({
        id: 7654321,
        is_bot: true,
        first_name: "TheEngineer",
      });
      const status = await plugin.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.message).toContain("7654321");
    });
  });

  describe("config validation", () => {
    it("rejects missing bot_token", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({ chat_id: "-1001234567890" });
      expect(result.success).toBe(false);
    });

    it("rejects missing chat_id", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({ bot_token: "123456:ABC" });
      expect(result.success).toBe(false);
    });

    it("applies default parse_mode (MarkdownV2)", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      await p.initialize(VALID_CONFIG);
      expect((p as unknown as { config: { parse_mode: string } }).config.parse_mode).toBe(
        "MarkdownV2",
      );
    });

    it("applies default disable_link_preview (true)", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      await p.initialize(VALID_CONFIG);
      expect(
        (p as unknown as { config: { disable_link_preview: boolean } }).config.disable_link_preview,
      ).toBe(true);
    });

    it("accepts custom parse_mode", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      const result = await p.initialize({ ...VALID_CONFIG, parse_mode: "HTML" });
      expect(result.success).toBe(true);
      expect((p as unknown as { config: { parse_mode: string } }).config.parse_mode).toBe("HTML");
    });
  });
});

// ── Pure function tests ──────────────────────────────────────────────────────

describe("escapeMarkdownV2()", () => {
  it("escapes underscore", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
  });

  it("escapes asterisk", () => {
    expect(escapeMarkdownV2("*bold*")).toBe("\\*bold\\*");
  });

  it("escapes brackets", () => {
    expect(escapeMarkdownV2("[link](url)")).toBe("\\[link\\]\\(url\\)");
  });

  it("escapes tilde", () => {
    expect(escapeMarkdownV2("~strike~")).toBe("\\~strike\\~");
  });

  it("escapes backtick", () => {
    expect(escapeMarkdownV2("`code`")).toBe("\\`code\\`");
  });

  it("escapes greater-than", () => {
    expect(escapeMarkdownV2("> quote")).toBe("\\> quote");
  });

  it("escapes hash", () => {
    expect(escapeMarkdownV2("# heading")).toBe("\\# heading");
  });

  it("escapes plus and minus", () => {
    expect(escapeMarkdownV2("a+b-c")).toBe("a\\+b\\-c");
  });

  it("escapes equals and pipe", () => {
    expect(escapeMarkdownV2("a=b|c")).toBe("a\\=b\\|c");
  });

  it("escapes braces", () => {
    expect(escapeMarkdownV2("{a}")).toBe("\\{a\\}");
  });

  it("escapes dot and exclamation", () => {
    expect(escapeMarkdownV2("Hello!")).toBe("Hello\\!");
    expect(escapeMarkdownV2("file.ts")).toBe("file\\.ts");
  });

  it("escapes backslash", () => {
    expect(escapeMarkdownV2("path\\to")).toBe("path\\\\to");
  });

  it("passes through clean text unchanged", () => {
    expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });

  it("handles multiple special chars together", () => {
    expect(escapeMarkdownV2("file_name.ts [v1.0]")).toBe("file\\_name\\.ts \\[v1\\.0\\]");
  });
});

describe("classifyTelegramError()", () => {
  it("classifies 401 as auth_failed", () => {
    expect(classifyTelegramError({ error_code: 401 })).toBe("auth_failed");
  });

  it("classifies 403 as auth_failed", () => {
    expect(classifyTelegramError({ error_code: 403 })).toBe("auth_failed");
  });

  it("classifies 404 as not_found", () => {
    expect(classifyTelegramError({ error_code: 404 })).toBe("not_found");
  });

  it("classifies 429 as rate_limited", () => {
    expect(classifyTelegramError({ error_code: 429 })).toBe("rate_limited");
  });

  it("classifies 500 as network_error", () => {
    expect(classifyTelegramError({ error_code: 500 })).toBe("network_error");
  });

  it("classifies unknown error as network_error", () => {
    expect(classifyTelegramError(new Error("oops"))).toBe("network_error");
  });

  it("classifies null as network_error", () => {
    expect(classifyTelegramError(null)).toBe("network_error");
  });
});
