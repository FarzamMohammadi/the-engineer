import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { outreachDirForSubPhase } from "../../../../src/core/orchestrator/index.js";
import { responseCarry } from "../../../../src/core/orchestrator/index.js";
import { sendOutreach } from "../../../../src/core/orchestrator/outreach-sender.js";
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

// ── sendOutreach — the generalized delivery callee ─────────────────────────────
//
// deliverOutreach resolves the outreach directory per blocking sub-phase (above) and hands it to
// sendOutreach. These tests lock in that callee: a real outreach file in a non-requirements phase's
// directory is delivered as a `question`, falling back to the owner when the named person is unknown.

describe("sendOutreach delivers from any phase's outreach directory", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "outreach-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(people: { getPerson: () => unknown; getOwner: () => unknown }) {
    const notify = vi.fn();
    return {
      notify,
      sendDeps: {
        peopleDirectory: people as never,
        notifications: { notify } as never,
        observer: createTestObserverFacade("orchestrator"),
      },
    };
  }

  it("delivers an outreach file written under a non-requirements phase directory", async () => {
    const outreachDir = path.join(root, "execution", "outreach");
    mkdirSync(outreachDir, { recursive: true });
    writeFileSync(path.join(outreachDir, "owner.txt"), "Which DB driver should I use?", "utf-8");

    const owner = mockOwner();
    const { notify, sendDeps } = deps({ getPerson: () => owner, getOwner: () => owner });

    const result = await sendOutreach("task-99", outreachDir, null, sendDeps);

    expect(result.delivered).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.question, personId: "owner", taskId: "task-99" }),
    );
  });

  it("reports no_files when the asking phase wrote no outreach (the synthesized-question fallback path)", async () => {
    const owner = mockOwner();
    const { sendDeps } = deps({ getPerson: () => owner, getOwner: () => owner });

    const result = await sendOutreach("task-99", path.join(root, "execution", "outreach"), null, sendDeps);

    expect(result).toEqual({ delivered: false, reason: "no_files" });
  });
});
