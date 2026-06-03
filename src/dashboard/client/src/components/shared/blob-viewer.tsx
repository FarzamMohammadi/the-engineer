import { Check, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";
import { type BlobResult, fetchBlob, isBlobRef } from "../../lib/blob";
import { cn } from "../../lib/cn";
import { ScrollArea } from "../ui/scroll-area";

interface BlobViewerProps {
  /** A `prefix/hash` blob ref; `""`/null means the engine recorded no blob for this slot. */
  blobRef: string | null | undefined;
  /** Toggle label (e.g. "Prompt", "Response", "Transcript", "Diff"). */
  label: string;
  className?: string;
}

/**
 * Lazy drill-down into a blob-stored payload (prompt / response / transcript / diff). The blob is fetched
 * from `GET /api/blob/:prefix/:hash` only on first expand — large agent transcripts never load until the
 * observer asks for them. Empty refs render an inert placeholder; a 404 or network error renders a quiet
 * message instead of throwing. This is the deepest drill-down in the dashboard (coding-standards §14:
 * "bounded summary on top, full detail one click beneath it").
 */
export function BlobViewer({ blobRef, label, className }: BlobViewerProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<BlobResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasBlob = isBlobRef(blobRef);

  function handleToggle(): void {
    const next = !expanded;
    setExpanded(next);
    if (next && result === null && hasBlob) {
      setLoading(true);
      fetchBlob(blobRef)
        .then((fetched) => setResult(fetched))
        .catch((error: unknown) =>
          setResult({ status: "error", message: error instanceof Error ? error.message : "Load failed" }),
        )
        .finally(() => setLoading(false));
    }
  }

  function handleCopy(text: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }

  if (!hasBlob) {
    return (
      <div className={cn("text-xs text-muted-foreground/60", className)}>
        <span className="font-medium text-muted-foreground/70">{label}: </span>none recorded
      </div>
    );
  }

  const loadedText = result?.status === "loaded" ? result.text : null;

  return (
    <div className={cn("text-xs", className)}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleToggle}
          className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronRight size={12} className={cn("transition-transform", expanded && "rotate-90")} />
          {label}
        </button>
        {expanded && loadedText !== null && (
          <button
            type="button"
            onClick={() => handleCopy(loadedText)}
            className="inline-flex items-center gap-1 text-muted-foreground/70 hover:text-foreground"
            title="Copy to clipboard"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-1.5 rounded-md border border-border/60 bg-muted/30">{renderBody(loading, result)}</div>
      )}
    </div>
  );
}

function renderBody(loading: boolean, result: BlobResult | null): React.JSX.Element {
  if (loading || result === null) {
    return <p className="p-3 text-muted-foreground">Loading…</p>;
  }
  if (result.status === "not_found") {
    return <p className="p-3 text-muted-foreground/70">Blob no longer available (404).</p>;
  }
  if (result.status === "error") {
    return <p className="p-3 text-red-400">Failed to load: {result.message}</p>;
  }
  if (result.status === "empty" || result.text.length === 0) {
    return <p className="p-3 text-muted-foreground/60">Empty.</p>;
  }
  return (
    <ScrollArea className="max-h-80">
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
        {result.text}
      </pre>
    </ScrollArea>
  );
}
