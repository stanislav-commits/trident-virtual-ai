import type { ChatMessageDto } from "../../types/chat";
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

function formatText(text: string): string {
  return text.trim();
}

export function MessageBubble({
  message,
  isLoading = false,
}: MessageBubbleProps) {
  const { role, content, createdAt, contextReferences } = message;
  const formattedContent = formatText(content);

  return (
    <div className={`chat-message chat-message--${role}`}>
      <div className="chat-message__content">{formattedContent}</div>

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

      <div className="chat-message__time">{formatTime(createdAt)}</div>
    </div>
  );
}
