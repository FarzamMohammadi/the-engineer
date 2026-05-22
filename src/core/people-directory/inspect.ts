import type { Person } from "../../schemas/adapters.js";

// ── People Directory Inspection ───────────────────────────────────────────────
// Pure health checks over the configured people, surfaced by every shell that
// loads the directory (daemon startup logs them, `engineer doctor` renders them).
// See docs/constraints.md — the single-user constraint these warnings enforce.

/** The role string that marks the single human The Engineer reaches out to. */
export const OWNER_ROLE = "owner";

/** Distinguishes the people-config health problems The Engineer warns about. */
export type PeopleDirectoryWarningKind = "no_owner" | "multiple_people" | "unreachable_owner_channel";

/** A single people-config health warning: a kind, a plain-language message, and structured data. */
export interface PeopleDirectoryWarning {
  readonly kind: PeopleDirectoryWarningKind;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

/**
 * Inspect the configured people against the single-user constraint and the channels
 * communication plugins can actually deliver. Returns warnings only — never throws,
 * never fails. An empty array means the directory is healthy.
 */
export function inspectPeopleDirectory(
  people: readonly Person[],
  availableChannels: ReadonlySet<string>,
): PeopleDirectoryWarning[] {
  const warnings: PeopleDirectoryWarning[] = [];

  const owner = people.find((person) => person.roles.includes(OWNER_ROLE)) ?? null;

  if (!owner) {
    warnings.push({
      kind: "no_owner",
      message:
        "No owner is configured — The Engineer cannot reach you when a task is blocked, " +
        "needs additional context, or needs a decision during requirements gathering",
      data: { peopleCount: people.length },
    });
  }

  if (people.length > 1) {
    warnings.push({
      kind: "multiple_people",
      message: `${String(people.length)} people are configured, but v1 reaches only the owner — the others will not be contacted`,
      data: { peopleCount: people.length },
    });
  }

  if (owner) {
    for (const channel of unreachableChannels(owner, availableChannels)) {
      warnings.push({
        kind: "unreachable_owner_channel",
        message: `The owner has a "${channel}" contact, but no installed communication plugin handles the "${channel}" channel — messages on it cannot be delivered`,
        data: { channel },
      });
    }
  }

  return warnings;
}

/** The owner's contact channels that no available communication plugin can deliver, de-duplicated and in config order. */
function unreachableChannels(owner: Person, availableChannels: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const unreachable: string[] = [];
  for (const contact of owner.contacts) {
    if (availableChannels.has(contact.channel) || seen.has(contact.channel)) {
      continue;
    }
    seen.add(contact.channel);
    unreachable.push(contact.channel);
  }
  return unreachable;
}
