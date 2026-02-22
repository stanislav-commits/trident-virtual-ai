import type { ReactNode } from 'react';
import searchIcon from '../../assets/look.svg';
import timeIcon from '../../assets/time.svg';
import plusAddIcon from '../../assets/plus-add.svg';

interface SidebarProps {
  searchPlaceholder?: string;
  onNewChat?: () => void;
  children: ReactNode;
}

export function Sidebar({
  searchPlaceholder = 'Search for chats',
  onNewChat,
  children,
}: SidebarProps) {
  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar__search-wrap">
        <img src={searchIcon} alt="" className="chat-sidebar__search-icon" aria-hidden />
        <input
          type="search"
          className="chat-sidebar__search"
          placeholder={searchPlaceholder}
          aria-label="Search chats"
        />
      </div>
      <div className="chat-sidebar__header">
        <img src={timeIcon} alt="" className="chat-sidebar__header-icon" aria-hidden />
        <span className="chat-sidebar__header-title">Recent chats</span>
        <button
          type="button"
          className="chat-sidebar__new"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
        >
          <img src={plusAddIcon} alt="" className="chat-sidebar__new-img" />
        </button>
      </div>
      <hr className="chat-sidebar__divider" />
      <div className="chat-sidebar__list">{children}</div>
    </aside>
  );
}
