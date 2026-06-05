import { describe, expect, it } from "vitest";

import { PeopleDirectory } from "../../../../src/core/people-directory/index.js";
import type { Person } from "../../../../src/schemas/adapters.js";
import type { PeopleConfig } from "../../../../src/schemas/config.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePerson(overrides: Partial<Person> & { id: string }): Person {
  return {
    name: overrides.id,
    roles: [],
    contacts: [],
    ...overrides,
  };
}

const farzam = makePerson({
  id: "farzam",
  name: "Farzam",
  roles: ["owner", "reviewer"],
  contacts: [
    { channel: "telegram", handle: "@farzam" },
    { channel: "github", handle: "farzam-gh" },
  ],
});

const alice = makePerson({
  id: "alice",
  name: "Alice",
  roles: ["reviewer"],
  contacts: [{ channel: "github", handle: "alice-gh" }],
});

const bob = makePerson({
  id: "bob",
  name: "Bob",
  roles: ["contributor"],
  contacts: [],
});

function makeConfig(people: Person[]): PeopleConfig {
  return { people };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PeopleDirectory", () => {
  describe("getPerson", () => {
    it("returns person by ID", () => {
      const dir = new PeopleDirectory(makeConfig([farzam, alice]));
      expect(dir.getPerson("farzam")).toEqual(farzam);
      expect(dir.getPerson("alice")).toEqual(alice);
    });

    it("returns null for unknown ID", () => {
      const dir = new PeopleDirectory(makeConfig([farzam]));
      expect(dir.getPerson("unknown")).toBeNull();
    });
  });

  describe("getByRole", () => {
    it("returns all people with the given role", () => {
      const dir = new PeopleDirectory(makeConfig([farzam, alice, bob]));
      const reviewers = dir.getByRole("reviewer");
      expect(reviewers).toHaveLength(2);
      expect(reviewers.map((p) => p.id)).toEqual(["farzam", "alice"]);
    });

    it("returns empty array for unknown role", () => {
      const dir = new PeopleDirectory(makeConfig([farzam, alice]));
      expect(dir.getByRole("admin")).toEqual([]);
    });
  });

  describe("getOwner", () => {
    it("returns first person with owner role", () => {
      const dir = new PeopleDirectory(makeConfig([farzam, alice]));
      expect(dir.getOwner()).toEqual(farzam);
    });

    it("returns null when no owner configured", () => {
      const dir = new PeopleDirectory(makeConfig([alice, bob]));
      expect(dir.getOwner()).toBeNull();
    });
  });

  describe("getReviewers", () => {
    it("returns all reviewers", () => {
      const dir = new PeopleDirectory(makeConfig([farzam, alice, bob]));
      const reviewers = dir.getReviewers();
      expect(reviewers).toHaveLength(2);
      expect(reviewers.map((p) => p.id)).toEqual(["farzam", "alice"]);
    });

    it("returns empty array when no reviewers", () => {
      const dir = new PeopleDirectory(makeConfig([bob]));
      expect(dir.getReviewers()).toEqual([]);
    });
  });

  describe("resolveContact", () => {
    it("returns matching channel contact", () => {
      const dir = new PeopleDirectory(makeConfig([farzam]));
      const contact = dir.resolveContact("farzam", "github");
      expect(contact).toEqual({
        channel: "github",
        handle: "farzam-gh",
        plugin_id: "github",
      });
    });

    it("falls back to first contact when preferred channel not found", () => {
      const dir = new PeopleDirectory(makeConfig([farzam]));
      const contact = dir.resolveContact("farzam", "slack");
      expect(contact).toEqual({
        channel: "telegram",
        handle: "@farzam",
        plugin_id: "telegram",
      });
    });

    it("returns null for unknown person", () => {
      const dir = new PeopleDirectory(makeConfig([farzam]));
      expect(dir.resolveContact("unknown", "github")).toBeNull();
    });

    it("returns null for person with no contacts", () => {
      const dir = new PeopleDirectory(makeConfig([bob]));
      expect(dir.resolveContact("bob", "github")).toBeNull();
    });
  });

  describe("getAll", () => {
    it("returns all people", () => {
      const dir = new PeopleDirectory(makeConfig([farzam, alice, bob]));
      const all = dir.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((p) => p.id)).toEqual(["farzam", "alice", "bob"]);
    });

    it("returns empty array for empty config", () => {
      const dir = new PeopleDirectory(makeConfig([]));
      expect(dir.getAll()).toEqual([]);
    });
  });

  describe("empty config", () => {
    it("constructs without error and returns empty results", () => {
      const dir = new PeopleDirectory(makeConfig([]));
      expect(dir.getPerson("anyone")).toBeNull();
      expect(dir.getByRole("owner")).toEqual([]);
      expect(dir.getOwner()).toBeNull();
      expect(dir.getReviewers()).toEqual([]);
      expect(dir.getAll()).toEqual([]);
    });
  });
});
