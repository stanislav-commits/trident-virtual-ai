import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import type { ChatContextReferenceDto } from "../../types/chat";
import {
  getChatDocumentOpenTarget,
  getChatSourceGroupKey,
  isDisplayableChatSourceReference,
  isHttpUrl,
  openChatDocumentSource,
} from "./chatSourceReferences";
import "../../styles/chat.css";

interface SourceCitationsProps {
  citations: ChatContextReferenceDto[];
  mode?: "inline" | "panel";
  onOpenPanel?: (citations: ChatContextReferenceDto[]) => void;
}

const DEFAULT_VISIBLE_SOURCES = 3;

/**
 * Display citations/sources for assistant messages
 * Shows documents, pages, and relevant snippets
 */
export function SourceCitations({
  citations,
  mode = "inline",
  onOpenPanel,
}: SourceCitationsProps) {
  const { token } = useAuth();
  const [isExpanded, setIsExpanded] = useState(false);
  const displayableCitations = useMemo(
    () => citations.filter(isDisplayableChatSourceReference),
    [citations],
  );

  const getDisplayTitle = (citation: ChatContextReferenceDto) => {
    const rawTitle = citation.sourceTitle?.trim();
    const rawUrl = citation.sourceUrl?.trim();

    if (rawTitle && !isHttpUrl(rawTitle)) {
      return rawTitle;
    }

    if (isHttpUrl(rawUrl)) {
      try {
        return new URL(rawUrl).hostname.replace(/^www\./i, "");
      } catch {
        return rawUrl;
      }
    }

    if (rawTitle) {
      return rawTitle;
    }

    return "Unknown source";
  };

  const getDisplayUrl = (citation: ChatContextReferenceDto) => {
    const rawUrl = citation.sourceUrl?.trim();
    if (!isHttpUrl(rawUrl)) {
      return null;
    }

    try {
      const parsed = new URL(rawUrl);
      return `${parsed.hostname.replace(/^www\./i, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
      return rawUrl;
    }
  };

  const handleOpenDocument = useCallback(
    (citation: ChatContextReferenceDto) => {
      const target = getChatDocumentOpenTarget(citation);
      if (!target) return;

      void openChatDocumentSource(target, token);
    },
    [token],
  );

  const groupedEntries = useMemo(
    () =>
      Object.entries(
        displayableCitations.reduce(
          (acc, citation) => {
            const key = getChatSourceGroupKey(citation);
            if (!acc[key]) {
              acc[key] = [];
            }
            acc[key].push(citation);
            return acc;
          },
          {} as Record<string, ChatContextReferenceDto[]>,
        ),
      ),
    [displayableCitations],
  );

  if (displayableCitations.length === 0) {
    return null;
  }

  const hasHiddenSources =
    mode === "inline" && groupedEntries.length > DEFAULT_VISIBLE_SOURCES;
  const visibleEntries =
    mode === "panel"
      ? groupedEntries
      : isExpanded
        ? groupedEntries
        : groupedEntries.slice(0, DEFAULT_VISIBLE_SOURCES);

  return (
    <div className="chat-sources">
      <div className="chat-sources__header">Sources</div>
      <div className="chat-sources__list">
        {visibleEntries.map(([source, items]) => {
          const primaryCitation = items[0];
          if (!primaryCitation) {
            return null;
          }

          const canOpenDocument = !!getChatDocumentOpenTarget(primaryCitation);
          const sourceUrl = isHttpUrl(primaryCitation.sourceUrl)
            ? primaryCitation.sourceUrl.trim()
            : null;
          const displayTitle = getDisplayTitle(primaryCitation);
          const displayUrl = getDisplayUrl(primaryCitation);
          const pages = [
            ...new Set(
              items
                .map((item) => item.pageNumber)
                .filter((page): page is number => page != null),
            ),
          ].sort((a, b) => a - b);

          return (
            <div
              key={source}
              className={`chat-source-item${canOpenDocument ? " chat-source-item--clickable" : ""}`}
              role={canOpenDocument ? "button" : undefined}
              tabIndex={canOpenDocument ? 0 : undefined}
              onClick={
                canOpenDocument
                  ? () => handleOpenDocument(primaryCitation)
                  : undefined
              }
              onKeyDown={
                canOpenDocument
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleOpenDocument(primaryCitation);
                      }
                    }
                  : undefined
              }
            >
              <div className="chat-source-item__title">
                <div className="chat-source-item__title-main">
                  {sourceUrl ? (
                    <a
                      className="chat-source-item__title-link"
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {displayTitle}
                    </a>
                  ) : (
                    <span className="chat-source-item__title-text">
                      {displayTitle}
                    </span>
                  )}
                  {displayUrl && (
                    <div className="chat-source-item__url">{displayUrl}</div>
                  )}
                </div>
                <div className="chat-source-item__meta">
                  {pages.length > 0 && (
                    <span className="chat-source-item__page">
                      p.&nbsp;{pages.join(", ")}
                    </span>
                  )}
                  {(canOpenDocument || sourceUrl) && (
                    <span
                      className="chat-source-item__open-icon"
                      title={canOpenDocument ? "Open document" : "Open source"}
                    >
                      {"\u2197"}
                    </span>
                  )}
                </div>
              </div>
              {primaryCitation.snippet && (
                <div className="chat-source-item__snippet">
                  {primaryCitation.snippet}
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
      {hasHiddenSources && (
        <button
          type="button"
          className="chat-sources__toggle"
          onClick={() => {
            if (onOpenPanel) {
              onOpenPanel(displayableCitations);
              return;
            }

            setIsExpanded((value) => !value);
          }}
        >
          {onOpenPanel
            ? `View all ${groupedEntries.length} references`
            : isExpanded
              ? "Show fewer references"
              : `View all ${groupedEntries.length} references`}
        </button>
      )}
    </div>
  );
}
