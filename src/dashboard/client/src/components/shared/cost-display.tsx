import { cn } from "../../lib/cn";
import { formatCurrency } from "../../lib/formatters";

interface CostDisplayProps {
  amount: number | null | undefined;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function CostDisplay({ amount, className, size = "md" }: CostDisplayProps): React.JSX.Element {
  const sizeClasses = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-lg font-semibold",
  };

  return (
    <span className={cn("font-mono tabular-nums text-foreground", sizeClasses[size], className)}>
      {formatCurrency(amount)}
    </span>
  );
}
