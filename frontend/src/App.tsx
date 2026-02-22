import { useState, useCallback } from 'react';
import type { TopBarTab } from './components/layout/TopBar';
import { HomePage } from './pages/HomePage';
import { ChatPage } from './pages/ChatPage';
import { DatasetPage } from './pages/DatasetPage';

function App() {
  const [activeTab, setActiveTab] = useState<TopBarTab>('home');

  const handleTabChange = useCallback((tab: TopBarTab) => {
    setActiveTab(tab);
  }, []);

  const handleStartChat = useCallback((_message: string) => {
    setActiveTab('chats');
  }, []);

  if (activeTab === 'home') {
    return (
      <HomePage
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onStartChat={handleStartChat}
      />
    );
  }

  if (activeTab === 'dataset') {
    return (
      <DatasetPage activeTab={activeTab} onTabChange={handleTabChange} />
    );
  }

  return (
    <ChatPage activeTab={activeTab} onTabChange={handleTabChange} />
  );
}

export default App;
