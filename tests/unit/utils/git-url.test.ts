import { describe, expect, it } from "vitest";
import { injectAuth } from "../../../src/utils/git-url.js";

describe("injectAuth", () => {
  it("injects token into HTTPS URL", () => {
    expect(injectAuth("https://github.com/owner/repo.git", "my-token")).toBe(
      "https://git:my-token@github.com/owner/repo.git",
    );
  });

  it("returns URL unchanged when token is empty", () => {
    expect(injectAuth("https://github.com/owner/repo.git", "")).toBe("https://github.com/owner/repo.git");
  });

  it("returns URL unchanged for non-HTTPS URL", () => {
    expect(injectAuth("git@github.com:owner/repo.git", "my-token")).toBe("git@github.com:owner/repo.git");
  });

  it("returns URL unchanged for HTTP URL", () => {
    expect(injectAuth("http://github.com/owner/repo.git", "my-token")).toBe("http://github.com/owner/repo.git");
  });
});
