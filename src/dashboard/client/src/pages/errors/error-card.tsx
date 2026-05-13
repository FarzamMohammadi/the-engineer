import { AlertCircle, AlertTriangle, ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/cn";
import { formatTimeAgo } from "../../lib/formatters";
import { ROUTES } from "../../lib/routes";
import type { ErrorEntry } from "../../types/api";

interface ErrorCardProps {
  error: ErrorEntry;
}

const KIND_LABELS: Record<string, string> = {
  task_failure: "Task Failure",
  observation: "Observation",
  event: "Event",
};

/** Error detail card with level-colored border, kind badge, and task click-through. */
export function ErrorCard({ error }: ErrorCardProps): React.JSX.Element {
  const isError = error.level === "error";
  const borderColor = isError ? "border-red-500/20" : "border-amber-500/20";
  const bgColor = isError ? "bg-red-500/5" : "bg-amber-500/5";

  return (
    <div className={cn("rounded-lg border p-4 transition-colors hover:bg-accent/50", borderColor, bgColor)}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {isError ? (
            <AlertCircle size={16} className="text-red-400" />
          ) : (
            <AlertTriangle size={16} className="text-amber-400" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {KIND_LABELS[error.kind] ?? error.kind}
            </Badge>
            <span className={cn("text-xs font-medium", isError ? "text-red-400" : "text-amber-400")}>
              {error.level}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">{formatTimeAgo(error.timestamp)}</span>
          </div>

          <p className="text-sm">{error.message}</p>

          {error.detail && <p className="text-xs text-muted-foreground">{error.detail}</p>}

          {error.task_id && (
            <Link
              to={ROUTES.taskDetail(error.task_id)}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {error.task_title ?? error.task_id.slice(0, 12)}
              <ArrowRight size={10} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
