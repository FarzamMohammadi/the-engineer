import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecureValue } from "./secure-value.js";

describe("SecureValue", () => {
  const raw = "ghp_superSecretToken1234567890";

  it("unwrap() returns the original value", () => {
    const sv = new SecureValue(raw);
    expect(sv.unwrap()).toBe(raw);
  });

  it("toString() returns [REDACTED]", () => {
    const sv = new SecureValue(raw);
    expect(sv.toString()).toBe("[REDACTED]");
  });

  it("template literal interpolation returns [REDACTED]", () => {
    const sv = new SecureValue(raw);
    expect(`token is ${sv}`).toBe("token is [REDACTED]");
  });

  it("string concatenation returns [REDACTED]", () => {
    const sv = new SecureValue(raw);
    // biome-ignore lint/style/useTemplate: testing concatenation specifically
    expect("token: " + sv).toBe("token: [REDACTED]");
  });

  it("JSON.stringify() returns quoted [REDACTED]", () => {
    const sv = new SecureValue(raw);
    expect(JSON.stringify(sv)).toBe('"[REDACTED]"');
  });

  it("JSON.stringify() in an object returns [REDACTED]", () => {
    const sv = new SecureValue(raw);
    const obj = { token: sv };
    expect(JSON.parse(JSON.stringify(obj))).toEqual({ token: "[REDACTED]" });
  });

  it("util.inspect() returns [REDACTED]", () => {
    const sv = new SecureValue(raw);
    expect(inspect(sv)).toBe("[REDACTED]");
  });

  it("works with empty string", () => {
    const sv = new SecureValue("");
    expect(sv.unwrap()).toBe("");
    expect(sv.toString()).toBe("[REDACTED]");
  });

  it("#value is inaccessible from outside", () => {
    const sv = new SecureValue(raw);
    // Private field — no property access
    expect(Object.keys(sv)).toEqual([]);
    expect(Object.getOwnPropertyNames(sv)).toEqual([]);
    // Only unwrap() can retrieve the value
    expect(JSON.stringify(sv)).not.toContain(raw);
  });
});
