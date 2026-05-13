import { AlertTriangle, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Textarea } from "../../components/ui/textarea";
import { useRespondToTask } from "../../hooks/use-tasks";

interface BlockedResponseProps {
  taskId: string;
  blocked: Record<string, unknown> | null;
}

export function BlockedResponse({ taskId, blocked }: BlockedResponseProps): React.JSX.Element {
  const [content, setContent] = useState("");
  const respondMutation = useRespondToTask(taskId);

  function handleSubmit(): void {
    if (!content.trim()) return;
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

  const reason = blocked?.["reason"] as string | undefined;
  const question = blocked?.["question"] as string | undefined;
  const context = blocked?.["context"] as string | undefined;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-amber-400">
          <AlertTriangle size={16} />
          Task Blocked — Needs Response
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reason && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Reason</span>
            <p className="text-sm text-foreground/90 mt-0.5">{reason}</p>
          </div>
        )}
        {question && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Question</span>
            <p className="text-sm text-foreground/90 mt-0.5">{question}</p>
          </div>
        )}
        {context && (
          <div>
            <span className="text-xs font-medium text-muted-foreground">Context</span>
            <p className="text-sm text-foreground/80 mt-0.5">{context}</p>
          </div>
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
