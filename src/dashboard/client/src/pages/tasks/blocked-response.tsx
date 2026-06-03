import { AlertTriangle, Send } from "lucide-react";
import { useState } from "react";
import { BlockBadges } from "../../components/shared/block-badges";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { useRespondToTask } from "../../hooks/use-tasks";
import type { BlockedDetails } from "../../types/api";

interface BlockedResponseProps {
  taskId: string;
  blocked: BlockedDetails | null;
}

/**
 * The blocked-task banner: the full block taxonomy (the coarse reason, the precise category, the sub-phase it
 * blocked in, and — most actionable — the `needed` next step) followed by the response box that unblocks it.
 * Reads only the real `BlockedDetails` fields; the phantom `question`/`context` fields never existed.
 */
export function BlockedResponse({ taskId, blocked }: BlockedResponseProps): React.JSX.Element {
  const [content, setContent] = useState("");
  const respondMutation = useRespondToTask(taskId);

  function handleSubmit(): void {
    if (!content.trim()) {
      return;
    }
    respondMutation.mutate(content.trim(), {
      onSuccess: () => setContent(""),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-amber-400">
          <AlertTriangle size={16} />
          Task Blocked — Needs Response
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {blocked && (
          <BlockBadges
            reason={blocked.reason}
            category={blocked.category}
            subPhase={blocked.sub_phase}
            needed={blocked.needed}
          />
        )}
        <div className="flex gap-2">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your response..."
            className="min-h-[80px] bg-background"
            disabled={respondMutation.isPending}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {respondMutation.isSuccess ? "Response sent" : "Cmd+Enter to send"}
          </span>
          <Button size="sm" onClick={handleSubmit} disabled={!content.trim() || respondMutation.isPending}>
            <Send size={14} />
            {respondMutation.isPending ? "Sending..." : "Send Response"}
          </Button>
        </div>
        {respondMutation.isError && (
          <p className="text-xs text-destructive">Failed to send: {respondMutation.error.message}</p>
        )}
      </CardContent>
    </Card>
  );
}
