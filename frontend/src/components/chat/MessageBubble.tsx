import { useCallback, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { ChatMessageDto, ChatContextReferenceDto } from "../../types/chat";
import { useAuth } from "../../context/AuthContext";
import { fetchWithAuth } from "../../api/client";
import { SourceCitations } from "./SourceCitations";

interface MessageBubbleProps {
  message: ChatMessageDto;
  isLoading?: boolean;
  onCopy?: (content: string) => void;
  onRegenerate?: (messageId: string) => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Replace [1], [2] etc. with <cite-ref> custom elements so ReactMarkdown preserves them */
function injectCiteRefs(text: string): string {
  return text.replace(/\[(\d+)\]/g, '<cite-ref data-idx="$1"></cite-ref>');
}

function CitationBadge({
  idx,
  citations,
  onOpen,
}: {
  idx: number;
  citations: ChatContextReferenceDto[];
  onOpen?: (shipId: string, manualId: string) => void;
}) {
  const ref = citations[idx - 1];
  const title = ref
    ? `${ref.sourceTitle || "Document"}${ref.pageNumber ? ` — p. ${ref.pageNumber}` : ""}`
    : `Source [${idx}]`;
  const canOpen = !!(ref?.shipId && ref?.shipManualId && onOpen);

  return (
    <span
      className={`chat-cite-badge${canOpen ? " chat-cite-badge--clickable" : ""}`}
      title={title}
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={
        canOpen ? () => onOpen(ref.shipId!, ref.shipManualId!) : undefined
      }
      onKeyDown={
        canOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ")
                onOpen(ref.shipId!, ref.shipManualId!);
            }
          : undefined
      }
    >
      {idx}
    </span>
  );
}

function useMdComponents(
  citations: ChatContextReferenceDto[],
  onOpen?: (shipId: string, manualId: string) => void,
): Components {
  return useMemo(
    () => ({
      "cite-ref": ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...props
      }: any) => {
        const idx = Number(props["data-idx"]);
        if (!idx) return null;
        return (
          <CitationBadge idx={idx} citations={citations} onOpen={onOpen} />
        );
      },
    }),
    [citations, onOpen],
  ) as Components;
}

export function MessageBubble({
  message,
  isLoading = false,
  onCopy,
  onRegenerate,
}: MessageBubbleProps) {
  const { token, user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { id, role, content, createdAt, contextReferences, ragflowContext } =
    message;
  const refs = contextReferences ?? [];
  const telemetryShips = Array.isArray(ragflowContext?.telemetryShips)
    ? ragflowContext.telemetryShips
        .filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        )
        .map((v) => v.trim())
    : [];
  const noDocumentation = ragflowContext?.noDocumentation === true;

  const handleCopy = useCallback(() => {
    const text = content.trim();
    if (text && onCopy) onCopy(text);
    else if (text) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }, [content, onCopy]);

  const handleRegenerate = useCallback(() => {
    if (role === "assistant" && onRegenerate) onRegenerate(id);
  }, [role, id, onRegenerate]);

  const handleOpenDocument = useCallback(
    async (shipId: string, manualId: string) => {
      if (!token) return;
      try {
        const res = await fetchWithAuth(
          `ships/${shipId}/manuals/${manualId}/download`,
          { token },
        );
        if (!res.ok) throw new Error("Download failed");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch {
        // silently fail
      }
    },
    [token],
  );

  const mdComponents = useMdComponents(refs, handleOpenDocument);

  return (
    <div className={`chat-message chat-message--${role}`}>
      <div className="chat-message__content">
        {role === "assistant" && isAdmin && telemetryShips.length > 0 && (
          <div
            className="chat-message__telemetry-ships"
            aria-label="Telemetry ships"
          >
            {telemetryShips.map((name) => (
              <span key={name} className="chat-message__telemetry-ship">
                {name}
              </span>
            ))}
          </div>
        )}
        {role === "assistant" ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={mdComponents}
          >
            {refs.length > 0 ? injectCiteRefs(content.trim()) : content.trim()}
          </ReactMarkdown>
        ) : (
          content.trim()
        )}
      </div>

      {/* Show citations for assistant messages that have them */}
      {role === "assistant" &&
        contextReferences &&
        contextReferences.length > 0 && (
          <div className="chat-message__sources">
            <SourceCitations citations={contextReferences} />
          </div>
        )}

      {role === "assistant" && noDocumentation && refs.length === 0 && (
        <div className="chat-message__no-docs">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          No matching manual chunk for this query — answered from telemetry
          &amp; general knowledge
        </div>
      )}

      {isLoading && (
        <div className="typing-dots">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      )}

      {role !== "user" && (
        <div className="chat-message__time">{formatTime(createdAt)}</div>
      )}

      <div className="chat-message__actions">
        {role === "assistant" && (
          <button
            type="button"
            className="chat-message__action"
            onClick={handleCopy}
            title="Copy"
            aria-label="Copy message"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}
        {role === "assistant" && onRegenerate && !isLoading && (
          <button
            type="button"
            className="chat-message__action"
            onClick={handleRegenerate}
            title="Regenerate"
            aria-label="Regenerate response"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
