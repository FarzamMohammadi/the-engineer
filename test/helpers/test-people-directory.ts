import { PeopleDirectory } from "../../src/core/people-directory/index.js";
import type { Person } from "../../src/schemas/adapters.js";

/** Default people for tests: one owner, one reviewer. */
const defaultPeople: Person[] = [
  {
    id: "owner",
    name: "Test Owner",
    roles: ["owner", "reviewer"],
    contacts: [
      { channel: "github", handle: "test-owner" },
      { channel: "telegram", handle: "@test-owner" },
    ],
    preferences: { notification_level: "all", quiet_hours: null },
  },
  {
    id: "reviewer",
    name: "Test Reviewer",
    roles: ["reviewer"],
    contacts: [{ channel: "github", handle: "test-reviewer" }],
    preferences: { notification_level: "milestones", quiet_hours: null },
  },
];

/** Create a PeopleDirectory with sensible defaults for testing. */
export function createTestPeopleDirectory(people?: Person[]): PeopleDirectory {
  return new PeopleDirectory({ people: people ?? defaultPeople });
}
