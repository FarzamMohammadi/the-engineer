import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens } from "../../lib/formatters";

interface TokenUsageProps {
  data: { input: number; output: number; cache_read: number; total: number } | undefined;
  isLoading: boolean;
}

export function TokenUsage({ data, isLoading }: TokenUsageProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={`sk-${String(i)}`}>
            <CardContent className="p-4">
              <Skeleton className="h-12 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const stats = [
    { label: "Input Tokens", value: data?.input ?? 0, color: "text-blue-400" },
    { label: "Output Tokens", value: data?.output ?? 0, color: "text-emerald-400" },
    { label: "Cache Read", value: data?.cache_read ?? 0, color: "text-amber-400" },
    { label: "Total", value: data?.total ?? 0, color: "text-foreground" },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
