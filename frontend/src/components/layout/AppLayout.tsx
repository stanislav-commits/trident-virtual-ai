import type { ReactNode } from "react";
import type { TopBarTab } from "./TopBar";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";

interface AppLayoutProps {
  sidebar: ReactNode;
  onNewChat?: () => void;
  onSearch?: (query: string) => void;
  children: ReactNode;
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
}

export function AppLayout({
  sidebar,
  onNewChat,
  onSearch,
  children,
  activeTab,
  onTabChange,
}: AppLayoutProps) {
  return (
    <div className="chat-layout">
      <Sidebar onNewChat={onNewChat} onSearch={onSearch}>
        {sidebar}
      </Sidebar>
      <div className="chat-layout__right">
        <TopBar activeTab={activeTab} onTabChange={onTabChange} />
        <div className="chat-layout__body">
          <main className="chat-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
