import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StateStore } from "../../../../src/adapters/base.js";
import { createStateStore } from "../../../../src/core/state-store/index.js";
import { createTestDatabase } from "../../../helpers/test-database.js";
import type { TestDatabaseHandle } from "../../../helpers/test-database.js";

describe("StateStore", () => {
  let dbHandle: TestDatabaseHandle;
  let store: StateStore;

  beforeEach(() => {
    dbHandle = createTestDatabase();
    store = createStateStore(dbHandle.db, "test-plugin");
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  describe("get", () => {
    it("returns null for a missing key", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("returns the stored value after set", () => {
      store.set("key1", { cursor: "2026-01-01" });
      expect(store.get("key1")).toEqual({ cursor: "2026-01-01" });
    });

    it("handles string values", () => {
      store.set("simple", "hello");
      expect(store.get("simple")).toBe("hello");
    });

    it("handles numeric values", () => {
      store.set("count", 42);
      expect(store.get("count")).toBe(42);
    });

    it("handles boolean values", () => {
      store.set("flag", true);
      expect(store.get("flag")).toBe(true);
    });

    it("handles array values", () => {
      store.set("list", [1, 2, 3]);
      expect(store.get("list")).toEqual([1, 2, 3]);
    });

    it("handles null values", () => {
      store.set("nullable", null);
      expect(store.get("nullable")).toBeNull();
    });
  });

  describe("set", () => {
    it("overwrites an existing value", () => {
      store.set("key", "v1");
      store.set("key", "v2");
      expect(store.get("key")).toBe("v2");
    });

    it("handles complex nested objects", () => {
      const watermarks = {
        "owner/repo1": "2026-01-15T10:00:00Z",
        "owner/repo2": "2026-01-16T12:00:00Z",
      };
      store.set("watermarks", watermarks);
      expect(store.get("watermarks")).toEqual(watermarks);
    });
  });

  describe("delete", () => {
    it("removes an existing key", () => {
      store.set("key", "value");
      store.delete("key");
      expect(store.get("key")).toBeNull();
    });

    it("is a no-op for a missing key", () => {
      expect(() => store.delete("nonexistent")).not.toThrow();
    });
  });

  describe("namespace isolation", () => {
    it("prevents one plugin from reading another's keys", () => {
      const storeA = createStateStore(dbHandle.db, "plugin-a");
      const storeB = createStateStore(dbHandle.db, "plugin-b");

      storeA.set("shared-key", "a-value");
      storeB.set("shared-key", "b-value");

      expect(storeA.get("shared-key")).toBe("a-value");
      expect(storeB.get("shared-key")).toBe("b-value");
    });

    it("deleting in one namespace does not affect another", () => {
      const storeA = createStateStore(dbHandle.db, "plugin-a");
      const storeB = createStateStore(dbHandle.db, "plugin-b");

      storeA.set("key", "a");
      storeB.set("key", "b");

      storeA.delete("key");
      expect(storeA.get("key")).toBeNull();
      expect(storeB.get("key")).toBe("b");
    });
  });
});
