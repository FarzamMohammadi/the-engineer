import type { PRComment } from "../../../schemas/adapters.js";
import { type PrEvent, type PrEventType, PrEventTypes } from "../../../schemas/git-hosting-events.js";
import type { Task } from "../../../schemas/task.js";
import type { IPeopleDirectory } from "../../interfaces/people-directory.interface.js";
import { autoMerge } from "./delivery/auto-merge.js";
import { implement } from "./execution/implement.js";
import { type Carry, type Entry, Phases } from "./types.js";

// ── PR-Event Core Policy ─────────────────────────────────────────────────────
//
// Everything Core decides about a PR event before it becomes pipeline work. The
// git hosting plugin reports facts (detectPrEvents); Core owns the policy: where
// each event re-enters the pipeline (entryFor), which single event wins when several
// arrive in one poll (arbitrate), which feedback is genuinely new (dedup), and
// whether a `/approve` comment counts (authorization). The plugin never sees the
// people directory or The Engineer's `/approve` convention — both live here, so a
// new hosting plugin re-implements none of it. The daemon wiring that calls these
// lands at the external re-entry session; here they are pure, unit-tested policy.

/**
 * Where each external PR event re-enters the pipeline, keyed by the event type the task persists.
 * Comments may surface new scope, so they re-enter at requirements (the trivial-skip gates forward as
 * needed); CI failures and merge conflicts re-enter at execution to fix; a ready-to-merge or
 * already-merged event re-enters at delivery's entry-only `auto-merge`.
 */
export function entryFor(type: PrEventType): Entry {
  switch (type) {
    case PrEventTypes.pr_comments:
      return { phase: Phases.requirements };
    case PrEventTypes.pr_ci_failure:
      return { phase: Phases.execution, sub: implement.name };
    case PrEventTypes.pr_merge_conflict:
      return { phase: Phases.execution, sub: implement.name };
    case PrEventTypes.pr_ready_to_merge:
      return { phase: Phases.delivery, sub: autoMerge.name };
    case PrEventTypes.pr_merged:
      return { phase: Phases.delivery, sub: autoMerge.name };
    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled PR event type "${JSON.stringify(exhaustive)}"`);
    }
  }
}

/**
 * The rework context a re-entered agent opens with, derived from the event type. Surfaced through the
 * runner's carry, so the phase reached by {@link entryFor} starts by addressing what came back rather
 * than from scratch. Comments carry their content (already sanitized in `review.feedback_rounds`);
 * CI and conflict re-derive their detail live, per the thin-payload rule. The merge events carry a
 * placeholder — `auto-merge` is an orchestrator step that does not read carry.
 */
export function reentryCarry(type: PrEventType, task: Task): Carry {
  switch (type) {
    case PrEventTypes.pr_comments:
      return { summary: feedbackCarrySummary(task) };
    case PrEventTypes.pr_ci_failure:
      return {
        summary:
          "The open pull request's CI checks are failing. Reproduce the failures by running the project's own gates, fix the root cause, and let delivery re-push the branch.",
      };
    case PrEventTypes.pr_merge_conflict:
      return {
        summary:
          "The open pull request no longer merges cleanly into its base branch. Update the branch against the base, resolve every conflict, and let delivery re-push.",
      };
    case PrEventTypes.pr_ready_to_merge:
    case PrEventTypes.pr_merged:
      return { summary: "The pull request is approved and being finalized for merge." };
    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled PR event type "${JSON.stringify(exhaustive)}"`);
    }
  }
}

/** Render the task's outstanding (unapplied) review feedback into the rework summary the agent reads. */
function feedbackCarrySummary(task: Task): string {
  const comments = (task.review?.feedback_rounds ?? [])
    .filter((round) => !round.applied)
    .flatMap((round) => round.comments);
  if (comments.length === 0) {
    return "New reviewer feedback arrived on the open pull request. Re-read the PR conversation, address the feedback, and let delivery re-push.";
  }
  const list = comments.map((comment) => `- ${comment}`).join("\n");
  return ["New reviewer feedback arrived on the open pull request. Address it before continuing:", "", list].join("\n");
}

/**
 * Precedence over PR events that land in the same poll, highest first. A merge is terminal and
 * wins outright; otherwise reviewer feedback and the blockers (conflict, CI) are addressed before
 * a ready-to-merge is acted on, so a simultaneous approval never skips pending feedback.
 */
const PR_EVENT_PRECEDENCE: readonly PrEventType[] = [
  PrEventTypes.pr_merged,
  PrEventTypes.pr_comments,
  PrEventTypes.pr_merge_conflict,
  PrEventTypes.pr_ci_failure,
  PrEventTypes.pr_ready_to_merge,
];

/** Pick the single event to act on when several arrive in one poll, by precedence. Null when none do. */
export function arbitrate(events: readonly PrEvent[]): PrEvent | null {
  for (const type of PR_EVENT_PRECEDENCE) {
    const winner = events.find((event) => event.type === type);
    if (winner) {
      return winner;
    }
  }
  return null;
}

/**
 * Drop feedback the task has already accommodated, so the same reviewer comments do not re-rework
 * a task on every poll. Only `pr_comments` is deduped — the other events are re-derived from live
 * PR state and acted on idempotently. A comments event survives if it carries at least one comment
 * the task has not yet seen; a pure state signal carrying no comments is left for the consumer.
 *
 * Dedup against the comment ids is the primitive Core owns. The PR-event poller handles the
 * review-state dimension by waiting rather than reworking on a bare changes-requested that carries
 * no comment text — there is nothing to act on — so dedup needs no separate review-state flag.
 */
export function dedupePrEvents(events: readonly PrEvent[], accommodatedCommentIds: readonly string[]): PrEvent[] {
  const accommodated = new Set(accommodatedCommentIds);
  return events.filter((event) => {
    if (event.type !== PrEventTypes.pr_comments) {
      return true;
    }
    if (event.comments.length === 0) {
      return true;
    }
    return event.comments.some((comment) => !accommodated.has(comment.id));
  });
}

/** Standalone `/approve` or `/approved` comment command — The Engineer's convention, owned by Core. */
const APPROVE_COMMAND_REGEX = /^\/(approve|approved)\s*$/i;

/**
 * Find the first `/approve` comment from someone allowed to approve, or null. The plugin surfaces
 * the comment as a fact; Core decides whether it counts — `/approve` exists because a sole
 * contributor cannot approve their own PR on the host, so the comment is their approval path.
 *
 * Authorization is permissive for the single-contributor case (no one configured → any `/approve`
 * counts) but gated once an owner or reviewer is configured, so a drive-by `/approve` on a public
 * repo never triggers a merge. Tightening this to "only the owner" is a future knob.
 */
export function findAuthorizedApproval(
  comments: readonly PRComment[],
  peopleDirectory: IPeopleDirectory,
): { author: string } | null {
  for (const comment of comments) {
    if (!APPROVE_COMMAND_REGEX.test(comment.body.trim())) {
      continue;
    }
    if (isAuthorizedApprover(comment.author, peopleDirectory)) {
      return { author: comment.author };
    }
  }
  return null;
}

function isAuthorizedApprover(author: string, peopleDirectory: IPeopleDirectory): boolean {
  const owner = peopleDirectory.getOwner();
  const authorized = owner ? [owner, ...peopleDirectory.getReviewers()] : peopleDirectory.getReviewers();
  if (authorized.length === 0) {
    return true;
  }
  const handle = author.toLowerCase();
  return authorized.some((person) =>
    person.contacts.some((contact) => contact.channel === "github" && contact.handle.toLowerCase() === handle),
  );
}
