import { fetchWithAuth } from "./client";
import type {
  ChatSessionDto,
  ChatMessageDto,
  ChatSessionListDto,
} from "../types/chat";

const CHAT_API_BASE = import.meta.env.VITE_CHAT_API_BASE ?? "chat-v2";

const chatApiPath = (path: string = "") =>
  [CHAT_API_BASE.replace(/^\/+|\/+$/g, ""), path.replace(/^\/+/, "")]
    .filter(Boolean)
    .join("/");

export async function getChatSessions(
  token: string,
  params?: {
    search?: string;
    cursor?: string | null;
    limit?: number;
  },
): Promise<ChatSessionListDto> {
  const searchParams = new URLSearchParams();
  if (params?.search?.trim()) {
    searchParams.set("search", params.search.trim());
  }
  if (params?.cursor?.trim()) {
    searchParams.set("cursor", params.cursor.trim());
  }
  if (typeof params?.limit === "number" && Number.isFinite(params.limit)) {
    searchParams.set("limit", `${params.limit}`);
  }

  const path = searchParams.size
    ? chatApiPath(`sessions?${searchParams.toString()}`)
    : chatApiPath("sessions");
  const res = await fetchWithAuth(path, { token });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to fetch chat sessions");
  }
  return res.json();
}

export async function getChatSession(
  sessionId: string,
  token: string,
): Promise<ChatSessionDto> {
  const res = await fetchWithAuth(chatApiPath(`sessions/${sessionId}`), {
    token,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to fetch chat session");
  }
  return res.json();
}

/** Omit shipId for admin (global RAG). */
export async function createChatSession(
  shipId: string | undefined,
  token: string,
  title?: string,
): Promise<ChatSessionDto> {
  const body: { shipId?: string | null; title: string } = {
    title: title || "New Chat",
  };
  if (shipId != null) body.shipId = shipId;

  const res = await fetchWithAuth(chatApiPath("sessions"), {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to create chat session");
  }
  return res.json();
}

export async function sendChatMessage(
  sessionId: string,
  content: string,
  token: string,
): Promise<ChatMessageDto> {
  const res = await fetchWithAuth(
    chatApiPath(`sessions/${sessionId}/messages`),
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.trim() }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to send message");
  }
  return res.json();
}

export async function getChatMessages(
  sessionId: string,
  token: string,
): Promise<ChatMessageDto[]> {
  const res = await fetchWithAuth(
    chatApiPath(`sessions/${sessionId}/messages`),
    { token },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to fetch messages");
  }
  return res.json();
}

export async function renameChatSession(
  sessionId: string,
  title: string,
  token: string,
): Promise<ChatSessionDto> {
  const res = await fetchWithAuth(chatApiPath(`sessions/${sessionId}`), {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to rename chat session");
  }
  return res.json();
}

export async function setChatSessionPinned(
  sessionId: string,
  isPinned: boolean,
  token: string,
): Promise<ChatSessionDto> {
  const res = await fetchWithAuth(chatApiPath(`sessions/${sessionId}/pin`), {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isPinned }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update chat pin state");
  }
  return res.json();
}

export async function deleteChatSession(
  sessionId: string,
  token: string,
): Promise<void> {
  const res = await fetchWithAuth(chatApiPath(`sessions/${sessionId}`), {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete chat session");
  }
}

export async function deleteChatMessage(
  sessionId: string,
  messageId: string,
  token: string,
): Promise<void> {
  const res = await fetchWithAuth(
    chatApiPath(`sessions/${sessionId}/messages/${messageId}`),
    { token, method: "DELETE" },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete message");
  }
}

export async function regenerateChatResponse(
  sessionId: string,
  token: string,
): Promise<ChatMessageDto> {
  const res = await fetchWithAuth(
    chatApiPath(`sessions/${sessionId}/regenerate`),
    {
      token,
      method: "POST",
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to regenerate response");
  }
  return res.json();
}
