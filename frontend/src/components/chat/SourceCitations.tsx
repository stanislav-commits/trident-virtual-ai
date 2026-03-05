import { useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import { fetchWithAuth } from "../../api/client";
import type { ChatContextReferenceDto } from "../../types/chat";
import "../../styles/chat.css";

interface SourceCitationsProps {
  citations: ChatContextReferenceDto[];
}

/**
 * Display citations/sources for assistant messages
 * Shows documents, pages, and relevant snippets
 */
export function SourceCitations({ citations }: SourceCitationsProps) {
  const { token } = useAuth();

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
        // silently fail — the source link just won't open
      }
    },
    [token],
  );

  if (!citations || citations.length === 0) {
    return null;
  }

  // Group citations by source for cleaner display
  const groupedBySource = citations.reduce(
    (acc, citation) => {
      const key = citation.sourceTitle || "Unknown";
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(citation);
      return acc;
    },
    {} as Record<string, ChatContextReferenceDto[]>,
  );

  return (
    <div className="chat-sources">
      <div className="chat-sources__header">Sources</div>
      <div className="chat-sources__list">
        {Object.entries(groupedBySource).map(([source, items]) => {
          const canOpen = !!(items[0]?.shipId && items[0]?.shipManualId);
          const pages = [
            ...new Set(
              items
                .map((i) => i.pageNumber)
                .filter((p): p is number => p != null),
            ),
          ].sort((a, b) => a - b);

          return (
            <div
              key={source}
              className={`chat-source-item${canOpen ? " chat-source-item--clickable" : ""}`}
              role={canOpen ? "button" : undefined}
              tabIndex={canOpen ? 0 : undefined}
              onClick={
                canOpen
                  ? () =>
                      handleOpenDocument(
                        items[0].shipId!,
                        items[0].shipManualId!,
                      )
                  : undefined
              }
              onKeyDown={
                canOpen
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ")
                        handleOpenDocument(
                          items[0].shipId!,
                          items[0].shipManualId!,
                        );
                    }
                  : undefined
              }
            >
              <div className="chat-source-item__title">
                {source}
                {pages.length > 0 && (
                  <span className="chat-source-item__page">
                    p.&nbsp;{pages.join(", ")}
                  </span>
                )}
                {canOpen && (
                  <span
                    className="chat-source-item__open-icon"
                    title="Open document"
                  >
                    ↗
                  </span>
                )}
              </div>
              {items[0]?.snippet && (
                <div className="chat-source-item__snippet">
                  {items[0].snippet}
                </div>
              )}
              {items.length > 1 && (
                <div className="chat-source-item__count">
                  +{items.length - 1} more references
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
