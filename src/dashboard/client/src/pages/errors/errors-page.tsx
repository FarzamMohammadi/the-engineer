import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "../../components/shared/empty-state";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { useErrors } from "../../hooks/use-errors";
import type { ErrorEntry } from "../../types/api";
import { ErrorList } from "./error-list";

type LevelFilter = "all" | "error" | "warn";

export function ErrorsPage(): React.JSX.Element {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const { data: errors, isLoading } = useErrors();

  const filtered = useMemo((): ErrorEntry[] => {
    if (!errors) return [];
    if (levelFilter === "all") return errors;
    return errors.filter((e) => e.level === levelFilter);
  }, [errors, levelFilter]);

  const counts = useMemo(() => {
    const errorCount = errors?.filter((e) => e.level === "error").length ?? 0;
    const warnCount = errors?.filter((e) => e.level === "warn").length ?? 0;
    return { error: errorCount, warn: warnCount };
  }, [errors]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Errors</h1>
        <span className="text-xs text-muted-foreground">{filtered.length} items</span>
      </div>

      <div className="flex gap-1">
        <FilterChip
          label="All"
          count={errors?.length ?? 0}
          active={levelFilter === "all"}
          onClick={() => setLevelFilter("all")}
        />
        <FilterChip
          label="Error"
          count={counts.error}
          active={levelFilter === "error"}
          onClick={() => setLevelFilter("error")}
          color="text-red-400"
        />
        <FilterChip
          label="Warn"
          count={counts.warn}
          active={levelFilter === "warn"}
          onClick={() => setLevelFilter("warn")}
          color="text-amber-400"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={`sk-${String(i)}`} className="h-20 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={levelFilter === "all" ? <ShieldCheck size={32} /> : <AlertTriangle size={32} />}
          title={levelFilter === "all" ? "No errors" : `No ${levelFilter} entries`}
          description={levelFilter === "all" ? "System healthy — no errors or warnings recorded" : undefined}
        />
      ) : (
        <ErrorList errors={filtered} />
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  color,
}: { label: string; count: number; active: boolean; onClick: () => void; color?: string }): React.JSX.Element {
  return (
    <Badge
      variant={active ? "default" : "outline"}
      className={`cursor-pointer text-xs transition-colors ${active ? "" : "opacity-60"} ${color ?? ""}`}
      onClick={onClick}
    >
      {label} ({count})
    </Badge>
  );
}
