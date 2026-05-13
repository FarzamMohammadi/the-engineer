import { Badge } from "../../components/ui/badge";
import { Switch } from "../../components/ui/switch";
import { OBSERVATION_TYPE_LABELS } from "../../lib/constants";
import type { ObservationLevel, ObservationType } from "../../types/api";

const LEVEL_OPTIONS: { value: ObservationLevel; label: string; color: string }[] = [
  { value: "error", label: "Error", color: "bg-red-500/20 text-red-400 border-red-500/30" },
  { value: "warn", label: "Warn", color: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  { value: "info", label: "Info", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  { value: "debug", label: "Debug", color: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30" },
];

const TYPE_OPTIONS = Object.entries(OBSERVATION_TYPE_LABELS) as [ObservationType, string][];

interface ActivityFiltersProps {
  selectedTypes: Set<ObservationType>;
  onToggleType: (type: ObservationType) => void;
  selectedLevels: Set<ObservationLevel>;
  onToggleLevel: (level: ObservationLevel) => void;
  autoScroll: boolean;
  onToggleAutoScroll: () => void;
}

export function ActivityFilters({
  selectedTypes,
  onToggleType,
  selectedLevels,
  onToggleLevel,
  autoScroll,
  onToggleAutoScroll,
}: ActivityFiltersProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Level:</span>
        <div className="flex flex-wrap gap-1">
          {LEVEL_OPTIONS.map((opt) => (
            <Badge
              key={opt.value}
              variant="outline"
              className={`cursor-pointer text-[10px] transition-colors ${selectedLevels.has(opt.value) ? opt.color : "opacity-40"}`}
              onClick={() => onToggleLevel(opt.value)}
            >
              {opt.label}
            </Badge>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Auto-scroll</span>
          <Switch checked={autoScroll} onCheckedChange={onToggleAutoScroll} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Type:</span>
        <div className="flex flex-wrap gap-1">
          {TYPE_OPTIONS.map(([type, label]) => (
            <Badge
              key={type}
              variant="outline"
              className={`cursor-pointer text-[10px] transition-colors ${selectedTypes.has(type) ? "bg-primary/10 text-primary border-primary/30" : "opacity-40"}`}
              onClick={() => onToggleType(type)}
            >
              {label}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
