import { describe, expect, it } from "vitest";

import { extractErrorMessage } from "../../../src/utils/errors.js";

describe("extractErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(extractErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("extracts message from Error subclasses", () => {
    expect(extractErrorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("converts string errors", () => {
    expect(extractErrorMessage("string error")).toBe("string error");
  });

  it("converts numeric errors", () => {
    expect(extractErrorMessage(42)).toBe("42");
  });

  it("converts null", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("converts undefined", () => {
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });
});
