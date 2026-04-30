import { useEffect, useRef, type ReactNode } from "react";
import searchIcon from "../../assets/look.svg";
import timeIcon from "../../assets/time.svg";
import plusAddIcon from "../../assets/plus-add.svg";
import logoImg from "../../assets/logo-home.png";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";

interface SidebarBrandProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface SidebarBodyProps {
  searchPlaceholder?: string;
  onNewChat?: () => void;
  onSearch?: (query: string) => void;
  children: ReactNode;
  collapsed: boolean;
  onExpand: () => void;
}

function PanelToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      {collapsed ? (
        <polyline points="13 9 16 12 13 15" />
      ) : (
        <polyline points="16 9 13 12 16 15" />
      )}
    </svg>
  );
}

export function SidebarBrand({
  collapsed,
  onToggleCollapsed,
}: SidebarBrandProps) {
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <aside className="chat-sidebar chat-sidebar--brand">
      <div className="chat-sidebar__brand">
        <img
          src={logoImg}
          alt=""
          className="chat-sidebar__brand-logo"
          aria-hidden
        />
        <span className="chat-sidebar__brand-name">
          <span className="chat-sidebar__brand-line">Trident</span>
          <span className="chat-sidebar__brand-line">Intelligence</span>
          <span className="chat-sidebar__brand-line">Platform</span>
        </span>
        <button
          type="button"
          className="chat-sidebar__toggle"
          onClick={onToggleCollapsed}
          aria-label={toggleLabel}
          aria-controls="chat-sidebar-body"
          aria-expanded={!collapsed}
          title={toggleLabel}
        >
          <PanelToggleIcon collapsed={collapsed} />
        </button>
      </div>
    </aside>
  );
}

export function SidebarBody({
  searchPlaceholder = "Search for chats",
  onNewChat,
  onSearch,
  children,
  collapsed,
  onExpand,
}: SidebarBodyProps) {
  const { logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusSearchAfterExpandRef = useRef(false);
  const bodyClassName = [
    "chat-sidebar",
    "chat-sidebar--body",
    collapsed ? "chat-sidebar--body-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (collapsed || !focusSearchAfterExpandRef.current) {
      return;
    }

    focusSearchAfterExpandRef.current = false;
    searchInputRef.current?.focus();
  }, [collapsed]);

  const handleRailSearch = () => {
    focusSearchAfterExpandRef.current = true;
    onExpand();
  };

  return (
    <aside
      id="chat-sidebar-body"
      className={bodyClassName}
      aria-label="Chat navigation"
    >
      {collapsed ? (
        <div className="chat-sidebar__rail" aria-label="Collapsed chat navigation">
          <button
            type="button"
            className="chat-sidebar__rail-btn"
            onClick={handleRailSearch}
            aria-label="Search chats"
            title="Search chats"
          >
            <img
              src={searchIcon}
              alt=""
              className="chat-sidebar__rail-icon chat-sidebar__rail-icon--search"
              aria-hidden
            />
          </button>
          {onNewChat && (
            <button
              type="button"
              className="chat-sidebar__rail-btn"
              onClick={onNewChat}
              aria-label="New chat"
              title="New chat"
            >
              <img
                src={plusAddIcon}
                alt=""
                className="chat-sidebar__rail-icon chat-sidebar__rail-icon--new"
                aria-hidden
              />
            </button>
          )}
        </div>
      ) : (
        <div className="chat-sidebar__body-inner">
          <div className="chat-sidebar__search-wrap">
            <img
              src={searchIcon}
              alt=""
              className="chat-sidebar__search-icon"
              aria-hidden
            />
            <input
              ref={searchInputRef}
              type="search"
              className="chat-sidebar__search"
              placeholder={searchPlaceholder}
              aria-label="Search chats"
              onChange={(e) => onSearch?.(e.target.value)}
            />
          </div>
          <div className="chat-sidebar__header">
            <img
              src={timeIcon}
              alt=""
              className="chat-sidebar__header-icon"
              aria-hidden
            />
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

          <div className="chat-sidebar__footer">
            <button
              type="button"
              className="chat-sidebar__theme-btn"
              onClick={toggleTheme}
              title={
                theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
              }
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <button
              type="button"
              className="chat-sidebar__logout-btn"
              onClick={logout}
              title="Logout"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Logout
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
