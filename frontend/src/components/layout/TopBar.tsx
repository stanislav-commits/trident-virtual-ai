import { useEffect, useRef, useState } from "react";
import profileIcon from "../../assets/profile.svg";
import { useAdminPanel } from "../../context/AdminPanelContext";
import { useAuth } from "../../context/AuthContext";

export type TopBarTab = "home" | "chats" | "dataset";

interface TopBarProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
}

export function TopBar({ onTabChange: _onTabChange }: TopBarProps) {
  const { user } = useAuth();
  const { open: openAdminPanel } = useAdminPanel();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setDropdownOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [dropdownOpen]);

  const handleAdminPanel = () => {
    setDropdownOpen(false);
    openAdminPanel();
  };

  const initials =
    user?.role === "admin"
      ? "A"
      : (user?.userId?.slice(0, 2).toUpperCase() ?? "U");

  return (
    <header className="chat-topbar">
      <div className="chat-topbar__right">
        {user?.role === "admin" && (
          <div className="chat-topbar__profile-wrap" ref={wrapRef}>
            <button
              type="button"
              className="chat-topbar__profile-btn"
              onClick={() => setDropdownOpen((o) => !o)}
              aria-label="Profile menu"
              aria-expanded={dropdownOpen}
            >
              <div className="chat-topbar__avatar">
                <img
                  src={profileIcon}
                  alt=""
                  className="chat-topbar__profile-img"
                />
                <span className="chat-topbar__avatar-initials">{initials}</span>
              </div>
            </button>
            {dropdownOpen && (
              <div className="chat-topbar__profile-dropdown">
                {user?.role && (
                  <div className="chat-topbar__profile-info">
                    <span className="chat-topbar__profile-role">
                      {user.role}
                    </span>
                  </div>
                )}
                {user?.role === "admin" && (
                  <button
                    type="button"
                    className="chat-topbar__profile-item"
                    onClick={handleAdminPanel}
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
                      <circle cx="12" cy="8" r="4" />
                      <path d="M20 21a8 8 0 1 0-16 0" />
                    </svg>
                    Admin panel
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
