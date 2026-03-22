/**
 * Glob-style event pattern matching.
 *
 * - `"*"` matches any event type
 * - `"task.*"` matches `"task.created"`, `"task.state_changed"` (one segment after dot)
 * - `"task.*"` does NOT match `"task.state.deep"` (segment count must match)
 * - `"*.created"` matches `"task.created"` but not `"task.state_changed"`
 */
export function matchesPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") {
    return true;
  }
  const patternParts = pattern.split(".");
  const typeParts = eventType.split(".");
  if (patternParts.length !== typeParts.length) {
    return false;
  }
  return patternParts.every((p, i) => p === "*" || p === typeParts[i]);
}
