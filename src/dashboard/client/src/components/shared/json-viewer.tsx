import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";

interface JsonViewerProps {
  data: unknown;
  label?: string;
  defaultExpanded?: boolean;
  className?: string;
}

/** Recursively renders JSON data as a collapsible, syntax-highlighted tree. */
export function JsonViewer({ data, label, defaultExpanded = false, className }: JsonViewerProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (data === null || data === undefined) {
    return <span className="font-mono text-xs text-muted-foreground">null</span>;
  }

  if (typeof data !== "object") {
    return <span className="font-mono text-xs text-foreground">{formatPrimitive(data)}</span>;
  }

  const entries = Array.isArray(data) ? data.map((v, i) => [String(i), v] as const) : Object.entries(data);
  const isEmpty = entries.length === 0;
  const bracket = Array.isArray(data) ? ["[", "]"] : ["{", "}"];

  if (isEmpty) {
    return (
      <span className="font-mono text-xs text-muted-foreground">
        {label && <span className="text-foreground/70">{label}: </span>}
        {bracket[0]}
        {bracket[1]}
      </span>
    );
  }

  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-0.5 font-mono text-muted-foreground hover:text-foreground"
      >
        <ChevronRight size={12} className={cn("transition-transform", expanded && "rotate-90")} />
        {label && <span className="text-foreground/70">{label}: </span>}
        <span>
          {bracket[0]} {entries.length} {entries.length === 1 ? "entry" : "entries"} {bracket[1]}
        </span>
      </button>
      {expanded && (
        <div className="ml-4 border-l border-border/50 pl-3 pt-1 space-y-0.5">
          {entries.map(([key, value]) => (
            <div key={key}>
              {typeof value === "object" && value !== null ? (
                <JsonViewer data={value} label={key} />
              ) : (
                <div className="font-mono">
                  <span className="text-foreground/70">{key}</span>
                  <span className="text-muted-foreground">: </span>
                  <span className={valueColorClass(value)}>{formatPrimitive(value)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  return String(value);
}

function valueColorClass(value: unknown): string {
  if (value === null || value === undefined) {
    return "text-muted-foreground";
  }
  if (typeof value === "string") {
    return "text-emerald-400";
  }
  if (typeof value === "number") {
    return "text-blue-400";
  }
  if (typeof value === "boolean") {
    return "text-amber-400";
  }
  return "text-foreground";
}
