import { useEffect, useRef, useState } from 'react';
import profileIcon from '../../assets/profile.svg';
import { useAdminPanel } from '../../context/AdminPanelContext';
import { useAuth } from '../../context/AuthContext';

export type TopBarTab = 'home' | 'chats' | 'dataset';

interface TopBarProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
}

export function TopBar({ activeTab, onTabChange }: TopBarProps) {
  const { user, logout } = useAuth();
  const { open: openAdminPanel } = useAdminPanel();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [dropdownOpen]);

  const handleLogout = () => {
    setDropdownOpen(false);
    logout();
  };

  const handleAdminPanel = () => {
    setDropdownOpen(false);
    openAdminPanel();
  };

  const initials = user?.role === 'admin' ? 'A' : (user?.userId?.slice(0, 2).toUpperCase() ?? 'U');

  return (
    <header className="chat-topbar">
      <div className="chat-topbar__brand">
        <span className="chat-topbar__brand-name">TRIDENT VIRTUAL AI</span>
      </div>

      <nav className="chat-topbar__tabs" aria-label="Navigation">
        <button
          type="button"
          className={`chat-topbar__tab ${activeTab === 'home' ? 'chat-topbar__tab--active' : ''}`}
          onClick={() => onTabChange('home')}
        >
          Home
        </button>
        <button
          type="button"
          className={`chat-topbar__tab ${activeTab === 'chats' ? 'chat-topbar__tab--active' : ''}`}
          onClick={() => onTabChange('chats')}
        >
          Chats
        </button>
        <button
          type="button"
          className={`chat-topbar__tab ${activeTab === 'dataset' ? 'chat-topbar__tab--active' : ''}`}
          onClick={() => onTabChange('dataset')}
        >
          Dataset
        </button>
      </nav>

      <div className="chat-topbar__right">
        <div className="chat-topbar__profile-wrap" ref={wrapRef}>
          <button
            type="button"
            className="chat-topbar__profile-btn"
            onClick={() => setDropdownOpen((o) => !o)}
            aria-label="Profile menu"
            aria-expanded={dropdownOpen}
          >
            <div className="chat-topbar__avatar">
              <img src={profileIcon} alt="" className="chat-topbar__profile-img" />
              <span className="chat-topbar__avatar-initials">{initials}</span>
            </div>
          </button>
          {dropdownOpen && (
            <div className="chat-topbar__profile-dropdown">
              {user?.role && (
                <div className="chat-topbar__profile-info">
                  <span className="chat-topbar__profile-role">{user.role}</span>
                </div>
              )}
              {user?.role === 'admin' && (
                <button
                  type="button"
                  className="chat-topbar__profile-item"
                  onClick={handleAdminPanel}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/><circle cx="19" cy="6" r="3" fill="currentColor" stroke="none" opacity="0.4"/></svg>
                  Admin panel
                </button>
              )}
              <button
                type="button"
                className="chat-topbar__profile-item chat-topbar__profile-item--danger"
                onClick={handleLogout}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
