import type { ChatContextReferenceDto } from "../../types/chat";
import { isDisplayableChatSourceReference } from "./chatSourceReferences";
import { SourceCitations } from "./SourceCitations";

interface ChatSourcesPanelProps {
  citations: ChatContextReferenceDto[];
  onClose: () => void;
}

export function ChatSourcesPanel({
  citations,
  onClose,
}: ChatSourcesPanelProps) {
  const displayableCitations = citations.filter(isDisplayableChatSourceReference);
  const groupedSourceCount = new Set(
    displayableCitations.map(
      (citation) =>
        citation.sourceUrl?.trim() || citation.sourceTitle?.trim() || "Unknown",
    ),
  ).size;

  return (
    <aside
      className="chat-sources-panel"
      aria-label="All sources"
    >
      <div className="chat-sources-panel__header">
        <div className="chat-sources-panel__titles">
          <div className="chat-sources-panel__eyebrow">Sources</div>
          <h2 className="chat-sources-panel__title">All References</h2>
          <p className="chat-sources-panel__subtitle">
            {groupedSourceCount} source{groupedSourceCount === 1 ? "" : "s"} for
            this answer
          </p>
        </div>
        <button
          type="button"
          className="chat-sources-panel__close"
          onClick={onClose}
          aria-label="Close sources panel"
        >
          ×
        </button>
      </div>

      <div className="chat-sources-panel__body">
        <SourceCitations citations={displayableCitations} mode="panel" />
      </div>
    </aside>
  );
}
