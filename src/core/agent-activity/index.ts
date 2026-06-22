/**
 * Agent-activity module — the only both-sides mediator for live agent conversation.
 *
 * It consumes the canonical {@link AgentActivityEvent} (the adapter contract's plugin-agnostic vocabulary)
 * and writes each one as a durable `agent_activity` observation under the run's open `agent_call` span, so
 * the dashboard can play the conversation live and re-watch it afterward. It depends ONLY on that event type
 * and the observer interface — never on any plugin — so Plugin Opacity holds: delete every plugin and this
 * module still compiles and runs (inert, because nothing emits). The write path is best-effort and can never
 * fail the agent run (see {@link createActivitySink}).
 */
export { createActivitySink } from "./sink.js";
export { type ActivityParts, activityHasContent, type BlobDirective, mapActivity } from "./mapping.js";
