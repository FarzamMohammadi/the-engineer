import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import {
  CommunicationAdapter,
  type FormattedMessage,
  type HealthStatus,
  type InboundMessage,
  type InitResult,
  type MessageType,
  type SendResult,
  type Target,
  createAdapterError,
} from "../../../adapters/index.js";
import { type TelegramCommConfig, TelegramCommConfigSchema } from "./config.js";

// ── MarkdownV2 escaping ──────────────────────────────────────────────────────

/** Characters that must be escaped in Telegram MarkdownV2. */
const MARKDOWNV2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/** Strip leading @ from telegram handles. */
const LEADING_AT = /^@/;

/** Escape text for Telegram MarkdownV2 format. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_SPECIAL, "\\$1");
}

// ── Message type prefixes per parse mode ─────────────────────────────────────

const MARKDOWNV2_PREFIXES: Record<MessageType, string> = {
  notification: "*Info*",
  question: "*Question*",
  status_response: "*Status*",
  milestone: "*Milestone*",
  alert: "*Alert*",
};

const HTML_PREFIXES: Record<MessageType, string> = {
  notification: "<b>Info</b>",
  question: "<b>Question</b>",
  status_response: "<b>Status</b>",
  milestone: "<b>Milestone</b>",
  alert: "<b>Alert</b>",
};

const MARKDOWN_PREFIXES: Record<MessageType, string> = {
  notification: "*Info*",
  question: "*Question*",
  status_response: "*Status*",
  milestone: "*Milestone*",
  alert: "*Alert*",
};

// ── HTML escaping ────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Error classification ─────────────────────────────────────────────────────

/** Classify a Telegram API error into an adapter error code. */
export function classifyTelegramError(error: unknown): string {
  if (error && typeof error === "object" && "error_code" in error) {
    const code = (error as { error_code: number }).error_code;
    if (code === 401 || code === 403) {
      return "auth_failed";
    }
    if (code === 404) {
      return "not_found";
    }
    if (code === 429) {
      return "rate_limited";
    }
    if (code >= 500) {
      return "network_error";
    }
  }
  return "network_error";
}

function isRetryable(error: unknown): boolean {
  if (error && typeof error === "object" && "error_code" in error) {
    const code = (error as { error_code: number }).error_code;
    return code === 429 || code >= 500;
  }
  return true;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "parameters" in error &&
    typeof (error as { parameters: unknown }).parameters === "object" &&
    (error as { parameters: { retry_after?: unknown } }).parameters !== null
  ) {
    const retryAfter = (error as { parameters: { retry_after?: number } }).parameters.retry_after;
    if (typeof retryAfter === "number") {
      return retryAfter * 1000;
    }
  }
  return undefined;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * TelegramCommPlugin — sends notifications via Telegram bot.
 *
 * Capabilities: send, receive.
 * Communication plugins are dumb transport (Decision #40).
 * Orchestrator owns all intelligence.
 *
 * ## Setup: /start Handshake
 *
 * Telegram bots cannot message users unless the user initiates contact first.
 * Each person in People Directory must send `/start` to the bot once.
 *
 * Flow:
 * 1. Create a bot via @BotFather on Telegram → get bot token
 * 2. Set TELEGRAM_BOT_TOKEN in ~/.engineer/.env
 * 3. Each user opens the bot in Telegram and sends `/start`
 * 4. The plugin captures the username → chat_id mapping automatically
 * 5. Mapping is persisted to ~/.engineer/state/telegram-comm/chat-map.json
 *    (crash-safe atomic write via rename)
 *
 * The `handle` field in People Directory contacts must match the user's
 * Telegram username (case-insensitive). If no mapping exists for a handle,
 * sendMessage returns a clear error: "they need to /start the bot first".
 *
 * Mappings are captured both during initialization (drains pending updates)
 * and during polling (live /start messages). Once captured, the mapping
 * persists across restarts.
 */
export class TelegramCommPlugin extends CommunicationAdapter {
  private config!: TelegramCommConfig;
  protected bot!: Bot;

  private lastUpdateId = 0;

  /** Persistent mapping: lowercase username → Telegram chat_id. */
  private userChatMap = new Map<string, string>();

  /** Lightweight lookup: lowercase telegram handle → person name (from People Directory). */
  private telegramNameMap = new Map<string, string>();

  override hasCapability(capability: string): boolean {
    return capability === "send" || capability === "receive";
  }

  formatMessage(content: string, type: MessageType): string {
    const parseMode = this.config?.parse_mode ?? "MarkdownV2";
    return formatForParseMode(content, type, parseMode);
  }

  protected async doSendMessage(target: Target, message: FormattedMessage): Promise<SendResult> {
    const chatId = this.resolveChatId(target.user_id);
    if (!chatId) {
      return {
        success: false,
        message_id: null,
        error: createAdapterError(
          "not_found",
          `No chat_id for user "${target.user_id}" — they need to /start the bot first`,
          { retryable: true },
        ),
      };
    }

    try {
      const result = await this.bot.api.sendMessage(chatId, message.content, {
        parse_mode: this.config.parse_mode,
        link_preview_options: { is_disabled: this.config.disable_link_preview },
      });
      return {
        success: true,
        message_id: String(result.message_id),
        error: null,
      };
    } catch (error) {
      const retryAfterMs = getRetryAfterMs(error);
      return {
        success: false,
        message_id: null,
        error: createAdapterError(
          classifyTelegramError(error),
          error instanceof Error ? error.message : String(error),
          {
            retryable: isRetryable(error),
            ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
          },
        ),
      };
    }
  }

  // ── Receive: poll for new messages via getUpdates ───────────────────────

  protected async doPollMessages(
    _channels: string[],
    _since: string,
  ): Promise<{ messages: InboundMessage[]; cursor: string }> {
    const params: { timeout: number; allowed_updates: readonly ["message"]; offset?: number } = {
      timeout: 0,
      allowed_updates: ["message"] as const,
    };
    if (this.lastUpdateId > 0) {
      params.offset = this.lastUpdateId + 1;
    }
    const updates = await this.bot.api.getUpdates(params);

    const messages: InboundMessage[] = [];

    for (const update of updates) {
      if (update.update_id > this.lastUpdateId) {
        this.lastUpdateId = update.update_id;
      }

      const msg = update.message;
      if (!msg?.text) {
        continue;
      }

      // Capture /start handshakes for username → chat_id mapping
      if (msg.text.startsWith("/start") && msg.from?.username) {
        await this.captureHandshake(msg.from.username, String(msg.chat.id));
        continue;
      }

      // Skip other bot commands
      if (msg.text.startsWith("/")) {
        continue;
      }

      messages.push({
        source: "telegram",
        sender: msg.from?.username ?? String(msg.from?.id ?? "unknown"),
        content: msg.text,
        timestamp: new Date(msg.date * 1000).toISOString(),
        reply_to: msg.reply_to_message ? String(msg.reply_to_message.message_id) : null,
        platform_metadata: {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          from_id: msg.from?.id,
        },
      });
    }

    return { messages, cursor: String(this.lastUpdateId) };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected async doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    // Extract people data before Zod strips unknown keys
    this.buildNameMap(config["people"]);

    const parsed = TelegramCommConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { success: false, message: `Invalid config: ${parsed.error.message}` };
    }
    this.config = parsed.data;
    this.bot = new Bot(this.config.bot_token);

    // Load persisted username → chat_id mapping
    this.loadChatMap();

    // Fetch bot identity and update startup hint with actual bot username
    try {
      const me = await this.bot.api.getMe();
      const botHandle = me.username ? `@${me.username}` : `bot ${me.id}`;
      this.manifest.startup_hints = [
        `Each person in People Directory must send /start to ${botHandle} before The Engineer can reach them via Telegram.`,
      ];
    } catch {
      // Non-fatal — hint stays as default, healthCheck will catch auth issues
    }

    // Drain pending updates, capturing /start handshakes along the way.
    try {
      const pending = await this.bot.api.getUpdates({
        timeout: 0,
        allowed_updates: ["message"] as const,
      });
      for (const update of pending) {
        if (update.update_id > this.lastUpdateId) {
          this.lastUpdateId = update.update_id;
        }
        // Capture /start handshakes from messages received while offline
        const msg = update.message;
        if (msg?.text?.startsWith("/start") && msg.from?.username) {
          await this.captureHandshake(msg.from.username, String(msg.chat.id));
        }
      }
    } catch {
      // Non-fatal — if drain fails, first poll may return stale messages
      // but the response poller's cursor mechanism provides a second safety net
    }

    return { success: true, message: null };
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    try {
      const me = await this.bot.api.getMe();
      return {
        healthy: true,
        message: `Telegram bot: @${me.username ?? String(me.id)}`,
        details: { username: me.username ?? null, id: me.id },
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Telegram API error: ${error instanceof Error ? error.message : String(error)}`,
        details: null,
      };
    }
  }

  protected doShutdown(): Promise<void> {
    this.saveChatMap();
    return Promise.resolve();
  }

  // ── Handle → chat_id resolution ─────────────────────────────────────────

  /** Case-insensitive lookup of username → chat_id. */
  private resolveChatId(handle: string): string | undefined {
    return this.userChatMap.get(handle.toLowerCase());
  }

  /** Record a /start handshake, persist immediately (crash-safe), and reply. */
  private async captureHandshake(username: string, chatId: string): Promise<void> {
    const key = username.toLowerCase();
    if (this.userChatMap.get(key) === chatId) {
      // Already known — skip disk write but confirm to user
      const displayName = this.resolveNameByUsername(username);
      const body = escapeMarkdownV2(`Hi ${displayName}. You're already connected.`);
      const greeting = `*Comms Ready*\n\n${body}`;
      try {
        await this.bot.api.sendMessage(chatId, greeting, {
          parse_mode: this.config.parse_mode,
        });
      } catch {
        // Non-fatal
      }
      return;
    }
    this.userChatMap.set(key, chatId);
    this.saveChatMap();

    const displayName = this.resolveNameByUsername(username);
    const body = escapeMarkdownV2(`Hi ${displayName}. Your telegram chat id has been stored.`);
    const greeting = `*Comms Ready*\n\n${body}`;
    try {
      await this.bot.api.sendMessage(chatId, greeting, {
        parse_mode: this.config.parse_mode,
      });
    } catch {
      // Non-fatal: handshake was captured, reply delivery is best-effort
    }
  }

  /** Build telegram handle → person name lookup from people data. */
  private buildNameMap(rawPeople: unknown): void {
    if (!Array.isArray(rawPeople)) {
      return;
    }
    for (const person of rawPeople) {
      if (!person || typeof person !== "object") {
        continue;
      }
      const name = (person as { name?: string }).name;
      const contacts = (person as { contacts?: Array<{ channel: string; handle: string }> })
        .contacts;
      if (!(name && Array.isArray(contacts))) {
        continue;
      }
      for (const contact of contacts) {
        if (contact.channel === "telegram" && contact.handle) {
          const handle = contact.handle.replace(LEADING_AT, "").toLowerCase();
          this.telegramNameMap.set(handle, name);
        }
      }
    }
  }

  /** Resolve telegram username to person name, falling back to @username. */
  private resolveNameByUsername(username: string): string {
    return this.telegramNameMap.get(username.toLowerCase()) ?? `@${username}`;
  }

  // ── Persistent chat map (same pattern as github-trigger watermarks) ───

  private getStatePath(): string {
    const engineerHome = process.env["ENGINEER_HOME"] ?? join(homedir(), ".engineer");
    return join(engineerHome, "state", this.manifest.id, "chat-map.json");
  }

  private loadChatMap(): void {
    try {
      const path = this.getStatePath();
      if (existsSync(path)) {
        const data = readFileSync(path, "utf-8");
        const stored = JSON.parse(data) as Record<string, string>;
        for (const [key, value] of Object.entries(stored)) {
          this.userChatMap.set(key, value);
        }
      }
    } catch {
      // First run or corrupt — start fresh
    }
  }

  private saveChatMap(): void {
    try {
      const path = this.getStatePath();
      const stateDir = join(path, "..");
      mkdirSync(stateDir, { recursive: true });
      const tempPath = `${path}.tmp`;
      writeFileSync(tempPath, JSON.stringify(Object.fromEntries(this.userChatMap)), "utf-8");
      renameSync(tempPath, path);
    } catch {
      // Best effort — mapping loss means users need to /start again
    }
  }
}

// ── Format helpers ───────────────────────────────────────────────────────────

function formatForParseMode(content: string, type: MessageType, parseMode: string): string {
  if (parseMode === "HTML") {
    const prefix = HTML_PREFIXES[type] ?? "";
    const escaped = escapeHtml(content);
    return prefix ? `${prefix}\n\n${escaped}` : escaped;
  }
  if (parseMode === "MarkdownV2") {
    const prefix = MARKDOWNV2_PREFIXES[type] ?? "";
    const escaped = escapeMarkdownV2(content);
    return prefix ? `${prefix}\n\n${escaped}` : escaped;
  }
  // Legacy Markdown — no escaping needed (Telegram is lenient)
  const prefix = MARKDOWN_PREFIXES[type] ?? "";
  return prefix ? `${prefix}\n\n${content}` : content;
}
