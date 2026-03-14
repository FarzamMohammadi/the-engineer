import { z } from "zod";

export const BashToolConfigSchema = z.object({
  max_output_bytes: z.number().int().positive().default(10_485_760), // 10MB
  command_timeout_ms: z.number().int().positive().default(300_000), // 5 min
  env_passthrough: z.array(z.string()).default([]),
  /** Regex patterns that block command execution when matched (case-insensitive). */
  blocked_patterns: z.array(z.string()).default([
    // Credential/secret exfiltration
    "curl.*\\benv\\b",
    "wget.*\\benv\\b",
    "cat.*/etc/shadow",
    "cat.*/etc/passwd",
    // Destructive operations outside workspace
    "rm\\s+-rf\\s+/",
    "rm\\s+-rf\\s+~",
    "mkfs\\.",
    "dd\\s+if=",
    // Process/system manipulation
    "kill\\s+-9",
    "killall",
    "shutdown",
    "reboot",
    // Network exfiltration
    "nc\\s+-l",
    "\\bncat\\b",
    "\\bsocat\\b",
    // Env dumping (secrets)
    "^\\s*\\benv\\b\\s*$",
    "\\bprintenv\\b",
    "^\\s*set\\s*$",
    "^\\s*export\\s*$",
  ]),
  /** Whether to audit all commands (include full command in side_effects). */
  audit_commands: z.boolean().default(true),
});

export type BashToolConfig = z.output<typeof BashToolConfigSchema>;
