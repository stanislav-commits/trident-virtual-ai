import { useCallback, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type {
  ChatMessageDto,
  ChatContextReferenceDto,
  ChatSuggestionActionDto,
} from "../../types/chat";
import { useAuth } from "../../context/AuthContext";
import { SourceCitations } from "./SourceCitations";
import {
  type ChatDocumentOpenTarget,
  getChatDocumentOpenTarget,
  openChatDocumentSource,
} from "./chatSourceReferences";

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
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const title = ref
    ? `${ref.sourceTitle || "Document"}${ref.pageNumber ? ` \u2014 p. ${ref.pageNumber}` : ""}`
    : `Source [${idx}]`;
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
  onSendMessage,
  onOpenSourcesPanel,
  actionsDisabled = false,
}: MessageBubbleProps) {
  const { token, user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { id, role, content, createdAt, contextReferences, ragflowContext } =
    message;
  const refs = contextReferences ?? [];
  const telemetryShips = Array.isArray(ragflowContext?.telemetryShips)
    ? ragflowContext.telemetryShips
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => value.trim())
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
            stripLegacyInteractiveMarkup(
              normalizeMathLikeFormatting(content.trim()),
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
    (target: ChatDocumentOpenTarget) => {
      void openChatDocumentSource(target, token);
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
            {refs.length > 0
              ? injectCiteRefs(renderedAssistantContent)
              : renderedAssistantContent}
          </ReactMarkdown>
        ) : (
          content.trim()
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
        contextReferences &&
        contextReferences.length > 0 && (
          <div className="chat-message__sources">
            <SourceCitations
              citations={contextReferences}
              onOpenPanel={onOpenSourcesPanel}
            />
          </div>
        )}

      {false && (
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
          No matching manual chunk for this query {"\u2014"} answered without
          supporting manual context
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
