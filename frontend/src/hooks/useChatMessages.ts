import { useState, useEffect } from "react";
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

  // Fetch messages when session changes
  useEffect(() => {
    if (!sessionId || !token) {
      setState({ messages: [], isLoading: false, error: null });
      return;
    }

    const fetchMessages = async () => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        const session = await getChatSession(sessionId, token);
        setState({
          messages: session.messages || [],
          isLoading: false,
          error: null,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load messages";
        setState({ messages: [], isLoading: false, error: message });
      }
    };

    fetchMessages();
  }, [sessionId, token]);

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
  };
}
