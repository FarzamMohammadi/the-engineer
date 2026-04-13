import { describe, expect, it } from "vitest";

import { AdapterErrorSeverities } from "../schemas/adapters.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

describe("createAdapterError", () => {
  it("returns AdapterError with sensible defaults", () => {
    const error = createAdapterError("rate_limited", "Too many requests");
    expect(error).toEqual({
      code: "rate_limited",
      message: "Too many requests",
      retryable: false,
      retry_after_ms: null,
      severity: AdapterErrorSeverities.error,
    });
  });

  it("applies custom options", () => {
    const error = createAdapterError("rate_limited", "Slow down", {
      retryable: true,
      retry_after_ms: 5000,
      severity: AdapterErrorSeverities.warning,
    });
    expect(error).toEqual({
      code: "rate_limited",
      message: "Slow down",
      retryable: true,
      retry_after_ms: 5000,
      severity: AdapterErrorSeverities.warning,
    });
  });

  it("allows partial options (rest use defaults)", () => {
    const error = createAdapterError("timeout", "Timed out", { retryable: true });
    expect(error.retryable).toBe(true);
    expect(error.retry_after_ms).toBeNull();
    expect(error.severity).toBe(AdapterErrorSeverities.error);
  });
});

describe("AdapterMethodError", () => {
  it("extends Error", () => {
    const adapterError = createAdapterError("auth_failed", "Bad credentials");
    const error = new AdapterMethodError(adapterError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AdapterMethodError);
  });

  it("carries structured adapterError payload", () => {
    const adapterError = createAdapterError("timeout", "Request timed out", {
      retryable: true,
      severity: AdapterErrorSeverities.warning,
    });
    const error = new AdapterMethodError(adapterError);
    expect(error.adapterError).toBe(adapterError);
    expect(error.adapterError.code).toBe("timeout");
    expect(error.adapterError.retryable).toBe(true);
  });

  it("uses adapterError.message as the Error message", () => {
    const adapterError = createAdapterError("not_found", "Resource missing");
    const error = new AdapterMethodError(adapterError);
    expect(error.message).toBe("Resource missing");
  });

  it("has name AdapterMethodError", () => {
    const adapterError = createAdapterError("internal_error", "Something broke");
    const error = new AdapterMethodError(adapterError);
    expect(error.name).toBe("AdapterMethodError");
  });

  it("works with try/catch instanceof check", () => {
    const adapterError = createAdapterError("conflict", "Concurrent modification");
    try {
      throw new AdapterMethodError(adapterError);
    } catch (caught) {
      expect(caught).toBeInstanceOf(AdapterMethodError);
      if (caught instanceof AdapterMethodError) {
        expect(caught.adapterError.code).toBe("conflict");
      }
    }
  });
});
