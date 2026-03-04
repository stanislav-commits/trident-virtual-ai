import { useState, useRef, useEffect } from 'react';
import type { ChatSession } from '../../types/chat';

interface ChatListItemProps {
  session: ChatSession;
  isActive: boolean;
  onClick: () => void;
  onDelete?: (id: string) => void;
}

export function ChatListItem({ session, isActive, onClick, onDelete }: ChatListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClose = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClose);
    return () => document.removeEventListener('mousedown', handleClose);
  }, [menuOpen]);

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((o) => !o);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onDelete?.(session.id);
  };

  return (
    <div className={`chat-list-item ${isActive ? 'chat-list-item--active' : ''}`}>
      <button
        type="button"
        className="chat-list-item__btn"
        onClick={onClick}
      >
        <span className="chat-list-item__title">{session.title}</span>
      </button>

      <div className="chat-list-item__menu-wrap" ref={menuRef}>
        <button
          type="button"
          className="chat-list-item__dots"
          onClick={handleMenuClick}
          aria-label="Chat options"
          title="Options"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>

        {menuOpen && (
          <div className="chat-list-item__dropdown">
            <button
              type="button"
              className="chat-list-item__dropdown-item chat-list-item__dropdown-item--danger"
              onClick={handleDelete}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
