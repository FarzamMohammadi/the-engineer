/**
 * Git URL utilities — pure functions for URL manipulation.
 *
 * Lives in utils/ so both Core and Plugin tiers can import without
 * creating circular dependencies.
 */

/**
 * Inject authentication into an HTTPS git URL (D148).
 *
 * Replaces `https://` with `https://git:{token}@`. If token is empty or URL
 * is not HTTPS, returns the URL unchanged.
 */
export function injectAuth(url: string, token: string): string {
  if (!(token && url.startsWith("https://"))) {
    return url;
  }
  return url.replace("https://", `https://git:${token}@`);
}
