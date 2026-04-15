import { useCallback, useEffect, useState } from "react";
import type { ChatSessionDto } from "../types/chat";
import {
  getChatSessions,
  createChatSession,
  deleteChatSession,
  renameChatSession,
  setChatSessionPinned,
} from "../api/chatApi";
import { sortChatSessions } from "../utils/chatSessionOrder";

const CHAT_SESSION_PAGE_SIZE = 20;

interface UseChatSessionsState {
  sessions: ChatSessionDto[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
}

function mergeSessionUpdate(
  current: ChatSessionDto,
  updated: ChatSessionDto,
): ChatSessionDto {
  return {
    ...current,
    ...updated,
    messageCount: updated.messageCount ?? current.messageCount,
    messages: updated.messages ?? current.messages,
  };
}

function mergeSessionPages(
  current: ChatSessionDto[],
  incoming: ChatSessionDto[],
): ChatSessionDto[] {
  const merged = new Map<string, ChatSessionDto>();

  for (const session of current) {
    merged.set(session.id, session);
  }

  for (const session of incoming) {
    const existing = merged.get(session.id);
    merged.set(
      session.id,
      existing ? mergeSessionUpdate(existing, session) : session,
    );
  }

  return sortChatSessions([...merged.values()]);
}

export function useChatSessions(
  token: string | null,
  searchQuery = "",
) {
  const normalizedSearch = searchQuery.trim();
  const [state, setState] = useState<UseChatSessionsState>({
    sessions: [],
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    nextCursor: null,
    error: null,
  });

  const fetchFirstPage = useCallback(async () => {
    if (!token) {
      setState({
        sessions: [],
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        nextCursor: null,
        error: null,
      });
      return;
    }

    setState((prev) => ({
      ...prev,
      isLoading: true,
      isLoadingMore: false,
      error: null,
    }));

    try {
      const data = await getChatSessions(token, {
        search: normalizedSearch || undefined,
        limit: CHAT_SESSION_PAGE_SIZE,
      });
      setState({
        sessions: sortChatSessions(data.sessions),
        isLoading: false,
        isLoadingMore: false,
        hasMore: data.hasMore,
        nextCursor: data.nextCursor,
        error: null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load sessions";
      setState({
        sessions: [],
        isLoading: false,
        isLoadingMore: false,
        hasMore: false,
        nextCursor: null,
        error: message,
      });
    }
  }, [normalizedSearch, token]);

  useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const createSession = async (shipId: string | undefined, title?: string) => {
    if (!token) throw new Error("No authentication token");

    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const newSession = await createChatSession(shipId, token, title);
      setState((prev) => ({
        ...prev,
        sessions: sortChatSessions([newSession, ...prev.sessions]),
        isLoading: false,
        error: null,
      }));
      return newSession;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create session";
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
      throw err;
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!token) throw new Error("No authentication token");

    try {
      await deleteChatSession(sessionId, token);
      setState((prev) => ({
        ...prev,
        sessions: prev.sessions.filter((session) => session.id !== sessionId),
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete session";
      setState((prev) => ({ ...prev, error: message }));
      throw err;
    }
  };

  const renameSession = async (sessionId: string, title: string) => {
    if (!token) throw new Error("No authentication token");

    try {
      const updated = await renameChatSession(sessionId, title, token);
      setState((prev) => ({
        ...prev,
        sessions: sortChatSessions(
          prev.sessions.map((session) =>
            session.id === sessionId
              ? mergeSessionUpdate(session, updated)
              : session,
          ),
        ),
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to rename session";
      setState((prev) => ({ ...prev, error: message }));
      throw err;
    }
  };

  const pinSession = async (sessionId: string, isPinned: boolean) => {
    if (!token) throw new Error("No authentication token");

    try {
      const updated = await setChatSessionPinned(sessionId, isPinned, token);
      setState((prev) => ({
        ...prev,
        sessions: sortChatSessions(
          prev.sessions.map((session) =>
            session.id === sessionId
              ? mergeSessionUpdate(session, updated)
              : session,
          ),
        ),
      }));
      return updated;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update chat pin";
      setState((prev) => ({ ...prev, error: message }));
      throw err;
    }
  };

  const loadMoreSessions = useCallback(async () => {
    if (
      !token ||
      state.isLoading ||
      state.isLoadingMore ||
      !state.hasMore ||
      !state.nextCursor
    ) {
      return;
    }

    setState((prev) => ({ ...prev, isLoadingMore: true, error: null }));

    try {
      const data = await getChatSessions(token, {
        search: normalizedSearch || undefined,
        cursor: state.nextCursor,
        limit: CHAT_SESSION_PAGE_SIZE,
      });
      setState((prev) => ({
        ...prev,
        sessions: mergeSessionPages(prev.sessions, data.sessions),
        isLoadingMore: false,
        hasMore: data.hasMore,
        nextCursor: data.nextCursor,
        error: null,
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load more sessions";
      setState((prev) => ({
        ...prev,
        isLoadingMore: false,
        error: message,
      }));
    }
  }, [
    normalizedSearch,
    state.hasMore,
    state.isLoading,
    state.isLoadingMore,
    state.nextCursor,
    token,
  ]);

  const refreshSessions = useCallback(async () => {
    await fetchFirstPage();
  }, [fetchFirstPage]);

  return {
    ...state,
    createSession,
    deleteSession,
    renameSession,
    pinSession,
    loadMoreSessions,
    refreshSessions,
  };
}
