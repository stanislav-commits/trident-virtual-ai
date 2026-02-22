import type { ChatSession } from '../../types/chat';
import { ChatListItem } from './ChatListItem';

interface ChatListProps {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function ChatList({ sessions, activeId, onSelect }: ChatListProps) {
  return (
    <>
      {sessions.map((session) => (
        <ChatListItem
          key={session.id}
          session={session}
          isActive={session.id === activeId}
          onClick={() => onSelect(session.id)}
        />
      ))}
    </>
  );
}
