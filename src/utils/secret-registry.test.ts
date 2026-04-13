import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSecretRegistryForTest,
  getSecretEnvVars,
  registerSecretEnvVars,
} from "./secret-registry.js";

describe("secret-registry", () => {
  afterEach(() => {
    _resetSecretRegistryForTest();
  });

  it("starts empty", () => {
    expect(getSecretEnvVars().size).toBe(0);
  });

  it("registers env var names", () => {
    registerSecretEnvVars(["GITHUB_TOKEN", "MY_SECRET"]);
    expect(getSecretEnvVars().has("GITHUB_TOKEN")).toBe(true);
    expect(getSecretEnvVars().has("MY_SECRET")).toBe(true);
  });

  it("deduplicates names", () => {
    registerSecretEnvVars(["A", "B", "A"]);
    expect(getSecretEnvVars().size).toBe(2);
  });

  it("accumulates across multiple calls", () => {
    registerSecretEnvVars(["A"]);
    registerSecretEnvVars(["B"]);
    expect(getSecretEnvVars().size).toBe(2);
  });

  it("reset clears all names", () => {
    registerSecretEnvVars(["A", "B"]);
    _resetSecretRegistryForTest();
    expect(getSecretEnvVars().size).toBe(0);
  });

  it("returns a readonly set", () => {
    const vars = getSecretEnvVars();
    // ReadonlySet — no .add or .delete at type level
    expect(typeof vars.has).toBe("function");
    expect(typeof vars.size).toBe("number");
  });
});
