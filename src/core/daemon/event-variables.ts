/**
 * Extracts engineer variables from trigger event body.
 *
 * Users embed `@key: value` patterns in ticket descriptions.
 * Core scans for these — platform-agnostic, zero plugin config.
 * Currently extracts `@priority: <number>` (range 1-100).
 */

export interface EventVariables {
  priority?: number;
}

const PRIORITY_RE = /@priority:\s*(\d+)/;

export function extractEventVariables(body: string | null): EventVariables {
  const vars: EventVariables = {};
  if (!body) {
    return vars;
  }

  const priorityMatch = PRIORITY_RE.exec(body);
  if (priorityMatch) {
    const value = Number(priorityMatch[1]);
    if (value >= 1 && value <= 100) {
      vars.priority = value;
    }
  }

  return vars;
}
