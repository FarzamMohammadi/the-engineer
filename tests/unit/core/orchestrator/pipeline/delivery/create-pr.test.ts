import { describe, expect, it, vi } from "vitest";

import {
  composePrBody,
  composePrTitle,
  createPr,
  formatTriggerReference,
} from "../../../../../../src/core/orchestrator/pipeline/delivery/create-pr.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import type { ExternalRef, ReviewState } from "../../../../../../src/schemas/task.js";

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
}

function mockCtx(options: MockCtxOptions = {}) {
  const createPR = vi.fn().mockResolvedValue({ pr_number: 42, url: "https://x/42" });
  const dismissApprovals = vi.fn().mockResolvedValue(undefined);
  const updateTaskField = vi.fn();
  const notify = vi.fn();
  const hosting = options.hosting === false ? null : { createPR, dismissApprovals };
  const ctx = {
    registry: { getPrimaryPlugin: (type: string) => (type === "git_hosting" ? hosting : null) },
    workspaceManager: {
      getWorkspaceRecord: () => ({ repo: "acme/app", branch: "feat/x", baseBranch: "main", thoughtsDir: "thoughts/x" }),
    },
    worktreePath: "/tmp/the-engineer-test-no-such-worktree",
    thoughtsDir: "thoughts/x",
    taskEngine: { updateTaskField },
    notifications: { notify },
    observer: { info: vi.fn(), warn: vi.fn() },
    task: {
      id: "t1",
      title: "Add feature",
      external_ref: ref({ url: "https://x/42" }),
      review: options.review ?? null,
    },
  } as unknown as Ctx;
  return { ctx, createPR, dismissApprovals, updateTaskField, notify };
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
      expect.objectContaining({ pr_number: 42, feedback_rounds: [] }),
    );
    expect(notify).toHaveBeenCalled();
  });

  it("on rework dismisses the stale approval, marks feedback applied, and opens no new PR", async () => {
    const { ctx, createPR, dismissApprovals, updateTaskField } = mockCtx({
      review: {
        pr_number: 7,
        merged_at: null,
        feedback_rounds: [{ applied: false, comments: ["fix it"] }],
        accommodated_comment_ids: [],
        accommodated_review_state: null,
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
});
