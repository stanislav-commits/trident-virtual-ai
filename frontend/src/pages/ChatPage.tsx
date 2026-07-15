import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAdminShip } from "../context/AdminShipContext";
import { useAuth } from "../context/AuthContext";
import { useChatSessions } from "../hooks/useChatSessions";
import { useChatMessages } from "../hooks/useChatMessages";
import { useChatProgress } from "../hooks/useChatProgress";
import {
  getChatSession,
  regenerateChatResponse,
  sendChatMessage,
} from "../api/chatApi";
import { AppLayout } from "../components/layout/AppLayout";
import { ChatList } from "../components/chat/ChatList";
import { ChatSourcesPanel } from "../components/chat/ChatSourcesPanel";
import { PmsSidePanel } from "../components/chat/PmsSidePanel";
import { AlertsSidePanel } from "../components/chat/AlertsSidePanel";
import type { Alert } from "../api/alertsApi";
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
  // Keep the progress stream open briefly after the reply so the async
  // auto-title ('title' event, generated a beat after 'done') still arrives
  // and updates the header/sidebar live instead of only after a reload.
  const [titleWatch, setTitleWatch] = useState(false);
  const titleWatchTimer = useRef<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sourcesPanelCitations, setSourcesPanelCitations] = useState<
    ChatContextReferenceDto[] | null
  >(null);
  const [showPms, setShowPms] = useState(false);
  const [pmsClosing, setPmsClosing] = useState(false);
  const pmsOpenRef = useRef(false);
  const pmsTimer = useRef<number | null>(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [alertsClosing, setAlertsClosing] = useState(false);
  const alertsOpenRef = useRef(false);
  const alertsTimer = useRef<number | null>(null);
  // True when a panel is shown by swapping in for the other (already-open)
  // panel — both share the same width, so we suppress the width open/close
  // animation and just swap the CONTENT, avoiding a workspace jump.
  const [panelSwap, setPanelSwap] = useState(false);

  useEffect(() => {
    setSourcesPanelCitations(null);
  }, [activeSessionId]);

  // TopBar lives inside AppLayout, so it signals the PMS toggle via a
  // window event rather than a prop drilled through the layout.
  useEffect(() => {
    // Only one right-hand panel is open at a time. When one is already open
    // and the user opens the other, we swap the CONTENT in place (no width
    // animation) so the chat workspace width doesn't jump.
    const togglePms = () => {
      if (pmsTimer.current) {
        window.clearTimeout(pmsTimer.current);
        pmsTimer.current = null;
      }
      if (pmsOpenRef.current) {
        // Closing — keep it mounted briefly so the exit animation can play.
        pmsOpenRef.current = false;
        setPmsClosing(true);
        setPanelSwap(false);
        pmsTimer.current = window.setTimeout(() => {
          setShowPms(false);
          setPmsClosing(false);
          pmsTimer.current = null;
        }, 400);
      } else if (alertsOpenRef.current) {
        // Alerts is already open at full width — swap to PMS without animating.
        if (alertsTimer.current) {
          window.clearTimeout(alertsTimer.current);
          alertsTimer.current = null;
        }
        alertsOpenRef.current = false;
        setAlertsClosing(false);
        setShowAlerts(false);
        pmsOpenRef.current = true;
        setPmsClosing(false);
        setPanelSwap(true);
        setShowPms(true);
      } else {
        // Opening from nothing — play the width animation.
        pmsOpenRef.current = true;
        setPmsClosing(false);
        setPanelSwap(false);
        setShowPms(true);
      }
    };

    const toggleAlerts = () => {
      if (alertsTimer.current) {
        window.clearTimeout(alertsTimer.current);
        alertsTimer.current = null;
      }
      if (alertsOpenRef.current) {
        alertsOpenRef.current = false;
        setAlertsClosing(true);
        setPanelSwap(false);
        alertsTimer.current = window.setTimeout(() => {
          setShowAlerts(false);
          setAlertsClosing(false);
          alertsTimer.current = null;
        }, 400);
      } else if (pmsOpenRef.current) {
        // PMS is already open at full width — swap to alerts without animating.
        if (pmsTimer.current) {
          window.clearTimeout(pmsTimer.current);
          pmsTimer.current = null;
        }
        pmsOpenRef.current = false;
        setPmsClosing(false);
        setShowPms(false);
        alertsOpenRef.current = true;
        setAlertsClosing(false);
        setPanelSwap(true);
        setShowAlerts(true);
      } else {
        // Opening from nothing — play the width animation.
        alertsOpenRef.current = true;
        setAlertsClosing(false);
        setPanelSwap(false);
        setShowAlerts(true);
      }
    };
    window.addEventListener("trident:toggle-pms", togglePms);
    window.addEventListener("trident:toggle-alerts", toggleAlerts);
    return () => {
      window.removeEventListener("trident:toggle-pms", togglePms);
      window.removeEventListener("trident:toggle-alerts", toggleAlerts);
    };
  }, []);

  const clearTitleWatchTimer = useCallback(() => {
    if (titleWatchTimer.current !== null) {
      window.clearTimeout(titleWatchTimer.current);
      titleWatchTimer.current = null;
    }
  }, []);

  // Live SSE progress while the reply is generating: shows real pipeline
  // activity under the typing dots and delivers the finished message
  // instantly (polling remains the fallback transport if SSE drops).
  const { progressText, draftText } = useChatProgress({
    sessionId: activeSessionId,
    token,
    active: isWaitingForResponse || titleWatch,
    onDone: () => {
      pollAbortRef.current?.abort();
      void (async () => {
        await refetchMessages();
        setIsWaitingForResponse(false);
        refreshSessions();
      })();
      // Safety: stop holding the stream open for the title after a while, in
      // case the title refresh is skipped (already titled / manual title). The
      // handle is tracked so a later turn can cancel this timer and it can't
      // tear down that turn's title stream (see clearTitleWatchTimer).
      clearTitleWatchTimer();
      titleWatchTimer.current = window.setTimeout(() => {
        titleWatchTimer.current = null;
        setTitleWatch(false);
      }, 12000);
    },
    onError: (text) => {
      pollAbortRef.current?.abort();
      setIsWaitingForResponse(false);
      // Error ends the turn — stop watching for a title so the stream closes.
      clearTitleWatchTimer();
      setTitleWatch(false);
      setSendError(text);
    },
    // The auto-title is generated after the reply (separate LLM call); refresh
    // the session list the moment it lands so the header + sidebar update live
    // instead of only after a page reload.
    onTitle: () => {
      clearTitleWatchTimer();
      setTitleWatch(false);
      refreshSessions();
    },
  });

  // Header title. Kept in state (not derived) so it survives the active session
  // being filtered out of the sidebar search or falling off the first page:
  // adopt the title once the session appears in the loaded list, reset only
  // when the user switches to a different session.
  const [activeSessionTitle, setActiveSessionTitle] = useState<string | null>(
    null,
  );
  const prevTitleSessionId = useRef<string | null>(activeSessionId);
  useEffect(() => {
    const switched = prevTitleSessionId.current !== activeSessionId;
    prevTitleSessionId.current = activeSessionId;
    const found = sessions.find(
      (session) => session.id === activeSessionId,
    )?.title;
    if (found) {
      setActiveSessionTitle(found);
    } else if (switched) {
      setActiveSessionTitle(null);
    }
  }, [sessions, activeSessionId]);

  // Track unmount/session-change so a long-running pollForResponse loop
  // doesn't keep firing setState after the component is gone or the user
  // navigated away from the session.
  const isMountedRef = useRef(true);
  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      clearTitleWatchTimer();
    };
  }, [clearTitleWatchTimer]);

  // When the user switches sessions, abort the in-flight poll for the
  // previous one — its result is no longer relevant to this view, and stop
  // watching for the previous turn's title so its stream doesn't linger.
  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      clearTitleWatchTimer();
      setTitleWatch(false);
    };
  }, [activeSessionId, clearTitleWatchTimer]);

  const pollForResponse = useCallback(
    async (currentSessionId: string, userMessageId: string) => {
      // Chat-v2 multi-ask + documents/web fallback can take 2-3 minutes on
      // complex questions. Poll fast at first, then back off, up to ~6 min.
      // Never silently drop isWaitingForResponse — keep the typing animation
      // running so the user knows the system hasn't given up.
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;

      const totalBudgetMs = 6 * 60 * 1000;
      const startedAt = Date.now();
      let intervalMs = 2000;

      while (
        Date.now() - startedAt < totalBudgetMs &&
        !controller.signal.aborted &&
        isMountedRef.current
      ) {
        try {
          const updatedSession = await getChatSession(currentSessionId, token!);
          if (controller.signal.aborted || !isMountedRef.current) return;
          const currentMessages = updatedSession.messages || [];
          const lastMessage = currentMessages[currentMessages.length - 1];

          if (
            lastMessage &&
            lastMessage.role === "assistant" &&
            lastMessage.id !== userMessageId
          ) {
            addMessage(lastMessage);
            refreshSessions();
            window.setTimeout(() => {
              if (!isMountedRef.current) return;
              void refreshSessions();
            }, 2500);
            if (isMountedRef.current) setIsWaitingForResponse(false);
            return;
          }
        } catch {
          // Keep polling until the assistant response is available.
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        if (controller.signal.aborted || !isMountedRef.current) return;
        // Linear backoff after 30s so we stop hammering for slow answers
        // but still find them: 2s × 15 attempts, then 5s × ~62 attempts.
        const elapsed = Date.now() - startedAt;
        if (elapsed > 30_000 && intervalMs < 5000) intervalMs = 5000;
      }

      if (!isMountedRef.current || controller.signal.aborted) return;
      // Budget exceeded — surface a polite timeout, but keep the assistant
      // message slot so the user can refresh if it does come in later.
      setIsWaitingForResponse(false);
      setSendError(
        "The answer is taking longer than usual. Try refreshing the page in a moment to see it.",
      );
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
        clearTitleWatchTimer();
        setTitleWatch(true);
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
      clearTitleWatchTimer,
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

  // "Ask AI" on an alert: close the alerts panel and send a context-rich
  // question into the chat so the assistant (with asset/metric/manual tools)
  // returns recommendations grounded in the alerting equipment.
  const handleAskAlertAi = useCallback(
    (alert: Alert) => {
      if (alertsTimer.current) {
        window.clearTimeout(alertsTimer.current);
        alertsTimer.current = null;
      }
      alertsOpenRef.current = false;
      setAlertsClosing(false);
      setShowAlerts(false);

      const subject = alert.assetName ?? "the affected equipment";
      // Encode the alert as a marker the chat renders as a card; the text that
      // follows is the (hidden) instruction the assistant actually answers.
      const card = JSON.stringify({
        title: alert.title,
        asset: alert.assetName,
        severity: alert.severity,
        value: alert.value,
        startedAt: alert.startedAt,
      });
      const prompt =
        `[[ALERT]]${card}\n` +
        `Briefly explain this alert on ${subject}: what the reading means, ` +
        `how serious it is, and what to check first. Keep it short and ` +
        `practical — only mention related tasks or parts if they are clearly relevant.`;
      void handleSend(prompt);
    },
    [handleSend],
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
        clearTitleWatchTimer();
        setTitleWatch(true);
        await regenerateChatResponse(activeSessionId, token);
        await refetchMessages();
        refreshSessions();
      } catch (err) {
        console.error("Failed to regenerate:", err);
      } finally {
        setIsWaitingForResponse(false);
      }
    },
    [
      activeSessionId,
      clearTitleWatchTimer,
      refetchMessages,
      refreshSessions,
      token,
    ],
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
            className={`chat-main__workspace${sourcesPanelCitations || showPms || pmsClosing || showAlerts || alertsClosing ? " chat-main__workspace--with-panel" : ""}`}
          >
            <div className="chat-main__stars" aria-hidden />
            <section className="chat-main__conversation">
              {activeSessionTitle ? (
                <header className="chat-main__title-bar">
                  <h1 className="chat-main__title" title={activeSessionTitle}>
                    {activeSessionTitle}
                  </h1>
                </header>
              ) : null}
              <MessageList
                messages={messages}
                isLoadingResponse={isWaitingForResponse || isLoadingMessages}
                progressText={progressText}
                draftText={draftText}
                onRegenerate={handleRegenerate}
                onSendMessage={(text) => handleSend(text)}
                onOpenSourcesPanel={handleOpenSourcesPanel}
                actionsDisabled={isDisabled}
              />
              <MessageInput
                value={inputValue}
                onChange={setInputValue}
                onSend={() => handleSend()}
                token={token}
                sessionId={activeSessionId}
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
            {(showPms || pmsClosing) && (
              <PmsSidePanel
                token={token}
                shipId={sessionShipId}
                closing={pmsClosing}
                noAnim={panelSwap}
              />
            )}
            {(showAlerts || alertsClosing) && (
              <AlertsSidePanel
                token={token}
                shipId={sessionShipId}
                closing={alertsClosing}
                noAnim={panelSwap}
                onAskAi={handleAskAlertAi}
              />
            )}
          </div>
        ) : (
          <div
            className={`chat-main__workspace${showPms || pmsClosing || showAlerts || alertsClosing ? " chat-main__workspace--with-panel" : ""}`}
          >
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
                <p className="chat-welcome__sub">
                  What would you like to know?
                </p>
              </div>
              <MessageInput
                value={inputValue}
                onChange={setInputValue}
                onSend={() => handleSend()}
                token={token}
                sessionId={activeSessionId}
                disabled={isDisabled}
                placeholder="Start a new conversation..."
              />
            </div>
            {(showPms || pmsClosing) && (
              <PmsSidePanel
                token={token}
                shipId={sessionShipId}
                closing={pmsClosing}
                noAnim={panelSwap}
              />
            )}
            {(showAlerts || alertsClosing) && (
              <AlertsSidePanel
                token={token}
                shipId={sessionShipId}
                closing={alertsClosing}
                noAnim={panelSwap}
                onAskAi={handleAskAlertAi}
              />
            )}
          </div>
        )}
      </>
    </AppLayout>
  );
}
