import { z } from "zod";

export const TelegramCommConfigSchema = z.object({
  bot_token: z.string().min(1),
  parse_mode: z.enum(["MarkdownV2", "Markdown", "HTML"]).default("MarkdownV2"),
  disable_link_preview: z.boolean().default(true),
});

export type TelegramCommConfig = z.output<typeof TelegramCommConfigSchema>;
