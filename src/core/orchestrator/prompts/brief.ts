import type { Person } from "../../../schemas/adapters.js";
import type {
  AutonomyBoundaries,
  AutonomyDecision,
  CostLimitValue,
  CostLimits,
  MergePolicy,
  ResponseTimeout,
  ScopeBoundaries,
  WorkspaceConfig,
} from "../../../schemas/config.js";
import { AutonomyLevels } from "../../../schemas/config.js";
import type { Ctx } from "../pipeline/types.js";
import { section } from "./format.js";
import { MY_ASSIGNMENT } from "./self-model/index.js";

// ── The Live Brief ────────────────────────────────────────────────────────────
//
// `MY_ASSIGNMENT` is the static "my assignment" doc — the SHAPE of what my
// manager decided, in handoff voice but with the specifics left as placeholders
// ("a point past which", "whatever my manager set them to be"). composeBrief
// fills those placeholders with this run's ACTUAL settings, so every phase opens
// knowing how it is really set up — not a template, the real lines.
//
// Voice discipline: this stays a manager's brief, not a config dump. We render
// only the behavior-shaping settings as real values, in the first person, and we
// leave machinery out entirely (poll intervals, stuck thresholds, concurrency,
// retries, telemetry, db). The fixed prose in MY_ASSIGNMENT already carries
// the pace beat and the section-4 invariants (reversibility, secrets sealed, no
// swallowed failures); we do not re-interpolate those — they never vary.
//
// One null-to-prose convention throughout: an absent setting is rendered as the
// stance it implies (trust, openness, a degraded safety net), never as a blank
// or a literal "null". The reader should never see a gap where a value belongs.

/** The static heading the live values render under, in brief voice. */
const SETUP_HEADING = "How I am actually set up";

/**
 * Compose the agent's live brief: the static "my assignment" framing followed by a
 * "how I am actually set up" section filled with this run's real owner settings.
 * Pure — reads only from `ctx` (people directory, safety config, workspace config,
 * task repo) and never throws. A missing owner or open (null) limit renders as the
 * stance it implies, so the brief is always complete and never blank.
 */
export function composeBrief(ctx: Ctx): string {
  const owner = ctx.peopleDirectory.getOwner();
  const liveSetup = section(
    SETUP_HEADING,
    [
      "These are the specifics for the job I am on — the lines my manager actually drew, not the shape of them:",
      "",
      renderOwner(owner),
      "",
      renderAutonomy(ctx.safetyConfig.autonomy, ctx.task.repo),
      "",
      renderLane(ctx.safetyConfig.scope, ctx.workspaceConfig),
      "",
      renderSpend(ctx.safetyConfig.cost_limits),
      "",
      renderBlockedCadence(ctx.safetyConfig.response_timeout),
      "",
      renderThinkingTrail(ctx.safetyConfig.merge),
    ].join("\n"),
  );
  return [MY_ASSIGNMENT, liveSetup].join("\n\n");
}

// ── Who I answer to ────────────────────────────────────────────────────────────

/**
 * The owner and how to reach them. A null owner renders the degraded stance from the brief — I keep
 * working, but I name the hole: I cannot reach them when blocked, get a decision, or hand off context.
 */
function renderOwner(owner: Person | null): string {
  if (!owner) {
    return "**Who I answer to** — I have no named owner configured. I keep working, but the safety net has a hole I should name: I cannot reach anyone when I am blocked, I cannot get a decision when I need one, and I cannot hand off context. I do not treat this as permission to go fully solo — I proceed cautiously and surface that the contact is missing.";
  }
  const channels =
    owner.contacts.length > 0
      ? owner.contacts.map((c) => `${c.channel} (${c.handle})`).join(", ")
      : "no contact channel is configured, so I cannot actually reach them — I name that gap rather than assume silence means they are ignoring me";
  const roles = owner.roles.filter((r) => r !== "owner");
  const roleSuffix = roles.length > 0 ? `, who is also ${roles.join(", ")}` : "";
  return `**Who I answer to** — ${owner.name}${roleSuffix}. When I need a decision, a sign-off, or I am blocked, I reach them on: ${channels}.`;
}

// ── What I decide alone vs. check first ─────────────────────────────────────────

/**
 * The autonomy policy grouped into the three buckets the agent reasons in: decide alone
 * (always_decide), decide up to a count then check (threshold), and always check first
 * (always_ask). Per-repo overrides are resolved against the task's repo so it reads "for THIS repo".
 */
function renderAutonomy(autonomy: AutonomyBoundaries, repo: string | null): string {
  const resolved = resolveDecisions(autonomy, repo);
  const decideAlone: string[] = [];
  const upToCount: string[] = [];
  const alwaysAsk: string[] = [];
  for (const [category, decision] of Object.entries(resolved)) {
    const label = decision.description ? `${category} (${decision.description})` : category;
    switch (decision.level) {
      case AutonomyLevels.always_decide:
        decideAlone.push(label);
        break;
      case AutonomyLevels.threshold:
        upToCount.push(decision.threshold ? `${label} — up to ${decision.threshold}, then I check first` : label);
        break;
      case AutonomyLevels.always_ask:
        alwaysAsk.push(label);
        break;
      default:
        // The level is a closed enum, so this is unreachable today. Any unforeseen level falls into
        // "check first" — the brief's own fail-safe — rather than throwing, keeping composeBrief total.
        alwaysAsk.push(label);
        break;
    }
  }

  const repoNote = repo ? `For this repo (\`${repo}\`), here is where the lines fall` : "Here is where the lines fall";
  const lines = [`**What I decide alone vs. check first** — ${repoNote}:`, ""];
  lines.push(renderBucket("I decide these alone", decideAlone));
  lines.push(renderBucket("I decide these up to a point, then check first", upToCount));
  lines.push(renderBucket("I always check first on these", alwaysAsk));
  lines.push(
    "Anything that fits none of these I treat as check-first — when in doubt, I ask rather than assume I am trusted.",
  );
  return lines.join("\n");
}

/** Resolve the effective per-category decisions: base policy with this repo's overrides merged on top. */
function resolveDecisions(autonomy: AutonomyBoundaries, repo: string | null): Record<string, AutonomyDecision> {
  const merged: Record<string, AutonomyDecision> = { ...autonomy.decisions };
  const override = repo ? autonomy.repo_overrides[repo] : undefined;
  if (override) {
    for (const [category, partial] of Object.entries(override.decisions)) {
      const base = merged[category] ?? { level: AutonomyLevels.always_ask, threshold: null, description: "" };
      merged[category] = {
        level: partial.level ?? base.level,
        threshold: partial.threshold ?? base.threshold,
        description: partial.description ?? base.description,
      };
    }
  }
  return merged;
}

/** One labelled bucket of categories, or an honest empty line when the bucket has none. */
function renderBucket(label: string, categories: string[]): string {
  if (categories.length === 0) {
    return `- ${label}: none.`;
  }
  return `- ${label}: ${categories.join("; ")}.`;
}

// ── My lane ─────────────────────────────────────────────────────────────────────

/**
 * Where I am allowed to work: my branch patterns (create/push/merge), the files I never touch,
 * and the workspace's home base, branch prefix, and merge strategy.
 */
function renderLane(scope: ScopeBoundaries, workspace: WorkspaceConfig): string {
  const offLimits =
    scope.files.exclude_patterns.length > 0
      ? scope.files.exclude_patterns.join(", ")
      : "none are configured, so I still keep my hands off anything that looks like a secret";
  return [
    "**My lane** — where I am allowed to work:",
    `- I branch off \`${workspace.default_base_branch}\` by default and aim my finished work back at it. Every branch I create is prefixed \`${workspace.branch_prefix}\` so my work is always recognizable as mine.`,
    `- I create branches matching \`${scope.branches.create_pattern}\` and push only to ${formatPatternList(scope.branches.push_to)}. The one place I am cleared to merge into is ${formatPatternList(scope.branches.merge_to)} — I cannot push there directly.`,
    `- Off-limits files I never read, edit, or commit: ${offLimits}.`,
    `- When I deliver, my PR is merged by the \`${workspace.pr.default_merge_strategy}\` strategy.`,
  ].join("\n");
}

/** Render a list of glob patterns as inline code, comma-joined. */
function formatPatternList(patterns: string[]): string {
  if (patterns.length === 0) {
    return "nowhere (no destination is configured)";
  }
  return patterns.map((p) => `\`${p}\``).join(", ");
}

// ── My spend ceiling ─────────────────────────────────────────────────────────────

/** The spending leash — per-task, daily, monthly. A null limit is trust, not a blank, and I say so. */
function renderSpend(costLimits: CostLimits): string {
  return [
    "**My spend ceiling** — how much I am allowed to cost:",
    `- Per task: ${formatCost(costLimits.per_task)}.`,
    `- Per day: ${formatCost(costLimits.daily)}.`,
    `- Per month: ${formatCost(costLimits.monthly)}.`,
    "Either way I spend like it is my manager's money, because it is.",
  ].join("\n");
}

/** A cost limit as prose: a hard dollar ceiling, or — when null — explicit trust rather than a blank. */
function formatCost(limit: CostLimitValue): string {
  if (limit.cost_usd === null) {
    return "left open — no hard cap, which I read as trust in my judgment, not a license to spend freely";
  }
  return `capped at $${String(limit.cost_usd)}`;
}

// ── When I am blocked ────────────────────────────────────────────────────────────

/**
 * The patience-then-persistence cadence once I am blocked on the owner: each stage's timing
 * in brief voice (a reminder, a self-unblock attempt, an escalation), drawn from the real stages.
 */
function renderBlockedCadence(responseTimeout: ResponseTimeout): string {
  const stages = responseTimeout.blocked.stages;
  if (stages.length === 0) {
    return "**When I am blocked, when you will chase it** — no escalation cadence is configured, so a block can sit silently. I still nudge and surface it, but nothing automatic chases it for me.";
  }
  const lines = ["**When I am blocked, when you will chase it** — once I am waiting on the owner:"];
  for (const stage of stages) {
    lines.push(`- ${describeStageAction(stage.action)} after ${formatDuration(stage.after_ms)}.`);
  }
  return lines.join("\n");
}

/** Turn a timeout-stage action into the brief's first-person beat. */
function describeStageAction(action: ResponseTimeout["blocked"]["stages"][number]["action"]): string {
  switch (action) {
    case "send_reminder":
      return "I nudge with a reminder";
    case "evaluate_self_unblock":
      return "I try once to unblock myself";
    case "escalation_alert":
      return "a quiet wait becomes a real escalation";
    default:
      // The action is a closed enum — unreachable today. A new action degrades to a neutral beat
      // rather than throwing, keeping composeBrief total.
      return "I follow up with the owner";
  }
}

// ── My thinking trail at merge ────────────────────────────────────────────────────

/** Whether my `thoughts/` trail is stripped at merge: kept in the PR for review either way. */
function renderThinkingTrail(merge: MergePolicy): string {
  const fate = merge.exclude_thoughts_on_merge
    ? "stripped out of the branch before it lands, so they stay in the PR for review but never reach the permanent record"
    : "kept in the PR and land with the merge — they are part of the record here, not stripped";
  return `**My thinking trail at merge** — my \`thoughts/\` working notes are ${fate}.`;
}

// ── Duration formatting ───────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Render a millisecond duration as the largest whole human unit (e.g. 14400000 -> "4 hours"). */
function formatDuration(ms: number): string {
  if (ms >= MS_PER_DAY && ms % MS_PER_DAY === 0) {
    return plural(ms / MS_PER_DAY, "day");
  }
  if (ms >= MS_PER_HOUR && ms % MS_PER_HOUR === 0) {
    return plural(ms / MS_PER_HOUR, "hour");
  }
  if (ms >= MS_PER_MINUTE && ms % MS_PER_MINUTE === 0) {
    return plural(ms / MS_PER_MINUTE, "minute");
  }
  if (ms >= MS_PER_DAY) {
    return plural(Math.round(ms / MS_PER_DAY), "day");
  }
  if (ms >= MS_PER_HOUR) {
    return plural(Math.round(ms / MS_PER_HOUR), "hour");
  }
  if (ms >= MS_PER_MINUTE) {
    return plural(Math.round(ms / MS_PER_MINUTE), "minute");
  }
  return plural(Math.round(ms / MS_PER_SECOND), "second");
}

/** "1 hour" / "4 hours" — a count with a unit, pluralized. */
function plural(count: number, unit: string): string {
  return count === 1 ? `${String(count)} ${unit}` : `${String(count)} ${unit}s`;
}
