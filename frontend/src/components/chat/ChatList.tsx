import { useEffect, useRef } from "react";
import type { ChatSession } from "../../types/chat";
import { ChatListItem } from "./ChatListItem";

interface ChatListProps {
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onTogglePin?: (id: string, isPinned: boolean) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}

export function ChatList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: ChatListProps) {
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || !onLoadMore || !loadMoreRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isLoadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: "180px 0px" },
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore, sessions.length]);

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

      {hasMore ? (
        <div ref={loadMoreRef} className="chat-list__load-more-wrap">
          <button
            type="button"
            className="chat-list__load-more"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? "Loading more chats..." : "Load more chats"}
          </button>
        </div>
      ) : null}
    </>
  );
}
