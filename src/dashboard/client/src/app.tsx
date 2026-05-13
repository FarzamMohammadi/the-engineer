import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router";
import { AppShell } from "./components/layout/app-shell";
import { TooltipProvider } from "./components/ui/tooltip";
import { ActivityPage } from "./pages/activity/activity-page";
import { ErrorsPage } from "./pages/errors/errors-page";
import { MetricsPage } from "./pages/metrics/metrics-page";
import { OverviewPage } from "./pages/overview/overview-page";
import { TaskDetailPage } from "./pages/tasks/task-detail-page";
import { TasksPage } from "./pages/tasks/tasks-page";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:taskId", element: <TaskDetailPage /> },
      { path: "tasks/:taskId/:tab", element: <TaskDetailPage /> },
      { path: "activity", element: <ActivityPage /> },
      { path: "metrics", element: <MetricsPage /> },
      { path: "errors", element: <ErrorsPage /> },
    ],
  },
]);

/** Root application component that provides routing, query client, and tooltip context. */
export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
