import { ActiveTasksCard } from "./active-tasks-card";
import { ActivitySnapshot } from "./activity-snapshot";
import { BlockedTasksCard } from "./blocked-tasks-card";
import { CostTicker } from "./cost-ticker";
import { DaemonStatus } from "./daemon-status";
import { RecentErrors } from "./recent-errors";

/** Dashboard home page with status cards and activity snapshot. */
export function OverviewPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Overview</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <DaemonStatus />
        <CostTicker />
        <RecentErrors />
        <BlockedTasksCard />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ActiveTasksCard />
        <ActivitySnapshot />
      </div>
    </div>
  );
}
