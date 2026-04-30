interface OpenAiCompatibleAudioTranscriptionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  language?: string;
}

interface OpenAiCompatibleAudioTranscriptionResponse {
  text?: string;
  language?: string | null;
  duration?: number | null;
  error?: {
    message?: string;
  } | null;
}

export async function createOpenAiCompatibleAudioTranscription(
  input: OpenAiCompatibleAudioTranscriptionInput,
): Promise<{
  text: string;
  language?: string | null;
  durationMs?: number | null;
}> {
  const form = new FormData();
  const audioBlob = new Blob([toArrayBuffer(input.buffer)], {
    type: input.mimeType,
  });

  form.append('model', input.model);
  form.append('file', audioBlob, input.fileName);
  form.append('response_format', 'json');

  if (input.language) {
    form.append('language', input.language);
  }

  const response = await fetch(buildAudioTranscriptionsUrl(input.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: form,
  });

  const responseText = await response.text();
  const payload = parseJsonObject(responseText);

  if (!response.ok) {
    const message =
      payload?.error?.message?.trim() ||
      responseText.trim() ||
      `Audio transcription request failed: ${response.status} ${response.statusText}`;

    throw new Error(message);
  }

  const text = payload?.text?.trim() ?? '';

  return {
    text,
    language:
      typeof payload?.language === 'string' && payload.language.trim()
        ? payload.language.trim()
        : null,
    durationMs:
      typeof payload?.duration === 'number' && Number.isFinite(payload.duration)
        ? Math.round(payload.duration * 1000)
        : null,
  };
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.length);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function buildAudioTranscriptionsUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    throw new Error('Audio transcription base URL is not configured');
  }

  const normalizedBaseUrl = trimmedBaseUrl.replace(/\/+$/, '');
  return normalizedBaseUrl.endsWith('/audio/transcriptions')
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/audio/transcriptions`;
}

function parseJsonObject(
  value: string,
): OpenAiCompatibleAudioTranscriptionResponse | null {
  if (!value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as OpenAiCompatibleAudioTranscriptionResponse)
      : null;
  } catch {
    return null;
  }
}
