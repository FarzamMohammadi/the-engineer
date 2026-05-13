import { AlertCircle } from "lucide-react";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** Catches render errors in child components and displays a recovery UI. */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Dashboard error boundary caught:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-8">
          <AlertCircle size={24} className="text-red-400" />
          <p className="text-sm font-medium text-red-400">Something went wrong</p>
          <p className="max-w-md text-center text-xs text-muted-foreground">{this.state.error?.message}</p>
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
