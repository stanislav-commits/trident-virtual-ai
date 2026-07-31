import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import type { ChatContextReferenceDto } from "../../types/chat";
import {
  CHAT_SOURCE_KIND_LABEL,
  getChatDocumentOpenTarget,
  getChatSourceGroupKey,
  getChatSourceKind,
  isDisplayableChatSourceReference,
  isHttpUrl,
  openChatDocumentSource,
  type ChatSourceKind,
} from "./chatSourceReferences";
import "../../styles/chat.css";

interface SourceCitationsProps {
  citations: ChatContextReferenceDto[];
  mode?: "inline" | "panel";
  onOpenPanel?: (citations: ChatContextReferenceDto[]) => void;
}

const DEFAULT_VISIBLE_SOURCES = 3;

/**
 * Past this many sources of one kind, the list stops being evidence and starts
 * being a data dump. A question about expiring certificates cited eighty of
 * them, one card each, under a four-line answer — collapsed to a single row
 * with a count, expandable for anyone who wants the list.
 */
const COLLAPSE_KIND_ABOVE = 6;

/**
 * Turn a retrieval snippet into something a person can read.
 *
 * Chunks come out of the index as they went in — often a slab of HTML table
 * markup ("<table><caption> EM 011 POWER FAILURE</caption> <tr><td>…"). Shown
 * raw under an answer it reads as a bug, not as evidence. Tags out, entities
 * decoded, whitespace collapsed, and clipped to a sentence or two: enough to
 * recognise the passage, not a second copy of the document.
 */
const SNIPPET_MAX_CHARS = 220;

function readableSnippet(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 3) return null;
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const clipped = text.slice(0, SNIPPET_MAX_CHARS);
  const lastStop = Math.max(
    clipped.lastIndexOf(". "),
    clipped.lastIndexOf("! "),
    clipped.lastIndexOf("? "),
  );
  return `${lastStop > 80 ? clipped.slice(0, lastStop + 1) : clipped.trimEnd()}…`;
}



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
  const [expandedKinds, setExpandedKinds] = useState<Set<ChatSourceKind>>(
    new Set(),
  );
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

  /**
   * Kinds that appear too many times to list one by one. Collapsing happens
   * per kind, so a handful of ship documents stay visible even when eighty
   * certificates alongside them are folded into one row.
   */
  const collapsedKinds = useMemo(() => {
    const counts = new Map<ChatSourceKind, number>();
    for (const [, items] of groupedEntries) {
      const kind = getChatSourceKind(items[0]);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .filter(([kind, count]) => count > COLLAPSE_KIND_ABOVE && !expandedKinds.has(kind))
        .map(([kind]) => kind),
    );
  }, [groupedEntries, expandedKinds]);

  const collapsedSummaries = useMemo(() => {
    const summary = new Map<ChatSourceKind, number>();
    for (const [, items] of groupedEntries) {
      const kind = getChatSourceKind(items[0]);
      if (collapsedKinds.has(kind)) {
        summary.set(kind, (summary.get(kind) ?? 0) + 1);
      }
    }
    return [...summary.entries()];
  }, [groupedEntries, collapsedKinds]);

  if (displayableCitations.length === 0) {
    return null;
  }

  const listedEntries = groupedEntries.filter(
    ([, items]) => !collapsedKinds.has(getChatSourceKind(items[0])),
  );
  const hasHiddenSources =
    mode === "inline" && listedEntries.length > DEFAULT_VISIBLE_SOURCES;
  const visibleEntries =
    mode === "panel"
      ? listedEntries
      : isExpanded
        ? listedEntries
        : listedEntries.slice(0, DEFAULT_VISIBLE_SOURCES);

  return (
    <div className="chat-sources">
      <div className="chat-sources__header">Sources</div>
      <div className="chat-sources__list">
        {collapsedSummaries.map(([kind, count]) => (
          <button
            key={`collapsed-${kind}`}
            type="button"
            className="chat-source-item chat-source-item--collapsed"
            onClick={() =>
              setExpandedKinds((prev) => new Set(prev).add(kind))
            }
          >
            <span className="chat-source-item__title-text">
              {CHAT_SOURCE_KIND_LABEL[kind]} records — {count}
            </span>
            <span className="chat-source-item__open-icon">{"\u2304"}</span>
          </button>
        ))}
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
                  <span
                    className={`chat-source-item__kind chat-source-item__kind--${getChatSourceKind(primaryCitation)}`}
                  >
                    {CHAT_SOURCE_KIND_LABEL[getChatSourceKind(primaryCitation)]}
                  </span>
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
              {readableSnippet(primaryCitation.snippet) && (
                <div className="chat-source-item__snippet">
                  {readableSnippet(primaryCitation.snippet)}
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
