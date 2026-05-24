/**
 * Shared subprocess discipline for LLM plugins.
 *
 * Every LLM plugin spawns a CLI child process. These helpers enforce the two
 * disciplines that must never drift between plugins:
 *
 * - **Env sanitization** — only the allowlisted variables (and `LC_*` locale
 *   vars) are forwarded to the child. Secrets the parent holds for other
 *   adapters (`GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, ...) never reach the LLM.
 *   This is a Trust Through Restraint invariant.
 *
 * - **Stderr capping** — child processes can emit unbounded stderr (curl
 *   verbose, debug spew). The buffer is capped so an error message never
 *   blows up memory.
 *
 * No credential env vars are included — users authenticate with their CLI
 * provider separately before starting The Engineer (see docs/assumptions.md).
 */

// ── Env Sanitization ─────────────────────────────────────────────────────────

/** Environment variable allowlist for LLM CLI child processes. */
const LLM_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** Prefixes to match (for locale vars like LC_ALL, LC_CTYPE, ...). */
const LLM_ENV_PREFIX_ALLOWLIST = ["LC_"];

/**
 * Build a sanitized environment for LLM child processes.
 * Only forwards allowlisted vars — no secrets leak to the subprocess.
 */
export function buildLlmEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(LLM_ENV_ALLOWLIST);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (allowed.has(key) || LLM_ENV_PREFIX_ALLOWLIST.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}

// ── Stderr Buffering ─────────────────────────────────────────────────────────

/** Maximum bytes to retain from stderr. Only used in error messages. */
const MAX_STDERR_BYTES = 10_240;

/**
 * Append to a capped stderr buffer. Returns the (possibly truncated) new buffer.
 * When the buffer exceeds MAX_STDERR_BYTES, keeps only the tail.
 */
export function appendStderr(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_STDERR_BYTES) {
    return combined;
  }
  return combined.slice(combined.length - MAX_STDERR_BYTES);
}
