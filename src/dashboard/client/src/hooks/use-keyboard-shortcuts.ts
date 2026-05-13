import { useEffect } from "react";
import { useNavigate } from "react-router";
import { ROUTES } from "../lib/routes";

/** Global keyboard navigation: g+o (overview), g+t (tasks), g+a (activity), g+m (metrics), g+e (errors). */
export function useKeyboardShortcuts(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let pendingG = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "g") {
        pendingG = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => {
          pendingG = false;
        }, 500);
        return;
      }

      if (pendingG) {
        pendingG = false;
        if (gTimer) clearTimeout(gTimer);

        const routes: Record<string, string> = {
          o: ROUTES.overview,
          t: ROUTES.tasks,
          a: ROUTES.activity,
          m: ROUTES.metrics,
          e: ROUTES.errors,
        };
        const target = routes[e.key];
        if (target) {
          e.preventDefault();
          navigate(target);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [navigate]);
}
