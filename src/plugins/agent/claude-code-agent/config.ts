import { z } from "zod";

/**
 * Default Claude model. Single source of truth for the model id used everywhere
 * the plugin needs a fallback (config default, capabilities reporter, docs, templates).
 * Bump this and every consumer that reads it stays in sync.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

export const ClaudeCodeAgentConfigSchema = z.object({
  model: z.string().default(DEFAULT_CLAUDE_MODEL),
  cli_path: z.string().default("claude"),
  command_timeout_ms: z.number().int().positive().default(7_200_000), // 2 hours
  /** Maximum bytes of stdout before killing the CLI process. Prevents memory blowups. */
  max_cli_output_bytes: z.number().int().positive().default(500_000_000), // 500 MB
});

export type ClaudeCodeAgentConfig = z.output<typeof ClaudeCodeAgentConfigSchema>;
