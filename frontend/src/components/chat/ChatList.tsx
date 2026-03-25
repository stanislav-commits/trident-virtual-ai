import type { ChatSession } from "../../types/chat";
import { ChatListItem } from "./ChatListItem";

interface ChatListProps {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onTogglePin?: (id: string, isPinned: boolean) => void;
}

export function ChatList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
}: ChatListProps) {
  return (
    <>
      {sessions.map((session) => (
        <ChatListItem
          key={session.id}
          session={session}
          isActive={session.id === activeId}
          onClick={() => onSelect(session.id)}
          onDelete={onDelete}
          onRename={onRename}
          onTogglePin={onTogglePin}
        />
      ))}
    </>
  );
}
