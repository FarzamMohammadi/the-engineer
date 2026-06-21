import { describe, expect, it } from "vitest";

import {
  BLOB_REF_KEY_SUFFIX,
  BLOB_REF_PATTERN,
  isBlobRef,
  isBlobRefKey,
} from "../../../../src/core/observer/blob-ref.js";

// A well-formed ref: 2-hex prefix, slash, 64-hex sha256.
const REF = `ab/${"a".repeat(64)}`;

describe("isBlobRefKey", () => {
  it("accepts every key the engine writes under the convention", () => {
    for (const key of ["prompt_blob", "result_blob", "transcript_blob", "text_blob", "input_blob", "output_blob"]) {
      expect(isBlobRefKey(key)).toBe(true);
    }
  });

  it("accepts a not-yet-written key that follows the convention (future-proofing)", () => {
    expect(isBlobRefKey("diff_blob")).toBe(true);
  });

  it("rejects keys that do not end in the suffix", () => {
    for (const key of ["prompt_ref", "step", "cost_usd", "blob", "blob_input", "prompt_blobx"]) {
      expect(isBlobRefKey(key)).toBe(false);
    }
  });

  it("derives the suffix from the exported constant", () => {
    expect(isBlobRefKey(`anything${BLOB_REF_KEY_SUFFIX}`)).toBe(true);
  });
});

describe("isBlobRef", () => {
  it("accepts a well-formed ref", () => {
    expect(isBlobRef(REF)).toBe(true);
    expect(BLOB_REF_PATTERN.test(REF)).toBe(true);
  });

  it("rejects the empty string a failed capture writes", () => {
    expect(isBlobRef("")).toBe(false);
  });

  it("rejects malformed or non-string values", () => {
    expect(isBlobRef("not-a-ref")).toBe(false);
    expect(isBlobRef(`ab/${"a".repeat(63)}`)).toBe(false); // short hash
    expect(isBlobRef(`ab/${"A".repeat(64)}`)).toBe(false); // uppercase hex
    expect(isBlobRef(`abc/${"a".repeat(64)}`)).toBe(false); // 3-char prefix
    expect(isBlobRef(null)).toBe(false);
    expect(isBlobRef(42)).toBe(false);
    expect(isBlobRef(undefined)).toBe(false);
  });
});
