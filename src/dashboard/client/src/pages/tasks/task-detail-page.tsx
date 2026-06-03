import { ArrowLeft, Ban, GanttChartSquare } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { PhasePipeline } from "../../components/shared/phase-pipeline";
import { StateBadge } from "../../components/shared/state-badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useSystemStatus } from "../../hooks/use-system-status";
import { useCancelTask, useTaskDetail } from "../../hooks/use-tasks";
import { ROUTES } from "../../lib/routes";
import type { Phase, TaskDetail } from "../../types/api";
import { BlockedResponse } from "./blocked-response";
import { TaskAgentTab } from "./task-agent-tab";
import { TaskOverviewTab } from "./task-overview-tab";
import { TaskPhasesTab } from "./task-phases-tab";
import { TaskTimelineTab } from "./task-timeline-tab";
import { TaskToolsTab } from "./task-tools-tab";

const TAB_ROUTES = ["overview", "timeline", "phases", "agent", "tools"] as const;
type TabValue = (typeof TAB_ROUTES)[number];

/** Single task detail page with tabbed views for overview, timeline, phases, agent calls, and tools. */
export function TaskDetailPage(): React.JSX.Element {
  const { taskId, tab } = useParams<{ taskId: string; tab?: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTaskDetail(taskId);
  const { data: systemStatus } = useSystemStatus();
  const cancelMutation = useCancelTask(taskId ?? "");

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
  const isCancellable = typedTask.state === "active" || typedTask.state === "queued" || typedTask.state === "blocked";

  // The Jaeger deep-link. Shown only when export is on AND this task has a trace yet. The OTLP id is derived
  // server-side from the dispatch's trace ULID (via the exporter's own deriveTraceId), so the link matches the
  // exported trace by construction. The UI base is the Jaeger web UI, distinct from the OTLP ingest endpoint.
  const traceUrl =
    systemStatus?.telemetry_enabled && typedTask.trace_otlp_id
      ? `${systemStatus.telemetry_ui_base}/trace/${typedTask.trace_otlp_id}`
      : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.tasks)}>
          <ArrowLeft size={16} />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold">{typedTask.title}</h1>
            <StateBadge state={typedTask.state} />
          </div>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-muted-foreground font-mono">{typedTask.id}</span>
            <PhasePipeline currentPhase={typedTask.phase} phasesRan={phasesFromDetail(typedTask)} />
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
          <TabsTrigger value="agent">Agent Calls</TabsTrigger>
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
        <TabsContent value="agent">
          <TaskAgentTab taskId={typedTask.id} />
        </TabsContent>
        <TabsContent value="tools">
          <TaskToolsTab taskId={typedTask.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Coarse heuristic for which phases a task has touched, from the detail record's presence flags. This is a
 * placeholder using the REAL phase vocabulary; S3 replaces it with the true distinct phases derived from the
 * task's phase_transition observations (the same `input.phase` source the list endpoint now reads).
 */
function phasesFromDetail(task: TaskDetail): Phase[] {
  const phases: Phase[] = [];
  if (task.workspace) {
    phases.push("execution");
  }
  if (task.review) {
    phases.push("review");
  }
  return phases;
}
