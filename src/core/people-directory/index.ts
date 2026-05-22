import type { ContactInfo, Person } from "../../schemas/adapters.js";
import type { PeopleConfig } from "../../schemas/config.js";
import { TeamMemberRoles } from "../../schemas/task.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import { OWNER_ROLE } from "./inspect.js";

export {
  type PeopleDirectoryWarning,
  type PeopleDirectoryWarningKind,
  inspectPeopleDirectory,
  OWNER_ROLE,
} from "./inspect.js";

// ── PeopleDirectory ──────────────────────────────────────────────────────────
// Config-driven contact resolution for notifications and escalation.
// Pure lookup table — no DB, no EventBus. Hot-reloadable via updateConfig().

export class PeopleDirectory implements IPeopleDirectory {
  private people: Map<string, Person>;

  constructor(config: PeopleConfig) {
    this.people = PeopleDirectory.buildMap(config);
  }

  /** Look up a person by their unique ID. */
  getPerson(id: string): Person | null {
    return this.people.get(id) ?? null;
  }

  /** Get all people who have the given role. */
  getByRole(role: string): Person[] {
    const result: Person[] = [];
    for (const person of this.people.values()) {
      if (person.roles.includes(role)) {
        result.push(person);
      }
    }
    return result;
  }

  /** Convenience: first person with role "owner", or null. */
  getOwner(): Person | null {
    return this.getByRole(OWNER_ROLE)[0] ?? null;
  }

  /** Convenience: all people with role "reviewer". */
  getReviewers(): Person[] {
    return this.getByRole(TeamMemberRoles.reviewer);
  }

  /**
   * Resolve contact info for a person on a preferred channel.
   *
   * Falls back to the person's first contact if the preferred channel
   * is not configured. Returns null if the person is not found or has
   * no contacts at all.
   *
   * The `plugin_id` is set to the contact's channel name — the Orchestrator
   * maps channel names to Registry plugin IDs.
   */
  resolveContact(personId: string, preferredChannel: string): ContactInfo | null {
    const person = this.people.get(personId);
    if (!person || person.contacts.length === 0) {
      return null;
    }

    const preferred = person.contacts.find((c) => c.channel === preferredChannel);
    const contact = preferred ?? person.contacts[0];
    if (!contact) {
      return null;
    }

    return {
      channel: contact.channel,
      handle: contact.handle,
      plugin_id: contact.channel,
    };
  }

  /** Return all people in the directory. */
  getAll(): Person[] {
    return [...this.people.values()];
  }

  /** Hot-reload: replace all people with a new config. */
  updateConfig(newConfig: PeopleConfig): void {
    this.people = PeopleDirectory.buildMap(newConfig);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private static buildMap(config: PeopleConfig): Map<string, Person> {
    const map = new Map<string, Person>();
    for (const person of config.people) {
      map.set(person.id, person);
    }
    return map;
  }
}
