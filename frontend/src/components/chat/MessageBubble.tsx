import type { Message } from '../../types/chat';

interface MessageBubbleProps {
  message: Message;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <div>{message.content}</div>
      <div className="chat-message__time">{formatTime(message.createdAt)}</div>
    </div>
  );
}
