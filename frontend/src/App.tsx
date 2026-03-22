import { useState, useCallback } from "react";
import type { TopBarTab } from "./components/layout/TopBar";
import { AdminPanelProvider, useAdminPanel } from "./context/AdminPanelContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { AdminPanelPage } from "./pages/AdminPanelPage";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { DatasetPage } from "./pages/DatasetPage";
import { LoginPage } from "./pages/LoginPage";
import { PrivacyPolicyPage } from "./pages/PrivacyPolicyPage";

function AuthenticatedContent() {
  const { isOpen } = useAdminPanel();
  const [activeTab, setActiveTab] = useState<TopBarTab>("chats");
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
  const [page, setPage] = useState<"login" | "privacy">("login");

  if (!isAuthenticated) {
    if (page === "privacy") {
      return <PrivacyPolicyPage onBack={() => setPage("login")} />;
    }
    return <LoginPage onOpenPrivacy={() => setPage("privacy")} />;
  }

  return (
    <AdminPanelProvider>
      <AuthenticatedContent />
    </AdminPanelProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
