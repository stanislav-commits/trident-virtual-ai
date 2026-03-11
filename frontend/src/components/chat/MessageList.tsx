import { useEffect, useRef } from "react";
import type { ChatMessageDto } from "../../types/chat";
import { MessageBubble } from "./MessageBubble";

interface MessageListProps {
  messages: ChatMessageDto[];
  isLoadingResponse?: boolean;
  onCopy?: (content: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSendMessage?: (text: string) => void;
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
          />
        ))
      )}

      {isLoadingResponse && (
        <div className="chat-message chat-message--assistant">
          <div className="chat-message__loading">Generating response...</div>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
}
