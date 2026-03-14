/**
 * Shared factory for creating the full Core component graph.
 *
 * Used by bootstrap.ts and test helpers to avoid duplicating wiring logic.
 * This is NOT a service locator — it creates and returns a plain object.
 * Components receive their dependencies through constructor injection.
 */
import type Database from "better-sqlite3";

import type { SafetyConfig, WorkspaceConfig } from "../schemas/config.js";
import { ActionPipeline } from "./action-pipeline/index.js";
import { EventBus } from "./event-bus/index.js";
import type { ISafetyLayer } from "./interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "./interfaces/session-memory.interface.js";
import type { ITaskEngine } from "./interfaces/task-engine.interface.js";
import { SafetyLayer } from "./safety-layer/index.js";
import { SessionMemory } from "./session-memory/index.js";
import { TaskEngine } from "./task-engine/index.js";
import { WorkspaceManager } from "./workspace-manager/index.js";

export interface CoreComponents {
  eventBus: EventBus;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: ActionPipeline;
  sessionMemory: ISessionMemory;
  workspaceManager: WorkspaceManager;
}

export interface CreateCoreInput {
  db: Database.Database;
  safetyConfig: SafetyConfig;
  workspaceConfig: WorkspaceConfig;
}

/**
 * Create all Core components with proper dependency wiring.
 * Does NOT create Registry, Orchestrator, Daemon, or PeopleDirectory —
 * those have additional dependencies (config, logger, etc.).
 */
export function createCoreComponents(input: CreateCoreInput): CoreComponents {
  const eventBus = new EventBus(input.db);
  const taskEngine = new TaskEngine(input.db, eventBus);
  const safetyLayer = new SafetyLayer(input.db, eventBus, input.safetyConfig);
  const actionPipeline = new ActionPipeline(taskEngine, safetyLayer, eventBus);
  const sessionMemory = new SessionMemory(input.db);
  const workspaceManager = new WorkspaceManager(eventBus, input.workspaceConfig);

  return { eventBus, taskEngine, safetyLayer, actionPipeline, sessionMemory, workspaceManager };
}
