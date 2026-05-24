import { CostDisplay } from "../../components/shared/cost-display";
import { JsonViewer } from "../../components/shared/json-viewer";
import { TimeAgo } from "../../components/shared/time-ago";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { formatDate, formatTokens } from "../../lib/formatters";
import type { TaskDetail } from "../../types/api";

interface TaskOverviewTabProps {
  task: TaskDetail;
}

/** Overview tab showing task details, cost, timestamps, acceptance criteria, and workspace info. */
export function TaskOverviewTab({ task }: TaskOverviewTabProps): React.JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <DetailRow label="State" value={task.state} />
            {task.sub_state && <DetailRow label="Sub-state" value={task.sub_state} />}
            {task.phase && <DetailRow label="Phase" value={task.phase} />}
            <DetailRow label="Priority" value={String(task.priority)} />
            {task.repo && <DetailRow label="Repository" value={task.repo} />}
            {task.branch && <DetailRow label="Branch" value={task.branch} />}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cost & Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">LLM Cost</dt>
              <dd>
                <CostDisplay amount={task.llm_cost_usd} size="sm" />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tokens</dt>
              <dd className="font-mono text-xs tabular-nums">{formatTokens(task.llm_tokens)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timestamps</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="flex items-center gap-2">
                <span className="text-xs">{formatDate(task.created_at)}</span>
                <TimeAgo timestamp={task.created_at} />
              </dd>
            </div>
            {task.started_at && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Started</dt>
                <dd className="flex items-center gap-2">
                  <span className="text-xs">{formatDate(task.started_at)}</span>
                  <TimeAgo timestamp={task.started_at} />
                </dd>
              </div>
            )}
            {task.completed_at && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Completed</dt>
                <dd className="flex items-center gap-2">
                  <span className="text-xs">{formatDate(task.completed_at)}</span>
                  <TimeAgo timestamp={task.completed_at} />
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Last transition</dt>
              <dd>
                <TimeAgo timestamp={task.last_transition_at} />
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

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
                <dt className="text-muted-foreground mb-1">Reason</dt>
                <dd className="text-xs text-foreground/80">{task.last_transition_reason}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {task.acceptance_criteria && task.acceptance_criteria.length > 0 && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Acceptance Criteria</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc list-inside space-y-1 text-sm text-foreground/80">
              {task.acceptance_criteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {task.decisions && task.decisions.length > 0 && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Decisions</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonViewer data={task.decisions} defaultExpanded={true} />
          </CardContent>
        </Card>
      )}

      {task.workspace && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonViewer data={task.workspace} defaultExpanded={true} />
          </CardContent>
        </Card>
      )}

      {task.review && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Review</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonViewer data={task.review} defaultExpanded={true} />
          </CardContent>
        </Card>
      )}

      {task.external_ref && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>External Reference</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonViewer data={task.external_ref} defaultExpanded={true} />
          </CardContent>
        </Card>
      )}
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
