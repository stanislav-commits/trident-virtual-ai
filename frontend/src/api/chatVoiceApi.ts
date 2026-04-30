import { fetchWithAuth } from "./core";

const CHAT_API_BASE = import.meta.env.VITE_CHAT_API_BASE ?? "chat-v2";

const chatVoiceApiPath = (path: string = "") =>
  [CHAT_API_BASE.replace(/^\/+|\/+$/g, ""), "voice", path.replace(/^\/+/, "")]
    .filter(Boolean)
    .join("/");

export interface ChatVoiceTranscriptionInput {
  audio: Blob;
  token: string;
  fileName: string;
  sessionId?: string | null;
  locale?: string;
  durationMs?: number;
  clientRequestId?: string;
}

export interface ChatVoiceTranscriptionResult {
  transcript: string;
  language?: string | null;
  durationMs?: number | null;
  provider: string;
  model: string;
  requestId: string;
}

function getErrorMessage(responseBody: unknown, fallback: string): string {
  return typeof responseBody === "object" &&
    responseBody !== null &&
    "message" in responseBody &&
    typeof responseBody.message === "string"
    ? responseBody.message
    : fallback;
}

export async function transcribeChatVoice(
  input: ChatVoiceTranscriptionInput,
): Promise<ChatVoiceTranscriptionResult> {
  const form = new FormData();
  form.append("audio", input.audio, input.fileName);

  if (input.sessionId) {
    form.append("sessionId", input.sessionId);
  }

  if (input.locale?.trim()) {
    form.append("locale", input.locale.trim());
  }

  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    form.append("durationMs", String(Math.round(input.durationMs)));
  }

  if (input.clientRequestId?.trim()) {
    form.append("clientRequestId", input.clientRequestId.trim());
  }

  const response = await fetchWithAuth(chatVoiceApiPath("transcriptions"), {
    token: input.token,
    method: "POST",
    body: form,
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      getErrorMessage(responseBody, "Failed to transcribe voice input"),
    );
  }

  return responseBody as ChatVoiceTranscriptionResult;
}
