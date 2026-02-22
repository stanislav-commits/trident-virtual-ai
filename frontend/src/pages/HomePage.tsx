import { useState, useCallback } from 'react';
import type { TopBarTab } from '../components/layout/TopBar';
import { TopBar } from '../components/layout/TopBar';
import logoImg from '../assets/logo-home.png';
import plusAddIcon from '../assets/plus-add.svg';
import sendIcon from '../assets/Vector.svg';

interface HomePageProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
  onStartChat: (message: string) => void;
}

export function HomePage({ activeTab, onTabChange, onStartChat }: HomePageProps) {
  const [inputValue, setInputValue] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (inputValue.trim()) {
        onStartChat(inputValue.trim());
        setInputValue('');
      }
    },
    [inputValue, onStartChat]
  );

  return (
    <div className="home-layout">
      <TopBar activeTab={activeTab} onTabChange={onTabChange} />
      <div className="home-content">
        <div className="home-content__logo-zone">
          <img src={logoImg} alt="Trident Virtual AI" className="home-logo" />
        </div>
        <div className="home-card">
          <div className="home-card__welcome">Welcome to</div>
          <h1 className="home-card__title">TRIDENT VIRTUAL AI</h1>
          <form className="home-card__input-row" onSubmit={handleSubmit}>
            <div className="home-card__capsule">
              <button type="button" className="home-card__attach" aria-label="Attach" title="Attach">
                <img src={plusAddIcon} alt="" className="home-card__attach-img" />
              </button>
              <input
                type="text"
                className="home-card__input"
                placeholder="How can I help you today?"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                aria-label="Message"
              />
            </div>
            <button
              type="submit"
              className="home-card__send"
              disabled={!inputValue.trim()}
              aria-label="Send"
            >
              <img src={sendIcon} alt="" className="home-card__send-img" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
