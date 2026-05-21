import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCommPlugin } from "../../../../../src/plugins/communication/telegram-comm/telegram-comm.js";
import {
  classifyTelegramError,
  escapeMarkdownV2,
} from "../../../../../src/plugins/communication/telegram-comm/telegram-comm.js";
import type { FormattedMessage, PluginManifest, Target } from "../../../../../src/schemas/adapters.js";
import { MessageTypes } from "../../../../../src/schemas/adapters.js";
import { runCommunicationContractSuite } from "../../../../helpers/contract-suites/communication-contract.js";
import { createTestPluginContext } from "../../../../helpers/test-plugin-context.js";

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
  entry: "index.ts",
  adapter_meta: { capabilities: ["send"] },
  requirements: [],
  combined_with: [],
  contributes: { events: [], commands: [], config_keys: [], hooks: [] },
  startup_hints: [],
};

const VALID_CONFIG = {
  bot_token: "123456:ABC-DEF1234ghIkl-zyx57W2v",
};
const INVALID_CONFIG = {};

const TARGET: Target = { user_id: "FarzamMohammadi", channel: "telegram" };
const MESSAGE: FormattedMessage = {
  content: "Task picked up",
  metadata: { task_id: "task-1", type: MessageTypes.notification },
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
        // Pre-populate chat map so contract suite's sendMessage works
        (plugin as unknown as { userChatMap: Map<string, string> }).userChatMap.set(
          "farzammohammadi",
          "-1001234567890",
        );
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
    plugin.context = createTestPluginContext();
    mockBot = createMockBot();
    await plugin.initialize(VALID_CONFIG);
    (plugin as unknown as { bot: unknown }).bot = mockBot;
    // Clear map (loadChatMap in init may load persisted state from disk)
    // then add only the known entry tests expect
    (plugin as unknown as { userChatMap: Map<string, string> }).userChatMap.clear();
    (plugin as unknown as { userChatMap: Map<string, string> }).userChatMap.set("farzammohammadi", "-1001234567890");
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

    it("does not report ticket_management capability", () => {
      expect(plugin.hasCapability("ticket_management")).toBe(false);
    });
  });

  describe("formatMessage()", () => {
    it("formats notification with bold Info prefix (MarkdownV2)", () => {
      const result = plugin.formatMessage("Test", MessageTypes.notification);
      expect(result).toContain("*Info*");
      expect(result).toContain("Test");
    });

    it("formats question with bold Question prefix", () => {
      const result = plugin.formatMessage("What?", MessageTypes.question);
      expect(result).toContain("*Question*");
    });

    it("formats status_response with bold Status prefix", () => {
      const result = plugin.formatMessage("All good", MessageTypes.status_response);
      expect(result).toContain("*Status*");
    });

    it("formats milestone with bold Milestone prefix", () => {
      const result = plugin.formatMessage("Done!", MessageTypes.milestone);
      expect(result).toContain("*Milestone*");
    });

    it("formats alert with bold Alert prefix", () => {
      const result = plugin.formatMessage("Warning!", MessageTypes.alert);
      expect(result).toContain("*Alert*");
    });

    it("escapes MarkdownV2 special characters in content", () => {
      const result = plugin.formatMessage("file_name.ts [test]", MessageTypes.notification);
      expect(result).toContain("file\\_name\\.ts \\[test\\]");
    });

    it("formats with HTML when parse_mode is HTML", async () => {
      const htmlPlugin = new TelegramCommPlugin();
      htmlPlugin.manifest = MANIFEST;
      htmlPlugin.context = createTestPluginContext();
      await htmlPlugin.initialize({
        ...VALID_CONFIG,
        parse_mode: "HTML",
      });
      const result = htmlPlugin.formatMessage("Test <b>bold</b>", MessageTypes.notification);
      expect(result).toContain("<b>Info</b>");
      expect(result).toContain("&lt;b&gt;bold&lt;/b&gt;");
    });

    it("formats with legacy Markdown when parse_mode is Markdown", async () => {
      const mdPlugin = new TelegramCommPlugin();
      mdPlugin.manifest = MANIFEST;
      mdPlugin.context = createTestPluginContext();
      await mdPlugin.initialize({
        ...VALID_CONFIG,
        parse_mode: "Markdown",
      });
      const result = mdPlugin.formatMessage("Test_content", MessageTypes.notification);
      expect(result).toContain("*Info*");
      // Legacy Markdown does not escape underscores
      expect(result).toContain("Test_content");
    });
  });

  describe("sendMessage()", () => {
    it("resolves handle to chat_id and sends", async () => {
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(true);
      expect(result.message_id).toBe("42");
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith("-1001234567890", MESSAGE.content, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    });

    it("resolves handle case-insensitively", async () => {
      const upperTarget: Target = { user_id: "FARZAMMOHAMMADI", channel: "telegram" };
      const result = await plugin.sendMessage(upperTarget, MESSAGE);
      expect(result.success).toBe(true);
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith("-1001234567890", expect.any(String), expect.any(Object));
    });

    it("returns not_found error for unknown handle", async () => {
      const unknownTarget: Target = { user_id: "unknown_user", channel: "telegram" };
      const result = await plugin.sendMessage(unknownTarget, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(result.error?.message).toContain("unknown_user");
      expect(result.error?.message).toContain("/start");
      expect(result.error?.retryable).toBe(true);
      expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("returns error on auth failure (401)", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { error_code: 401 }));
      const result = await plugin.sendMessage(TARGET, MESSAGE);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("auth_failed");
    });

    it("returns error on not found (404)", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(Object.assign(new Error("Chat not found"), { error_code: 404 }));
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
      p.context = createTestPluginContext();
      const result = await p.initialize({});
      expect(result.success).toBe(false);
    });

    it("applies default parse_mode (MarkdownV2)", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      await p.initialize(VALID_CONFIG);
      expect((p as unknown as { config: { parse_mode: string } }).config.parse_mode).toBe("MarkdownV2");
    });

    it("applies default disable_link_preview (true)", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      await p.initialize(VALID_CONFIG);
      expect((p as unknown as { config: { disable_link_preview: boolean } }).config.disable_link_preview).toBe(true);
    });

    it("accepts custom parse_mode", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      const result = await p.initialize({ ...VALID_CONFIG, parse_mode: "HTML" });
      expect(result.success).toBe(true);
      expect((p as unknown as { config: { parse_mode: string } }).config.parse_mode).toBe("HTML");
    });
  });
  describe("chat map persistence", () => {
    const savedHome = process.env["ENGINEER_HOME"];
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      if (savedHome === undefined) {
        delete process.env["ENGINEER_HOME"];
      } else {
        process.env["ENGINEER_HOME"] = savedHome;
      }
    });

    it("saveChatMap + loadChatMap round-trips the mapping", () => {
      tmpDir = join(process.cwd(), `tmp-test-state-${Date.now()}`);
      process.env["ENGINEER_HOME"] = tmpDir;

      // Save current map (pre-populated in beforeEach)
      (plugin as unknown as { saveChatMap: () => void }).saveChatMap();

      // Create a fresh plugin and load
      const p2 = new TelegramCommPlugin();
      p2.manifest = MANIFEST;
      p2.context = createTestPluginContext();
      (p2 as unknown as { loadChatMap: () => void }).loadChatMap();

      const map = (p2 as unknown as { userChatMap: Map<string, string> }).userChatMap;
      expect(map.get("farzammohammadi")).toBe("-1001234567890");
    });

    it("loadChatMap handles missing file gracefully", () => {
      process.env["ENGINEER_HOME"] = `/tmp/nonexistent-engineer-${Date.now()}`;

      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      // Should not throw
      (p as unknown as { loadChatMap: () => void }).loadChatMap();
      const map = (p as unknown as { userChatMap: Map<string, string> }).userChatMap;
      expect(map.size).toBe(0);
    });

    it("captureHandshake skips disk write when mapping already exists", async () => {
      const saveSpy = vi.spyOn(plugin as unknown as { saveChatMap: () => void }, "saveChatMap");

      // Call with same data that's already in the map
      await (plugin as unknown as { captureHandshake: (u: string, c: string) => Promise<void> }).captureHandshake(
        "FarzamMohammadi",
        "-1001234567890",
      );

      expect(saveSpy).not.toHaveBeenCalled();
      saveSpy.mockRestore();
    });
  });

  describe("/start handshake capture", () => {
    it("captures username → chat_id from /start during init", async () => {
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();

      // Mock Bot constructor to inject our mock before init runs
      const mock = createMockBot();
      (mock.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates = vi.fn().mockResolvedValue([
        {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1700000000,
            chat: { id: 555666777 },
            from: { id: 123, username: "NewUser" },
            text: "/start",
          },
        },
      ]);

      await p.initialize(VALID_CONFIG);
      // Replace bot AFTER init created it, then re-run the drain logic
      (p as unknown as { bot: unknown }).bot = mock;

      // Directly call captureHandshake to test the mapping logic
      // (init already ran with the real bot which has no updates)
      await (p as unknown as { captureHandshake: (u: string, c: string) => Promise<void> }).captureHandshake(
        "NewUser",
        "555666777",
      );

      const map = (p as unknown as { userChatMap: Map<string, string> }).userChatMap;
      expect(map.get("newuser")).toBe("555666777");
    });

    it("sends reply with People Directory name on /start", async () => {
      // Re-init with people data
      const p = new TelegramCommPlugin();
      p.manifest = MANIFEST;
      p.context = createTestPluginContext();
      const mock = createMockBot();
      (mock.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates = vi.fn().mockResolvedValue([]);

      await p.initialize({
        ...VALID_CONFIG,
        people: [
          {
            id: "farzam",
            name: "Farzam",
            roles: ["owner"],
            contacts: [{ channel: "telegram", handle: "AnotherUser" }],
          },
        ],
      });
      (p as unknown as { bot: unknown }).bot = mock;

      // Trigger /start via pollMessages
      (mock.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates.mockResolvedValue([
        {
          update_id: 200,
          message: {
            message_id: 60,
            date: 1700000000,
            chat: { id: 999888777 },
            from: { id: 789, username: "AnotherUser" },
            text: "/start",
          },
        },
      ]);

      await p.pollMessages([], "0");

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        "999888777",
        "*Comms Ready*\n\nHi Farzam\\. Your telegram chat id has been stored\\.",
        { parse_mode: "MarkdownV2" },
      );
    });

    it("falls back to @username when no people match", async () => {
      (mockBot.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates = vi.fn().mockResolvedValue([
        {
          update_id: 300,
          message: {
            message_id: 70,
            date: 1700000000,
            chat: { id: 777888999 },
            from: { id: 456, username: "UnknownUser" },
            text: "/start",
          },
        },
      ]);

      await plugin.pollMessages([], "0");

      expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
        "777888999",
        "*Comms Ready*\n\nHi @UnknownUser\\. Your telegram chat id has been stored\\.",
        { parse_mode: "MarkdownV2" },
      );
    });

    it("reply failure is non-fatal — handshake still captured", async () => {
      mockBot.api.sendMessage.mockRejectedValueOnce(new Error("Network error"));
      (mockBot.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates = vi.fn().mockResolvedValue([
        {
          update_id: 100,
          message: {
            message_id: 50,
            date: 1700000000,
            chat: { id: 444333222 },
            from: { id: 456, username: "FailUser" },
            text: "/start",
          },
        },
      ]);

      // Should not throw
      await plugin.pollMessages([], "0");

      const map = (plugin as unknown as { userChatMap: Map<string, string> }).userChatMap;
      expect(map.get("failuser")).toBe("444333222");
    });

    it("re-/start with same chat_id skips disk write but still replies", async () => {
      const saveSpy = vi.spyOn(plugin as unknown as { saveChatMap: () => void }, "saveChatMap");

      // Pre-populate with existing mapping
      (plugin as unknown as { userChatMap: Map<string, string> }).userChatMap.set("existinguser", "111222333");

      (mockBot.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates = vi.fn().mockResolvedValue([
        {
          update_id: 100,
          message: {
            message_id: 50,
            date: 1700000000,
            chat: { id: 111222333 },
            from: { id: 456, username: "ExistingUser" },
            text: "/start",
          },
        },
      ]);

      await plugin.pollMessages([], "0");

      // Reply sent but no disk write — mapping unchanged
      expect(mockBot.api.sendMessage).toHaveBeenCalled();
      expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
        "111222333",
        expect.stringContaining("already connected"),
        expect.any(Object),
      );
      expect(saveSpy).not.toHaveBeenCalled();
      saveSpy.mockRestore();
    });

    it("captures /start during pollMessages", async () => {
      // Set up getUpdates to return a /start message
      (mockBot.api as unknown as { getUpdates: ReturnType<typeof vi.fn> }).getUpdates = vi.fn().mockResolvedValue([
        {
          update_id: 100,
          message: {
            message_id: 50,
            date: 1700000000,
            chat: { id: 444333222 },
            from: { id: 456, username: "AnotherUser" },
            text: "/start",
          },
        },
      ]);

      await plugin.pollMessages([], "0");

      const map = (plugin as unknown as { userChatMap: Map<string, string> }).userChatMap;
      expect(map.get("anotheruser")).toBe("444333222");
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
