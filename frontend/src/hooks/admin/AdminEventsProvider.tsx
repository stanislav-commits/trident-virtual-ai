import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { getApiUrl } from "../../api/core";
import {
  AdminEventsContext,
  type AdminEvent,
  type AdminEventDomain,
  type AdminEventHandler,
} from "./adminEvents";

/**
 * Opens ONE SSE connection to the admin change-event stream for the whole
 * admin panel and fans events out to per-domain subscribers. Another admin's
 * mutation → an event here → the affected section re-fetches, so two people
 * with the panel open see each other's changes live. Auth is via
 * `?access_token=` (EventSource can't set headers); the browser auto-
 * reconnects if the stream drops.
 */
export function AdminEventsProvider({
  token,
  children,
}: {
  token: string | null;
  children: ReactNode;
}) {
  const handlers = useRef<Map<AdminEventDomain, Set<AdminEventHandler>>>(
    new Map(),
  );

  useEffect(() => {
    if (!token) return;
    const url = getApiUrl(
      `admin/events/stream?access_token=${encodeURIComponent(token)}`,
    );
    const source = new EventSource(url);
    source.onmessage = (message) => {
      let event: AdminEvent;
      try {
        event = JSON.parse(message.data) as AdminEvent;
      } catch {
        return;
      }
      const set = handlers.current.get(event.domain);
      if (!set) return;
      for (const handler of set) handler(event);
    };
    // onerror: EventSource auto-reconnects; nothing to do.
    return () => source.close();
  }, [token]);

  const subscribe = useCallback(
    (domain: AdminEventDomain, handler: AdminEventHandler) => {
      let set = handlers.current.get(domain);
      if (!set) {
        set = new Set();
        handlers.current.set(domain, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    [],
  );

  return (
    <AdminEventsContext.Provider value={{ subscribe }}>
      {children}
    </AdminEventsContext.Provider>
  );
}
