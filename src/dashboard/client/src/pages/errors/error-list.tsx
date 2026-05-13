import { ScrollArea } from "../../components/ui/scroll-area";
import type { ErrorEntry } from "../../types/api";
import { ErrorCard } from "./error-card";

interface ErrorListProps {
  errors: ErrorEntry[];
}

/** Scrollable list of error cards. */
export function ErrorList({ errors }: ErrorListProps): React.JSX.Element {
  return (
    <ScrollArea className="h-[calc(100vh-200px)]">
      <div className="space-y-2 pr-4">
        {errors.map((error) => (
          <ErrorCard key={error.id} error={error} />
        ))}
      </div>
    </ScrollArea>
  );
}
