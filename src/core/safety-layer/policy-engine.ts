import type { ResponseTimeout, SafetyConfig } from "../../schemas/config.js";
import { ActionClasses } from "../../schemas/task.js";
import type { ActionClass } from "../../schemas/task.js";
import type { SafetyQuery, SafetyVerdict } from "../interfaces/safety-layer.interface.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Parsed threshold from autonomy config. */
export interface ParsedThreshold {
  metric: string;
  op: ">" | "<" | ">=" | "<=" | "=";
  value: number;
}

/**
 * The outcome of measuring a threshold against a decision's details. Three states, not a bool,
 * because "the metric is missing" must route differently from "the metric is within limit":
 * an absent metric means the agent surfaced a threshold-governed decision without the number the
 * threshold needs, so the safe move is to ask the owner rather than silently proceed.
 */
export type ThresholdOutcome = "exceeded" | "within" | "metric_absent";

// ── Constants ────────────────────────────────────────────────────────────────

const THRESHOLD_REGEX = /^(\w+)\s*(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)/;

// ── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Parse a threshold string like `"scope > 5 files"` or `"scope > 5"`.
 *
 * Format: `<metric> <op> <value> [unit]`
 * Supported operators: `>`, `<`, `>=`, `<=`, `=`
 * Returns null if the string cannot be parsed.
 */
export function parseThreshold(threshold: string): ParsedThreshold | null {
  const match = THRESHOLD_REGEX.exec(threshold.trim());
  const metric = match?.[1];
  const op = match?.[2];
  const val = match?.[3];
  if (!(metric && op && val)) {
    return null;
  }
  return {
    metric,
    op: op as ParsedThreshold["op"],
    value: Number(val),
  };
}

/**
 * Measure a parsed threshold against a details object. `exceeded` means the ask-the-owner
 * condition is met; `within` means the agent may proceed; `metric_absent` means details carry
 * no number for the metric, which fails safe to asking (see {@link ThresholdOutcome}).
 */
export function evaluateThreshold(parsed: ParsedThreshold, details: Record<string, unknown>): ThresholdOutcome {
  const actual = details[parsed.metric];
  if (typeof actual !== "number") {
    return "metric_absent";
  }
  return compareThreshold(parsed.op, actual, parsed.value) ? "exceeded" : "within";
}

/** Apply a threshold operator to two numbers — true when the ask-the-owner condition holds. */
function compareThreshold(op: ParsedThreshold["op"], actual: number, value: number): boolean {
  switch (op) {
    case ">":
      return actual > value;
    case "<":
      return actual < value;
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case "=":
      return actual === value;
    default:
      return false;
  }
}

/**
 * Match a path/string against a glob-like pattern.
 *
 * Supports:
 * - `*` matches any single path segment (no slashes)
 * - `**` matches zero or more path segments
 * - `*` at the end of a string (no slashes) matches any suffix (e.g., `.env*` matches `.env.local`)
 * - Literal matching otherwise
 *
 * This is for file paths and branch names, NOT for dot-separated event types
 * (use EventBus's `matchesPattern` for those).
 */
export function matchesPathPattern(pattern: string, value: string): boolean {
  // No slashes in pattern — treat as a simple glob against the full value or basename
  if (!pattern.includes("/")) {
    return simpleGlob(pattern, value) || simpleGlob(pattern, basename(value));
  }

  // Path-based matching with slash segments
  const patternParts = pattern.split("/");
  const valueParts = value.split("/");
  return matchSegments(patternParts, 0, valueParts, 0);
}

function simpleGlob(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern === "**") {
    return true;
  }

  // Handle patterns like `.env*` or `*.pem` — convert to regex
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value);
  }

  return pattern === value;
}

function matchSegments(
  pattern: readonly string[],
  patternStart: number,
  value: readonly string[],
  valueStart: number,
): boolean {
  let pi = patternStart;
  let vi = valueStart;

  while (pi < pattern.length && vi < value.length) {
    const seg = pattern[pi];
    if (seg === "**") {
      return matchDoublestar(pattern, pi, value, vi);
    }
    if (seg === undefined || !simpleGlob(seg, value[vi] ?? "")) {
      return false;
    }
    pi++;
    vi++;
  }

  // Skip trailing ** patterns
  while (pi < pattern.length && pattern[pi] === "**") {
    pi++;
  }

  return pi === pattern.length && vi === value.length;
}

function matchDoublestar(pattern: readonly string[], pi: number, value: readonly string[], vi: number): boolean {
  for (let skip = vi; skip <= value.length; skip++) {
    if (matchSegments(pattern, pi + 1, value, skip)) {
      return true;
    }
  }
  return false;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// ── PolicyEngine ─────────────────────────────────────────────────────────────

/**
 * Evaluates safety policies: scope boundaries, autonomy decisions, merge policy.
 *
 * Pure logic — no database, no event bus. Takes config, returns verdicts.
 */
export class PolicyEngine {
  private config: SafetyConfig;

  constructor(config: SafetyConfig) {
    this.config = config;
  }

  /** Gate 2 scope evaluation (repo, branch, file, merge). Returns null if all checks pass. */
  evaluateScope(actionClass: ActionClass, details: Record<string, unknown>): SafetyVerdict | null {
    // 1. Repo scope check
    const repoCheck = this.checkRepoScope(details);
    if (repoCheck) {
      return repoCheck;
    }

    // 2. Branch scope check (for git_remote and merge actions)
    if (actionClass === ActionClasses.git_remote || actionClass === ActionClasses.merge) {
      const branchCheck = this.checkBranchScope(actionClass, details);
      if (branchCheck) {
        return branchCheck;
      }
    }

    // 3. File scope check (for write actions)
    if (actionClass === ActionClasses.write) {
      const fileCheck = this.checkFileScope(details);
      if (fileCheck) {
        return fileCheck;
      }
    }

    // 4. Merge policy check
    if (actionClass === ActionClasses.merge) {
      const mergeCheck = this.checkMergePolicy(details);
      if (mergeCheck) {
        return mergeCheck;
      }
    }

    return null;
  }

  /**
   * Autonomy evaluation for should_i_ask queries — does the owner's policy let the agent decide
   * this category, or must it ask? Reached via consultJudgment("should_i_ask"), which the pipeline
   * runner issues per discretionary decision the agent surfaces. A category with no rule (or a
   * threshold whose metric is absent) fails safe to ask_human — when in doubt, involve the owner.
   */
  evaluateAutonomy(query: SafetyQuery): SafetyVerdict {
    const category = query.context.decision_category;
    if (!category) {
      return { allowed: false, action: "ask_human", reason: "no decision category provided" };
    }

    // Check for repo override first
    const repoOverride = this.findRepoOverride(query.context.repo, category);
    const decision = repoOverride ?? this.config.autonomy.decisions[category];

    if (!decision) {
      return {
        allowed: false,
        action: "ask_human",
        reason: `unknown decision category "${category}" — defaulting to ask_human`,
      };
    }

    switch (decision.level) {
      case "always_decide":
        return { allowed: true, action: "proceed", reason: `"${category}" is always_decide` };

      case "always_ask":
        return {
          allowed: false,
          action: "ask_human",
          reason: `"${category}" requires human approval`,
        };

      case "threshold": {
        if (!decision.threshold) {
          return {
            allowed: false,
            action: "ask_human",
            reason: `"${category}" has threshold level but no threshold defined`,
          };
        }
        const parsed = parseThreshold(decision.threshold);
        if (!parsed) {
          return {
            allowed: false,
            action: "ask_human",
            reason: `unparseable threshold "${decision.threshold}" for "${category}"`,
          };
        }
        switch (evaluateThreshold(parsed, query.context.details)) {
          case "exceeded":
            return {
              allowed: false,
              action: "ask_human",
              reason: `${category} ${parsed.metric} (${query.context.details[parsed.metric]}) exceeds threshold (${parsed.value})`,
            };
          case "metric_absent":
            return {
              allowed: false,
              action: "ask_human",
              reason: `${category} has threshold "${decision.threshold}" but no "${parsed.metric}" was provided — asking the owner`,
            };
          default:
            return { allowed: true, action: "proceed", reason: `${category} within threshold` };
        }
      }

      default:
        return { allowed: false, action: "ask_human", reason: "unknown autonomy level" };
    }
  }

  /** Check if auto-merge is allowed for a repo. */
  checkAutoMergeAllowed(repo: string): boolean {
    const mergeConfig = this.config.merge.auto_merge_after_approval;
    const repoSetting = mergeConfig.repos[repo];
    return repoSetting ?? mergeConfig.default;
  }

  /** Whether /approve PR comments are treated as approval signals (solo-dev workflow). */
  isCommentApprovalEnabled(): boolean {
    return this.config.merge.enable_comment_approval;
  }

  /** Whether thoughts/ directory should be removed from the branch before merge. */
  shouldExcludeThoughtsOnMerge(): boolean {
    return this.config.merge.exclude_thoughts_on_merge;
  }

  /** Get response timeout policy. */
  getTimeoutPolicy(): ResponseTimeout {
    return this.config.response_timeout;
  }

  // ── Private: Scope Checks ──────────────────────────────────────────────────

  private checkRepoScope(details: Record<string, unknown>): SafetyVerdict | null {
    const allowed = this.config.scope.repos.allowed;
    if (allowed === null) {
      return null;
    }
    const repo = details["repo"];
    if (typeof repo !== "string") {
      return null;
    }
    if (!allowed.includes(repo)) {
      return {
        allowed: false,
        action: "deny",
        reason: `repo "${repo}" is not in the allowed list`,
      };
    }
    return null;
  }

  private checkBranchScope(
    actionClass: "git_remote" | "merge",
    details: Record<string, unknown>,
  ): SafetyVerdict | null {
    const branch = details["branch"];
    if (typeof branch !== "string") {
      return null;
    }

    const patterns =
      actionClass === ActionClasses.merge ? this.config.scope.branches.merge_to : this.config.scope.branches.push_to;

    const matches = patterns.some((p) => matchesPathPattern(p, branch));
    if (!matches) {
      const verb = actionClass === ActionClasses.merge ? "merge into" : "push to";
      return {
        allowed: false,
        action: "deny",
        reason: `cannot ${verb} branch "${branch}" — not in allowed patterns`,
      };
    }
    return null;
  }

  private checkFileScope(details: Record<string, unknown>): SafetyVerdict | null {
    const patterns = this.config.scope.files.exclude_patterns;
    if (patterns.length === 0) {
      return null;
    }

    const files = this.extractFiles(details);
    for (const file of files) {
      for (const pattern of patterns) {
        if (matchesPathPattern(pattern, file)) {
          return {
            allowed: false,
            action: "deny",
            reason: `file "${file}" matches exclude pattern "${pattern}"`,
          };
        }
      }
    }
    return null;
  }

  private checkMergePolicy(details: Record<string, unknown>): SafetyVerdict | null {
    const repo = details["repo"];
    if (typeof repo !== "string") {
      return null;
    }

    const mergeConfig = this.config.merge.auto_merge_after_approval;
    const repoSetting = mergeConfig.repos[repo];
    const autoMergeAllowed = repoSetting ?? mergeConfig.default;

    if (!autoMergeAllowed) {
      return {
        allowed: false,
        action: "ask_human",
        reason: `auto-merge is not enabled for repo "${repo}"`,
      };
    }
    return null;
  }

  private findRepoOverride(
    repo: string,
    category: string,
  ): { level: "always_ask" | "threshold" | "always_decide"; threshold: string | null } | null {
    for (const [repoPattern, override] of Object.entries(this.config.autonomy.repo_overrides)) {
      if (matchesPathPattern(repoPattern, repo)) {
        const decision = override.decisions[category];
        if (decision?.level) {
          return {
            level: decision.level,
            threshold: decision.threshold ?? null,
          };
        }
      }
    }
    return null;
  }

  private extractFiles(details: Record<string, unknown>): string[] {
    const file = details["file"];
    const files = details["files"];

    if (typeof file === "string") {
      return [file];
    }
    if (Array.isArray(files)) {
      return files.filter((f): f is string => typeof f === "string");
    }
    return [];
  }
}
