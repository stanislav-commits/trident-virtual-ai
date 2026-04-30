export interface TranscribeAudioInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  language?: string;
  requestId: string;
}

export interface TranscribeAudioResult {
  transcript: string;
  language?: string | null;
  durationMs?: number | null;
  provider: string;
  model: string;
}
