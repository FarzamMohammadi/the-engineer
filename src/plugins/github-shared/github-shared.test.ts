import { describe, expect, it } from "vitest";
import {
  diffStateLabels,
  parseGitHubUrl,
  parseTargetChannel,
  stateLabelName,
  toExternalRef,
} from "./index.js";

describe("parseGitHubUrl", () => {
  it("parses an issue URL", () => {
    const result = parseGitHubUrl("https://github.com/acme/webapp/issues/42");
    expect(result).toEqual({ owner: "acme", repo: "webapp", number: 42, type: "issue" });
  });

  it("parses a PR URL", () => {
    const result = parseGitHubUrl("https://github.com/acme/webapp/pull/7");
    expect(result).toEqual({ owner: "acme", repo: "webapp", number: 7, type: "pull" });
  });

  it("handles http (not https)", () => {
    const result = parseGitHubUrl("http://github.com/acme/webapp/issues/1");
    expect(result).not.toBeNull();
    expect(result?.owner).toBe("acme");
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseGitHubUrl("https://gitlab.com/acme/webapp/issues/1")).toBeNull();
  });

  it("returns null for malformed paths", () => {
    expect(parseGitHubUrl("https://github.com/acme/webapp")).toBeNull();
    expect(parseGitHubUrl("https://github.com/acme")).toBeNull();
    expect(parseGitHubUrl("")).toBeNull();
  });

  it("returns null for non-numeric issue number", () => {
    expect(parseGitHubUrl("https://github.com/acme/webapp/issues/abc")).toBeNull();
  });

  it("handles URLs with trailing paths", () => {
    const result = parseGitHubUrl("https://github.com/acme/webapp/issues/42/comments");
    expect(result).not.toBeNull();
    expect(result?.number).toBe(42);
  });
});

describe("toExternalRef", () => {
  it("creates github_issue ref", () => {
    const ref = toExternalRef("acme", "webapp", 42, "issue");
    expect(ref).toEqual({ type: "github_issue", repo: "acme/webapp", number: 42 });
  });

  it("creates github_pr ref", () => {
    const ref = toExternalRef("acme", "webapp", 7, "pull");
    expect(ref).toEqual({ type: "github_pr", repo: "acme/webapp", number: 7 });
  });
});

describe("stateLabelName", () => {
  it("generates label with prefix", () => {
    expect(stateLabelName("active", "engineer:")).toBe("engineer:active");
  });

  it("lowercases the state", () => {
    expect(stateLabelName("Review_Pending", "engineer:")).toBe("engineer:review_pending");
  });

  it("works with custom prefix", () => {
    expect(stateLabelName("queued", "bot-")).toBe("bot-queued");
  });
});

describe("diffStateLabels", () => {
  const prefix = "engineer:";

  it("adds new label and removes old one", () => {
    const result = diffStateLabels(["engineer:queued", "bug"], "active", prefix);
    expect(result.add).toEqual(["engineer:active"]);
    expect(result.remove).toEqual(["engineer:queued"]);
  });

  it("no-ops when label already present", () => {
    const result = diffStateLabels(["engineer:active", "bug"], "active", prefix);
    expect(result.add).toEqual([]);
    expect(result.remove).toEqual([]);
  });

  it("removes multiple old state labels", () => {
    // Shouldn't happen normally, but handles it gracefully
    const result = diffStateLabels(["engineer:queued", "engineer:blocked"], "active", prefix);
    expect(result.add).toEqual(["engineer:active"]);
    expect(result.remove).toEqual(["engineer:queued", "engineer:blocked"]);
  });

  it("preserves non-prefixed labels", () => {
    const result = diffStateLabels(["bug", "priority:high", "engineer:queued"], "active", prefix);
    expect(result.remove).toEqual(["engineer:queued"]);
    // Non-prefixed labels are not touched
  });

  it("handles empty current labels", () => {
    const result = diffStateLabels([], "active", prefix);
    expect(result.add).toEqual(["engineer:active"]);
    expect(result.remove).toEqual([]);
  });
});

describe("parseTargetChannel", () => {
  it("parses owner/repo#number", () => {
    const result = parseTargetChannel("acme/webapp#42");
    expect(result).toEqual({ owner: "acme", repo: "webapp", issueNumber: 42 });
  });

  it("returns null for invalid format", () => {
    expect(parseTargetChannel("acme/webapp")).toBeNull();
    expect(parseTargetChannel("acme#42")).toBeNull();
    expect(parseTargetChannel("")).toBeNull();
  });

  it("returns null for non-numeric issue number", () => {
    expect(parseTargetChannel("acme/webapp#abc")).toBeNull();
  });
});
