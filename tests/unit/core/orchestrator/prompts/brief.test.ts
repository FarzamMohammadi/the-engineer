import { describe, expect, it } from "vitest";
import type { z } from "zod";

import type { Ctx } from "../../../../../src/core/orchestrator/pipeline/types.js";
import { composeBrief } from "../../../../../src/core/orchestrator/prompts/brief.js";
import { MY_ASSIGNMENT } from "../../../../../src/core/orchestrator/prompts/self-model/index.js";
import type { Person } from "../../../../../src/schemas/adapters.js";
import { SafetyConfigSchema, WorkspaceConfigSchema } from "../../../../../src/schemas/config.js";

// ── Harness ────────────────────────────────────────────────────────────────────
//
// composeBrief reads a narrow slice of Ctx — the people directory's owner, the safety
// config, the workspace config, and the task's repo. We build exactly that slice so each
// test drives one real setting and asserts the live value lands in the rendered brief.

interface BriefCtxOptions {
  readonly owner?: Person | null;
  // The schema INPUT types (pre-default), so a test can pass a deep-partial config — every nested
  // field is optional and filled by the schema's `.default()`s when `parse` runs.
  readonly safety?: z.input<typeof SafetyConfigSchema>;
  readonly workspace?: z.input<typeof WorkspaceConfigSchema>;
  readonly repo?: string | null;
}

function briefCtx(options: BriefCtxOptions = {}): Ctx {
  const owner = options.owner === undefined ? defaultOwner() : options.owner;
  return {
    peopleDirectory: { getOwner: () => owner },
    safetyConfig: SafetyConfigSchema.parse(options.safety ?? {}),
    workspaceConfig: WorkspaceConfigSchema.parse(options.workspace ?? {}),
    task: { repo: options.repo === undefined ? "acme/app" : options.repo },
  } as unknown as Ctx;
}

function defaultOwner(): Person {
  return {
    id: "farzam",
    name: "Farzam",
    roles: ["owner"],
    contacts: [{ channel: "telegram", handle: "@farzam" }],
  };
}

// ── Static framing preserved ─────────────────────────────────────────────────────

describe("composeBrief", () => {
  it("keeps the static MY_ASSIGNMENT framing verbatim, then appends the live setup", () => {
    const brief = composeBrief(briefCtx());
    // The whole static brief is preserved — composeBrief fills placeholders by APPENDING a live
    // section, it never rewrites the framing doc.
    expect(brief).toContain(MY_ASSIGNMENT);
    expect(brief).toContain("How I am actually set up");
    expect(brief.indexOf(MY_ASSIGNMENT)).toBeLessThan(brief.indexOf("How I am actually set up"));
  });

  // ── Who I answer to ──────────────────────────────────────────────────────────

  it("renders the owner by name with each contact channel and handle", () => {
    const owner: Person = {
      id: "farzam",
      name: "Farzam",
      roles: ["owner"],
      contacts: [
        { channel: "telegram", handle: "@farzam" },
        { channel: "email", handle: "farzam@example.com" },
      ],
    };
    const brief = composeBrief(briefCtx({ owner }));
    expect(brief).toContain("Farzam");
    expect(brief).toContain("telegram (@farzam)");
    expect(brief).toContain("email (farzam@example.com)");
  });

  it("renders the degraded no-owner stance naming the consequence, without throwing or blanking", () => {
    let brief = "";
    expect(() => {
      brief = composeBrief(briefCtx({ owner: null }));
    }).not.toThrow();
    expect(brief).toContain("no named owner");
    // The consequence must be named — not a silent gap.
    expect(brief).toContain("cannot reach anyone when I am blocked");
    expect(brief).toContain("cannot get a decision");
    expect(brief).toContain("hand off context");
    // Never a blank where a value belongs.
    expect(brief).not.toContain("How I am actually set up\n\n\n");
  });

  // ── Autonomy buckets ─────────────────────────────────────────────────────────

  it("groups autonomy into the three buckets with the threshold count surfaced", () => {
    const brief = composeBrief(briefCtx());
    // always_decide -> decide alone
    expect(brief).toContain("I decide these alone");
    expect(brief).toContain("code_style");
    // threshold -> decide up to a point, count included from the policy's threshold string
    expect(brief).toContain("I decide these up to a point, then check first");
    expect(brief).toContain("scope_expansion");
    expect(brief).toContain("up to files > 5, then I check first");
    // always_ask -> always check first
    expect(brief).toContain("I always check first on these");
    expect(brief).toContain("architecture");
    expect(brief).toContain("security");
    // the fail-safe default for unknown categories
    expect(brief).toContain("Anything that fits none of these I treat as check-first");
  });

  it("resolves per-repo autonomy overrides against the task's repo so it reads for THIS repo", () => {
    const brief = composeBrief(
      briefCtx({
        repo: "acme/crown-jewels",
        safety: {
          autonomy: {
            repo_overrides: {
              "acme/crown-jewels": {
                // Tighten code_style on the crown-jewels repo: normally decide-alone, here always-ask.
                decisions: { code_style: { level: "always_ask" } },
              },
            },
          },
        },
      }),
    );
    expect(brief).toContain("acme/crown-jewels");
    // code_style moved from the decide-alone bucket into the always-ask bucket for THIS repo.
    const decideAloneIdx = brief.indexOf("I decide these alone");
    const alwaysAskIdx = brief.indexOf("I always check first on these");
    const codeStyleIdx = brief.indexOf("code_style");
    expect(codeStyleIdx).toBeGreaterThan(alwaysAskIdx);
    // It is no longer in the decide-alone bucket (which precedes always-ask in the render).
    const decideAloneSlice = brief.slice(decideAloneIdx, alwaysAskIdx);
    expect(decideAloneSlice).not.toContain("code_style");
  });

  // ── My lane ──────────────────────────────────────────────────────────────────

  it("renders the lane: branch patterns, off-limits files, and the base branch", () => {
    const brief = composeBrief(briefCtx());
    // branches (defaults): create engineer/.*, push engineer/*, merge main
    expect(brief).toContain("engineer/.*");
    expect(brief).toContain("engineer/*");
    expect(brief).toContain("`main`");
    // off-limits files (default exclude patterns)
    expect(brief).toContain(".env*");
    expect(brief).toContain("secrets/**");
    // base branch + branch prefix + merge strategy from workspace config
    expect(brief).toContain("engineer/");
    expect(brief).toContain("squash");
  });

  // ── Spend ceiling ────────────────────────────────────────────────────────────

  it("renders a hard cost ceiling when a limit is set", () => {
    const brief = composeBrief(
      briefCtx({ safety: { cost_limits: { per_task: { cost_usd: 5 }, daily: { cost_usd: 50 } } } }),
    );
    expect(brief).toContain("My spend ceiling");
    expect(brief).toContain("capped at $5");
    expect(brief).toContain("capped at $50");
  });

  it("renders an open (null) cost limit as trust, never a blank", () => {
    // Defaults are all null — the open case.
    const brief = composeBrief(briefCtx());
    expect(brief).toContain("left open");
    expect(brief).toContain("trust in my judgment");
    expect(brief).not.toContain("null");
  });

  // ── Blocked-escalation cadence ────────────────────────────────────────────────

  it("renders the blocked-escalation cadence with each stage's timing in brief voice", () => {
    const brief = composeBrief(briefCtx());
    // Defaults: reminder after 4h, self-unblock after 8h, escalation after 2d.
    expect(brief).toContain("When I am blocked, when you will chase it");
    expect(brief).toContain("I nudge with a reminder after 4 hours");
    expect(brief).toContain("I try once to unblock myself after 8 hours");
    expect(brief).toContain("a quiet wait becomes a real escalation after 2 days");
  });

  // ── Thinking trail at merge ───────────────────────────────────────────────────

  it("renders the thinking-trail-at-merge stance from the merge policy", () => {
    const kept = composeBrief(briefCtx({ safety: { merge: { exclude_thoughts_on_merge: false } } }));
    expect(kept).toContain("My thinking trail at merge");
    expect(kept).toContain("land with the merge");

    const stripped = composeBrief(briefCtx({ safety: { merge: { exclude_thoughts_on_merge: true } } }));
    expect(stripped).toContain("stripped out of the branch before it lands");
    expect(stripped).toContain("stay in the PR for review");
  });
});
