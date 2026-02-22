import { useState, useCallback } from "react";
import type { TopBarTab } from "../components/layout/TopBar";
import { AppLayout } from "../components/layout/AppLayout";
import { ChatList } from "../components/chat/ChatList";
import { MessageList } from "../components/chat/MessageList";
import { MessageInput } from "../components/chat/MessageInput";
import { mockSessions, mockMessagesBySession } from "../mocks/chat";
import logoImg from "../assets/logo-chats.png";

interface ChatPageProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
}

export function ChatPage({ activeTab, onTabChange }: ChatPageProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    mockSessions[0]?.id ?? null,
  );
  const [inputValue, setInputValue] = useState("");

  const messages = activeSessionId
    ? (mockMessagesBySession[activeSessionId] ?? [])
    : [];

  const handleSend = useCallback(() => {
    if (!inputValue.trim()) return;
    setInputValue("");
  }, [inputValue]);

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  return (
    <AppLayout
      sidebar={
        <ChatList
          sessions={mockSessions}
          activeId={activeSessionId}
          onSelect={setActiveSessionId}
        />
      }
      onNewChat={handleNewChat}
      activeTab={activeTab}
      onTabChange={onTabChange}
    >
      {activeSessionId ? (
        <>
          <div className="chat-main__bg-logo" aria-hidden>
            <img src={logoImg} alt="" />
          </div>
          <MessageList messages={messages} />
          <MessageInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            placeholder="Type a message..."
          />
        </>
      ) : (
        <div className="chat-empty">
          <div className="chat-empty__logo-zone">
            <img
              src={logoImg}
              alt="Trident Virtual AI"
              className="chat-empty__logo chats-logo"
            />
          </div>
          <div className="chat-empty__card">
            <div className="chat-empty__title">Select a chat</div>
            <p>Choose a conversation from the sidebar or start a new one.</p>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
