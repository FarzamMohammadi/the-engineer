import { describe, expect, it } from "vitest";

import { SafetyConfigSchema } from "../../schemas/config.js";
import type { SafetyQuery } from "../interfaces/safety-layer.interface.js";
import {
  PolicyEngine,
  evaluateThreshold,
  matchesPathPattern,
  parseThreshold,
} from "./policy-engine.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createEngine(overrides: Parameters<typeof SafetyConfigSchema.parse>[0] = {}) {
  return new PolicyEngine(SafetyConfigSchema.parse(overrides));
}

// ── Pure Functions ───────────────────────────────────────────────────────────

describe("parseThreshold", () => {
  it("parses metric > value format", () => {
    expect(parseThreshold("scope > 5 files")).toEqual({ metric: "scope", op: ">", value: 5 });
  });

  it("returns null for unparseable input", () => {
    expect(parseThreshold("invalid")).toBeNull();
  });
});

describe("evaluateThreshold", () => {
  it("returns true when threshold exceeded", () => {
    expect(evaluateThreshold(parseThreshold("scope > 5")!, { scope: 10 })).toBe(true);
  });

  it("returns false when within threshold", () => {
    expect(evaluateThreshold(parseThreshold("scope > 5")!, { scope: 3 })).toBe(false);
  });
});

describe("matchesPathPattern", () => {
  it("matches .env* glob", () => {
    expect(matchesPathPattern(".env*", ".env.local")).toBe(true);
    expect(matchesPathPattern(".env*", "other")).toBe(false);
  });

  it("matches secrets/** deep glob", () => {
    expect(matchesPathPattern("secrets/**", "secrets/nested/file.txt")).toBe(true);
  });

  it("matches basename against non-slash pattern", () => {
    expect(matchesPathPattern("*.key", "certs/server.key")).toBe(true);
  });
});

// ── PolicyEngine — Scope Checks ──────────────────────────────────────────────

describe("PolicyEngine — evaluateScope", () => {
  it("returns null when all scope checks pass", () => {
    const engine = createEngine();
    const result = engine.evaluateScope("write", { file: "src/main.ts" });
    expect(result).toBeNull();
  });

  it("denies repo not in allowed list", () => {
    const engine = createEngine({ scope: { repos: { allowed: ["owner/repo-a"] } } });
    const result = engine.evaluateScope("write", { repo: "owner/repo-b" });
    expect(result).not.toBeNull();
    expect(result?.action).toBe("deny");
    expect(result?.reason).toContain("repo-b");
  });

  it("allows repo in allowed list", () => {
    const engine = createEngine({ scope: { repos: { allowed: ["owner/repo-a"] } } });
    const result = engine.evaluateScope("write", { repo: "owner/repo-a" });
    expect(result).toBeNull();
  });

  it("allows any repo when allowed is null", () => {
    const engine = createEngine({ scope: { repos: { allowed: null } } });
    const result = engine.evaluateScope("write", { repo: "any/repo" });
    expect(result).toBeNull();
  });

  it("denies push to branch not matching push_to patterns", () => {
    const engine = createEngine({ scope: { branches: { push_to: ["engineer/*"] } } });
    const result = engine.evaluateScope("git_remote", { branch: "main" });
    expect(result?.action).toBe("deny");
    expect(result?.reason).toContain("push to");
  });

  it("allows push to matching branch", () => {
    const engine = createEngine({ scope: { branches: { push_to: ["engineer/*"] } } });
    const result = engine.evaluateScope("git_remote", { branch: "engineer/42-fix" });
    expect(result).toBeNull();
  });

  it("denies writing to excluded file", () => {
    const engine = createEngine();
    const result = engine.evaluateScope("write", { file: ".env.local" });
    expect(result?.action).toBe("deny");
    expect(result?.reason).toContain(".env");
  });

  it("allows writing to non-excluded file", () => {
    const engine = createEngine();
    const result = engine.evaluateScope("write", { file: "src/index.ts" });
    expect(result).toBeNull();
  });

  it("checks multiple files via files array", () => {
    const engine = createEngine();
    const result = engine.evaluateScope("write", { files: ["src/main.ts", ".env"] });
    expect(result?.action).toBe("deny");
  });

  it("returns ask_human for merge when auto-merge disabled", () => {
    const engine = createEngine({
      scope: { branches: { merge_to: ["main"] } },
      merge: { auto_merge_after_approval: { default: false } },
    });
    const result = engine.evaluateScope("merge", { repo: "owner/repo", branch: "main" });
    expect(result?.action).toBe("ask_human");
  });

  it("allows merge when auto-merge enabled", () => {
    const engine = createEngine({
      scope: { branches: { merge_to: ["main"] } },
      merge: { auto_merge_after_approval: { default: true } },
    });
    const result = engine.evaluateScope("merge", { repo: "owner/repo", branch: "main" });
    expect(result).toBeNull();
  });
});

// ── PolicyEngine — checkAutoMergeAllowed ──────────────────────────────────────

describe("PolicyEngine — checkAutoMergeAllowed", () => {
  it("returns true when default is true", () => {
    const engine = createEngine({ merge: { auto_merge_after_approval: { default: true } } });
    expect(engine.checkAutoMergeAllowed("any/repo")).toBe(true);
  });

  it("returns false when default is false", () => {
    const engine = createEngine({ merge: { auto_merge_after_approval: { default: false } } });
    expect(engine.checkAutoMergeAllowed("any/repo")).toBe(false);
  });

  it("repo override takes precedence", () => {
    const engine = createEngine({
      merge: { auto_merge_after_approval: { default: false, repos: { "owner/repo": true } } },
    });
    expect(engine.checkAutoMergeAllowed("owner/repo")).toBe(true);
    expect(engine.checkAutoMergeAllowed("other/repo")).toBe(false);
  });
});

// ── PolicyEngine — Comment Approval & Thoughts Exclusion ────────────────────

describe("PolicyEngine — isCommentApprovalEnabled", () => {
  it("returns false by default", () => {
    const engine = createEngine({});
    expect(engine.isCommentApprovalEnabled()).toBe(false);
  });

  it("returns true when enabled", () => {
    const engine = createEngine({ merge: { enable_comment_approval: true } });
    expect(engine.isCommentApprovalEnabled()).toBe(true);
  });
});

describe("PolicyEngine — shouldExcludeThoughtsOnMerge", () => {
  it("returns false by default", () => {
    const engine = createEngine({});
    expect(engine.shouldExcludeThoughtsOnMerge()).toBe(false);
  });

  it("returns true when enabled", () => {
    const engine = createEngine({ merge: { exclude_thoughts_on_merge: true } });
    expect(engine.shouldExcludeThoughtsOnMerge()).toBe(true);
  });
});

// ── PolicyEngine — Autonomy ──────────────────────────────────────────────────

describe("PolicyEngine — evaluateAutonomy", () => {
  function makeQuery(overrides: Partial<SafetyQuery["context"]> = {}): SafetyQuery {
    return {
      type: "should_i_ask",
      context: {
        task_id: "task-1",
        repo: "owner/repo",
        details: {},
        ...overrides,
      },
    };
  }

  it("returns proceed for always_decide", () => {
    const engine = createEngine({
      autonomy: { decisions: { code_style: { level: "always_decide", description: "" } } },
    });
    const verdict = engine.evaluateAutonomy(makeQuery({ decision_category: "code_style" }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.action).toBe("proceed");
  });

  it("returns ask_human for always_ask", () => {
    const engine = createEngine({
      autonomy: { decisions: { arch: { level: "always_ask", description: "" } } },
    });
    const verdict = engine.evaluateAutonomy(makeQuery({ decision_category: "arch" }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
  });

  it("threshold within limit returns proceed", () => {
    const engine = createEngine({
      autonomy: {
        decisions: {
          refactoring: { level: "threshold", threshold: "scope > 5 files", description: "" },
        },
      },
    });
    const verdict = engine.evaluateAutonomy(
      makeQuery({ decision_category: "refactoring", details: { scope: 3 } }),
    );
    expect(verdict.allowed).toBe(true);
  });

  it("threshold exceeded returns ask_human", () => {
    const engine = createEngine({
      autonomy: {
        decisions: {
          refactoring: { level: "threshold", threshold: "scope > 5 files", description: "" },
        },
      },
    });
    const verdict = engine.evaluateAutonomy(
      makeQuery({ decision_category: "refactoring", details: { scope: 12 } }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.action).toBe("ask_human");
  });

  it("unknown category returns ask_human", () => {
    const engine = createEngine();
    const verdict = engine.evaluateAutonomy(makeQuery({ decision_category: "unknown_cat" }));
    expect(verdict.action).toBe("ask_human");
  });

  it("missing decision_category returns ask_human", () => {
    const engine = createEngine();
    const verdict = engine.evaluateAutonomy(makeQuery());
    expect(verdict.action).toBe("ask_human");
  });

  it("repo override takes precedence over base config", () => {
    const engine = createEngine({
      autonomy: {
        decisions: { refactoring: { level: "always_decide", description: "" } },
        repo_overrides: {
          "owner/critical-repo": { decisions: { refactoring: { level: "always_ask" } } },
        },
      },
    });

    const baseVerdict = engine.evaluateAutonomy(
      makeQuery({ repo: "owner/other", decision_category: "refactoring" }),
    );
    expect(baseVerdict.action).toBe("proceed");

    const overrideVerdict = engine.evaluateAutonomy(
      makeQuery({ repo: "owner/critical-repo", decision_category: "refactoring" }),
    );
    expect(overrideVerdict.action).toBe("ask_human");
  });
});

// ── PolicyEngine — getTimeoutPolicy ──────────────────────────────────────────

describe("PolicyEngine — getTimeoutPolicy", () => {
  it("returns the configured response timeout", () => {
    const engine = createEngine();
    const policy = engine.getTimeoutPolicy();
    expect(policy.blocked.stages).toHaveLength(3);
    expect(policy.review_pending.reminder_after_ms).toBe(86_400_000);
  });
});

// ── PolicyEngine — Hot-Reload ────────────────────────────────────────────────

describe("PolicyEngine — hot-reload", () => {
  it("new scope rules apply after updateConfig", () => {
    const engine = createEngine({ scope: { repos: { allowed: ["owner/repo-a"] } } });

    // Initially denied
    expect(engine.evaluateScope("write", { repo: "owner/repo-b" })?.action).toBe("deny");

    // Update config
    engine.updateConfig(
      SafetyConfigSchema.parse({
        scope: { repos: { allowed: ["owner/repo-a", "owner/repo-b"] } },
      }),
    );

    // Now allowed
    expect(engine.evaluateScope("write", { repo: "owner/repo-b" })).toBeNull();
  });

  it("new autonomy rules apply after updateConfig", () => {
    const engine = createEngine({
      autonomy: { decisions: { refactoring: { level: "always_decide", description: "" } } },
    });

    const query: SafetyQuery = {
      type: "should_i_ask",
      context: { task_id: "t1", repo: "r", decision_category: "refactoring", details: {} },
    };

    expect(engine.evaluateAutonomy(query).action).toBe("proceed");

    engine.updateConfig(
      SafetyConfigSchema.parse({
        autonomy: { decisions: { refactoring: { level: "always_ask", description: "" } } },
      }),
    );

    expect(engine.evaluateAutonomy(query).action).toBe("ask_human");
  });
});
