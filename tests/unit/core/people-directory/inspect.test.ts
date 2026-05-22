import { describe, expect, it } from "vitest";

import { inspectPeopleDirectory } from "../../../../src/core/people-directory/inspect.js";
import type { Person } from "../../../../src/schemas/adapters.js";
import { NotificationLevels } from "../../../../src/schemas/adapters.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePerson(overrides: Partial<Person> & { id: string }): Person {
  return {
    name: overrides.id,
    roles: [],
    contacts: [],
    preferences: {
      notification_level: NotificationLevels.all,
      quiet_hours: null,
    },
    ...overrides,
  };
}

const owner = makePerson({
  id: "owner",
  name: "Owner",
  roles: ["owner"],
  contacts: [
    { channel: "telegram", handle: "@owner" },
    { channel: "github", handle: "owner-gh" },
  ],
});

const allChannels = new Set(["telegram", "github"]);

function kinds(people: readonly Person[], channels: ReadonlySet<string>): string[] {
  return inspectPeopleDirectory(people, channels).map((w) => w.kind);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("inspectPeopleDirectory", () => {
  describe("healthy directory", () => {
    it("returns no warnings for a single owner with reachable channels", () => {
      expect(inspectPeopleDirectory([owner], allChannels)).toEqual([]);
    });
  });

  describe("no owner", () => {
    it("warns when no person has the owner role", () => {
      const stranger = makePerson({ id: "alice", roles: ["reviewer"] });
      const warnings = inspectPeopleDirectory([stranger], allChannels);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.kind).toBe("no_owner");
      expect(warnings[0]?.data).toEqual({ peopleCount: 1 });
    });

    it("warns when the directory is empty", () => {
      expect(kinds([], allChannels)).toEqual(["no_owner"]);
    });

    it("explains the consequence of having no contact", () => {
      const [warning] = inspectPeopleDirectory([], allChannels);
      expect(warning?.message).toContain("blocked");
      expect(warning?.message).toContain("requirements gathering");
    });

    it("skips channel checks when there is no owner", () => {
      const stranger = makePerson({ id: "alice", roles: ["reviewer"], contacts: [{ channel: "slack", handle: "a" }] });
      expect(kinds([stranger], new Set())).toEqual(["no_owner"]);
    });
  });

  describe("multiple people", () => {
    it("warns that only the owner is reached when more than one person is configured", () => {
      const reviewer = makePerson({ id: "alice", roles: ["reviewer"] });
      const warnings = inspectPeopleDirectory([owner, reviewer], allChannels);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.kind).toBe("multiple_people");
      expect(warnings[0]?.data).toEqual({ peopleCount: 2 });
    });

    it("does not warn for exactly one person", () => {
      expect(kinds([owner], allChannels)).toEqual([]);
    });
  });

  describe("unreachable owner channels", () => {
    it("warns for each owner channel with no available plugin", () => {
      const warnings = inspectPeopleDirectory([owner], new Set(["github"]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.kind).toBe("unreachable_owner_channel");
      expect(warnings[0]?.data).toEqual({ channel: "telegram" });
    });

    it("warns once per channel even when duplicated in contacts", () => {
      const dupe = makePerson({
        id: "owner",
        roles: ["owner"],
        contacts: [
          { channel: "slack", handle: "a" },
          { channel: "slack", handle: "b" },
        ],
      });
      const warnings = inspectPeopleDirectory([dupe], new Set());
      expect(warnings.map((w) => w.kind)).toEqual(["unreachable_owner_channel"]);
      expect(warnings[0]?.data).toEqual({ channel: "slack" });
    });

    it("reports unreachable channels in config order", () => {
      const both = inspectPeopleDirectory([owner], new Set());
      expect(both.map((w) => w.data["channel"])).toEqual(["telegram", "github"]);
    });
  });

  describe("combined problems", () => {
    it("reports no_owner, multiple_people, and channel warnings together", () => {
      const reviewer = makePerson({ id: "alice", roles: ["reviewer"] });
      // No owner among two people, so channel checks are skipped (no owner to check).
      expect(kinds([reviewer, reviewer], new Set())).toEqual(["no_owner", "multiple_people"]);
    });

    it("reports multiple_people alongside unreachable owner channels", () => {
      const reviewer = makePerson({ id: "alice", roles: ["reviewer"] });
      expect(kinds([owner, reviewer], new Set(["github"]))).toEqual(["multiple_people", "unreachable_owner_channel"]);
    });
  });
});
