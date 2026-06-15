import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composePrBody,
  composePrTitle,
  createPr,
  formatTriggerReference,
} from "../../../../../../src/core/orchestrator/pipeline/delivery/create-pr.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import { ObservationTypes } from "../../../../../../src/schemas/observer.js";
import type { ExternalRef, ReviewState } from "../../../../../../src/schemas/task.js";
import { createRecordingObserver } from "../../../../../helpers/test-mock-pipeline.js";

const ref = (over: Partial<ExternalRef> = {}): ExternalRef => ({ type: "issue", repo: "acme/app", id: "42", ...over });

// ── Pure Composition ───────────────────────────────────────────────────────────

describe("create-pr composition", () => {
  describe("formatTriggerReference", () => {
    it("links the reference when it carries a url", () => {
      expect(formatTriggerReference(ref({ url: "https://x/42" }))).toBe("> Triggered by [acme/app#42](https://x/42)");
    });

    it("is a plain reference with no url", () => {
      expect(formatTriggerReference(ref())).toBe("> Triggered by acme/app#42");
    });

    it("is null when there is no reference", () => {
      expect(formatTriggerReference(null)).toBeNull();
    });
  });

  describe("composePrBody", () => {
    it("wraps the narrative with a trigger reference and the branding footer", () => {
      const body = composePrBody("Did the thing", ref({ url: "https://x/42" }));
      expect(body).toContain("> Triggered by [acme/app#42](https://x/42)");
      expect(body).toContain("Did the thing");
      expect(body).toContain("Crafted by The Engineer");
    });

    it("applies plugin description decorations in order", () => {
      const body = composePrBody(
        "body",
        ref({ pr_decorations: { description_prefix: "PRE", description_suffix: "SUF" } }),
      );
      expect(body.indexOf("PRE")).toBeLessThan(body.indexOf("body"));
      expect(body.indexOf("body")).toBeLessThan(body.indexOf("SUF"));
    });
  });

  describe("composePrTitle", () => {
    it("applies prefix and suffix decorations around the title", () => {
      expect(composePrTitle("Title", ref({ pr_decorations: { title_prefix: "#1:", title_suffix: "[x]" } }))).toBe(
        "#1: Title [x]",
      );
    });

    it("is just the title when there are no decorations", () => {
      expect(composePrTitle("Title", null)).toBe("Title");
    });
  });
});

// ── Run Paths ────────────────────────────────────────────────────────────────

interface MockCtxOptions {
  readonly review?: ReviewState | null;
  readonly hosting?: boolean;
  /** What `workspaceManager.diffDigestAgainstBase` returns — the PR's current substance signal. */
  readonly diffDigest?: string | null;
  /** Override the worktree root — point it at a real temp dir to exercise the deliverable reads. */
  readonly worktreePath?: string;
}

// Real temp worktrees created by `worktreeWithDeliverables`, removed after each test.
const tempWorktrees: string[] = [];

afterEach(() => {
  for (const dir of tempWorktrees.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Stand up a real temp worktree holding the diff-derived deliverables the pr-description sub-phase
 * writes (`thoughts/x/delivery/pr-title.md` + `pr-description.md`), so a test exercises the real
 * readPrTitle/readPrDescription path instead of the absent-file fallback. The thoughtsDir matches
 * mockCtx's `thoughts/x`.
 */
function worktreeWithDeliverables(deliverables: { title?: string; description?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "create-pr-"));
  tempWorktrees.push(dir);
  const deliveryDir = join(dir, "thoughts/x/delivery");
  mkdirSync(deliveryDir, { recursive: true });
  if (deliverables.title !== undefined) {
    writeFileSync(join(deliveryDir, "pr-title.md"), deliverables.title);
  }
  if (deliverables.description !== undefined) {
    writeFileSync(join(deliveryDir, "pr-description.md"), deliverables.description);
  }
  return dir;
}

function mockCtx(options: MockCtxOptions = {}) {
  const createPR = vi.fn().mockResolvedValue({ pr_number: 42, url: "https://x/42" });
  const dismissApprovals = vi.fn().mockResolvedValue(undefined);
  const updatePR = vi.fn().mockResolvedValue(undefined);
  const updateTaskField = vi.fn();
  const notify = vi.fn();
  const observer = createRecordingObserver();
  const diffDigestAgainstBase = vi
    .fn()
    .mockReturnValue(options.diffDigest === undefined ? "digest-default" : options.diffDigest);
  const hosting = options.hosting === false ? null : { createPR, dismissApprovals, updatePR };
  const ctx = {
    registry: { getPrimaryPlugin: (type: string) => (type === "git_hosting" ? hosting : null) },
    workspaceManager: {
      getWorkspaceRecord: () => ({ repo: "acme/app", branch: "feat/x", baseBranch: "main", thoughtsDir: "thoughts/x" }),
      diffDigestAgainstBase,
    },
    worktreePath: options.worktreePath ?? "/tmp/the-engineer-test-no-such-worktree",
    thoughtsDir: "thoughts/x",
    taskEngine: { updateTaskField },
    notifications: { notify },
    observer,
    task: {
      id: "t1",
      title: "Add feature",
      external_ref: ref({ url: "https://x/42" }),
      review: options.review ?? null,
    },
  } as unknown as Ctx;
  return { ctx, createPR, dismissApprovals, updatePR, updateTaskField, notify, observer, diffDigestAgainstBase };
}

/** A ReviewState for an open PR awaiting rework, with an overridable last-presented digest. */
function reworkReview(over: Partial<ReviewState> = {}): ReviewState {
  return {
    pr_number: 7,
    merged_at: null,
    feedback_rounds: [{ applied: false, comments: ["fix it"] }],
    accommodated_comment_ids: [],
    accommodated_review_state: null,
    consecutive_blocker_reentries: 0,
    ...over,
  };
}

describe("create-pr run", () => {
  it("opens a PR against the workspace branch and records it on the task", async () => {
    const { ctx, createPR, updateTaskField, notify } = mockCtx({ review: null });

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    expect(createPR).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/app", branch: "feat/x", base: "main", draft: false }),
    );
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ pr_number: 42, feedback_rounds: [], presented_diff_digest: "digest-default" }),
    );
    expect(notify).toHaveBeenCalled();
  });

  it("opens the PR with the diff-derived title and narrative body from the deliverables", async () => {
    // Real deliverables in a real worktree so readPrTitle/readPrDescription return their content,
    // not the fallback. The title is distinct from ctx.task.title ("Add feature") and the body
    // carries a unique narrative sentinel (not the shared footer), so this fails if the reads are gone.
    const worktreePath = worktreeWithDeliverables({
      title: "Refresh PR presentation on rework",
      description: "Regenerated from the full diff.",
    });
    const { ctx, createPR } = mockCtx({ review: null, worktreePath });

    await createPr.run(ctx);

    expect(createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Refresh PR presentation on rework",
        body: expect.stringContaining("Regenerated from the full diff."),
      }),
    );
  });

  it("on rework dismisses the stale approval, marks feedback applied, and opens no new PR", async () => {
    const { ctx, createPR, dismissApprovals, updateTaskField } = mockCtx({
      review: {
        pr_number: 7,
        merged_at: null,
        feedback_rounds: [{ applied: false, comments: ["fix it"] }],
        accommodated_comment_ids: [],
        accommodated_review_state: null,
        consecutive_blocker_reentries: 0,
      },
    });

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    expect(createPR).not.toHaveBeenCalled();
    expect(dismissApprovals).toHaveBeenCalledWith("acme/app", 7, expect.any(String));
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ feedback_rounds: [expect.objectContaining({ applied: true })] }),
    );
  });

  it("throws so the runner blocks when no git hosting plugin is registered", async () => {
    const { ctx } = mockCtx({ hosting: false });
    await expect(createPr.run(ctx)).rejects.toThrow("no git hosting plugin");
  });

  it("spans the PR creation as a tool_execution carrying the resulting pr_number and url", async () => {
    const { ctx, observer } = mockCtx({ review: null });

    await createPr.run(ctx);

    const span = observer.spans.find((s) => s.name === "create_pr");
    expect(span?.type).toBe(ObservationTypes.tool_execution);
    expect(span?.input).toMatchObject({ repo: "acme/app", branch: "feat/x", base: "main" });
    expect(span?.output).toMatchObject({ pr_number: 42, url: "https://x/42" });
    expect(span?.errored).toBeFalsy();
  });

  it("ends the create_pr span errored when the host rejects the PR", async () => {
    const { ctx, createPR, observer } = mockCtx({ review: null });
    createPR.mockRejectedValueOnce(new Error("host down"));

    await expect(createPr.run(ctx)).rejects.toThrow("host down");

    const span = observer.spans.find((s) => s.name === "create_pr");
    expect(span?.errored).toBe(true);
  });

  it("spans the approval dismissal on rework and records the dismissal on the result data", async () => {
    const { ctx, dismissApprovals, observer } = mockCtx({
      review: {
        pr_number: 7,
        merged_at: null,
        feedback_rounds: [{ applied: false, comments: ["fix it"] }],
        accommodated_comment_ids: [],
        accommodated_review_state: null,
        consecutive_blocker_reentries: 0,
      },
    });

    const result = await createPr.run(ctx);

    expect(dismissApprovals).toHaveBeenCalled();
    const span = observer.spans.find((s) => s.name === "dismiss_approvals");
    expect(span?.type).toBe(ObservationTypes.tool_execution);
    expect(span?.output).toMatchObject({ dismissed: true });
    expect(result.outcome).toBe("ok");
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({ approval_dismissed: true });
  });

  it("on rework with changed substance pushes the diff-derived title and narrative body", async () => {
    // Real deliverables: updatePR must carry the diff-derived title (distinct from ctx.task.title)
    // and the composed narrative — this fails if readPrTitle/readPrDescription are removed.
    const worktreePath = worktreeWithDeliverables({
      title: "Refresh PR presentation on rework",
      description: "Regenerated from the full diff.",
    });
    const { ctx, updatePR, updateTaskField } = mockCtx({
      review: reworkReview({ presented_diff_digest: "old-digest" }),
      diffDigest: "new-digest",
      worktreePath,
    });

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    expect(updatePR).toHaveBeenCalledTimes(1);
    expect(updatePR).toHaveBeenCalledWith(
      "acme/app",
      7,
      expect.objectContaining({
        title: "Refresh PR presentation on rework",
        body: expect.stringContaining("Regenerated from the full diff."),
        draft: null,
      }),
    );
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ presented_diff_digest: "new-digest" }),
    );
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({ description_updated: true });
  });

  it("on rework with changed substance but no deliverable leaves the live body in place", async () => {
    // No deliverable on disk: the body must be null ("leave the host body unchanged") rather than the
    // `PR for: <title>` stub, so a rework never degrades a rich body written at creation. The title
    // still refreshes (its fallback reproduces the live title) and the digest still advances.
    const { ctx, updatePR, updateTaskField, notify } = mockCtx({
      review: reworkReview({ presented_diff_digest: "old-digest" }),
      diffDigest: "new-digest",
    });

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    expect(updatePR).toHaveBeenCalledTimes(1);
    expect(updatePR).toHaveBeenCalledWith(
      "acme/app",
      7,
      expect.objectContaining({ title: "Add feature", body: null, draft: null }),
    );
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ presented_diff_digest: "new-digest" }),
    );
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({ description_updated: true });
    // The rework notification is cause-neutral — it no longer claims "addressing review feedback".
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Pushed rework to the PR." }));
  });

  it("on rework with unchanged substance leaves the host untouched and preserves the digest", async () => {
    const { ctx, updatePR, dismissApprovals, updateTaskField } = mockCtx({
      review: reworkReview({ presented_diff_digest: "same-digest" }),
      diffDigest: "same-digest",
    });

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    expect(updatePR).not.toHaveBeenCalled();
    // The no-op falls out of the digest gate — approval dismissal and feedback-applied still happen.
    expect(dismissApprovals).toHaveBeenCalled();
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({
        presented_diff_digest: "same-digest",
        feedback_rounds: [expect.objectContaining({ applied: true })],
      }),
    );
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({ description_updated: false });
  });

  it("on rework skips the refresh when the diff digest cannot be computed", async () => {
    const { ctx, updatePR, updateTaskField } = mockCtx({
      review: reworkReview({ presented_diff_digest: "old-digest" }),
      diffDigest: null,
    });

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    expect(updatePR).not.toHaveBeenCalled();
    // The stored digest is preserved (not advanced to null) so a later round can still detect change.
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ presented_diff_digest: "old-digest" }),
    );
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({ description_updated: false });
  });

  it("on rework keeps delivery green and does not advance the digest when updatePR fails", async () => {
    const { ctx, updatePR, updateTaskField, observer } = mockCtx({
      review: reworkReview({ presented_diff_digest: "old-digest" }),
      diffDigest: "new-digest",
    });
    updatePR.mockRejectedValueOnce(new Error("host down"));

    const result = await createPr.run(ctx);

    expect(result.outcome).toBe("ok");
    const span = observer.spans.find((s) => s.name === "update_pr_presentation");
    expect(span?.type).toBe(ObservationTypes.tool_execution);
    expect(span?.errored).toBe(true);
    expect(updateTaskField).toHaveBeenCalledWith(
      "t1",
      "review",
      expect.objectContaining({ presented_diff_digest: "old-digest" }),
    );
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({ description_updated: false });
  });
});
