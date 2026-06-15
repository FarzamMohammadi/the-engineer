import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { GitHostingAdapter } from "../../../../adapters/git-hosting.js";
import { AdapterTypes, type PRResult } from "../../../../schemas/adapters.js";
import { NotificationKinds } from "../../../../schemas/notifications.js";
import { ObservationTypes } from "../../../../schemas/observer.js";
import type { ExternalRef } from "../../../../schemas/task.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../../../utils/sanitize.js";
import type { WorkspaceRecord } from "../../../interfaces/workspace-manager.interface.js";
import { traceScope } from "../observability.js";
import type { Ctx, Route, SubPhase, SubPhaseResult } from "../types.js";
import { skipWhenPushOnly } from "./deliverable.js";

/** The reason dismissApprovals carries to the host — also recorded on the rework result so it is inspectable. */
const DISMISS_REASON = "New commits pushed — the prior approval is for outdated code, re-review required.";

// ── The Sub-Phase ────────────────────────────────────────────────────────────
//
// create-pr opens the pull request, or — when the task already has one and is
// back here on a rework re-entry — pushes the rework onto it: dismiss the now-stale
// approval (push just ran) so the change is re-reviewed, mark the addressed feedback
// applied so it is not re-surfaced, and refresh the PR's title and body so they describe
// the whole PR as it now stands (gated on the diff-against-base digest so an unchanged
// re-push is a clean no-op). PR mode only; skips in push-only. A hard failure (no hosting
// plugin, no workspace, a failed createPR) throws, so the runner blocks it loud and
// operator-recoverable; the description refresh is best-effort and never blocks delivery.

const PHASE_DIR = "delivery";
const DELIVERABLE = "pr-description.md";
const TITLE_DELIVERABLE = "pr-title.md";

/** Strips a leading markdown heading marker so a title written as `# Foo` reads as `Foo`. */
const LEADING_HEADING = /^#\s+/;

/** Delivery: open the pull request, or push a rework onto the existing one. Skipped in push-only mode. */
export const createPr: SubPhase = {
  name: "create-pr",
  skip: skipWhenPushOnly,
  run: runCreatePr,
  next: createPrNext,
};

/** Once the PR exists (newly opened or rework-pushed), advance to await-review, which parks the task. */
export function createPrNext(): Route {
  return { go: "advance" };
}

// ── Running ──────────────────────────────────────────────────────────────────

// async so a guard surfaces as a rejected promise (run() never throws synchronously), and the awaited
// branch keeps the runner's try/catch the single place a create-pr failure becomes an orchestrator block.
async function runCreatePr(ctx: Ctx): Promise<SubPhaseResult> {
  const hosting = ctx.registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);
  if (!hosting) {
    throw new Error("Cannot create a pull request: no git hosting plugin is registered");
  }
  const record = ctx.workspaceManager.getWorkspaceRecord(ctx.task.id);
  if (!(ctx.worktreePath && record)) {
    throw new Error("Cannot create a pull request: the task has no workspace");
  }

  const existingPr = ctx.task.review?.pr_number;
  if (existingPr != null) {
    return await reworkExistingPr(ctx, hosting, record.repo, existingPr);
  }
  return await openNewPr(ctx, hosting, record);
}

/**
 * Rework path: the PR already exists and `push` just landed new commits. Dismiss the stale approval so
 * the rework is re-reviewed rather than merged on an outdated sign-off, refresh the PR's title and body
 * so they describe the whole PR as it now stands, and mark the feedback addressed so the next re-entry
 * does not re-surface it. Approval dismissal and the description refresh are both best-effort — neither
 * blocks delivery (the code is already pushed).
 */
async function reworkExistingPr(
  ctx: Ctx,
  hosting: GitHostingAdapter,
  repo: string,
  prNumber: number,
): Promise<SubPhaseResult> {
  const approvalDismissed = await dismissStaleApproval(ctx, hosting, repo, prNumber);
  const refresh = await refreshPrPresentation(ctx, hosting, repo, prNumber);

  if (ctx.task.review) {
    // One review write folds in both the feedback-applied update and the new presentation digest.
    // updatePR already ran (above), so a crash before this persist costs at most one redundant,
    // idempotent re-push next round — never a missed update.
    ctx.taskEngine.updateTaskField(ctx.task.id, "review", {
      ...ctx.task.review,
      feedback_rounds: ctx.task.review.feedback_rounds.map((round) => ({ ...round, applied: true })),
      presented_diff_digest: refresh.digest,
    });
  }

  ctx.notifications.notify({
    kind: NotificationKinds.ticket_comment,
    taskId: ctx.task.id,
    // Cause-neutral: reworkExistingPr is also reached by CI-fix and merge-conflict re-pushes, where
    // "addressing review feedback" would be wrong.
    message: "Pushed rework to the PR.",
  });
  ctx.observer.info("Rework pushed to existing PR", {
    taskId: ctx.task.id,
    prNumber,
    descriptionUpdated: refresh.updated,
  });
  return {
    outcome: "ok",
    summary: `Pushed rework to PR #${String(prNumber)}`,
    data: {
      approval_dismissed: approvalDismissed,
      description_updated: refresh.updated,
      description_refresh_reason: refresh.reason,
      reason: DISMISS_REASON,
    },
  };
}

/**
 * Refresh the open PR's title and body so they describe the whole PR as it now stands, gated on the
 * PR's substance. The pr-description sub-phase regenerates the presentation from an LLM every round,
 * so its prose churns even when nothing merge-relevant changed; keying change-detection on the prose
 * would push a spurious update on every no-op round. Instead we key on the diff-against-base digest:
 * when the diff is unchanged since the currently-shown presentation, the re-push is a clean no-op and
 * the host is left untouched.
 *
 * Best-effort and non-blocking, mirroring `dismissStaleApproval`: a failed host update never blocks
 * the rework and never advances the stored digest, so the next round retries. Returns the digest to
 * persist (the new one only when the host update landed) and whether the host presentation changed.
 */
async function refreshPrPresentation(
  ctx: Ctx,
  hosting: GitHostingAdapter,
  repo: string,
  prNumber: number,
): Promise<{ updated: boolean; digest: string | null; reason: string }> {
  const last = ctx.task.review?.presented_diff_digest ?? null;
  const current = ctx.workspaceManager.diffDigestAgainstBase(ctx.task.id);

  if (current == null) {
    ctx.observer.warn("Cannot verify PR substance — skipping description refresh", {
      taskId: ctx.task.id,
      prNumber,
    });
    return { updated: false, digest: last, reason: "digest_unavailable" };
  }
  if (current === last) {
    ctx.observer.info("PR substance unchanged since last description — skipping refresh", {
      taskId: ctx.task.id,
      prNumber,
    });
    return { updated: false, digest: last, reason: "unchanged" };
  }

  // A rework must not degrade a good published presentation. When a deliverable is absent or empty
  // we send null for that field ("leave the host value unchanged") rather than overwriting the live
  // value with a fallback: for the body that fallback is the `PR for: <title>` stub, and for the
  // title it is `ctx.task.title` — the *original task* title, the exact drift this feature exists to
  // prevent. Leaving them unchanged preserves whatever the deliverable produced at creation or a prior
  // round. Creation keeps the task-title fallback: PROptions.title is non-nullable and there is nothing
  // live to degrade when first opening.
  const titleDeliverable = readPrTitle(ctx);
  const title = titleDeliverable ? composePrTitle(titleDeliverable, ctx.task.external_ref) : null;
  const description = readPrDescription(ctx);
  const body = description ? composePrBody(sanitizeSecrets(description), ctx.task.external_ref) : null;

  const span = ctx.observer.startSpan(
    ObservationTypes.tool_execution,
    "update_pr_presentation",
    { repo, prNumber },
    traceScope(ctx),
  );
  try {
    await hosting.updatePR(repo, prNumber, {
      title,
      body,
      draft: null,
      labels_add: null,
      labels_remove: null,
    });
    span.end({ updated: true });
    return { updated: true, digest: current, reason: "changed" };
  } catch (error) {
    span.setError(error);
    span.end({ updated: false });
    ctx.observer.warn("Failed to refresh PR title/body after rework push — proceeding", {
      taskId: ctx.task.id,
      prNumber,
      error: sanitizeErrorMessage(error),
    });
    return { updated: false, digest: last, reason: "update_failed" };
  }
}

/**
 * Dismiss the stale approval inside a tool_execution span — best-effort, but recorded: the observer sees the
 * dismissal attempt, the PR it targeted, and whether it landed. A failure never blocks the rework; it returns
 * false so the result data records that the prior approval may still stand.
 */
async function dismissStaleApproval(
  ctx: Ctx,
  hosting: GitHostingAdapter,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  const span = ctx.observer.startSpan(
    ObservationTypes.tool_execution,
    "dismiss_approvals",
    { repo, prNumber },
    traceScope(ctx),
  );
  try {
    await hosting.dismissApprovals(repo, prNumber, DISMISS_REASON);
    span.end({ dismissed: true });
    return true;
  } catch (error) {
    span.setError(error);
    span.end({ dismissed: false });
    ctx.observer.warn("Failed to dismiss stale approvals after rework push — proceeding", {
      taskId: ctx.task.id,
      prNumber,
      error: sanitizeErrorMessage(error),
    });
    return false;
  }
}

/** New-PR path: compose the title and body from the description deliverable, open the PR, and record it on the task. */
async function openNewPr(ctx: Ctx, hosting: GitHostingAdapter, record: WorkspaceRecord): Promise<SubPhaseResult> {
  const description = sanitizeSecrets(readPrDescription(ctx) ?? `PR for: ${ctx.task.title}`);
  ctx.observer.info("Creating pull request", { taskId: ctx.task.id, repo: record.repo, branch: record.branch });

  // Opening the PR is delivery's central external action — span it so the observer sees the PR call, the
  // branch and base it targeted, and the PR number and url it produced (or the error that stopped it).
  const span = ctx.observer.startSpan(
    ObservationTypes.tool_execution,
    "create_pr",
    { repo: record.repo, branch: record.branch, base: record.baseBranch },
    traceScope(ctx),
  );
  let result: PRResult;
  try {
    result = await hosting.createPR({
      repo: record.repo,
      branch: record.branch,
      base: record.baseBranch,
      // Title is sourced from the same diff-derived deliverable as on rework, so the first re-push
      // does not spuriously rewrite an unchanged title (falls back to the task title when absent).
      title: composePrTitle(readPrTitle(ctx) ?? ctx.task.title, ctx.task.external_ref),
      body: composePrBody(description, ctx.task.external_ref),
      draft: false,
      labels: null,
      reviewers: null,
    });
  } catch (error) {
    span.setError(error);
    span.end({});
    throw error;
  }
  span.end({ pr_number: result.pr_number, url: result.url });

  ctx.taskEngine.updateTaskField(ctx.task.id, "review", {
    pr_number: result.pr_number,
    merged_at: null,
    feedback_rounds: [],
    accommodated_comment_ids: [],
    accommodated_review_state: null,
    // Baseline for change-detection: the digest of the diff this title/body were generated from, so
    // the first rework only re-pushes the presentation when the PR's substance has actually changed.
    presented_diff_digest: ctx.workspaceManager.diffDigestAgainstBase(ctx.task.id),
  });

  ctx.notifications.notify({
    kind: NotificationKinds.milestone,
    taskId: ctx.task.id,
    message: `PR created: ${result.url}`,
  });
  ctx.notifications.notify({
    kind: NotificationKinds.ticket_comment,
    taskId: ctx.task.id,
    message: `PR created: ${result.url}`,
  });
  ctx.observer.info("Pull request created", { taskId: ctx.task.id, prNumber: result.pr_number, url: result.url });
  return { outcome: "ok", summary: `Opened PR #${String(result.pr_number)}` };
}

/** Read the PR narrative the pr-description sub-phase wrote, or null when it is absent. */
function readPrDescription(ctx: Ctx): string | null {
  if (!(ctx.worktreePath && ctx.thoughtsDir)) {
    return null;
  }
  const file = path.join(ctx.worktreePath, ctx.thoughtsDir, PHASE_DIR, DELIVERABLE);
  if (!(existsSync(file) && statSync(file).isFile())) {
    return null;
  }
  return readFileSync(file, "utf-8").trim() || null;
}

/**
 * Read the diff-derived PR title the pr-description sub-phase wrote — its first non-empty line, with a
 * leading markdown "# " stripped — or null when the file is absent or empty. Callers fall back to the
 * task title so a missing deliverable never breaks PR creation or refresh.
 */
function readPrTitle(ctx: Ctx): string | null {
  if (!(ctx.worktreePath && ctx.thoughtsDir)) {
    return null;
  }
  const file = path.join(ctx.worktreePath, ctx.thoughtsDir, PHASE_DIR, TITLE_DELIVERABLE);
  if (!(existsSync(file) && statSync(file).isFile())) {
    return null;
  }
  const firstLine = readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(LEADING_HEADING, "") || null : null;
}

// ── PR Composition (pure) ──────────────────────────────────────────────────────

/**
 * Compose the final PR body: optional plugin decorations, a trigger reference, the agent's narrative,
 * and the branding footer. Deterministic — the agent writes the narrative, this wraps the structure.
 */
export function composePrBody(description: string, externalRef: ExternalRef | null): string {
  const decorations = externalRef?.pr_decorations;
  const parts: string[] = [];
  if (decorations?.description_prefix) {
    parts.push(decorations.description_prefix);
  }
  const triggerRef = formatTriggerReference(externalRef);
  if (triggerRef) {
    parts.push(triggerRef);
  }
  parts.push(description);
  if (decorations?.description_suffix) {
    parts.push(decorations.description_suffix);
  }
  parts.push("---\n*Crafted by The Engineer*");
  return parts.join("\n\n");
}

/** Compose the PR title from the task title plus any plugin-opaque decorations. */
export function composePrTitle(title: string, externalRef: ExternalRef | null): string {
  const decorations = externalRef?.pr_decorations;
  return [decorations?.title_prefix, sanitizeSecrets(title), decorations?.title_suffix]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/** A plugin-opaque trigger reference line (never inspects the ref type), or null when there is no ref. */
export function formatTriggerReference(externalRef: ExternalRef | null): string | null {
  if (!externalRef) {
    return null;
  }
  const label = `${externalRef.repo}#${externalRef.id}`;
  return externalRef.url ? `> Triggered by [${label}](${externalRef.url})` : `> Triggered by ${label}`;
}
