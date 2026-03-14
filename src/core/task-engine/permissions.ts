import type { ActionClass, SubState, TaskState } from "../../schemas/task.js";
import { PermissionTable } from "../../schemas/task.js";
import type { PermissionResult } from "../interfaces/task-engine.interface.js";

/**
 * Gate 1 of the Action Pipeline: checks whether an action class is
 * permitted in the given state/sub_state.
 *
 * Pure function — no database, no side effects.
 */
export function checkPermission(
  state: TaskState,
  subState: SubState | null,
  actionClass: ActionClass,
): PermissionResult {
  const entry = PermissionTable.find((e) => e.state === state && e.sub_state === subState);

  if (!entry) {
    return {
      allowed: false,
      reason: `No permission entry for state ${state}.${subState ?? "null"}`,
    };
  }

  // Check if action is in the allowed list
  if ((entry.allowed as readonly string[]).includes(actionClass)) {
    return { allowed: true };
  }

  // Check conditional permissions
  if (entry.conditional) {
    const condition = (entry.conditional as Partial<Record<string, string>>)[actionClass];
    if (condition) {
      return { allowed: true, conditional: condition };
    }
  }

  const stateLabel = subState ? `${state}.${subState}` : state;
  return {
    allowed: false,
    reason: `Action "${actionClass}" not permitted in state ${stateLabel}`,
  };
}
