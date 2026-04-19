import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { fetchWithAuth } from "../../api/core";
import type { ChatContextReferenceDto } from "../../types/chat";
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

  const isHttpUrl = (value?: string): value is string =>
    typeof value === "string" && /^https?:\/\//i.test(value.trim());

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
  const groupedEntries = useMemo(
    () =>
      Object.entries(
        citations.reduce(
          (acc, citation) => {
            const key =
              citation.sourceUrl?.trim() ||
              citation.sourceTitle?.trim() ||
              "Unknown";
            if (!acc[key]) {
              acc[key] = [];
            }
            acc[key].push(citation);
            return acc;
          },
          {} as Record<string, ChatContextReferenceDto[]>,
        ),
      ),
    [citations],
  );

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
          const canOpenManual = !!(items[0]?.shipId && items[0]?.shipManualId);
          const sourceUrl = isHttpUrl(items[0]?.sourceUrl)
            ? items[0].sourceUrl!.trim()
            : null;
          const displayTitle = getDisplayTitle(items[0]);
          const displayUrl = getDisplayUrl(items[0]);
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
              className={`chat-source-item${canOpenManual ? " chat-source-item--clickable" : ""}`}
              role={canOpenManual ? "button" : undefined}
              tabIndex={canOpenManual ? 0 : undefined}
              onClick={
                canOpenManual
                  ? () =>
                      handleOpenDocument(
                        items[0].shipId!,
                        items[0].shipManualId!,
                      )
                  : undefined
              }
              onKeyDown={
                canOpenManual
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
                <div className="chat-source-item__title-main">
                  {sourceUrl ? (
                    <a
                      className="chat-source-item__title-link"
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
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
                  {(canOpenManual || sourceUrl) && (
                    <span
                      className="chat-source-item__open-icon"
                      title={canOpenManual ? "Open document" : "Open source"}
                    >
                      ↗
                    </span>
                  )}
                </div>
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
      {hasHiddenSources && (
        <button
          type="button"
          className="chat-sources__toggle"
          onClick={() => {
            if (onOpenPanel) {
              onOpenPanel(citations);
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
