import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * One progress event in the lifecycle of an assistant reply. `text` is
 * already human-readable (and localizable later) — the frontend renders it
 * verbatim under the spinner.
 */
export interface ChatProgressEvent {
  type:
    | 'planning'
    | 'ask_started'
    | 'tool'
    | 'composing'
    | 'delta'
    | 'delta_reset'
    | 'done'
    | 'error';
  text: string;
  /** Present on type='done' — the saved assistant message id. */
  messageId?: string;
  ts: number;
}

/**
 * In-memory pub/sub for chat reply progress, keyed by session id. The
 * generate-reply pipeline emits; the SSE endpoint subscribes. Subjects are
 * created lazily and torn down when the last subscriber disconnects, so an
 * abandoned tab doesn't leak.
 *
 * Deliberately NOT persistent: progress is ephemeral UX sugar. If the
 * browser reconnects mid-reply it simply picks up from the next event;
 * the final message always lands in the DB regardless.
 */
@Injectable()
export class ChatProgressBus {
  private readonly channels = new Map<
    string,
    { subject: Subject<ChatProgressEvent>; subscribers: number }
  >();

  emit(sessionId: string, event: Omit<ChatProgressEvent, 'ts'>): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return; // nobody listening — skip the work
    channel.subject.next({ ...event, ts: Date.now() });
  }

  subscribe(sessionId: string): Observable<ChatProgressEvent> {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = { subject: new Subject<ChatProgressEvent>(), subscribers: 0 };
      this.channels.set(sessionId, channel);
    }
    const owned = channel;
    owned.subscribers += 1;

    return new Observable<ChatProgressEvent>((observer) => {
      const sub = owned.subject.subscribe(observer);
      return () => {
        sub.unsubscribe();
        owned.subscribers -= 1;
        if (owned.subscribers <= 0) {
          this.channels.delete(sessionId);
        }
      };
    });
  }

  /** True when at least one SSE client is connected for this session. */
  hasListeners(sessionId: string): boolean {
    return (this.channels.get(sessionId)?.subscribers ?? 0) > 0;
  }
}
