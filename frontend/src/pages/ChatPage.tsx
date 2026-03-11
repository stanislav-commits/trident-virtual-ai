import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { useChatSessions } from "../hooks/useChatSessions";
import { useChatMessages } from "../hooks/useChatMessages";
import {
  getChatSession,
  sendChatMessage,
  regenerateChatResponse,
} from "../api/chatApi";
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
    renameSession,
    refreshSessions,
  } = useChatSessions(token);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isNewChatMode, setIsNewChatMode] = useState(true);

  const {
    messages,
    isLoading: isLoadingMessages,
    error: messagesError,
    addMessage,
    refetchMessages,
  } = useChatMessages(activeSessionId, token);

  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (initialSessionId) {
      setActiveSessionId(initialSessionId);
      setIsNewChatMode(false);
    }
  }, [initialSessionId]);

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => (s.title || "").toLowerCase().includes(q));
  }, [sessions, searchQuery]);

  // Auto-select the most recent session on load, but only if not explicitly in new-chat mode
  useEffect(() => {
    if (!initialSessionId && sessions.length > 0 && !activeSessionId && !isNewChatMode) {
      setActiveSessionId(sessions[0].id);
    }
  }, [initialSessionId, sessions, activeSessionId, isNewChatMode]);

  const pollForResponse = useCallback(
    async (sessionId: string, userMessageId: string) => {
      const maxAttempts = 30;
      let attempts = 0;
      while (attempts < maxAttempts) {
        try {
          const updatedSession = await getChatSession(sessionId, token!);
          const currentMessages = updatedSession.messages || [];
          const lastMessage = currentMessages[currentMessages.length - 1];
          if (
            lastMessage &&
            lastMessage.role === "assistant" &&
            lastMessage.id !== userMessageId
          ) {
            addMessage(lastMessage);
            refreshSessions();
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
      }
      setIsWaitingForResponse(false);
    },
    [token, addMessage, refreshSessions],
  );

  const handleSend = useCallback(async (textOverride?: string) => {
    const textToSend = textOverride || inputValue;
    if (!textToSend.trim() || isSending || isWaitingForResponse) return;

    if (!textOverride) {
      setInputValue("");
    }
    
    setIsSending(true);
    setSendError(null);

    try {
      let currentSessionId = activeSessionId;

      if (!currentSessionId) {
        const canCreate =
          user?.role === "admin" || (user?.role === "user" && !!user?.shipId);
        if (!canCreate) {
          setIsSending(false);
          return;
        }
        const shipIdForSession =
          user?.role === "admin" ? undefined : (user?.shipId ?? undefined);
        const newSession = await createSession(shipIdForSession);
        currentSessionId = newSession.id;
        setActiveSessionId(currentSessionId);
        setIsNewChatMode(false);
      }

      setIsWaitingForResponse(true);
      const userMessage = await sendChatMessage(
        currentSessionId,
        textToSend,
        token!,
      );
      addMessage(userMessage);
      setIsSending(false);
      pollForResponse(currentSessionId, userMessage.id);
    } catch (err) {
      setIsSending(false);
      setIsWaitingForResponse(false);
      setSendError(
        err instanceof Error ? err.message : "Failed to send message",
      );
      console.error("Failed to send message:", err);
    }
  }, [
    inputValue,
    isSending,
    isWaitingForResponse,
    activeSessionId,
    user,
    createSession,
    token,
    addMessage,
    pollForResponse,
  ]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await deleteSession(sessionId);
        if (activeSessionId === sessionId) {
          setActiveSessionId(null);
          setIsNewChatMode(true);
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [deleteSession, activeSessionId],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await renameSession(sessionId, title);
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    },
    [renameSession],
  );

  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
    setIsNewChatMode(true);
    setInputValue("");
    setSendError(null);
  }, []);

  const handleRegenerate = useCallback(
    async (_messageId: string) => {
      if (!activeSessionId || !token) return;
      try {
        setIsWaitingForResponse(true);
        await regenerateChatResponse(activeSessionId, token);
        await refetchMessages();
        refreshSessions();
      } catch (err) {
        console.error("Failed to regenerate:", err);
      } finally {
        setIsWaitingForResponse(false);
      }
    },
    [activeSessionId, token, refetchMessages, refreshSessions],
  );

  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setIsNewChatMode(false);
  }, []);

  const hasError = sessionsError || messagesError || sendError;
  const isDisabled = isSending || isWaitingForResponse || isLoadingSessions;

  return (
    <AppLayout
      sidebar={
        <ChatList
          sessions={filteredSessions.map((s) => ({
            id: s.id,
            title: s.title || "New Chat",
            messageCount: s.messageCount || 0,
            updatedAt: s.updatedAt,
          }))}
          activeId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onRename={handleRenameSession}
        />
      }
      onNewChat={handleNewChat}
      onSearch={setSearchQuery}
      activeTab={activeTab}
      onTabChange={onTabChange}
    >
      <>
        {hasError && activeSessionId && (
          <div className="chat-error-banner">
            <p>{sessionsError || messagesError || sendError}</p>
          </div>
        )}

        {activeSessionId ? (
          <>
            <div className="chat-main__stars" aria-hidden />
            <MessageList
              messages={messages}
              isLoadingResponse={isWaitingForResponse || isLoadingMessages}
              onRegenerate={handleRegenerate}
              onSendMessage={(text) => handleSend(text)}
            />
            <MessageInput
              value={inputValue}
              onChange={setInputValue}
              onSend={() => handleSend()}
              disabled={isDisabled}
              placeholder="Type a message..."
            />
          </>
        ) : (
          <div className="chat-main__welcome-wrap">
            <div className="chat-welcome">
              <div className="chat-welcome__logo-zone">
                <img
                  src={logoImg}
                  alt=""
                  className="chat-welcome__logo"
                  aria-hidden
                />
              </div>
              <h1 className="chat-welcome__title">Trident Intelligence Platform</h1>
              <p className="chat-welcome__sub">What would you like to know?</p>
            </div>
            <MessageInput
              value={inputValue}
              onChange={setInputValue}
              onSend={() => handleSend()}
              disabled={isDisabled}
              placeholder="Start a new conversation..."
            />
          </div>
        )}
      </>
    </AppLayout>
  );
}
