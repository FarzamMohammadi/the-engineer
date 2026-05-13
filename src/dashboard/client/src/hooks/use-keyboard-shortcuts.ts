import { useEffect } from "react";
import type { NavigateFunction } from "react-router";
import { useNavigate } from "react-router";
import { ROUTES } from "../lib/routes";

const SHORTCUT_ROUTES: Record<string, string> = {
  o: ROUTES.overview,
  t: ROUTES.tasks,
  a: ROUTES.activity,
  m: ROUTES.metrics,
  e: ROUTES.errors,
};

function isInputFocused(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function hasModifier(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

function createKeydownHandler(navigate: NavigateFunction): {
  handler: (e: KeyboardEvent) => void;
  cleanup: () => void;
} {
  let pendingG = false;
  let gTimer: ReturnType<typeof setTimeout> | null = null;

  function resetGChord(): void {
    pendingG = false;
    if (gTimer) {
      clearTimeout(gTimer);
    }
  }

  function startGChord(): void {
    pendingG = true;
    if (gTimer) {
      clearTimeout(gTimer);
    }
    gTimer = setTimeout(resetGChord, 500);
  }

  function navigateToChord(e: KeyboardEvent): void {
    resetGChord();
    const target = SHORTCUT_ROUTES[e.key];
    if (target) {
      e.preventDefault();
      navigate(target);
    }
  }

  function handler(e: KeyboardEvent): void {
    if (isInputFocused(e.target) || hasModifier(e)) {
      return;
    }
    if (e.key === "g") {
      startGChord();
      return;
    }
    if (pendingG) {
      navigateToChord(e);
    }
  }

  return { handler, cleanup: resetGChord };
}

export function useKeyboardShortcuts(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const { handler, cleanup } = createKeydownHandler(navigate);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      cleanup();
    };
  }, [navigate]);
}
