import { useEffect, useRef, useState } from "react";
import { getApiUrl } from "../api/core";

export interface ChatProgressEvent {
  type:
    | "planning"
    | "ask_started"
    | "tool"
    | "composing"
    | "delta"
    | "delta_reset"
    | "done"
    | "error";
  text: string;
  messageId?: string;
  ts: number;
}

/**
 * Live progress for the assistant reply being generated. Opens an SSE
 * stream (`/chat-v2/sessions/:id/stream`) while `active` and surfaces the
 * latest human-readable progress line — "Analyzing telemetry…", "running
 * find running hours…" — so the user watches real activity instead of a
 * bare typing animation.
 *
 * `onDone` fires the moment the backend saves the assistant message, with
 * its id — letting the page fetch it immediately instead of waiting for
 * the next poll tick. Polling stays as the fallback transport: if SSE
 * drops (proxy, sleep, network), nothing breaks — the page still polls.
 */
export function useChatProgress(input: {
  sessionId: string | null;
  token: string | null;
  active: boolean;
  onDone?: (messageId: string) => void;
  onError?: (text: string) => void;
}) {
  const { sessionId, token, active } = input;
  const [progressText, setProgressText] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);
  // Keep callbacks in refs so the EventSource isn't torn down when the
  // parent re-renders with a new closure.
  const onDoneRef = useRef(input.onDone);
  const onErrorRef = useRef(input.onError);
  onDoneRef.current = input.onDone;
  onErrorRef.current = input.onError;

  useEffect(() => {
    if (!sessionId || !token || !active) {
      setProgressText(null);
      setDraftText(null);
      return;
    }

    const url = getApiUrl(
      `chat-v2/sessions/${sessionId}/stream?access_token=${encodeURIComponent(token)}`,
    );
    const source = new EventSource(url);

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as ChatProgressEvent;
        if (event.type === "done") {
          setProgressText(null);
          setDraftText(null);
          if (event.messageId) onDoneRef.current?.(event.messageId);
          return;
        }
        if (event.type === "error") {
          setProgressText(null);
          setDraftText(null);
          onErrorRef.current?.(event.text);
          return;
        }
        if (event.type === "delta") {
          setDraftText((prev) => (prev ?? "") + event.text);
          return;
        }
        if (event.type === "delta_reset") {
          setDraftText(null);
          return;
        }
        setProgressText(event.text);
      } catch {
        // Malformed event — ignore; polling still covers delivery.
      }
    };
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do. If the server is truly
      // gone, polling remains the fallback.
    };

    return () => {
      source.close();
      setProgressText(null);
      setDraftText(null);
    };
  }, [sessionId, token, active]);

  return { progressText, draftText };
}
