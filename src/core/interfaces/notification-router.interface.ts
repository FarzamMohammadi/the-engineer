import type { TaskStateChangedPayload } from "../../schemas/events.js";
import type { Notification } from "../../schemas/notifications.js";

/** Centralized outbound communication. All Core components route through here. */
export interface INotificationRouter {
  /** Send a typed notification. Resolves recipients, templates, and channel routing internally. */
  notify(notification: Notification): void;
  /** Sync task state change to communication plugins with sync capability. */
  syncStateToCommPlugin(payload: TaskStateChangedPayload): void;
}
