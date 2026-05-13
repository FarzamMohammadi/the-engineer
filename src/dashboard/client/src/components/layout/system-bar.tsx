import { Wifi, WifiOff } from "lucide-react";
import { useSystemStatus } from "../../hooks/use-system-status";
import { cn } from "../../lib/cn";
import { formatCurrency } from "../../lib/formatters";
import { Separator } from "../ui/separator";

interface SystemBarProps {
  sseConnected: boolean;
}

/** Top status bar displaying daemon health, task counts, spend, and SSE connection state. */
export function SystemBar({ sseConnected }: SystemBarProps): React.JSX.Element {
  const { data: status } = useSystemStatus();

  const activeTasks = status?.tasks_by_state?.["active"] ?? 0;
  const blockedTasks = status?.tasks_by_state?.["blocked"] ?? 0;

  return (
    <header className="flex h-10 items-center gap-3 border-b border-border bg-card/50 px-4">
      <DaemonDot running={status?.daemon_running ?? false} />
      <Separator orientation="vertical" className="h-4" />

      <Stat label="Active" value={activeTasks} />
      <Stat label="Blocked" value={blockedTasks} highlight={blockedTasks > 0} />
      <Stat label="Total" value={status?.total_tasks ?? 0} />

      <Separator orientation="vertical" className="h-4" />

      <span className="text-xs text-muted-foreground">
        Spend <span className="font-mono tabular-nums text-foreground">{formatCurrency(status?.total_spend_usd)}</span>
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        {sseConnected ? (
          <Wifi size={14} className="text-emerald-400" />
        ) : (
          <WifiOff size={14} className="text-red-400" />
        )}
        <span className={cn("text-[10px]", sseConnected ? "text-emerald-400" : "text-red-400")}>
          {sseConnected ? "Live" : "Disconnected"}
        </span>
      </div>
    </header>
  );
}

function DaemonDot({ running }: { running: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          running ? "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/50" : "bg-red-400",
        )}
      />
      <span className="text-xs text-muted-foreground">{running ? "Daemon running" : "Daemon stopped"}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: { label: string; value: number; highlight?: boolean }): React.JSX.Element {
  return (
    <span className="text-xs text-muted-foreground">
      {label}{" "}
      <span className={cn("font-mono tabular-nums", highlight ? "text-amber-400 font-medium" : "text-foreground")}>
        {value}
      </span>
    </span>
  );
}
