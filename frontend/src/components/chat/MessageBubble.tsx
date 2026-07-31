import { useCallback, useRef, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type {
  ChatChartDto,
  ChatMapDto,
  ChatTableDto,
  ChatKpiBlockDto,
  ChatMessageDto,
  ChatContextReferenceDto,
  ChatSuggestionActionDto,
  ChatMessageAttachmentDto,
} from "../../types/chat";
import { useAuth } from "../../context/AuthContext";
import { fetchChatAttachmentObjectUrl } from "../../api/chatApi";
import ChatChartBlock from "./ChatChartBlock";
import ChatMapBlock from "./ChatMapBlock";
import ChatTableBlock from "./ChatTableBlock";
import ChatKpiBlock from "./ChatKpiBlock";
import { SourceCitations } from "./SourceCitations";
import {
  type ChatDocumentOpenTarget,
  getChatDocumentOpenTarget,
  isDisplayableChatSourceReference,
  openChatDocumentSource,
} from "./chatSourceReferences";

/**
 * Sent when photos travel without a caption — the API needs some text. The
 * crew did not write it, so it is not shown as if they had.
 */
export const PHOTO_ONLY_CAPTION = "Photo attached.";

interface MessageBubbleProps {
  message: ChatMessageDto;
  isLoading?: boolean;
  onCopy?: (content: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSendMessage?: (text: string) => void;
  onOpenSourcesPanel?: (citations: ChatContextReferenceDto[]) => void;
  actionsDisabled?: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

interface AlertCard {
  title: string;
  asset?: string | null;
  severity?: string;
  value?: number | null;
  startedAt?: string;
}

/** A user message that was sent from the alerts panel ("Ask AI"). */
function parseAlertMessage(content: string): AlertCard | null {
  const PREFIX = "[[ALERT]]";
  if (!content.startsWith(PREFIX)) return null;
  const nl = content.indexOf("\n");
  const json = content.slice(PREFIX.length, nl > 0 ? nl : undefined);
  try {
    const c = JSON.parse(json) as AlertCard;
    return c && typeof c.title === "string" ? c : null;
  } catch {
    return null;
  }
}

interface TaskCard {
  title: string;
  asset?: string | null;
  category?: string;
  due?: string;
}

/** A user message that was sent from the PMS panel ("Ask AI"). */
function parseTaskMessage(content: string): TaskCard | null {
  const PREFIX = "[[TASK]]";
  if (!content.startsWith(PREFIX)) return null;
  const nl = content.indexOf("\n");
  const json = content.slice(PREFIX.length, nl > 0 ? nl : undefined);
  try {
    const c = JSON.parse(json) as TaskCard;
    return c && typeof c.title === "string" ? c : null;
  } catch {
    return null;
  }
}

// Reuses the alert card's structural classes (icon/body/title/meta) — same
// visual grammar for any "sent from a side panel" message, just a different
// accent and icon.
function TaskMessageCard({ card }: { card: TaskCard }) {
  const sc = "var(--status-warn, #e0a800)";
  return (
    <div className="chat-alert-card" style={{ borderLeftColor: sc }}>
      <span className="chat-alert-card__icon" style={{ color: sc }} aria-hidden>
        ✓
      </span>
      <div className="chat-alert-card__body">
        <div className="chat-alert-card__title">{card.title}</div>
        <div className="chat-alert-card__meta">
          {card.asset && <span>{card.asset}</span>}
          {card.category && (
            <span>
              {card.asset ? "· " : ""}
              {card.category}
            </span>
          )}
          {card.due && <span className="chat-alert-card__when">· {card.due}</span>}
        </div>
      </div>
    </div>
  );
}

function alertSeverityColor(s?: string): string {
  if (s === "critical") return "var(--status-danger, #d9534f)";
  if (s === "high" || s === "warning") return "var(--status-warn, #e0a800)";
  return "var(--chat-text-muted)";
}

function AlertMessageCard({ card }: { card: AlertCard }) {
  const sc = alertSeverityColor(card.severity);
  const when = card.startedAt
    ? new Date(card.startedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="chat-alert-card" style={{ borderLeftColor: sc }}>
      <span className="chat-alert-card__icon" style={{ color: sc }} aria-hidden>
        ▲
      </span>
      <div className="chat-alert-card__body">
        <div className="chat-alert-card__title">{card.title}</div>
        <div className="chat-alert-card__meta">
          {card.asset && <span>{card.asset}</span>}
          {card.severity && (
            <span style={{ color: sc, textTransform: "capitalize" }}>
              {card.asset ? "· " : ""}
              {card.severity}
            </span>
          )}
          {card.value != null && <span>· {card.value.toFixed(1)}</span>}
          {when && <span className="chat-alert-card__when">· {when}</span>}
        </div>
      </div>
    </div>
  );
}

/** Replace [1], [2] etc. with <cite-ref> custom elements so ReactMarkdown preserves them */
function injectCiteRefs(text: string): string {
  return text.replace(/\[(\d+)\]/g, '<cite-ref data-idx="$1"></cite-ref>');
}

function normalizeMathLikeFormatting(text: string): string {
  return text
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\\text\{([^{}]+)\}/g, "$1")
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1 / $2)")
    .replace(/\\lceil\s*/g, "ceil(")
    .replace(/\s*\\rceil/g, ")")
    .replace(/\\times/g, "\u00d7")
    .replace(/\\cdot/g, "\u00b7")
    .replace(/\\left/g, "")
    .replace(/\\right/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function stripLegacyInteractiveMarkup(text: string): string {
  return text
    .replace(/<\/?action-button>/gi, "")
    .replace(/<\/?high-light>/gi, "");
}

/** Safety net: hide raw metric keys (bucket::measurement::field) if they slip
 *  through the model despite the output-hygiene prompt. */
function stripTechnicalIdentifiers(text: string): string {
  return text
    .replace(/\(?\b[A-Za-z0-9_.-]+::[A-Za-z0-9_.-]+::[A-Za-z0-9_.-]+\b\)?/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1");
}

function normalizeEscapedMarkdown(text: string): string {
  return text.replace(/\\([*_`~])/g, "$1");
}

function normalizeMojibakePunctuation(text: string): string {
  return text
    .replace(/\u0432\u0402\u201d|\u00e2\u20ac\u201d/g, "-")
    .replace(/\u0432\u0402\u201c|\u00e2\u20ac\u201c/g, "-")
    .replace(
      /\u0432\u0402\u2122|\u0432\u0402\u02dc|\u00e2\u20ac\u2122|\u00e2\u20ac\u02dc/g,
      "'",
    )
    .replace(
      /\u0432\u0402\u0459|\u0432\u0402\u045a|\u00e2\u20ac\u0153|\u00e2\u20ac\u009d/g,
      '"',
    )
    .replace(/\u0412\u00b0|\u00c2\u00b0/g, "\u00b0")
    .replace(/\u0412\u00b7|\u00c2\u00b7/g, "\u00b7")
    .replace(/\u0413\u2014/g, "x")
    .replace(/\u00c2/g, "");
}

function extractInlineButtonActions(text: string): {
  cleanedText: string;
  actions: ChatSuggestionActionDto[];
} {
  const matches = [...text.matchAll(/\[BUTTON:\s*([^\]]+?)\s*\]/gi)];
  const seen = new Set<string>();
  const actions: ChatSuggestionActionDto[] = [];

  matches.forEach((match) => {
    const label = match[1]?.trim();
    const normalizedLabel = label?.toLowerCase();
    if (!label || !normalizedLabel || seen.has(normalizedLabel)) {
      return;
    }

    seen.add(normalizedLabel);
    actions.push({
      label,
      message: label,
    });
  });

  const cleanedText = text
    .replace(/\[BUTTON:\s*[^\]]+?\s*\]/gi, "")
    .replace(/Would you like to:\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanedText, actions };
}

function CitationBadge({
  idx,
  citations,
  onOpen,
}: {
  idx: number;
  citations: ChatContextReferenceDto[];
  onOpen?: (target: ChatDocumentOpenTarget) => void;
}) {
  const ref = citations[idx - 1];
  if (!isDisplayableChatSourceReference(ref)) {
    return null;
  }

  const title = `${ref.sourceTitle || "Document"}${ref.pageNumber ? ` \u2014 p. ${ref.pageNumber}` : ""}`;
  const openTarget = getChatDocumentOpenTarget(ref);
  const canOpen = !!(openTarget && onOpen);
  const normalizedTitle = normalizeMojibakePunctuation(title);

  return (
    <span
      className={`chat-cite-badge${canOpen ? " chat-cite-badge--clickable" : ""}`}
      title={normalizedTitle}
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={canOpen ? () => onOpen(openTarget) : undefined}
      onKeyDown={
        canOpen
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(openTarget);
              }
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
  onOpen?: (target: ChatDocumentOpenTarget) => void,
): Components {
  return useMemo(
    () =>
      ({
        "cite-ref": (props: { "data-idx"?: string | number }) => {
          const idx = Number(props["data-idx"]);
          if (!idx) return null;
          return (
            <CitationBadge idx={idx} citations={citations} onOpen={onOpen} />
          );
        },
      }) as Components,
    [citations, onOpen],
  );
}

/** Bearer-authenticated thumbnail of a photo the user attached ("+ attach").
 *  Session id comes from the route — attachments are session-scoped. */
function UserAttachmentThumb({
  attachment,
  token,
}: {
  attachment: ChatMessageAttachmentDto;
  token: string | null;
}) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [url, setUrl] = useState<string | null>(null);
  // Opens INSIDE the app instead of a new browser tab — a blob: tab loses
  // the chat and cannot be navigated back to the conversation.
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoomed(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoomed]);
  useEffect(() => {
    if (!token || !sessionId) return;
    let objectUrl: string | null = null;
    let alive = true;
    void fetchChatAttachmentObjectUrl(sessionId, attachment.id, token)
      .then((u) => {
        objectUrl = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, sessionId, attachment.id]);

  if (!url) return <div className="chat-message__attachment chat-message__attachment--loading">…</div>;
  return (
    <>
      <button
        type="button"
        className="chat-message__attachment"
        onClick={() => setZoomed(true)}
        title={attachment.name}
        aria-label={`Open ${attachment.name}`}
      >
        <img src={url} alt={attachment.name} />
      </button>
      {zoomed &&
        // Portal to <body>: inside the bubble the thumbnail's own sizing
        // rules cascade onto the full-size image and shrink it to 88px.
        createPortal(
          <div
            className="chat-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={attachment.name}
            onClick={() => setZoomed(false)}
          >
            <button
              type="button"
              className="chat-lightbox__close"
              onClick={() => setZoomed(false)}
              aria-label="Close"
            >
              ×
            </button>
            <img
              className="chat-lightbox__img"
              src={url}
              alt={attachment.name}
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

export function MessageBubble({
  message,
  isLoading = false,
  onCopy,
  onRegenerate,
  onSendMessage,
  onOpenSourcesPanel,
  actionsDisabled = false,
}: MessageBubbleProps) {
  const { token, user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { id, role, content, createdAt, contextReferences, ragflowContext } =
    message;
  const refs = useMemo(() => contextReferences ?? [], [contextReferences]);
  const displayableRefs = useMemo(
    () => refs.filter(isDisplayableChatSourceReference),
    [refs],
  );
  // Chart click-to-ask UI strings (button labels + composed question),
  // translated server-side into whatever language this turn answered in —
  // works for any language the crew chats in, not a fixed pair.
  const chartLabels = ragflowContext?.chartLabels;
  const telemetryShips = Array.isArray(ragflowContext?.telemetryShips)
    ? ragflowContext.telemetryShips
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => value.trim())
    : [];
  // Charts the metric analyzer drew (render_chart) ride on the ask results.
  const charts: ChatChartDto[] = Array.isArray(ragflowContext?.askResults)
    ? ragflowContext.askResults.flatMap((ask) =>
        Array.isArray(ask?.data?.charts)
          ? ask.data.charts.filter(
              (c): c is ChatChartDto =>
                !!c &&
                typeof c === "object" &&
                typeof c.title === "string" &&
                Array.isArray(c.series),
            )
          : [],
      )
    : [];
  // Vessel-track maps the analyzer drew (render_map) ride on the ask results.
  const maps: ChatMapDto[] = Array.isArray(ragflowContext?.askResults)
    ? ragflowContext.askResults.flatMap((ask) =>
        Array.isArray(ask?.data?.maps)
          ? ask.data.maps.filter(
              (m): m is ChatMapDto =>
                !!m &&
                typeof m === "object" &&
                typeof m.title === "string" &&
                Array.isArray(m.track),
            )
          : [],
      )
    : [];
  // Structured tables (render_table) ride the same way as charts/maps.
  const tables: ChatTableDto[] = Array.isArray(ragflowContext?.askResults)
    ? ragflowContext.askResults.flatMap((ask) =>
        Array.isArray(ask?.data?.tables)
          ? ask.data.tables.filter(
              (t): t is ChatTableDto =>
                !!t &&
                typeof t === "object" &&
                typeof t.title === "string" &&
                Array.isArray(t.columns) &&
                Array.isArray(t.rows),
            )
          : [],
      )
    : [];
  // KPI gauge/stat cards (render_kpi) ride the same way.
  const kpis: ChatKpiBlockDto[] = Array.isArray(ragflowContext?.askResults)
    ? ragflowContext.askResults.flatMap((ask) =>
        Array.isArray(ask?.data?.kpis)
          ? ask.data.kpis.filter(
              (k): k is ChatKpiBlockDto =>
                !!k && typeof k === "object" && Array.isArray(k.items),
            )
          : [],
      )
    : [];
  const clarificationActions = Array.isArray(ragflowContext?.clarificationActions)
    ? ragflowContext.clarificationActions.filter(
        (action): action is ChatSuggestionActionDto =>
          typeof action === "object" &&
          action !== null &&
          typeof action.label === "string" &&
          action.label.trim().length > 0 &&
          typeof action.message === "string" &&
          action.message.trim().length > 0,
      )
    : [];
  const normalizedAssistantContent =
    role === "assistant"
      ? normalizeMojibakePunctuation(
          normalizeEscapedMarkdown(
            stripTechnicalIdentifiers(
              stripLegacyInteractiveMarkup(
                normalizeMathLikeFormatting(content.trim()),
              ),
            ),
          ),
        )
      : content.trim();
  const {
    cleanedText: renderedAssistantContent,
    actions: inlineButtonActions,
  } =
    role === "assistant"
      ? extractInlineButtonActions(normalizedAssistantContent)
      : { cleanedText: content.trim(), actions: [] };
  const suggestionActions =
    clarificationActions.length > 0 ? clarificationActions : inlineButtonActions;

  /**
   * Copy what the reader sees, not what the model wrote.
   *
   * The button used to put the raw markdown on the clipboard, so pasting an
   * answer into an email or a report brought '#', '**' and '|' along and lost
   * every heading, list and table on the way. The clipboard takes two flavours
   * at once: text/html for anywhere that understands formatting (Word, Gmail,
   * Notion), and text/plain for anywhere that does not — both taken from the
   * rendered DOM, so they match the screen.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const handleCopy = useCallback(() => {
    const node = bodyRef.current;
    const fallbackText = content.trim();

    if (!node) {
      if (fallbackText && onCopy) onCopy(fallbackText);
      else if (fallbackText) {
        navigator.clipboard.writeText(fallbackText).catch(() => {});
      }
      return;
    }

    // React leaves a run of blank text nodes between blocks; pasted into Word
    // they become empty paragraphs.
    const html = node.innerHTML.replace(/\n{2,}/g, '\n');
    // innerText, not textContent: it respects line breaks and list structure
    // the way the browser lays them out, which is what someone pasting into a
    // plain-text field expects to see.
    const plain = (node.innerText || fallbackText).trim();

    if (onCopy) onCopy(plain);

    const writeRich = async () => {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        await navigator.clipboard.writeText(plain);
        return;
      }
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
    };

    void writeRich().catch(() => {
      // Firefox before 127 has no ClipboardItem, and a denied permission ends
      // up here too — plain text still beats nothing.
      navigator.clipboard.writeText(plain).catch(() => {});
    });
  }, [content, onCopy]);

  const handleRegenerate = useCallback(() => {
    if (role === "assistant" && onRegenerate) onRegenerate(id);
  }, [role, id, onRegenerate]);

  const handleOpenDocument = useCallback(
    (target: ChatDocumentOpenTarget) => {
      void openChatDocumentSource(target, token);
    },
    [token],
  );
  const mdComponents = useMdComponents(refs, handleOpenDocument);
  const alertCard = role === "user" ? parseAlertMessage(content) : null;
  const taskCard = role === "user" && !alertCard ? parseTaskMessage(content) : null;
  // A task/alert "Ask AI" message renders as its own bordered card — skip the
  // usual grey chat bubble around it so the card's own border is the only
  // visible boundary, instead of a card nested inside a bubble.
  const isCardMessage = !!(alertCard || taskCard);

  return (
    <div
      className={`chat-message chat-message--${role}${isCardMessage ? " chat-message--card" : ""}`}
    >
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
          <div ref={bodyRef} className="chat-message__body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={mdComponents}
          >
            {displayableRefs.length > 0
              ? injectCiteRefs(renderedAssistantContent)
              : renderedAssistantContent}
          </ReactMarkdown>
          </div>
        ) : alertCard ? (
          <AlertMessageCard card={alertCard} />
        ) : taskCard ? (
          <TaskMessageCard card={taskCard} />
        ) : content.trim() === PHOTO_ONLY_CAPTION ? null : (
          content.trim()
        )}

        {role === "user" && (message.attachments?.length ?? 0) > 0 && (
          <div className="chat-message__attachments">
            {message.attachments!.map((att) => (
              <UserAttachmentThumb key={att.id} attachment={att} token={token} />
            ))}
          </div>
        )}

        {role === "assistant" && charts.length > 0 && (
          <div className="chat-message__charts">
            {charts.map((chart, index) => (
              <ChatChartBlock
                key={`${chart.title}-${index}`}
                chart={chart}
                onAsk={onSendMessage}
                labels={chartLabels}
              />
            ))}
          </div>
        )}

        {role === "assistant" && maps.length > 0 && (
          <div className="chat-message__charts">
            {maps.map((m, index) => (
              <ChatMapBlock key={`${m.title}-${index}`} chart={m} />
            ))}
          </div>
        )}

        {role === "assistant" && kpis.length > 0 && (
          <div className="chat-message__charts">
            {kpis.map((k, index) => (
              <ChatKpiBlock key={`${k.title}-${index}`} kpi={k} />
            ))}
          </div>
        )}

        {role === "assistant" && tables.length > 0 && (
          <div className="chat-message__charts">
            {tables.map((t, index) => (
              <ChatTableBlock key={`${t.title}-${index}`} table={t} />
            ))}
          </div>
        )}

        {role === "assistant" && suggestionActions.length > 0 && (
          <div
            className="chat-message__suggestions"
            aria-label="Suggested clarification actions"
          >
            {suggestionActions.map((action, index) => (
              <button
                key={`${action.kind || "suggestion"}-${index}-${action.label}`}
                type="button"
                className={`chat-suggestion${action.kind === "all" ? " chat-suggestion--all" : ""}`}
                onClick={() => onSendMessage?.(action.message)}
                disabled={!onSendMessage || actionsDisabled}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Show citations for assistant messages that have them */}
      {role === "assistant" &&
        displayableRefs.length > 0 && (
          <div className="chat-message__sources">
            <SourceCitations
              citations={displayableRefs}
              onOpenPanel={onOpenSourcesPanel}
            />
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
