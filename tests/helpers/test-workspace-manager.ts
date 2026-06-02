import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { z } from "zod";
import { EventBus, type EventRow, rowToEvent } from "../../src/core/event-bus/index.js";
import type { AuthUrlProvider } from "../../src/core/interfaces/workspace-manager.interface.js";
import type { IObserver } from "../../src/core/observer/index.js";
import { TaskEngine } from "../../src/core/task-engine/index.js";
import { WorkspaceManager } from "../../src/core/workspace-manager/index.js";
import type { WorkspaceConfigSchema } from "../../src/schemas/config.js";
import type { Event } from "../../src/schemas/events.js";
import { SecureValue } from "../../src/utils/secure-value.js";
import { type TestDatabaseHandle, createTestDatabase } from "./test-database.js";
import { createTestObserverFacade } from "./test-observer-facade.js";

type WorkspaceConfig = z.output<typeof WorkspaceConfigSchema>;

export interface TestWorkspaceManagerHandle {
  workspaceManager: WorkspaceManager;
  eventBus: EventBus;
  /** Real TaskEngine backing the workspace-manager's DB-backed reads. */
  taskEngine: TaskEngine;
  /** Path to the bare "remote" repository. */
  bareRepoDir: string;
  /** Path to the primary clone (acts as workspace_root/repoName). */
  cloneDir: string;
  /** Workspace root temp directory. */
  workspaceRoot: string;
  /** Repo name used in paths. */
  repoName: string;
  /** Insert a task row so workspace-manager's persistence writes have a target. */
  setupTask(taskId: string, options?: { title?: string }): void;
  /** Mint a fresh WorkspaceManager over the same DB — simulates a daemon restart. */
  createWorkspaceManager(): WorkspaceManager;
  /** Get all emitted events, optionally filtered by type. Reads from DB (source of truth). */
  getEmittedEvents(type?: string): Event[];
  /**
   * Assert that at least one event of the given type was emitted.
   * Optionally checks that at least one event's payload matches the predicate.
   * Throws a clear error if no matching event is found.
   */
  assertEventEmitted(type: string, payloadMatcher?: (payload: Record<string, unknown>) => boolean): void;
  /** Clean up all temp directories and close database. Call in afterEach. */
  cleanup(): void;
}

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Creates a WorkspaceManager backed by real git repos in temp directories.
 *
 * Sets up:
 * - A bare "remote" repository
 * - A clone at `{workspaceRoot}/{repoName}` (simulates the primary clone)
 * - An initial commit on `main` pushed to the bare remote
 * - An in-memory database + EventBus for event tracking
 */
/** Options for the test workspace manager. */
export interface TestWorkspaceManagerOptions {
  /** Observer the WorkspaceManager emits through. Defaults to a silent facade; pass a store-backed one to query workspace_op observations. */
  readonly observer?: IObserver;
}

export function createTestWorkspaceManager(options: TestWorkspaceManagerOptions = {}): TestWorkspaceManagerHandle {
  const baseDir = mkdtempSync(path.join(tmpdir(), "eng-ws-"));
  const bareRepoDir = path.join(baseDir, "remote.git");
  const workspaceRoot = path.join(baseDir, "workspaces");
  const repoName = "test-repo";
  const cloneDir = path.join(workspaceRoot, repoName);

  // Create bare remote
  execSync(`mkdir -p ${bareRepoDir}`, { stdio: "pipe" });
  git("init --bare --initial-branch=main", bareRepoDir);

  // Clone it to create the primary clone
  execSync(`mkdir -p ${workspaceRoot}`, { stdio: "pipe" });
  git(`clone ${bareRepoDir} ${cloneDir}`, workspaceRoot);

  // Create initial commit + push (so main branch exists)
  git("config user.email test@test.com", cloneDir);
  git("config user.name Test", cloneDir);
  execSync("touch README.md", { cwd: cloneDir, stdio: "pipe" });
  git("add README.md", cloneDir);
  git('commit -m "initial commit"', cloneDir);
  git("push origin main", cloneDir);

  // Set up DB + EventBus
  const testDb: TestDatabaseHandle = createTestDatabase();
  const observer = createTestObserverFacade("event-bus");
  const eventBus = new EventBus(testDb.db, { observer });

  const config: WorkspaceConfig = {
    workspace_root: workspaceRoot,
    branch_prefix: "engineer/",
    slug_max_length: 30,
    default_base_branch: "main",
    pr: {
      default_merge_strategy: "squash",
      branch_retention_days: null,
      skip_pr_creation: { default: false, repos: {} },
    },
    multi_repo: {
      enabled: true,
      max_repos_per_task: 5,
    },
  };

  // Test auth provider — passes URL through unchanged (local bare repos don't need auth)
  const authUrlProvider: AuthUrlProvider = (url) => new SecureValue(url);

  const taskEngine = new TaskEngine(testDb.db, eventBus, createTestObserverFacade("task-engine"));

  function buildWorkspaceManager(): WorkspaceManager {
    return new WorkspaceManager({
      eventBus,
      config,
      observer: options.observer ?? createTestObserverFacade("workspace-manager"),
      authUrlProvider,
      taskEngine,
    });
  }

  const workspaceManager = buildWorkspaceManager();

  const allEventsStmt = testDb.db.prepare("SELECT * FROM events ORDER BY sequence");
  const eventsByTypeStmt = testDb.db.prepare("SELECT * FROM events WHERE type = ? ORDER BY sequence");

  return {
    workspaceManager,
    eventBus,
    taskEngine,
    bareRepoDir,
    cloneDir,
    workspaceRoot,
    repoName,

    setupTask(taskId: string, options?: { title?: string }): void {
      taskEngine.createTask({
        title: options?.title ?? `Test task ${taskId}`,
        repo: repoName,
        source: "test",
        idempotency_key: `test:${taskId}`,
      });
      // TaskEngine generates its own id — overwrite with the desired test id for stable assertions.
      testDb.db.prepare("UPDATE tasks SET id = ? WHERE idempotency_key = ?").run(taskId, `test:${taskId}`);
    },

    createWorkspaceManager: buildWorkspaceManager,

    getEmittedEvents(type?: string): Event[] {
      const rows = (type ? eventsByTypeStmt.all(type) : allEventsStmt.all()) as EventRow[];
      return rows.map(rowToEvent);
    },

    assertEventEmitted(type: string, payloadMatcher?: (payload: Record<string, unknown>) => boolean): void {
      const events = this.getEmittedEvents(type);
      if (events.length === 0) {
        throw new Error(`Expected event "${type}" to be emitted, but none were found`);
      }
      if (payloadMatcher) {
        const match = events.some((e) => payloadMatcher(e.payload));
        if (!match) {
          throw new Error(
            `Event "${type}" was emitted ${events.length} time(s), but none matched the payload predicate`,
          );
        }
      }
    },

    cleanup() {
      testDb.cleanup();
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
