import { describe, expect, it } from "vitest";

import { PipelinePhaseSchema } from "../../../src/core/orchestrator/pipeline/types.js";
import {
  BLOCK_CATEGORIES,
  BLOCK_REASONS,
  OBSERVATION_TYPES,
  PHASES,
  TASK_STATES,
} from "../../../src/dashboard/client/src/lib/vocabulary.js";
import { ObservationTypeSchema } from "../../../src/schemas/observer.js";
import { BlockCategorySchema, BlockReasonSchema, TaskStateSchema } from "../../../src/schemas/task.js";

// ── Vocabulary parity ──────────────────────────────────────────────────────────────
//
// The client (src/dashboard/client) cannot import zod, so it carries a hand-mirrored copy of the engine's
// enums in `lib/vocabulary.ts`. This test is the lockstep guard: it reads each Zod enum's real `.options`
// and asserts set-equality with the client const array. A schema change that the mirror misses (the exact
// drift that left `self_review`/`demo_prep` in the old `Phase` type) fails CI here instead of shipping a
// dashboard that iterates a stale vocabulary. Each enum is sorted before comparison so order is irrelevant.

describe("dashboard client vocabulary parity with schema enums", () => {
  it("PHASES matches PipelinePhaseSchema", () => {
    expect([...PHASES].sort()).toEqual([...PipelinePhaseSchema.options].sort());
  });

  it("OBSERVATION_TYPES matches ObservationTypeSchema", () => {
    expect([...OBSERVATION_TYPES].sort()).toEqual([...ObservationTypeSchema.options].sort());
  });

  it("TASK_STATES matches TaskStateSchema", () => {
    expect([...TASK_STATES].sort()).toEqual([...TaskStateSchema.options].sort());
  });

  it("BLOCK_REASONS matches BlockReasonSchema", () => {
    expect([...BLOCK_REASONS].sort()).toEqual([...BlockReasonSchema.options].sort());
  });

  it("BLOCK_CATEGORIES matches BlockCategorySchema", () => {
    expect([...BLOCK_CATEGORIES].sort()).toEqual([...BlockCategorySchema.options].sort());
  });
});
