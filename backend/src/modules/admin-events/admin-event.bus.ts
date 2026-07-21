import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/** Admin-panel domains that broadcast change events. */
export type AdminEventDomain =
  | 'inventory'
  | 'pms'
  | 'compliance'
  | 'assets'
  | 'crew'
  | 'alerts'
  | 'documents'
  | 'users'
  | 'ships'
  | 'metrics'
  | 'publications';

/**
 * A change one admin made, broadcast so OTHER admins viewing the same data
 * refresh live. Deliberately coarse — `domain` + `action` is enough for the
 * client to decide "re-fetch this section"; we don't ship row payloads (the
 * receiving client re-reads through its normal, access-checked API).
 */
export interface AdminEvent {
  domain: AdminEventDomain;
  action: 'created' | 'updated' | 'deleted';
  /** Ship the change belongs to; null for platform-scoped domains
   *  (users / ships / publications). The client filters ship-scoped events
   *  to the vessel it currently has open. */
  shipId: string | null;
  /** The affected entity id, when known — lets a client skip echoes of its
   *  own optimistic change if it wants to. */
  entityId?: string;
  ts: number;
}

/**
 * In-memory pub/sub for admin-panel change events. One process today
 * (pm2, no cluster) so a single shared Subject fans out to every connected
 * admin SSE. NOT persistent: a reconnecting client simply resumes from the
 * next event and its section data is always re-fetched on (re)subscribe.
 * If the backend is ever clustered this needs a Redis (or similar) relay.
 */
@Injectable()
export class AdminEventBus {
  private readonly subject = new Subject<AdminEvent>();

  emit(event: Omit<AdminEvent, 'ts'>): void {
    this.subject.next({ ...event, ts: Date.now() });
  }

  subscribe(): Observable<AdminEvent> {
    return this.subject.asObservable();
  }
}
