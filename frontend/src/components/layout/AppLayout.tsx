import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";

interface AppLayoutProps {
  sidebar: ReactNode;
  onNewChat?: () => void;
  onSearch?: (query: string) => void;
  children: ReactNode;
}

export function AppLayout({
  sidebar,
  onNewChat,
  onSearch,
  children,
}: AppLayoutProps) {
  return (
    <div className="chat-layout">
      <Sidebar onNewChat={onNewChat} onSearch={onSearch}>
        {sidebar}
      </Sidebar>
      <div className="chat-layout__right">
        <TopBar />
        <div className="chat-layout__body">
          <main className="chat-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
