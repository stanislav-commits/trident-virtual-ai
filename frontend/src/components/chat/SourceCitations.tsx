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
        {Object.entries(groupedBySource).map(([source, items]) => (
          <div key={source} className="chat-source-item">
            <div className="chat-source-item__title">
              {source}
              {items[0]?.pageNumber && (
                <span className="chat-source-item__page">
                  p. {items[0].pageNumber}
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
        ))}
      </div>
    </div>
  );
}
