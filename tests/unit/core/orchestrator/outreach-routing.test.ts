import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { outreachDirForSubPhase } from "../../../../src/core/orchestrator/index.js";
import { responseCarry } from "../../../../src/core/orchestrator/index.js";
import { type QuestionDelivery, deliverBlockedQuestion } from "../../../../src/core/orchestrator/outreach.js";
import { buildCarrySection } from "../../../../src/core/orchestrator/pipeline/agent-prompt.js";
import type { Ctx } from "../../../../src/core/orchestrator/pipeline/types.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { mockOwner } from "../../../helpers/test-mock-pipeline.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

// ── outreachDirForSubPhase — forward outreach beyond requirements ───────────────
//
// The regression this guards: before S4 the orchestrator hardcoded `requirements/outreach`, so a
// `needs_human` (or an autonomy escalation) from ANY non-requirements phase blocked with no question
// delivered. Now the outreach directory is resolved from the BLOCKING sub-phase's own `resultDir`, so
// every phase's ask delivers — including review's nested `review/<lens>` layout.

/** A Ctx with just the fields resultDir reads (worktree + thoughts dir). */
function ctxWith(worktreePath: string | null, thoughtsDir: string | null): Ctx {
  return { worktreePath, thoughtsDir, task: { id: "task-1" } } as unknown as Ctx;
}

describe("outreachDirForSubPhase", () => {
  const ctx = ctxWith("/work", "thoughts");

  it("resolves requirements' outreach directory from the gather sub-phase", () => {
    expect(outreachDirForSubPhase(ctx, "gather")).toBe(path.join("/work", "thoughts", "requirements", "outreach"));
  });

  it("resolves a non-requirements phase's outreach directory from its sub-phase", () => {
    expect(outreachDirForSubPhase(ctx, "investigate")).toBe(path.join("/work", "thoughts", "research", "outreach"));
    expect(outreachDirForSubPhase(ctx, "design")).toBe(path.join("/work", "thoughts", "planning", "outreach"));
    expect(outreachDirForSubPhase(ctx, "implement")).toBe(path.join("/work", "thoughts", "execution", "outreach"));
    expect(outreachDirForSubPhase(ctx, "pr-description")).toBe(path.join("/work", "thoughts", "delivery", "outreach"));
  });

  it("resolves review's nested per-lens layout, not a flat review/outreach", () => {
    expect(outreachDirForSubPhase(ctx, "refine")).toBe(path.join("/work", "thoughts", "review", "refine", "outreach"));
    expect(outreachDirForSubPhase(ctx, "security")).toBe(
      path.join("/work", "thoughts", "review", "security", "outreach"),
    );
  });

  it("returns null for an orchestrator sub-phase that writes no deliverable", () => {
    // verify runs the project's gates; it has no agent deliverable and so no outreach directory.
    expect(outreachDirForSubPhase(ctx, "verify")).toBeNull();
  });

  it("returns null for an unknown sub-phase name", () => {
    expect(outreachDirForSubPhase(ctx, "not-a-real-sub-phase")).toBeNull();
  });
});

// ── Answer return into a non-requirements phase ────────────────────────────────
//
// 68a7 already carries the owner's answer back via resolveResponse → responseCarry → ResumeState.carry,
// and the runner seeds it as ctx.carry on the resumed sub-phase. The resumed sub-phase's prompt renders
// that carry through buildCarrySection — the same path requirements uses — so the answer reaches the
// agent on resume regardless of WHICH phase asked. This asserts the rendered prompt contains the reply.

describe("answer return on resume renders the owner's reply for any phase", () => {
  it("buildCarrySection renders the owner's answer carried by responseCarry", () => {
    const carry = responseCarry("use the existing AuthService, do not add a new dependency");
    const ctx = { carry } as unknown as Ctx;

    const rendered = buildCarrySection(ctx);

    expect(rendered).not.toBeNull();
    expect(rendered).toContain("use the existing AuthService, do not add a new dependency");
  });
});

// ── deliverBlockedQuestion — the unified outreach delivery ─────────────────────
//
// blockTask resolves the blocking sub-phase's outreach directory (above) and hands it to
// deliverBlockedQuestion — the single path for both an agent-written question and a synthesized autonomy
// decision. These tests lock in: the same canonical text reaches BOTH the owner's chat and the source
// ticket; the synthesized `needed` is used when the sub-phase wrote no file; the file is consumed on read
// so a later block cannot re-send a stale ask; and a missing owner still posts to the ticket.

describe("deliverBlockedQuestion delivers one canonical question to every surface", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "outreach-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(getOwner: () => unknown): { notify: ReturnType<typeof vi.fn>; delivery: QuestionDelivery } {
    const notify = vi.fn();
    return {
      notify,
      delivery: {
        peopleDirectory: { getPerson: () => null, getOwner } as never,
        notifications: { notify } as never,
        observer: createTestObserverFacade("orchestrator"),
      },
    };
  }

  function messagesFrom(notify: ReturnType<typeof vi.fn>): string[] {
    return notify.mock.calls.map((call) => (call[0] as { message: string }).message);
  }

  it("delivers an agent-written outreach file to BOTH the owner's chat and the source ticket", () => {
    const outreachDir = path.join(root, "execution", "outreach");
    mkdirSync(outreachDir, { recursive: true });
    writeFileSync(path.join(outreachDir, "owner.txt"), "Which DB driver should I use?", "utf-8");
    const { notify, delivery } = deps(() => mockOwner());

    const question = deliverBlockedQuestion(delivery, {
      taskId: "task-99",
      subPhase: "implement",
      outreachDir,
      needed: "fallback that must not be used",
    });

    expect(question).toBe("Which DB driver should I use?");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.question, personId: "owner", taskId: "task-99" }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.ticket_comment, taskId: "task-99" }),
    );
    // Same canonical text on both surfaces — no divergence.
    expect(messagesFrom(notify).every((m) => m.includes("Which DB driver should I use?"))).toBe(true);
  });

  it("falls back to the synthesized `needed` when the sub-phase wrote no outreach file", () => {
    const { notify, delivery } = deps(() => mockOwner());

    const question = deliverBlockedQuestion(delivery, {
      taskId: "task-99",
      subPhase: "gather",
      outreachDir: path.join(root, "requirements", "outreach"),
      needed: "Confirm the scope_expansion decision",
    });

    expect(question).toBe("Confirm the scope_expansion decision");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.question, personId: "owner" }),
    );
  });

  it("consumes the outreach file so a later block uses the synthesized question, not the stale file", () => {
    const outreachDir = path.join(root, "requirements", "outreach");
    mkdirSync(outreachDir, { recursive: true });
    const file = path.join(outreachDir, "owner.txt");
    writeFileSync(file, "Original gather question", "utf-8");
    const { delivery } = deps(() => mockOwner());

    // First block: the agent's file is the question...
    const first = deliverBlockedQuestion(delivery, { taskId: "t", subPhase: "gather", outreachDir, needed: "unused" });
    expect(first).toBe("Original gather question");
    expect(existsSync(file)).toBe(false); // ...and it is consumed.

    // Resume surfaces an autonomy decision (synthesized, no new file): the decision wins, not the stale file.
    const second = deliverBlockedQuestion(delivery, {
      taskId: "t",
      subPhase: "gather",
      outreachDir,
      needed: "Confirm the scope_expansion decision",
    });
    expect(second).toBe("Confirm the scope_expansion decision");
  });

  it("posts to the ticket but warns instead of DMing when no owner is configured", () => {
    const { notify, delivery } = deps(() => null);
    const warn = vi.spyOn(delivery.observer, "warn");

    const question = deliverBlockedQuestion(delivery, {
      taskId: "task-99",
      subPhase: "gather",
      outreachDir: null,
      needed: "Need a decision",
    });

    expect(question).toBe("Need a decision");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: NotificationKinds.ticket_comment }));
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: NotificationKinds.question }));
    expect(warn).toHaveBeenCalled();
  });
});
