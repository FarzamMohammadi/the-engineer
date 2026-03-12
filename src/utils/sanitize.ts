/**
 * Secret sanitization utility (D154).
 *
 * Applied at chokepoints (SessionMemory, agent-loop) to prevent tokens
 * from leaking into journal entries, LLM context, or log output.
 */

// ── Known secret environment variable names ──────────────────────────────────

const SECRET_ENV_VARS = ["GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN"];

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Redact known secrets from a string.
 *
 * 1. Replaces URL-embedded tokens (`https://git:{token}@` and `https://{token}@`).
 * 2. Replaces occurrences of known env var values (GITHUB_TOKEN, TELEGRAM_BOT_TOKEN).
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

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replace all literal occurrences of `search` in `text` with `replacement`. */
function replaceAll(text: string, search: string, replacement: string): string {
  // Use split+join for literal replacement (no regex escaping needed)
  return text.split(search).join(replacement);
}
