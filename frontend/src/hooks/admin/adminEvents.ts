import { createContext, useContext, useEffect, useRef } from "react";

export type AdminEventDomain =
  | "inventory"
  | "pms"
  | "compliance"
  | "assets"
  | "crew"
  | "alerts"
  | "documents"
  | "users"
  | "ships"
  | "metrics"
  | "publications";

export interface AdminEvent {
  domain: AdminEventDomain;
  action: "created" | "updated" | "deleted";
  shipId: string | null;
  entityId?: string;
  ts: number;
}

export type AdminEventHandler = (event: AdminEvent) => void;

export interface AdminEventsContextValue {
  subscribe: (domain: AdminEventDomain, handler: AdminEventHandler) => () => void;
}

export const AdminEventsContext = createContext<AdminEventsContextValue | null>(
  null,
);

/**
 * Subscribe a section to live change events for one domain (broadcast when
 * ANOTHER admin mutates the same data). The handler is kept in a ref so the
 * subscription isn't torn down when it — or its closed-over `refresh`/
 * `shipId` — changes between renders.
 */
export function useAdminEvents(
  domain: AdminEventDomain,
  handler: AdminEventHandler,
): void {
  const ctx = useContext(AdminEventsContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(domain, (event) => handlerRef.current(event));
  }, [ctx, domain]);
}
