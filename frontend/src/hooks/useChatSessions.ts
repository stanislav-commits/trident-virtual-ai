import { useState, useEffect } from "react";
import type { ChatSessionDto } from "../types/chat";
import {
  getChatSessions,
  createChatSession,
  deleteChatSession,
  renameChatSession,
  setChatSessionPinned,
} from "../api/chatApi";
import { sortChatSessions } from "../utils/chatSessionOrder";

interface UseChatSessionsState {
  sessions: ChatSessionDto[];
  isLoading: boolean;
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

export function useChatSessions(token: string | null) {
  const [state, setState] = useState<UseChatSessionsState>({
    sessions: [],
    isLoading: false,
    error: null,
  });

  // Fetch sessions on mount and when token changes
  useEffect(() => {
    if (!token) {
      setState({ sessions: [], isLoading: false, error: null });
      return;
    }

    const fetchSessions = async () => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        const data = await getChatSessions(token);
        setState({
          sessions: sortChatSessions(data),
          isLoading: false,
          error: null,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load sessions";
        setState({ sessions: [], isLoading: false, error: message });
      }
    };

    fetchSessions();
  }, [token]);

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
        sessions: prev.sessions.filter((s) => s.id !== sessionId),
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
          prev.sessions.map((s) =>
            s.id === sessionId ? mergeSessionUpdate(s, updated) : s,
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
          prev.sessions.map((s) =>
            s.id === sessionId ? mergeSessionUpdate(s, updated) : s,
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

  const refreshSessions = async () => {
    if (!token) return;
    try {
      const data = await getChatSessions(token);
      setState((prev) => ({
        ...prev,
        sessions: sortChatSessions(data),
        error: null,
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to refresh sessions";
      setState((prev) => ({ ...prev, error: message }));
    }
  };

  return {
    ...state,
    createSession,
    deleteSession,
    renameSession,
    pinSession,
    refreshSessions,
  };
}
