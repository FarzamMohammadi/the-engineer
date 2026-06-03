import { BlockBadges } from "../../components/shared/block-badges";
import { CostDisplay } from "../../components/shared/cost-display";
import { JsonViewer } from "../../components/shared/json-viewer";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { PHASE_LABELS, SUB_PHASE_LABELS } from "../../lib/constants";
import { formatDate, formatTokens } from "../../lib/formatters";
import type { Phase, TaskDetail } from "../../types/api";

interface TaskOverviewTabProps {
  task: TaskDetail;
}

/**
 * Overview tab: the at-a-glance answer to "where is this task, what has it cost, and — when blocked — what do
 * I need to do?". Surfaces the live pipeline position (phase / sub_phase / iteration / rework counts), the
 * cleanup signal (`reaped_at`), the legible block taxonomy via BlockBadges, and the structured artifacts.
 */
export function TaskOverviewTab({ task }: TaskOverviewTabProps): React.JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {task.blocked && <BlockedCard blocked={task.blocked} />}
      <DetailsCard task={task} />
      <CostCard task={task} />
      <TimestampsCard task={task} />
      <LastTransitionCard task={task} />
      <CriteriaCard criteria={task.acceptance_criteria} />
      <ArtifactCard title="Decisions" data={task.decisions} />
      <ArtifactCard title="Workspace" data={task.workspace} />
      <ArtifactCard title="Review" data={task.review} />
      <ArtifactCard title="External Reference" data={task.external_ref} />
    </div>
  );
}

function BlockedCard({ blocked }: { blocked: NonNullable<TaskDetail["blocked"]> }): React.JSX.Element {
  return (
    <Card className="border-amber-500/30 bg-amber-500/5 md:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-amber-400">Blocked</CardTitle>
      </CardHeader>
      <CardContent>
        <BlockBadges
          reason={blocked.reason}
          category={blocked.category}
          subPhase={blocked.sub_phase}
          needed={blocked.needed}
        />
      </CardContent>
    </Card>
  );
}

function DetailsCard({ task }: { task: TaskDetail }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          <DetailRow label="State" value={task.state} />
          {task.sub_state && <DetailRow label="Sub-state" value={task.sub_state} />}
          {task.phase && <DetailRow label="Phase" value={PHASE_LABELS[task.phase as Phase] ?? task.phase} />}
          {task.sub_phase && <DetailRow label="Sub-phase" value={SUB_PHASE_LABELS[task.sub_phase] ?? task.sub_phase} />}
          {task.phase_iteration > 1 && <DetailRow label="Iteration" value={String(task.phase_iteration)} />}
          {task.total_reworks > 0 && <DetailRow label="Reworks" value={String(task.total_reworks)} />}
          <DetailRow label="Priority" value={String(task.priority)} />
          {task.repo && <DetailRow label="Repository" value={task.repo} />}
          {task.branch && <DetailRow label="Branch" value={task.branch} />}
        </dl>
      </CardContent>
    </Card>
  );
}

function CostCard({ task }: { task: TaskDetail }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost & Tokens</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Agent Cost</dt>
            <dd>
              <CostDisplay amount={task.agent_cost_usd} size="sm" />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Tokens</dt>
            <dd className="font-mono text-xs tabular-nums">{formatTokens(task.agent_tokens)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function TimestampsCard({ task }: { task: TaskDetail }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timestamps</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          <TimestampRow label="Created" timestamp={task.created_at} />
          {task.started_at && <TimestampRow label="Started" timestamp={task.started_at} />}
          {task.completed_at && <TimestampRow label="Completed" timestamp={task.completed_at} />}
          {task.reaped_at && <TimestampRow label="Cleaned up" timestamp={task.reaped_at} />}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Last transition</dt>
            <dd>
              <TimeAgo timestamp={task.last_transition_at} />
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function LastTransitionCard({ task }: { task: TaskDetail }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last Transition</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          {task.last_transition_from && <DetailRow label="From" value={task.last_transition_from} />}
          {task.last_transition_by && <DetailRow label="Triggered by" value={task.last_transition_by} />}
          {task.last_transition_reason && (
            <div>
              <dt className="mb-1 text-muted-foreground">Reason</dt>
              <dd className="text-xs text-foreground/80">{task.last_transition_reason}</dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function CriteriaCard({ criteria }: { criteria: string[] | null }): React.JSX.Element | null {
  if (!criteria || criteria.length === 0) {
    return null;
  }
  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle>Acceptance Criteria</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-inside list-disc space-y-1 text-sm text-foreground/80">
          {criteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** A structured artifact (decisions / workspace / review / external ref) rendered as a drill-down JSON card. */
function ArtifactCard({ title, data }: { title: string; data: unknown }): React.JSX.Element | null {
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    return null;
  }
  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <JsonViewer data={data} defaultExpanded={true} />
      </CardContent>
    </Card>
  );
}

function TimestampRow({ label, timestamp }: { label: string; timestamp: string }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2">
        <span className="text-xs">{formatDate(timestamp)}</span>
        <TimeAgo timestamp={timestamp} />
      </dd>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
