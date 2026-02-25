import { useState, useCallback } from "react";
import type { TopBarTab } from "./components/layout/TopBar";
import { AdminPanelProvider, useAdminPanel } from "./context/AdminPanelContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AdminPanelPage } from "./pages/AdminPanelPage";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { DatasetPage } from "./pages/DatasetPage";
import { LoginPage } from "./pages/LoginPage";

function AuthenticatedContent() {
  const { isOpen } = useAdminPanel();
  const [activeTab, setActiveTab] = useState<TopBarTab>("home");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const handleTabChange = useCallback((tab: TopBarTab) => {
    setActiveTab(tab);
  }, []);

  const handleStartChat = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setActiveTab("chats");
  }, []);

  if (isOpen) {
    return <AdminPanelPage />;
  }

  if (activeTab === "home") {
    return (
      <HomePage
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onChatCreated={handleStartChat}
      />
    );
  }

  if (activeTab === "dataset") {
    return <DatasetPage activeTab={activeTab} onTabChange={handleTabChange} />;
  }

  return (
    <ChatPage
      activeTab={activeTab}
      onTabChange={handleTabChange}
      initialSessionId={activeSessionId}
    />
  );
}

function AppContent() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <AdminPanelProvider>
      <AuthenticatedContent />
    </AdminPanelProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
