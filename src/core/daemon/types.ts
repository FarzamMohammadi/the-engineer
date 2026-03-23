import type { DaemonConfig } from "../../schemas/config.js";
import type { Clock } from "../../utils/clock.js";
import type { DataLifecycleManager } from "../data-lifecycle/index.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";
import type { Orchestrator } from "../orchestrator/index.js";
import type { Registry } from "../registry/index.js";

// ── Canonical Daemon Context ────────────────────────────────────────────────

/** Shared dependencies available to all Daemon subsystems. */
export interface DaemonContext {
  config: DaemonConfig;
  eventBus: IEventBus;
  registry: Registry;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  orchestrator: Orchestrator;
  sessionMemory: ISessionMemory;
  workspaceManager: IWorkspaceManager;
  peopleDirectory: IPeopleDirectory;
  clock: Clock;
  observer: IObserver;
  engineerHome: string;
  dataLifecycleManager?: DataLifecycleManager;
}

// ── Per-Subsystem Narrowed Types ────────────────────────────────────────────

export type TriggerPollerContext = Pick<
  DaemonContext,
  "config" | "eventBus" | "registry" | "taskEngine" | "clock" | "observer"
>;

export type TaskSchedulerContext = Pick<
  DaemonContext,
  | "config"
  | "eventBus"
  | "taskEngine"
  | "orchestrator"
  | "sessionMemory"
  | "workspaceManager"
  | "observer"
>;

export type HealthMonitorContext = Pick<
  DaemonContext,
  | "config"
  | "eventBus"
  | "taskEngine"
  | "safetyLayer"
  | "orchestrator"
  | "sessionMemory"
  | "clock"
  | "observer"
>;

export type PreemptionManagerContext = Pick<
  DaemonContext,
  "config" | "eventBus" | "taskEngine" | "clock" | "observer"
>;

export type ReviewHandlerContext = Pick<
  DaemonContext,
  | "config"
  | "eventBus"
  | "registry"
  | "taskEngine"
  | "safetyLayer"
  | "workspaceManager"
  | "clock"
  | "observer"
>;

export type NotificationRouterContext = Pick<
  DaemonContext,
  "registry" | "taskEngine" | "peopleDirectory" | "eventBus" | "observer"
>;

export type ResponsePollerContext = Pick<
  DaemonContext,
  | "config"
  | "eventBus"
  | "registry"
  | "taskEngine"
  | "workspaceManager"
  | "peopleDirectory"
  | "observer"
>;
