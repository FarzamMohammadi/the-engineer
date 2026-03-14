// ── URL Parsing ──────────────────────────────────────────────────────────────

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  number: number;
  type: "issue" | "pull";
}

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/;

/**
 * Parse a GitHub issue or PR URL into structured components.
 * Returns null if the URL doesn't match the expected pattern.
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  const match = GITHUB_URL_RE.exec(url);
  if (!match) {
    return null;
  }

  const [, owner, repo, kind, num] = match;
  return {
    owner: owner as string,
    repo: repo as string,
    number: Number.parseInt(num as string, 10),
    type: kind === "pull" ? "pull" : "issue",
  };
}

// ── Label Helpers ────────────────────────────────────────────────────────────

/**
 * Generate a state label name from a task state.
 * E.g., `stateLabelName("active", "engineer:")` → `"engineer:active"`
 */
export function stateLabelName(state: string, prefix: string): string {
  return `${prefix}${state.toLowerCase()}`;
}

/**
 * Compute label add/remove operations to transition from current labels
 * to a new state. State labels are mutually exclusive within the prefix.
 *
 * Returns `{ add, remove }` where:
 * - `add` is the new state label (if not already present)
 * - `remove` is the list of old state labels to remove
 */
export function diffStateLabels(
  currentLabels: string[],
  newState: string,
  prefix: string,
): { add: string[]; remove: string[] } {
  const newLabel = stateLabelName(newState, prefix);
  const remove = currentLabels.filter((l) => l.startsWith(prefix) && l !== newLabel);
  const add = currentLabels.includes(newLabel) ? [] : [newLabel];
  return { add, remove };
}

// ── Target Parsing ───────────────────────────────────────────────────────────

export interface ParsedTarget {
  owner: string;
  repo: string;
  issueNumber: number;
}

const TARGET_CHANNEL_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/**
 * Parse a comm adapter target channel string in the format `owner/repo#number`.
 * Returns null if the format doesn't match.
 */
export function parseTargetChannel(channel: string): ParsedTarget | null {
  const match = TARGET_CHANNEL_RE.exec(channel);
  if (!match) {
    return null;
  }
  return {
    owner: match[1] as string,
    repo: match[2] as string,
    issueNumber: Number.parseInt(match[3] as string, 10),
  };
}
