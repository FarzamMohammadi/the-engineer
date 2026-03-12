import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore, computeHash, hashToRef, refToPath } from "./blob-store.js";

const BLOB_REF_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}$/;

describe("BlobStore", () => {
  let tracesDir: string;
  let store: BlobStore;

  beforeEach(() => {
    tracesDir = mkdtempSync(join(tmpdir(), "blob-test-"));
    store = new BlobStore(tracesDir);
  });

  afterEach(() => {
    rmSync(tracesDir, { recursive: true, force: true });
  });

  describe("pure functions", () => {
    it("computeHash returns consistent SHA-256 hex", () => {
      const hash1 = computeHash("hello world");
      const hash2 = computeHash("hello world");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it("computeHash differs for different content", () => {
      expect(computeHash("hello")).not.toBe(computeHash("world"));
    });

    it("hashToRef uses first 2 chars as subdirectory", () => {
      const hash = "abcdef1234567890";
      expect(hashToRef(hash)).toBe("ab/abcdef1234567890");
    });

    it("refToPath joins blobsDir with ref and .txt extension", () => {
      expect(refToPath("ab/abcdef", "/traces/blobs")).toBe("/traces/blobs/ab/abcdef.txt");
    });
  });

  describe("store", () => {
    it("stores content and returns a ref", () => {
      const ref = store.store("test content");
      expect(ref).toMatch(BLOB_REF_PATTERN);
    });

    it("returns same ref for identical content (dedup)", () => {
      const ref1 = store.store("identical");
      const ref2 = store.store("identical");
      expect(ref1).toBe(ref2);
    });

    it("returns different refs for different content", () => {
      const ref1 = store.store("content A");
      const ref2 = store.store("content B");
      expect(ref1).not.toBe(ref2);
    });
  });

  describe("read", () => {
    it("reads stored content back by ref", () => {
      const ref = store.store("hello blob");
      expect(store.read(ref)).toBe("hello blob");
    });

    it("returns null for missing ref", () => {
      expect(store.read("ff/nonexistent")).toBeNull();
    });

    it("handles large content", () => {
      const large = "x".repeat(100_000);
      const ref = store.store(large);
      expect(store.read(ref)).toBe(large);
    });
  });

  describe("exists", () => {
    it("returns true for stored blob", () => {
      const ref = store.store("some data");
      expect(store.exists(ref)).toBe(true);
    });

    it("returns false for missing blob", () => {
      expect(store.exists("00/missing")).toBe(false);
    });
  });

  it("creates blobs directory on construction", () => {
    const newDir = mkdtempSync(join(tmpdir(), "blob-new-"));
    const newStore = new BlobStore(newDir);
    const ref = newStore.store("test");
    expect(newStore.read(ref)).toBe("test");
    rmSync(newDir, { recursive: true, force: true });
  });
});
