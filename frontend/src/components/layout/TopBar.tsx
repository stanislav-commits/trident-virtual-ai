import { useEffect, useRef, useState } from 'react';
import homeIcon from '../../assets/home.svg';
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

  const handleProfileClick = () => {
    setDropdownOpen((o) => !o);
  };

  const handleLogout = () => {
    setDropdownOpen(false);
    logout();
  };

  const handleAdminPanel = () => {
    setDropdownOpen(false);
    openAdminPanel();
  };

  return (
    <header className="chat-topbar">
      <div className="chat-topbar__left-spacer" aria-hidden />
      <div className="chat-topbar__pill">
        <button
          type="button"
          className={`chat-topbar__tab chat-topbar__tab--icon ${activeTab === 'home' ? 'chat-topbar__tab--active' : ''}`}
          onClick={() => onTabChange('home')}
          title="Home"
          aria-label="Home"
        >
          <img src={homeIcon} alt="" className="chat-topbar__tab-img" />
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
      </div>
      <div className="chat-topbar__right">
        <div className="chat-topbar__profile-wrap" ref={wrapRef}>
          <button
            type="button"
            className="chat-topbar__profile-btn"
            onClick={handleProfileClick}
            aria-label="Profile"
            aria-expanded={dropdownOpen}
          >
            <img src={profileIcon} alt="" className="chat-topbar__profile-img" />
          </button>
          {dropdownOpen && (
            <div className="chat-topbar__profile-dropdown">
              {user?.role === 'admin' && (
                <button
                  type="button"
                  className="chat-topbar__profile-item"
                  onClick={handleAdminPanel}
                >
                  Admin panel
                </button>
              )}
              <button
                type="button"
                className="chat-topbar__profile-item"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
