/**
 * Shared factory for creating the full Core component graph.
 *
 * Used by bootstrap.ts and test helpers to avoid duplicating wiring logic.
 * This is NOT a service locator — it creates and returns a plain object.
 * Components receive their dependencies through constructor injection.
 */
import type Database from "better-sqlite3";

import type { SafetyConfig, WorkspaceConfig } from "../schemas/config.js";
import { EVENTS as ACTION_PIPELINE_EVENTS, ActionPipeline } from "./action-pipeline/index.js";
import { EventBus } from "./event-bus/index.js";
import { EventTopology } from "./event-bus/topology.js";
import type { IActionPipeline } from "./interfaces/action-pipeline.interface.js";
import type { IEventBus } from "./interfaces/event-bus.interface.js";
import type { ISafetyLayer } from "./interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "./interfaces/session-memory.interface.js";
import type { ITaskEngine } from "./interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "./interfaces/workspace-manager.interface.js";
import { EVENTS as SAFETY_LAYER_EVENTS, SafetyLayer } from "./safety-layer/index.js";
import { SessionMemory } from "./session-memory/index.js";
import { EVENTS as TASK_ENGINE_EVENTS, TaskEngine } from "./task-engine/index.js";
import { EVENTS as WORKSPACE_MANAGER_EVENTS, WorkspaceManager } from "./workspace-manager/index.js";

export interface CoreComponents {
  eventBus: IEventBus;
  topology: EventTopology;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  sessionMemory: ISessionMemory;
  workspaceManager: IWorkspaceManager;
}

export interface CreateCoreInput {
  db: Database.Database;
  safetyConfig: SafetyConfig;
  workspaceConfig: WorkspaceConfig;
  /** EventBus subscriber slow-callback warning threshold (ms). 0 = disabled. */
  subscriberWarnThresholdMs?: number;
}

/**
 * Create all Core components with proper dependency wiring.
 * Does NOT create Registry, Orchestrator, Daemon, or PeopleDirectory —
 * those have additional dependencies (config, logger, etc.).
 */
export function createCoreComponents(input: CreateCoreInput): CoreComponents {
  // Build event topology from core component declarations
  const topology = new EventTopology();
  topology.registerPublisher("task-engine", TASK_ENGINE_EVENTS);
  topology.registerPublisher("action-pipeline", ACTION_PIPELINE_EVENTS);
  topology.registerPublisher("safety-layer", SAFETY_LAYER_EVENTS);
  topology.registerPublisher("workspace-manager", WORKSPACE_MANAGER_EVENTS);

  const eventBusOptions: import("./event-bus/index.js").EventBusOptions = { topology };
  if (input.subscriberWarnThresholdMs !== undefined) {
    eventBusOptions.subscriberWarnThresholdMs = input.subscriberWarnThresholdMs;
  }
  const eventBus = new EventBus(input.db, eventBusOptions);
  const taskEngine = new TaskEngine(input.db, eventBus);
  const safetyLayer = new SafetyLayer(input.db, eventBus, input.safetyConfig);
  const actionPipeline = new ActionPipeline(taskEngine, safetyLayer, eventBus);
  const sessionMemory = new SessionMemory(input.db);
  const workspaceManager = new WorkspaceManager(eventBus, input.workspaceConfig);

  return {
    eventBus,
    topology,
    taskEngine,
    safetyLayer,
    actionPipeline,
    sessionMemory,
    workspaceManager,
  };
}
