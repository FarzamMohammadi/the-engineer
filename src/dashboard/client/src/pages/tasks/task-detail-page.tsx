import { ArrowLeft, Ban, GanttChartSquare } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import { CurrentPhaseBadge } from "../../components/shared/current-phase-badge";
import { PhasePipeline } from "../../components/shared/phase-pipeline";
import { StateBadge } from "../../components/shared/state-badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useSystemStatus } from "../../hooks/use-system-status";
import { useCancelTask, useTaskDetail, useTaskPhases } from "../../hooks/use-tasks";
import { PHASE_ORDER } from "../../lib/constants";
import { readPhaseTransition } from "../../lib/observation-shapes";
import { ROUTES } from "../../lib/routes";
import type { Observation, Phase, TaskDetail, TaskState } from "../../types/api";
import { BlockedResponse } from "./blocked-response";
import { TaskAgentTab } from "./task-agent-tab";
import { TaskDecisionsTab } from "./task-decisions-tab";
import { TaskOverviewTab } from "./task-overview-tab";
import { TaskPhasesTab } from "./task-phases-tab";
import { TaskTimelineTab } from "./task-timeline-tab";
import { TaskToolsTab } from "./task-tools-tab";

const TAB_ROUTES = ["overview", "timeline", "phases", "decisions", "agent", "tools"] as const;
type TabValue = (typeof TAB_ROUTES)[number];

/** Task states a task can be cancelled from — mirrors CANCELLABLE_STATES (src/schemas/task.ts). */
const CANCELLABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "requirements_gathering",
  "queued",
  "active",
  "blocked",
]);

/** Single task detail page with tabbed views for overview, timeline, phases, decisions, steps, and tools. */
export function TaskDetailPage(): React.JSX.Element {
  const { taskId, tab } = useParams<{ taskId: string; tab?: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTaskDetail(taskId);
  const { data: phaseObservations } = useTaskPhases(taskId);
  const { data: systemStatus } = useSystemStatus();
  const cancelMutation = useCancelTask(taskId ?? "");

  const phasesRan = useMemo(() => distinctPhasesRan(phaseObservations ?? []), [phaseObservations]);

  const activeTab: TabValue = TAB_ROUTES.includes(tab as TabValue) ? (tab as TabValue) : "overview";

  function handleTabChange(value: string): void {
    if (!taskId) {
      return;
    }
    if (value === "overview") {
      navigate(ROUTES.taskDetail(taskId), { replace: true });
    } else {
      navigate(`/tasks/${taskId}/${value}`, { replace: true });
    }
  }

  if (isLoading || !task) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-96" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const typedTask = task as TaskDetail;
  const isBlocked = typedTask.state === "blocked";
  const isCancellable = CANCELLABLE_STATES.has(typedTask.state);
  // The current-phase pill is meaningful only while the task is mid-flight — on a terminal task the phase
  // would be stale. The dot pulses only when actively executing (a blocked task is paused, not live).
  const isLive = typedTask.state === "active" || typedTask.state === "requirements_gathering";
  const showCurrentPhase = typedTask.phase !== null && (isLive || typedTask.state === "blocked");

  // The Jaeger deep-link. Shown only when export is on AND this task has a trace yet. The OTLP id is derived
  // server-side from the dispatch's trace ULID (via the exporter's own deriveTraceId), so the link matches the
  // exported trace by construction. The UI base is the Jaeger web UI, distinct from the OTLP ingest endpoint.
  const traceUrl =
    systemStatus?.telemetry_enabled && typedTask.trace_otlp_id
      ? `${systemStatus.telemetry_ui_base}/trace/${typedTask.trace_otlp_id}`
      : null;

  return (
    <div className="space-y-4">
      <div className="mb-8 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.tasks)}>
          <ArrowLeft size={16} />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="truncate text-lg font-semibold">{typedTask.title}</h1>
            <StateBadge state={typedTask.state} />
            {showCurrentPhase && (
              <>
                <div className="h-4 w-px bg-border" />
                <CurrentPhaseBadge phase={typedTask.phase} subPhase={typedTask.sub_phase} live={isLive} />
              </>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground">{typedTask.id}</span>
            <PhasePipeline
              currentPhase={typedTask.phase}
              phasesRan={phasesRan}
              phaseIteration={typedTask.phase_iteration}
              totalReworks={typedTask.total_reworks}
            />
          </div>
        </div>
        {traceUrl && (
          <Button variant="outline" size="sm" asChild={true}>
            <a href={traceUrl} target="_blank" rel="noreferrer">
              <GanttChartSquare size={14} />
              View trace in Jaeger
            </a>
          </Button>
        )}
        {isCancellable && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
          >
            <Ban size={14} />
            Cancel
          </Button>
        )}
      </div>

      {isBlocked && <BlockedResponse taskId={typedTask.id} blocked={typedTask.blocked} />}

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="phases">Phases</TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="agent">Steps</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <TaskOverviewTab task={typedTask} />
        </TabsContent>
        <TabsContent value="timeline">
          <TaskTimelineTab taskId={typedTask.id} />
        </TabsContent>
        <TabsContent value="phases">
          <TaskPhasesTab taskId={typedTask.id} />
        </TabsContent>
        <TabsContent value="decisions">
          <TaskDecisionsTab taskId={typedTask.id} />
        </TabsContent>
        <TabsContent value="agent">
          <TaskAgentTab taskId={typedTask.id} taskActive={typedTask.state === "active"} />
        </TabsContent>
        <TabsContent value="tools">
          <TaskToolsTab taskId={typedTask.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The distinct real phases a task has run, derived from its phase_transition observations — the same honest
 * `input.phase` source the list endpoint reads (the observation `name` holds the event, not the phase). Kept
 * in canonical pipeline order so the PhasePipeline marks completed steps correctly. Replaces the old
 * `phasesFromDetail` hack that inferred phases from presence flags (workspace → execution, review → review).
 */
function distinctPhasesRan(observations: readonly Observation[]): Phase[] {
  const seen = new Set<Phase>();
  for (const obs of observations) {
    const { phase } = readPhaseTransition(obs);
    if ((PHASE_ORDER as readonly string[]).includes(phase)) {
      seen.add(phase as Phase);
    }
  }
  return PHASE_ORDER.filter((phase) => seen.has(phase));
}
