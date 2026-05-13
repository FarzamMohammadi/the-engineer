import { Outlet } from "react-router";
import { useKeyboardShortcuts } from "../../hooks/use-keyboard-shortcuts";
import { useSse } from "../../hooks/use-sse";
import { ErrorBoundary } from "../shared/error-boundary";
import { SidebarNav } from "./sidebar-nav";
import { SystemBar } from "./system-bar";

/** Top-level layout combining sidebar, system bar, and routed page content. */
export function AppShell(): React.JSX.Element {
  const sseState = useSse();
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen overflow-hidden">
      <SidebarNav />
      <div className="flex flex-1 flex-col overflow-hidden">
        <SystemBar sseConnected={sseState.connected} />
        <main className="flex-1 overflow-auto p-6">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
