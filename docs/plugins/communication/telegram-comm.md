# Telegram Communication

Sends notifications and receives replies via a Telegram bot using the [grammy](https://grammy.dev/) library. This is the personal notification channel -- direct messages to the project owner about task progress, questions, and alerts.

Use this plugin when you want real-time personal notifications on your phone. Pair with `github-comm` for public-facing updates on issues.

## Requirements

| Type | Name | Notes |
|------|------|-------|
| env  | `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather). Set in `~/.engineer/.env`. |

No `TELEGRAM_CHAT_ID` env var is needed at the config level. Chat IDs are resolved automatically via the `/start` handshake (see below).

## The /start Handshake

Telegram bots cannot initiate conversations. Each person who should receive messages must send `/start` to the bot once. This is a Telegram platform requirement, not a plugin limitation.

**Setup flow:**

1. Create a bot via @BotFather on Telegram. Save the token.
2. Set `TELEGRAM_BOT_TOKEN` in `~/.engineer/.env`.
3. Each user opens the bot in Telegram and sends `/start`.
4. The plugin captures the `username -> chat_id` mapping automatically.
5. The mapping is persisted to `~/.engineer/state/telegram-comm/chat-map.json`.

The `handle` field in People Directory contacts must match the Telegram username (case-insensitive, without the `@` prefix). If no mapping exists when the Engineer tries to send a message, the error is clear: "they need to /start the bot first."

**Persistence.** The chat map is written atomically (write to `.tmp`, then rename) to survive crashes. Mappings persist across restarts. Once a user has `/start`-ed, they never need to do it again unless the state file is deleted.

**Capture timing.** Handshakes are captured both during initialization (drains all pending updates received while offline) and during live polling. A `/start` sent while the Engineer is stopped will be picked up on next startup.

## Capabilities

| Capability | Supported | Description |
|------------|-----------|-------------|
| `send` | Yes | Sends formatted messages to users via their Telegram chat |
| `receive` | Yes | Polls for inbound messages via `getUpdates` (long-polling disabled, instant return) |

## Configuration

Config file: `~/.engineer/config/plugins/telegram-comm.yaml`

```yaml
bot_token: "${TELEGRAM_BOT_TOKEN}"    # REQUIRED -- Telegram bot token (env var ref)
parse_mode: MarkdownV2                # MarkdownV2 | Markdown | HTML (default: MarkdownV2)
disable_link_preview: true            # Disable link previews in messages (default: true)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `bot_token` | `string` | -- (required) | Telegram bot token. Use `${TELEGRAM_BOT_TOKEN}` to reference the env var. |
| `parse_mode` | `"MarkdownV2"` \| `"Markdown"` \| `"HTML"` | `"MarkdownV2"` | Telegram message formatting mode. |
| `disable_link_preview` | `boolean` | `true` | When true, URLs in messages won't generate preview cards. |

## How It Works

**Message formatting.** Each message type gets a bold prefix appropriate to the parse mode:
- MarkdownV2/Markdown: `*Info*`, `*Question*`, `*Alert*`, etc.
- HTML: `<b>Info</b>`, `<b>Question</b>`, `<b>Alert</b>`, etc.

**Escaping.** MarkdownV2 mode automatically escapes all special characters (`_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`, `\`). HTML mode escapes `&`, `<`, `>`. Legacy Markdown mode does no escaping (Telegram is lenient with it).

**Sending.** The plugin resolves a target's `user_id` to a `chat_id` via the in-memory chat map (populated by `/start` handshakes). Calls `bot.api.sendMessage` with the configured `parse_mode` and link preview setting. Returns the Telegram `message_id` on success.

**Receiving.** `pollMessages` calls `getUpdates` with `timeout: 0` (non-blocking). Filters out bot commands (messages starting with `/`). Returns structured `InboundMessage` objects with sender username, content, timestamp, reply context, and platform metadata (`chat_id`, `message_id`, `from_id`).

**Startup drain.** On initialization, the plugin calls `getUpdates` once to drain all pending updates. Any `/start` messages received while the Engineer was offline are captured. If the drain fails, it is non-fatal -- the first poll cycle provides a safety net.

**Health checks.** Calls `bot.api.getMe()` to verify the bot token is valid. Reports the bot's username on success.

**Error classification.** Telegram error codes map to adapter error types:
- 401/403 --> `auth_failed`
- 404 --> `not_found`
- 429 --> `rate_limited` (includes `retry_after_ms` from Telegram's response)
- 5xx --> `network_error` (retryable)

**Shutdown.** Persists the chat map to disk before stopping.

## Limitations

- Bot-initiated conversations require the `/start` handshake. There is no workaround -- this is a Telegram platform constraint.
- Polling is non-blocking (`timeout: 0`). The plugin does not use long-polling or webhooks. Message delivery latency depends on the Daemon's poll interval.
- No group chat support. The plugin is designed for 1:1 bot-to-user messaging. Group messages are not filtered or handled specially.
- Message length limits. Telegram caps messages at 4096 characters. The plugin does not split long messages -- oversized messages will fail at the API level.
- The chat map file (`chat-map.json`) is the single source of truth for username-to-chat mappings. If deleted, all users must `/start` again.

## Related Plugins

| Plugin | Relationship |
|--------|-------------|
| `github-comm` | Public communication channel (issue comments, labels). Telegram handles personal notifications. |
| `github-trigger` | Triggers tasks from GitHub issues. Telegram notifies the owner about task progress. |
