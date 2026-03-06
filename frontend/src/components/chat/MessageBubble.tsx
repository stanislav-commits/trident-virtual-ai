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
}: MessageBubbleProps) {
  const { token } = useAuth();
  const { role, content, createdAt, contextReferences } = message;
  const refs = contextReferences ?? [];

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
    </div>
  );
}
