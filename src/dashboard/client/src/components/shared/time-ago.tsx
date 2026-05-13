import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { formatTimeAgo } from "../../lib/formatters";

interface TimeAgoProps {
  timestamp: string | null | undefined;
  className?: string;
}

/** Live-updating relative timestamp that refreshes every 10 seconds. */
export function TimeAgo({ timestamp, className }: TimeAgoProps): React.JSX.Element {
  const [display, setDisplay] = useState(() => formatTimeAgo(timestamp));

  useEffect(() => {
    if (!timestamp) {
      return;
    }
    const interval = setInterval(() => setDisplay(formatTimeAgo(timestamp)), 10_000);
    return () => clearInterval(interval);
  }, [timestamp]);

  return (
    <time
      className={cn("text-xs text-muted-foreground", className)}
      dateTime={timestamp ?? undefined}
      title={timestamp ?? undefined}
    >
      {display}
    </time>
  );
}
