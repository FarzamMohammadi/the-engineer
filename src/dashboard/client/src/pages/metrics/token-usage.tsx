import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens } from "../../lib/formatters";

interface TokenUsageProps {
  data: { input: number; output: number; cache_read: number; cache_creation: number; total: number } | undefined;
  isLoading: boolean;
}

/** Stat cards showing input, output, cache read, cache write, and total token counts. */
export function TokenUsage({ data, isLoading }: TokenUsageProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Card key={`sk-${String(i)}`}>
            <CardContent className="p-4">
              <Skeleton className="h-12 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // Cache write (cache_creation) is the most expensive token category per token — surfaced beside cache read so
  // the displayed token breakdown actually accounts for where the cost goes (cache writes are easy to miss).
  const stats = [
    { label: "Input Tokens", value: data?.input ?? 0, color: "text-blue-400" },
    { label: "Output Tokens", value: data?.output ?? 0, color: "text-emerald-400" },
    { label: "Cache Read", value: data?.cache_read ?? 0, color: "text-amber-400" },
    { label: "Cache Write", value: data?.cache_creation ?? 0, color: "text-orange-400" },
    { label: "Total", value: data?.total ?? 0, color: "text-foreground" },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardHeader className="pb-2">
            <CardTitle>{stat.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <span className={`text-2xl font-bold font-mono tabular-nums ${stat.color}`}>
              {formatTokens(stat.value)}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
