/** Format an ISO timestamp as a human-readable relative age (e.g., "3m ago", "2h ago", "5d ago"). */
export function timeAgo(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) {
      return `${String(minutes)}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${String(hours)}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${String(days)}d ago`;
  } catch {
    return "unknown";
  }
}
