import homeIcon from '../../assets/home.svg';
import profileIcon from '../../assets/profile.svg';

export type TopBarTab = 'home' | 'chats' | 'dataset';

interface TopBarProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
}

export function TopBar({ activeTab, onTabChange }: TopBarProps) {
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
        <img src={profileIcon} alt="" className="chat-topbar__profile-img" aria-hidden title="Profile" />
      </div>
    </header>
  );
}
