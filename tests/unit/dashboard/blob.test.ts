import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBlob, isBlobRef } from "../../../src/dashboard/client/src/lib/blob.js";

// ── blob ─────────────────────────────────────────────────────────────────────────
//
// The agent span stores blob refs as `prefix/hash`, or `""` when there is no blob. The viewer must tell
// those apart and degrade a 404 / network failure to a quiet message rather than throwing.

describe("isBlobRef", () => {
  it("accepts a well-formed prefix/hash ref", () => {
    expect(isBlobRef("prompts/abc123")).toBe(true);
  });

  it.each([null, undefined, "", "noslash", "/leading", "trailing/"])("rejects %p", (value) => {
    expect(isBlobRef(value)).toBe(false);
  });
});

describe("fetchBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("short-circuits to empty without a network call for a blank ref", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await fetchBlob("")).toEqual({ status: "empty" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns loaded text on a 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello world", { status: 200 }));
    expect(await fetchBlob("prompts/abc")).toEqual({ status: "loaded", text: "hello world" });
  });

  it("maps a 404 to not_found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await fetchBlob("prompts/missing")).toEqual({ status: "not_found" });
  });

  it("maps a non-404 error status to error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 500, statusText: "Internal Server Error" }),
    );
    const result = await fetchBlob("prompts/abc");
    expect(result.status).toBe("error");
  });

  it("maps a thrown network error to error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await fetchBlob("prompts/abc")).toEqual({ status: "error", message: "offline" });
  });
});
