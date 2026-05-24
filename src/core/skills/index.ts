import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ObservationTypes } from "../../schemas/observer.js";
import type { IObserver } from "../observer/index.js";

// ── Source Path ───────────────────────────────────────────────────────────────

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Source location for portable skills (resources/skills/ at the repo root).
 *
 * Resolved at module load time as a fixed relative offset from this file. Works
 * identically in src/ (tsx) and dist/ (compiled) because both layouts mirror the
 * same depth from the repo root.
 */
const SKILLS_SOURCE_DIR = path.resolve(MODULE_DIR, "..", "..", "..", "resources", "skills");

// ── SkillsManager ─────────────────────────────────────────────────────────────

/**
 * Manages the runtime location of portable skills.
 *
 * Syncs skills from the source tree (resources/skills/) into the workspace root
 * so the LLM CLI can load them on demand. The runtime path is exposed via
 * `getDir()` for phase prompts that point the CLI at it.
 */
export class SkillsManager {
  private readonly workspaceRoot: string;
  private readonly observer: IObserver;

  constructor(workspaceRoot: string, observer: IObserver) {
    this.workspaceRoot = workspaceRoot;
    this.observer = observer;
  }

  /** Absolute path to `{workspace_root}/skills/` — the runtime location for portable skills. */
  getDir(): string {
    return path.join(this.workspaceRoot, "skills");
  }

  /**
   * Copy skills from the source tree (resources/skills/) to `{workspace_root}/skills/`.
   *
   * Graceful degradation: warns and returns if the source directory is missing.
   * Skills are an optional runtime resource — their absence reduces capability
   * (no portable skills loaded) but never blocks startup.
   */
  sync(): void {
    const span = this.observer.startSpan(ObservationTypes.lifecycle, "skills_sync", {
      source: SKILLS_SOURCE_DIR,
      target: this.getDir(),
    });

    if (!existsSync(SKILLS_SOURCE_DIR)) {
      this.observer.warn("Skills source directory not found — skipping sync", { source: SKILLS_SOURCE_DIR });
      span.end({ skipped: true, reason: "source_missing" });
      return;
    }

    const target = this.getDir();
    try {
      mkdirSync(target, { recursive: true });
      cpSync(SKILLS_SOURCE_DIR, target, { recursive: true });
      this.observer.info("Skills synced", { source: SKILLS_SOURCE_DIR, target });
      span.end({ skipped: false, target });
    } catch (error) {
      span.setError(error);
      span.end({ skipped: false, target });
      throw error;
    }
  }
}
