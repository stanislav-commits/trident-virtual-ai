import { useState } from "react";
import type { ChatMessageDto } from "../types/chat";
import { sendChatMessage } from "../api/chatApi";

interface UseSendMessageState {
  isSending: boolean;
  error: string | null;
}

/**
 * Hook for sending chat messages
 * Handles the async message sending and provides loading/error states
 */
export function useSendMessage(sessionId: string | null, token: string | null) {
  const [state, setState] = useState<UseSendMessageState>({
    isSending: false,
    error: null,
  });

  const send = async (content: string): Promise<ChatMessageDto> => {
    if (!sessionId || !token) {
      throw new Error("No session or authentication token");
    }

    if (!content.trim()) {
      throw new Error("Message content cannot be empty");
    }

    setState({ isSending: true, error: null });
    try {
      const message = await sendChatMessage(sessionId, content, token);
      setState({ isSending: false, error: null });
      return message;
    } catch (err) {
      const error =
        err instanceof Error ? err.message : "Failed to send message";
      setState({ isSending: false, error });
      throw err;
    }
  };

  const clearError = () => {
    setState((prev) => ({ ...prev, error: null }));
  };

  return {
    ...state,
    send,
    clearError,
  };
}
