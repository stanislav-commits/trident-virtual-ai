import type { ChatSession } from '../../types/chat';

interface ChatListItemProps {
  session: ChatSession;
  isActive: boolean;
  onClick: () => void;
}

export function ChatListItem({ session, isActive, onClick }: ChatListItemProps) {
  return (
    <button
      type="button"
      className={`chat-list-item ${isActive ? 'chat-list-item--active' : ''}`}
      onClick={onClick}
    >
      <span className="chat-list-item__title">{session.title}</span>
    </button>
  );
}
