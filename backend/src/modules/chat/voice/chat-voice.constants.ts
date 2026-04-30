export const CHAT_VOICE_AUDIO_FIELD_NAME = 'audio';
export const CHAT_VOICE_DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const CHAT_VOICE_DEFAULT_MAX_DURATION_MS = 120_000;

export const CHAT_VOICE_ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
  'video/webm',
]);

export function getChatVoiceUploadLimitBytes(): number {
  const parsed = Number.parseInt(process.env.CHAT_VOICE_MAX_UPLOAD_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : CHAT_VOICE_DEFAULT_MAX_UPLOAD_BYTES;
}

export function normalizeAudioMimeType(value?: string | null): string {
  return value?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}
