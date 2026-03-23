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
 * Capabilities: send.
 * "receive" deferred — see future-considerations.md.
 *
 * Communication plugins are dumb transport (Decision #40).
 * Orchestrator owns all intelligence.
 */
export class TelegramCommPlugin extends CommunicationAdapter {
  private config!: TelegramCommConfig;
  protected bot!: Bot;

  private lastUpdateId = 0;

  override hasCapability(capability: string): boolean {
    return capability === "send" || capability === "receive";
  }

  formatMessage(content: string, type: MessageType): string {
    const parseMode = this.config?.parse_mode ?? "MarkdownV2";
    return formatForParseMode(content, type, parseMode);
  }

  protected async doSendMessage(target: Target, message: FormattedMessage): Promise<SendResult> {
    const chatId = target.channel ?? this.config.chat_id;

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

      // Skip bot commands (e.g., /start)
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

  protected doInitialize(config: Record<string, unknown>): Promise<InitResult> {
    const parsed = TelegramCommConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Promise.resolve({
        success: false,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    this.config = parsed.data;
    this.bot = new Bot(this.config.bot_token);
    return Promise.resolve({ success: true, message: null });
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
    return Promise.resolve();
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
