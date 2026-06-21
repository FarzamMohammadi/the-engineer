import { describe, expect, it } from "vitest";
import { correlationFromTraceScope } from "../../../src/schemas/notifications.js";

describe("notifications", () => {
  describe("correlationFromTraceScope", () => {
    it("carries the trace context from a full pipeline scope", () => {
      const correlation = correlationFromTraceScope({
        task_id: "task-1",
        trace_id: "trace-1",
        session_id: "session-1",
        phase: "delivery",
        parent_observation_id: "root-obs",
      });

      expect(correlation).toEqual({
        trace_id: "trace-1",
        session_id: "session-1",
        phase: "delivery",
        parent_observation_id: "root-obs",
      });
    });

    it("drops task_id — the notification already carries its own", () => {
      const correlation = correlationFromTraceScope({ task_id: "task-1", trace_id: "trace-1" });

      expect(correlation).not.toHaveProperty("task_id");
      expect(correlation.trace_id).toBe("trace-1");
    });

    it("omits absent fields rather than setting them undefined, so no phase is fabricated", () => {
      // The pickup scope has no phase — the pipeline has not entered one yet.
      const correlation = correlationFromTraceScope({
        task_id: "task-1",
        trace_id: "trace-1",
        session_id: "session-1",
        parent_observation_id: "root-obs",
      });

      expect(correlation).not.toHaveProperty("phase");
      expect(Object.keys(correlation).sort()).toEqual(["parent_observation_id", "session_id", "trace_id"]);
    });
  });
});
