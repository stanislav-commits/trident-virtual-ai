export interface UploadedChatVoiceAudioFile {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
  size?: number;
}

export interface ChatVoiceTranscriptionResponseDto {
  transcript: string;
  language?: string | null;
  durationMs?: number | null;
  provider: string;
  model: string;
  requestId: string;
}
