import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { SidebarBody, SidebarBrand } from "./Sidebar";
import { useSidebarCollapsed } from "../../hooks/useSidebarCollapsed";

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
  const { collapsed, toggle, setCollapsed } = useSidebarCollapsed();

  return (
    <div className="chat-layout">
      <div className="chat-layout__top">
        <SidebarBrand collapsed={collapsed} onToggleCollapsed={toggle} />
        <TopBar />
      </div>
      <div className="chat-layout__content">
        <SidebarBody
          collapsed={collapsed}
          onExpand={() => setCollapsed(false)}
          onNewChat={onNewChat}
          onSearch={onSearch}
        >
          {sidebar}
        </SidebarBody>
        <div className="chat-layout__body">
          <main className="chat-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
