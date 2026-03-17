import type { ContactInfo, Person } from "../../schemas/adapters.js";

/**
 * Read-only interface for contact resolution.
 *
 * The concrete PeopleDirectory also exposes updateConfig() for hot-reload,
 * but consumers should depend on this interface — only bootstrap owns the
 * mutable instance.
 */
export interface IPeopleDirectory {
  /** Look up a person by their unique ID. */
  getPerson(id: string): Person | null;

  /** Get all people who have the given role. */
  getByRole(role: string): Person[];

  /** Convenience: first person with role "owner", or null. */
  getOwner(): Person | null;

  /** Convenience: all people with role "reviewer". */
  getReviewers(): Person[];

  /**
   * Resolve contact info for a person on a preferred channel.
   * Falls back to the person's first contact if the preferred channel
   * is not configured. Returns null if the person is not found or has
   * no contacts at all.
   */
  resolveContact(personId: string, preferredChannel: string): ContactInfo | null;

  /** Return all people in the directory. */
  getAll(): Person[];
}
