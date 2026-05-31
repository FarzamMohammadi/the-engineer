import type { Ctx, SkipReason } from "../types.js";

// ── The Deliverable ────────────────────────────────────────────────────────────
//
// The whole pipeline produces one of two deliverables, chosen by config:
//
//   - PR mode (default): a reviewed, merged pull request. The full delivery
//     sequence runs — describe, push, open the PR, wait for review, merge.
//   - Push-only mode (`skip_pr_creation`): a pushed branch and nothing more. Only
//     `push` runs; the PR-specific sub-phases skip and the task completes.
//
// Everything upstream of delivery is identical across both modes. Only delivery's
// shape differs, and it differs as skip-gates, not as a hardcoded branch — the
// second concrete use of the skip mechanism after trivial-skip.

/** Whether this task delivers push-only (no PR), honoring the per-repo override over the default. */
export function isPushOnly(ctx: Ctx): boolean {
  const config = ctx.workspaceConfig.pr.skip_pr_creation;
  const repo = ctx.task.workspace?.repo ?? ctx.task.repo;
  return repo ? (config.repos[repo] ?? config.default) : config.default;
}

/** Skip gate for the PR-specific delivery sub-phases — they do not run in push-only mode. */
export function skipWhenPushOnly(ctx: Ctx): SkipReason | null {
  return isPushOnly(ctx) ? "push-only mode (skip_pr_creation) — no pull request is created" : null;
}
