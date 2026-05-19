import { describe, expect, it } from "vitest";

import { checkRequirementsMet } from "../../../../src/cli/setup/requirements.js";
import { detectEnvironment } from "../../../../src/cli/setup/setup.js";

// ── checkRequirementsMet ─────────────────────────────────────────────────────

describe("checkRequirementsMet", () => {
  const detection = detectEnvironment(
    { GITHUB_TOKEN: "ghp_test" },
    { claude: "/usr/bin/claude", bash: "/bin/bash", opencode: null },
    null,
  );

  it("returns true when all binary requirements met", () => {
    expect(checkRequirementsMet({ requirements: [{ type: "binary", name: "claude" }] }, detection)).toBe(true);
  });

  it("returns false when binary requirement not met", () => {
    expect(checkRequirementsMet({ requirements: [{ type: "binary", name: "opencode" }] }, detection)).toBe(false);
  });

  it("returns true when env requirement met", () => {
    expect(checkRequirementsMet({ requirements: [{ type: "env", name: "GITHUB_TOKEN" }] }, detection)).toBe(true);
  });

  it("returns false when env requirement not met", () => {
    expect(checkRequirementsMet({ requirements: [{ type: "env", name: "TELEGRAM_BOT_TOKEN" }] }, detection)).toBe(
      false,
    );
  });

  it("returns true when no requirements", () => {
    expect(checkRequirementsMet({ requirements: [] }, detection)).toBe(true);
  });

  it("returns false when any requirement not met (mixed)", () => {
    expect(
      checkRequirementsMet(
        {
          requirements: [
            { type: "binary", name: "claude" },
            { type: "env", name: "NONEXISTENT" },
          ],
        },
        detection,
      ),
    ).toBe(false);
  });

  it("skips unknown requirement types gracefully", () => {
    expect(
      checkRequirementsMet(
        {
          requirements: [
            { type: "binary", name: "claude" },
            { type: "port" as "binary", name: "5432" },
          ],
        },
        detection,
      ),
    ).toBe(true);
  });
});
