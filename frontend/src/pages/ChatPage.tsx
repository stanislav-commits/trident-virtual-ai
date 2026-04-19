import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAdminShip } from "../context/AdminShipContext";
import { useAuth } from "../context/AuthContext";
import { useChatSessions } from "../hooks/useChatSessions";
import { useChatMessages } from "../hooks/useChatMessages";
import {
  getChatSession,
  regenerateChatResponse,
  sendChatMessage,
} from "../api/chatApi";
import { AppLayout } from "../components/layout/AppLayout";
import { ChatList } from "../components/chat/ChatList";
import { ChatSourcesPanel } from "../components/chat/ChatSourcesPanel";
import { MessageInput } from "../components/chat/MessageInput";
import { MessageList } from "../components/chat/MessageList";
import logoImg from "../assets/logo-home.png";
import { appRoutes } from "../utils/routes";
import type { ChatContextReferenceDto } from "../types/chat";

export function ChatPage() {
  const { user, token } = useAuth();
  const { sessionShipId } = useAdminShip();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const activeSessionId = sessionId ?? null;
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const {
    sessions,
    isLoading: isLoadingSessions,
    isLoadingMore: isLoadingMoreSessions,
    hasMore: hasMoreSessions,
    error: sessionsError,
    createSession,
    deleteSession,
    renameSession,
    pinSession,
    loadMoreSessions,
    refreshSessions,
  } = useChatSessions(token, deferredSearchQuery);

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
  const [sendError, setSendError] = useState<string | null>(null);
  const [sourcesPanelCitations, setSourcesPanelCitations] = useState<
    ChatContextReferenceDto[] | null
  >(null);

  useEffect(() => {
    setSourcesPanelCitations(null);
  }, [activeSessionId]);

  const pollForResponse = useCallback(
    async (currentSessionId: string, userMessageId: string) => {
      const maxAttempts = 30;
      let attempts = 0;

      while (attempts < maxAttempts) {
        try {
          const updatedSession = await getChatSession(currentSessionId, token!);
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
        } catch {
          // Keep polling until the assistant response is available.
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
        attempts++;
      }

      setIsWaitingForResponse(false);
    },
    [addMessage, refreshSessions, token],
  );

  const handleSend = useCallback(
    async (textOverride?: string) => {
      const textToSend = textOverride || inputValue;
      if (!textToSend.trim() || isSending || isWaitingForResponse) {
        return;
      }

      if (!textOverride) {
        setInputValue("");
      }

      setIsSending(true);
      setSendError(null);

      try {
        let currentSessionId = activeSessionId;

        if (!currentSessionId) {
          const canCreate =
            user?.role === "admin" ||
            (user?.role === "user" && !!user?.shipId);

          if (!canCreate) {
            setIsSending(false);
            return;
          }

          const newSession = await createSession(sessionShipId);
          currentSessionId = newSession.id;
          navigate(appRoutes.chatSession(currentSessionId), { replace: true });
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
    },
    [
      activeSessionId,
      addMessage,
      createSession,
      inputValue,
      isSending,
      isWaitingForResponse,
      navigate,
      pollForResponse,
      token,
      sessionShipId,
      user,
    ],
  );

  const handleDeleteSession = useCallback(
    async (targetSessionId: string) => {
      try {
        await deleteSession(targetSessionId);
        if (activeSessionId === targetSessionId) {
          navigate(appRoutes.chats, { replace: true });
        }
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },
    [activeSessionId, deleteSession, navigate],
  );

  const handleRenameSession = useCallback(
    async (targetSessionId: string, title: string) => {
      try {
        await renameSession(targetSessionId, title);
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    },
    [renameSession],
  );

  const handleTogglePin = useCallback(
    async (targetSessionId: string, isPinned: boolean) => {
      try {
        await pinSession(targetSessionId, isPinned);
      } catch (err) {
        console.error("Failed to update pin state:", err);
      }
    },
    [pinSession],
  );

  const handleNewChat = useCallback(() => {
    navigate(appRoutes.chats);
    setInputValue("");
    setSendError(null);
  }, [navigate]);

  const handleRegenerate = useCallback(
    async () => {
      if (!activeSessionId || !token) {
        return;
      }

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
    [activeSessionId, refetchMessages, refreshSessions, token],
  );

  const handleSelectSession = useCallback(
    (targetSessionId: string) => {
      navigate(appRoutes.chatSession(targetSessionId));
    },
    [navigate],
  );

  const handleOpenSourcesPanel = useCallback(
    (citations: ChatContextReferenceDto[]) => {
      setSourcesPanelCitations(citations);
    },
    [],
  );

  const handleCloseSourcesPanel = useCallback(() => {
    setSourcesPanelCitations(null);
  }, []);

  const hasError = sessionsError || messagesError || sendError;
  const isDisabled = isSending || isWaitingForResponse || isLoadingSessions;

  return (
    <AppLayout
      sidebar={
        <ChatList
          sessions={sessions.map((session) => ({
            id: session.id,
            title: session.title || "New Chat",
            messageCount: session.messageCount || 0,
            pinnedAt: session.pinnedAt ?? null,
            isPinned: session.isPinned ?? Boolean(session.pinnedAt),
            updatedAt: session.updatedAt,
          }))}
          activeId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onRename={handleRenameSession}
          onTogglePin={handleTogglePin}
          hasMore={hasMoreSessions}
          isLoadingMore={isLoadingMoreSessions}
          onLoadMore={loadMoreSessions}
        />
      }
      onNewChat={handleNewChat}
      onSearch={setSearchQuery}
    >
      <>
        {hasError && activeSessionId && (
          <div className="chat-error-banner">
            <p>{sessionsError || messagesError || sendError}</p>
          </div>
        )}

        {activeSessionId ? (
          <div
            className={`chat-main__workspace${sourcesPanelCitations ? " chat-main__workspace--with-panel" : ""}`}
          >
            <div className="chat-main__stars" aria-hidden />
            <section className="chat-main__conversation">
              <MessageList
                messages={messages}
                isLoadingResponse={isWaitingForResponse || isLoadingMessages}
                onRegenerate={handleRegenerate}
                onSendMessage={(text) => handleSend(text)}
                onOpenSourcesPanel={handleOpenSourcesPanel}
                actionsDisabled={isDisabled}
              />
              <MessageInput
                value={inputValue}
                onChange={setInputValue}
                onSend={() => handleSend()}
                disabled={isDisabled}
                placeholder="Type a message..."
              />
            </section>
            {sourcesPanelCitations && (
              <ChatSourcesPanel
                citations={sourcesPanelCitations}
                onClose={handleCloseSourcesPanel}
              />
            )}
          </div>
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
              <h1 className="chat-welcome__title">
                Trident Intelligence Platform
              </h1>
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
