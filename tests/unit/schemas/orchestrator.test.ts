import { describe, expect, it } from "vitest";

import {
  CommEventSchema,
  QuestionBatchSchema,
  QuestionSchema,
  SafetyQuerySchema,
  SafetyVerdictSchema,
} from "../../../src/schemas/orchestrator.js";
import { ActionClasses } from "../../../src/schemas/task.js";

// ── Communication Types ─────────────────────────────────────────────────────────

describe("CommEventSchema", () => {
  it("parses valid event", () => {
    const event = CommEventSchema.parse({
      type: "milestone",
      task_id: "01ABC",
      channel: "telegram",
      urgency: "immediate",
      content: "Task completed!",
      metadata: {},
    });
    expect(event.type).toBe("milestone");
  });

  it("accepts all event types", () => {
    for (const type of ["milestone", "question", "status_update", "alert", "digest"]) {
      expect(
        CommEventSchema.parse({
          type,
          task_id: "x",
          channel: "y",
          urgency: "batched",
          content: "z",
          metadata: {},
        }).type,
      ).toBe(type);
    }
  });

  it("accepts all urgency levels", () => {
    for (const urgency of ["immediate", "batched", "digest"]) {
      expect(
        CommEventSchema.parse({
          type: "alert",
          task_id: "x",
          channel: "y",
          urgency,
          content: "z",
          metadata: {},
        }).urgency,
      ).toBe(urgency);
    }
  });
});

describe("QuestionSchema", () => {
  it("parses valid question", () => {
    const q = QuestionSchema.parse({
      id: "q_01",
      question: "Which auth provider?",
      options: ["OAuth", "API Key", "JWT"],
      category: "architecture",
      urgency: "blocking",
    });
    expect(q.options).toHaveLength(3);
  });

  it("accepts null options", () => {
    const q = QuestionSchema.parse({
      id: "q_02",
      question: "What's the deadline?",
      options: null,
      category: "planning",
      urgency: "informational",
    });
    expect(q.options).toBeNull();
  });
});

describe("QuestionBatchSchema", () => {
  it("parses valid batch", () => {
    const batch = QuestionBatchSchema.parse({
      task_id: "01ABC",
      questions: [
        {
          id: "q_01",
          question: "Which auth?",
          options: null,
          category: "arch",
          urgency: "blocking",
        },
      ],
      batch_window_ms: 30_000,
    });
    expect(batch.questions).toHaveLength(1);
  });
});

// ── Safety Query / Verdict ──────────────────────────────────────────────────────

describe("SafetyQuerySchema", () => {
  it("parses valid query", () => {
    const query = SafetyQuerySchema.parse({
      type: "can_i",
      context: {
        task_id: "01ABC",
        repo: "owner/repo",
        action_class: ActionClasses.write,
        decision_category: null,
        details: { file: "src/auth.ts" },
      },
    });
    expect(query.type).toBe("can_i");
  });

  it("accepts all query types", () => {
    for (const type of ["can_i", "should_i_ask", "cost_check"]) {
      expect(
        SafetyQuerySchema.parse({
          type,
          context: {
            task_id: "x",
            repo: "y",
            action_class: null,
            decision_category: null,
            details: {},
          },
        }).type,
      ).toBe(type);
    }
  });
});

describe("SafetyVerdictSchema", () => {
  it("parses valid verdict", () => {
    const verdict = SafetyVerdictSchema.parse({
      allowed: true,
      action: "proceed",
      reason: "Within scope",
      warnings: null,
    });
    expect(verdict.action).toBe("proceed");
  });

  it("accepts all action types", () => {
    for (const action of ["proceed", "ask_human", "deny"]) {
      expect(
        SafetyVerdictSchema.parse({
          allowed: action === "proceed",
          action,
          reason: "test",
          warnings: null,
        }).action,
      ).toBe(action);
    }
  });

  it("accepts warnings array", () => {
    const verdict = SafetyVerdictSchema.parse({
      allowed: true,
      action: "proceed",
      reason: "OK but watch out",
      warnings: ["Approaching cost limit"],
    });
    expect(verdict.warnings).toHaveLength(1);
  });
});
