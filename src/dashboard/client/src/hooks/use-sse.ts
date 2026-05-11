import { useEffect, useRef, useState } from "react";

type SseEventType = "observation" | "event" | "heartbeat";
type SseCallback = (data: unknown) => void;

interface SseState {
  connected: boolean;
  reconnecting: boolean;
  lastEventId: string | null;
}

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function useSse(): SseState {
  const [state, setState] = useState<SseState>({ connected: false, reconnecting: false, lastEventId: null });
  const sourceRef = useRef<EventSource | null>(null);
  const listenersRef = useRef<Map<SseEventType, Set<SseCallback>>>(new Map());
  const retryMsRef = useRef(INITIAL_RETRY_MS);

  useEffect(() => {
    function handleSseMessage(listenersMap: Map<SseEventType, Set<SseCallback>>, eventType: SseEventType) {
      return (e: MessageEvent) => {
        const parsed: unknown = JSON.parse(e.data as string);
        const callbacks = listenersMap.get(eventType);
        if (callbacks) {
          for (const cb of callbacks) cb(parsed);
        }
        if (e.lastEventId) {
          setState((prev) => ({ ...prev, lastEventId: e.lastEventId }));
        }
      };
    }

    function connect(): void {
      const source = new EventSource("/api/stream");
      sourceRef.current = source;

      source.onopen = () => {
        retryMsRef.current = INITIAL_RETRY_MS;
        setState({ connected: true, reconnecting: false, lastEventId: null });
      };

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        setState((prev) => ({ ...prev, connected: false, reconnecting: true }));

        const delay = retryMsRef.current;
        retryMsRef.current = Math.min(delay * 2, MAX_RETRY_MS);
        setTimeout(connect, delay);
      };

      for (const eventType of ["observation", "event", "heartbeat"] as SseEventType[]) {
        source.addEventListener(eventType, handleSseMessage(listenersRef.current, eventType));
      }
    }

    connect();

    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  return state;
}

export function useSseSubscription(eventType: SseEventType, callback: SseCallback): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler: SseCallback = (data) => callbackRef.current(data);

    const listeners = sseListeners.get(eventType) ?? new Set();
    listeners.add(handler);
    sseListeners.set(eventType, listeners);

    return () => {
      listeners.delete(handler);
    };
  }, [eventType]);
}

const sseListeners = new Map<SseEventType, Set<SseCallback>>();
