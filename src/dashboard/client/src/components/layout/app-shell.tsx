import { Outlet } from "react-router";
import { useSse } from "../../hooks/use-sse";
import { SidebarNav } from "./sidebar-nav";
import { SystemBar } from "./system-bar";

export function AppShell(): React.JSX.Element {
  const sseState = useSse();

  return (
    <div className="flex h-screen overflow-hidden">
      <SidebarNav />
      <div className="flex flex-1 flex-col overflow-hidden">
        <SystemBar sseConnected={sseState.connected} />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
