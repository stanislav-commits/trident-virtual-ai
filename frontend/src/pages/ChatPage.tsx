import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { useChatSessions } from "../hooks/useChatSessions";
import { useChatMessages } from "../hooks/useChatMessages";
import { useSendMessage } from "../hooks/useSendMessage";
import { getChatSession } from "../api/chatApi";
import type { TopBarTab } from "../components/layout/TopBar";
import { AppLayout } from "../components/layout/AppLayout";
import { ChatList } from "../components/chat/ChatList";
import { MessageList } from "../components/chat/MessageList";
import { MessageInput } from "../components/chat/MessageInput";
import logoImg from "../assets/logo-home.png";

interface ChatPageProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
  initialSessionId?: string | null;
}

export function ChatPage({
  activeTab,
  onTabChange,
  initialSessionId = null,
}: ChatPageProps) {
  const { user, token } = useAuth();

  const {
    sessions,
    isLoading: isLoadingSessions,
    error: sessionsError,
    createSession,
    deleteSession,
  } = useChatSessions(token);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const {
    messages,
    isLoading: isLoadingMessages,
    error: messagesError,
    addMessage,
  } = useChatMessages(activeSessionId, token);

  const isLoading = isLoadingSessions || isLoadingMessages;

  const {
    isSending,
    error: sendError,
    send: sendMessage,
  } = useSendMessage(activeSessionId, token);

  const [inputValue, setInputValue] = useState("");
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);

  useEffect(() => {
    if (initialSessionId) setActiveSessionId(initialSessionId);
  }, [initialSessionId]);

  useEffect(() => {
    if (!initialSessionId && sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[0].id);
    }
  }, [initialSessionId, sessions, activeSessionId]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isSending || !activeSessionId) return;

    const messageContent = inputValue;
    setInputValue("");
    setIsWaitingForResponse(true);

    try {
      const userMessage = await sendMessage(messageContent);
      addMessage(userMessage);

      const maxAttempts = 30;
      const checkForResponse = async () => {
        let attempts = 0;
        while (attempts < maxAttempts) {
          try {
            const updatedSession = await getChatSession(
              activeSessionId,
              token!,
            );
            const currentMessages = updatedSession.messages || [];
            const lastMessage = currentMessages[currentMessages.length - 1];
            if (
              lastMessage &&
              lastMessage.role === "assistant" &&
              lastMessage.id !== userMessage.id
            ) {
              addMessage(lastMessage);
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 2000));
          attempts++;
        }
        setIsWaitingForResponse(false);
      };
      checkForResponse();
    } catch (err) {
      setIsWaitingForResponse(false);
      console.error("Failed to send message:", err);
    }
  }, [inputValue, isSending, activeSessionId, sendMessage, addMessage, token]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      if (activeSessionId === sessionId) setActiveSessionId(null);
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }, [deleteSession, activeSessionId]);

  const handleNewChat = useCallback(async () => {
    const canCreate =
      user?.role === "admin" || (user?.role === "user" && !!user?.shipId);
    if (!canCreate) {
      console.error("Cannot create chat: admin or user with shipId required");
      return;
    }

    try {
      const shipIdForSession =
        user?.role === "admin" ? undefined : (user?.shipId ?? undefined);
      const newSession = await createSession(shipIdForSession);
      setActiveSessionId(newSession.id);
      setInputValue("");
    } catch (err) {
      console.error("Failed to create new chat:", err);
    }
  }, [user, createSession]);

  const hasError = sessionsError || messagesError || sendError;
  const showEmptyState = !activeSessionId && sessions.length === 0;

  return (
    <AppLayout
      sidebar={
        <ChatList
          sessions={sessions.map((s) => ({
            id: s.id,
            title: s.title || "Untitled Chat",
            messageCount: s.messageCount || 0,
            updatedAt: s.updatedAt,
          }))}
          activeId={activeSessionId}
          onSelect={setActiveSessionId}
          onDelete={handleDeleteSession}
        />
      }
      onNewChat={handleNewChat}
      activeTab={activeTab}
      onTabChange={onTabChange}
    >
      {showEmptyState ? (
        <div className="chat-empty">
          <div className="chat-empty__logo-zone">
            <img
              src={logoImg}
              alt="Trident Virtual AI"
              className="chat-empty__logo chats-logo"
            />
          </div>
          <div className="chat-empty__card">
            <div className="chat-empty__title">No chats yet</div>
            <p>Create a new chat to get started.</p>
          </div>
        </div>
      ) : activeSessionId ? (
        <>
          <div className="chat-main__bg-logo" aria-hidden>
            <img src={logoImg} alt="" />
          </div>

          {hasError && (
            <div className="chat-error-banner">
              <p>{sessionsError || messagesError || sendError}</p>
            </div>
          )}

          <MessageList
            messages={messages}
            isLoadingResponse={isWaitingForResponse}
          />

          <MessageInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            disabled={isSending || isWaitingForResponse || isLoading}
            placeholder="Type a message..."
          />
        </>
      ) : null}
    </AppLayout>
  );
}
