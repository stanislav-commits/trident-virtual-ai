import { useEffect, useRef } from "react";
import type { ChatContextReferenceDto, ChatMessageDto } from "../../types/chat";
import { MessageBubble } from "./MessageBubble";

interface MessageListProps {
  messages: ChatMessageDto[];
  isLoadingResponse?: boolean;
  onCopy?: (content: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSendMessage?: (text: string) => void;
  onOpenSourcesPanel?: (citations: ChatContextReferenceDto[]) => void;
  actionsDisabled?: boolean;
}

/**
 * Displays all messages in a chat session
 * Auto-scrolls to latest message
 */
export function MessageList({
  messages,
  isLoadingResponse = false,
  onCopy,
  onRegenerate,
  onSendMessage,
  onOpenSourcesPanel,
  actionsDisabled = false,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    // Use rAF to ensure DOM has painted the new content before scrolling
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [messages, isLoadingResponse]);

  return (
    <div className="chat-main__messages" ref={containerRef}>
      {messages.length === 0 ? (
        <div className="chat-empty-state">
          <p>No messages yet. Start a conversation!</p>
        </div>
      ) : (
        messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isLoading={false}
            onCopy={onCopy}
            onRegenerate={onRegenerate}
            onSendMessage={onSendMessage}
            onOpenSourcesPanel={onOpenSourcesPanel}
            actionsDisabled={actionsDisabled}
          />
        ))
      )}

      {isLoadingResponse && (
        <div
          className="chat-message chat-message--assistant"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="chat-message__loading">
            <span className="chat-message__loading-label">
              Generating response
            </span>
            <span className="typing-dots" aria-hidden="true">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
          </div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
}
