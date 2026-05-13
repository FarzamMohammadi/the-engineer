import type { ComponentProps, ReactNode } from "react";
import { ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "../../lib/cn";

interface ChartContainerProps {
  children: ReactNode;
  className?: string;
  height?: number;
}

/** Wraps Recharts charts in a responsive container with consistent sizing. */
export function ChartContainer({ children, className, height = 300 }: ChartContainerProps): React.JSX.Element {
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

/** Themed tooltip for Recharts charts. */
export function ChartTooltip(props: ComponentProps<typeof Tooltip>): React.JSX.Element {
  return (
    <Tooltip
      contentStyle={{
        backgroundColor: "oklch(0.17 0 0)",
        border: "1px solid oklch(0.3 0 0)",
        borderRadius: "0.375rem",
        padding: "0.5rem 0.75rem",
        fontSize: "0.75rem",
        color: "oklch(0.985 0 0)",
      }}
      labelStyle={{ color: "oklch(0.556 0 0)", marginBottom: "0.25rem" }}
      cursor={{ stroke: "oklch(0.3 0 0)" }}
      {...props}
    />
  );
}

/** Standard chart colors using CSS variable palette. */
export const CHART_COLORS = [
  "oklch(0.685 0.169 237.323)",
  "oklch(0.6 0.19 160)",
  "oklch(0.7 0.18 80)",
  "oklch(0.65 0.2 300)",
  "oklch(0.7 0.22 30)",
] as const;
