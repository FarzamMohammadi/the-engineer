import { describe, expect, it } from "vitest";

import { DispatchSchema } from "../../../src/schemas/ephemeral.js";
import { Phases } from "../../../src/schemas/orchestrator.js";
import { CheckpointReasons } from "../../../src/schemas/session-memory.js";
import { SubStates, TaskStates } from "../../../src/schemas/task.js";

describe("DispatchSchema", () => {
  const minimalTask = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    external_ref: null,
    idempotency_key: "test:dispatch",
    state: TaskStates.active,
    sub_state: SubStates.working,
    phase: Phases.execution,
    title: "Fix auth bug",
    description: "Users can't log in",
    source_text: "Issue body",
    acceptance_criteria: [],
    team: [],
    related: [],
    decisions: [],
    repo: null,
    workspace: null,
    review: null,
    blocked: null,
    return_to_phase: null,
    priority: 50,
    agent_tokens: 0,
    agent_cost_usd: 0,
    compute_time_ms: 0,
    created_at: "2026-03-10T12:00:00.000Z",
    started_at: "2026-03-10T12:01:00.000Z",
    completed_at: null,
    last_transition_at: "2026-03-10T12:01:00.000Z",
    clone_url: null,
    thoughts_id: null,
    session_id: "01SESSION",
  };

  it("parses valid dispatch with null resume_from", () => {
    const dispatch = DispatchSchema.parse({
      task: minimalTask,
      resume_from: null,
    });
    expect(dispatch.task.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(dispatch.resume_from).toBeNull();
  });

  it("parses dispatch with checkpoint", () => {
    const checkpoint = {
      id: "01CKPT",
      session_id: "01SESSION",
      task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      phase: Phases.execution,
      phase_progress: "50% through file changes",
      context_summary: "Implementing OAuth",
      key_findings: ["Found existing middleware"],
      open_questions: [],
      next_action: "Write tests",
      last_event_id: "01EVT",
      workspace_ref: { branch: "engineer/47-auth", last_commit: "abc123" },
      reason: CheckpointReasons.phase_transition,
      timestamp: "2026-03-10T12:30:00.000Z",
      journal_offset: 42,
    };

    const dispatch = DispatchSchema.parse({
      task: minimalTask,
      resume_from: checkpoint,
    });
    expect(dispatch.resume_from?.phase).toBe("execution");
  });
});
