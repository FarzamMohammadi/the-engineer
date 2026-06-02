import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { autoMerge, autoMergeNext } from "../../../../../../src/core/orchestrator/pipeline/delivery/auto-merge.js";
import {
  awaitReview,
  awaitReviewNext,
} from "../../../../../../src/core/orchestrator/pipeline/delivery/await-review.js";
import { createPr, createPrNext } from "../../../../../../src/core/orchestrator/pipeline/delivery/create-pr.js";
import { isPushOnly, skipWhenPushOnly } from "../../../../../../src/core/orchestrator/pipeline/delivery/deliverable.js";
import {
  prDescription,
  prDescriptionNext,
} from "../../../../../../src/core/orchestrator/pipeline/delivery/pr-description.js";
import { push, pushNext } from "../../../../../../src/core/orchestrator/pipeline/delivery/push.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import { ObservationTypes } from "../../../../../../src/schemas/observer.js";
import { createRecordingObserver } from "../../../../../helpers/test-mock-pipeline.js";
import type { TestWorkspaceManagerHandle } from "../../../../../helpers/test-workspace-manager.js";
import { createTestWorkspaceManager } from "../../../../../helpers/test-workspace-manager.js";

/** A minimal ctx carrying only the skip_pr_creation config and the repo the deliverable resolution reads. */
function ctxWith(skip: { default: boolean; repos?: Record<string, boolean> }, repo: string | null = "acme/app"): Ctx {
  return {
    workspaceConfig: { pr: { skip_pr_creation: { default: skip.default, repos: skip.repos ?? {} } } },
    task: { repo, workspace: null },
  } as unknown as Ctx;
}

const PR_MODE = ctxWith({ default: false });
const PUSH_ONLY = ctxWith({ default: true });

describe("delivery", () => {
  describe("the deliverable mode", () => {
    it("is PR mode by default", () => {
      expect(isPushOnly(PR_MODE)).toBe(false);
    });

    it("is push-only when skip_pr_creation defaults true", () => {
      expect(isPushOnly(PUSH_ONLY)).toBe(true);
    });

    it("lets a per-repo override beat the default in both directions", () => {
      expect(isPushOnly(ctxWith({ default: false, repos: { "acme/app": true } }))).toBe(true);
      expect(isPushOnly(ctxWith({ default: true, repos: { "acme/app": false } }))).toBe(false);
    });

    it("falls back to the default when the task has no repo to look up", () => {
      expect(isPushOnly(ctxWith({ default: true, repos: { "acme/app": false } }, null))).toBe(true);
    });
  });

  describe("skip-gates collapse delivery to push in push-only mode", () => {
    it("runs push in both modes — it is the push-only deliverable", () => {
      expect(push.skip).toBeUndefined();
    });

    it("runs the PR-specific sub-phases in PR mode", () => {
      for (const sub of [prDescription, createPr, awaitReview, autoMerge]) {
        expect(sub.skip?.(PR_MODE)).toBeNull();
      }
    });

    it("skips the PR-specific sub-phases in push-only mode", () => {
      for (const sub of [prDescription, createPr, awaitReview, autoMerge]) {
        expect(sub.skip?.(PUSH_ONLY)).toContain("push-only");
      }
    });

    it("reports PR mode as not skipped via skipWhenPushOnly", () => {
      expect(skipWhenPushOnly(PR_MODE)).toBeNull();
    });
  });

  describe("routing", () => {
    it("advances from pr-description once the narrative is written", () => {
      expect(prDescriptionNext({ outcome: "ok", summary: "written" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when pr-description is missing context", () => {
      expect(prDescriptionNext({ outcome: "needs_human", summary: "which issue?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });

    it("advances from push and create-pr", () => {
      expect(pushNext()).toEqual({ go: "advance" });
      expect(createPrNext()).toEqual({ go: "advance" });
    });

    it("parks the task on its PR with an awaiting_pr_review block", () => {
      expect(awaitReviewNext()).toMatchObject({ go: "block", category: "awaiting_pr_review" });
    });

    it("completes the task once auto-merge has merged", () => {
      expect(autoMergeNext({ outcome: "ok", summary: "merged", data: { disposition: "merged" } })).toEqual({
        go: "done",
      });
    });
  });

  describe("push run", () => {
    let handle: TestWorkspaceManagerHandle | undefined;

    afterEach(() => {
      handle?.cleanup();
      handle = undefined;
    });

    /** Stand up a real worktree with one branch-added commit so runPush reaches the actual push. */
    function pushCtx(): { ctx: Ctx; observer: ReturnType<typeof createRecordingObserver>; branch: string } {
      const h = createTestWorkspaceManager();
      handle = h;
      h.setupTask("t1", { title: "Add feature" });
      const record = h.workspaceManager.createWorkspace("t1", h.repoName, { title: "Add feature" });
      // A real commit ahead of base, so hasCommitsAheadOfBase is true and the push runs.
      writeFileSync(join(record.worktreePath, "feature.txt"), "feature\n");
      execSync("git add -A && git commit -m 'feat: add feature'", {
        cwd: record.worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
      });
      const observer = createRecordingObserver();
      const ctx = {
        observer,
        workspaceManager: h.workspaceManager,
        worktreePath: record.worktreePath,
        task: { id: "t1", title: "Add feature", review: null },
      } as unknown as Ctx;
      return { ctx, observer, branch: record.branch };
    }

    it("spans the branch push as a tool_execution carrying the branch it pushed", async () => {
      const { ctx, observer, branch } = pushCtx();

      const result = await push.run(ctx);

      expect(result.outcome).toBe("ok");
      const span = observer.spans.find((s) => s.name === "git_push");
      expect(span?.type).toBe(ObservationTypes.tool_execution);
      expect(span?.input).toMatchObject({ branch, repo: "test-repo" });
      expect(span?.output).toMatchObject({ pushed: true, branch });
      expect(span?.errored).toBeFalsy();
    });

    it("ends the git_push span errored when the push fails, then rethrows", async () => {
      const { ctx, observer, branch } = pushCtx();
      // Force the push to fail by pointing the workspace manager at a missing remote.
      (ctx.workspaceManager as { pushBranch: (id: string) => void }).pushBranch = () => {
        throw new Error("remote rejected");
      };

      // runPush is synchronous and rethrows, so push.run throws before producing a promise; await the call
      // wrapped so either a sync throw or a rejection is caught.
      await expect(Promise.resolve().then(() => push.run(ctx))).rejects.toThrow(`Cannot push branch "${branch}"`);

      const span = observer.spans.find((s) => s.name === "git_push");
      expect(span?.errored).toBe(true);
      expect(span?.output).toMatchObject({ pushed: false });
    });
  });
});
