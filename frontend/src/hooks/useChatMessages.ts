import { useState, useEffect, useCallback } from "react";
import type { ChatMessageDto } from "../types/chat";
import { getChatSession } from "../api/chatApi";

interface UseChatMessagesState {
  messages: ChatMessageDto[];
  isLoading: boolean;
  error: string | null;
}

export function useChatMessages(
  sessionId: string | null,
  token: string | null,
) {
  const [state, setState] = useState<UseChatMessagesState>({
    messages: [],
    isLoading: false,
    error: null,
  });

  const fetchMessages = useCallback(async (): Promise<ChatMessageDto[]> => {
    if (!sessionId || !token) return [];
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const session = await getChatSession(sessionId, token);
      const list = session.messages || [];
      setState({
        messages: list,
        isLoading: false,
        error: null,
      });
      return list;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load messages";
      setState({ messages: [], isLoading: false, error: message });
      return [];
    }
  }, [sessionId, token]);

  useEffect(() => {
    if (!sessionId || !token) {
      setState({ messages: [], isLoading: false, error: null });
      return;
    }
    fetchMessages();
  }, [sessionId, token, fetchMessages]);

  const addMessage = (message: ChatMessageDto) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }));
  };

  const updateLastMessage = (messageUpdates: Partial<ChatMessageDto>) => {
    setState((prev) => {
      const messages = [...prev.messages];
      if (messages.length > 0) {
        messages[messages.length - 1] = {
          ...messages[messages.length - 1],
          ...messageUpdates,
        };
      }
      return { ...prev, messages };
    });
  };

  return {
    ...state,
    addMessage,
    updateLastMessage,
    refetchMessages: fetchMessages,
  };
}
