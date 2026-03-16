/**
 * Secret sanitization utility (D154).
 *
 * Applied at chokepoints (SessionMemory, agent-loop) to prevent tokens
 * from leaking into journal entries, LLM context, or log output.
 */

// ── Known secret environment variable names ──────────────────────────────────

export const SECRET_ENV_VARS = [
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NPM_TOKEN",
  "DOCKER_PASSWORD",
  "DATABASE_URL",
];

/** Minimum length for an env var value to be treated as a secret. */
const MIN_SECRET_LENGTH = 8;

// ── URL token patterns ───────────────────────────────────────────────────────

/**
 * Matches `https://git:{token}@` (standard git credential URL).
 * Captures everything between `git:` and `@`.
 */
const GIT_CREDENTIAL_URL_RE = /https:\/\/git:[^@]+@/g;

/**
 * Matches `https://{token}@` where {token} is a single non-slash,
 * non-colon, non-whitespace segment (alternate git URL format).
 * Excludes `git:` prefix (already handled above).
 */
const BARE_TOKEN_URL_RE = /https:\/\/(?!git:)[^/:@\s]+@/g;

// ── Pattern-based secret detection ──────────────────────────────────────────

/** Patterns that look like API keys/tokens regardless of env var. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub tokens (ghp_, gho_, ghs_, ghr_, github_pat_)
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(ghs_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(ghr_[a-zA-Z0-9]{36,})\b/g, replacement: "[REDACTED:github_token]" },
  { pattern: /\b(github_pat_[a-zA-Z0-9_]{36,})\b/g, replacement: "[REDACTED:github_pat]" },
  // AWS access key IDs
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: "[REDACTED:aws_key]" },
  // Generic assignment patterns (conservative: only in key=value contexts)
  {
    pattern:
      /(?:token|secret|password|key|api_key|apikey)["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-/.]{40,})["']?/gi,
    replacement: "[REDACTED:secret_value]",
  },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Redact known secrets from a string.
 *
 * 1. Replaces URL-embedded tokens (`https://git:{token}@` and `https://{token}@`).
 * 2. Replaces occurrences of known env var values.
 * 3. Replaces pattern-matched secrets (GitHub tokens, AWS keys, assignment patterns).
 *
 * Returns the input unchanged if no secrets are detected.
 * Safe to call on empty strings.
 */
export function sanitizeSecrets(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  // Phase 1: URL-embedded tokens
  result = result.replace(GIT_CREDENTIAL_URL_RE, "https://git:***@");
  result = result.replace(BARE_TOKEN_URL_RE, "https://***@");

  // Phase 2: Known env var values
  for (const envKey of SECRET_ENV_VARS) {
    const value = process.env[envKey];
    if (value && value.length >= MIN_SECRET_LENGTH) {
      result = replaceAll(result, value, "[REDACTED]");
    }
  }

  // Phase 3: Pattern-based secret detection
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Reset regex lastIndex since we reuse global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replace all literal occurrences of `search` in `text` with `replacement`. */
function replaceAll(text: string, search: string, replacement: string): string {
  // Use split+join for literal replacement (no regex escaping needed)
  return text.split(search).join(replacement);
}
