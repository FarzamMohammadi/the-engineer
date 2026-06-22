/**
 * The effectful shell around the pure activity mapping: it turns each canonical {@link AgentActivityEvent}
 * the agent streams into a durable, live-streamable `agent_activity` observation nested under the open
 * `agent_call` span. It is the side channel's linchpin invariant in code — observation-only, and unable to
 * fail the run it watches: the whole per-event handler is wrapped, so any error (a malformed event, a blob
 * write, a store hiccup) degrades to a debug log and a return, never a throw back into the agent's loop.
 */

import type { AgentActivityEvent } from "../../schemas/adapters.js";
import { ObservationTypes, type SpanOptions } from "../../schemas/observer.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { IObserver } from "../observer/index.js";
import { type BlobDirective, activityHasContent, mapActivity } from "./mapping.js";

/**
 * Build the best-effort `on_activity` sink for one agent run. Each event the plugin emits becomes an
 * instant `agent_activity` observation whose `parent_observation_id` is the run's `agent_call` span, so
 * the dashboard reads it as a child of the call — live while the span is open, retroactive once closed.
 *
 * @param observer - the run's observer (writes observations + blobs; never imported by any plugin).
 * @param scope - the {task_id, session_id, trace_id, phase} correlation `traceScope` built for the run.
 * @param agentCallSpanId - the open `agent_call` span's id; every activity nests under it.
 */
export function createActivitySink(
  observer: IObserver,
  scope: SpanOptions,
  agentCallSpanId: string,
): (event: AgentActivityEvent) => void {
  const options: SpanOptions = { ...scope, parent_observation_id: agentCallSpanId };
  return (event) => {
    try {
      // An agent that withholds its reasoning/answer text streams a content-less chunk (e.g. a coding agent
      // whose CLI emits a signature-only thinking block). Record nothing for it so the conversation never
      // shows a hollow line — agent-agnostic, keyed off the empty payload, not the plugin behind it.
      if (!activityHasContent(event)) {
        return;
      }
      const parts = mapActivity(event);
      const data = { ...parts.data, ...storeBlobs(observer, parts.blobs) };
      observer.observe(ObservationTypes.agent_activity, parts.name, data, options);
    } catch (error) {
      // Invariant: the activity path can never throw into the agent run. Swallow, note, move on. The debug
      // note is itself wrapped — even a broken observer must not turn an observation-only feed into a failure.
      try {
        observer.debug("Agent activity sink dropped an event", { error: sanitizeErrorMessage(error) });
      } catch {
        // Nothing left to do — the side channel is fully dark, and that is still better than failing the run.
      }
    }
  };
}

/** Store each offloaded payload and return a `data` patch mapping each directive's field to its blob ref. */
function storeBlobs(observer: IObserver, blobs: readonly BlobDirective[]): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const blob of blobs) {
    refs[blob.field] = observer.storeBlob(blob.content);
  }
  return refs;
}
