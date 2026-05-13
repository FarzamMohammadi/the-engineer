/** Format a USD amount with 2-4 decimal places, showing extra precision below $0.01. */
export function formatCurrency(usd: number | null | undefined): string {
  if (usd == null) {
    return "$0.00";
  }
  if (usd < 0.01 && usd > 0) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/** Format milliseconds into a human-readable duration (e.g. "3m 12s", "1h 5m"). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms === 0) {
    return "—";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${String(hours)}h ${String(minutes)}m`;
}

/** Format a token count with k/M suffixes (e.g. "12.3k", "1.50M"). */
export function formatTokens(count: number | null | undefined): string {
  if (count == null || count === 0) {
    return "0";
  }
  if (count < 1_000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Format an ISO timestamp as a relative time string (e.g. "5m ago", "2d ago"). */
export function formatTimeAgo(isoString: string | null | undefined): string {
  if (!isoString) {
    return "—";
  }
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    return "just now";
  }
  if (diffMs < 5_000) {
    return "just now";
  }
  if (diffMs < 60_000) {
    return `${Math.floor(diffMs / 1_000)}s ago`;
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}m ago`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
  }
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/** Format an ISO timestamp as a 24-hour time string (HH:MM:SS). */
export function formatTimestamp(isoString: string | null | undefined): string {
  if (!isoString) {
    return "—";
  }
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Format an ISO timestamp as a localized date string (e.g. "May 12, 2026"). */
export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) {
    return "—";
  }
  return new Date(isoString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
