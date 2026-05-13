import { Activity, AlertTriangle, BarChart3, Cog, LayoutDashboard, ListTodo } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "../../lib/cn";
import { ROUTES } from "../../lib/routes";

interface NavItem {
  to: string;
  icon: ReactNode;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: ROUTES.overview, icon: <LayoutDashboard size={18} />, label: "Overview" },
  { to: ROUTES.tasks, icon: <ListTodo size={18} />, label: "Tasks" },
  { to: ROUTES.activity, icon: <Activity size={18} />, label: "Activity" },
  { to: ROUTES.metrics, icon: <BarChart3 size={18} />, label: "Metrics" },
  { to: ROUTES.errors, icon: <AlertTriangle size={18} />, label: "Errors" },
];

/** Fixed left sidebar with navigation links to each dashboard section. */
export function SidebarNav(): React.JSX.Element {
  return (
    <aside className="flex h-screen w-52 flex-col border-r border-border bg-sidebar">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <Cog size={18} className="text-primary" />
        <span className="text-sm font-semibold text-foreground">The Engineer</span>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-sidebar-active"
                  : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <p className="text-[10px] text-muted-foreground/50">v0.0.1</p>
      </div>
    </aside>
  );
}
