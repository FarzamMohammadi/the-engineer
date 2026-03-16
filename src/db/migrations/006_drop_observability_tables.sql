-- Drop legacy observability tables — all data now flows through the unified
-- observations table (003_observer.sql). These tables were superseded when
-- ObservabilityStore was merged into the Observer system.
DROP TABLE IF EXISTS action_traces;
DROP TABLE IF EXISTS phase_metrics;
DROP TABLE IF EXISTS llm_traces;
