import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AuthenticatedUser } from '../../../core/auth/auth.types';
import { TranscriptionService } from '../../../integrations/transcription/transcription.service';
import { ChatSessionsService } from '../chat-sessions.service';
import {
  CHAT_VOICE_ALLOWED_AUDIO_MIME_TYPES,
  CHAT_VOICE_DEFAULT_MAX_DURATION_MS,
  CHAT_VOICE_DEFAULT_MAX_UPLOAD_BYTES,
  normalizeAudioMimeType,
} from './chat-voice.constants';
import { CreateChatVoiceTranscriptionDto } from './dto/create-chat-voice-transcription.dto';
import {
  ChatVoiceTranscriptionResponseDto,
  UploadedChatVoiceAudioFile,
} from './chat-voice.types';

@Injectable()
export class ChatVoiceTranscriptionService {
  constructor(
    private readonly chatSessionsService: ChatSessionsService,
    private readonly transcriptionService: TranscriptionService,
    private readonly configService: ConfigService,
  ) {}

  async transcribe(
    user: AuthenticatedUser,
    input: CreateChatVoiceTranscriptionDto,
    file: UploadedChatVoiceAudioFile,
  ): Promise<ChatVoiceTranscriptionResponseDto> {
    if (input.sessionId) {
      await this.chatSessionsService.findAccessibleSessionOrThrow(
        user,
        input.sessionId,
      );
    }

    this.validateDuration(input.durationMs);
    const audio = this.validateAudioFile(file);
    const requestId = randomUUID();
    const language = this.normalizeLanguage(input.locale);

    const result = await this.transcriptionService.transcribeAudio({
      buffer: audio.buffer,
      fileName: audio.fileName,
      mimeType: audio.mimeType,
      language,
      requestId,
    });

    const transcript = result.transcript.trim();

    if (!transcript) {
      throw new BadRequestException('No speech was detected in the audio.');
    }

    return {
      transcript,
      language: result.language ?? language ?? null,
      durationMs: result.durationMs ?? input.durationMs ?? null,
      provider: result.provider,
      model: result.model,
      requestId,
    };
  }

  private validateAudioFile(file: UploadedChatVoiceAudioFile): {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    size: number;
  } {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
      throw new BadRequestException('audio file is required.');
    }

    const size = file.size ?? file.buffer.length;

    if (size <= 0) {
      throw new BadRequestException('audio file must not be empty.');
    }

    const maxUploadBytes = this.getMaxUploadBytes();
    if (size > maxUploadBytes) {
      throw new BadRequestException(
        `audio file must be ${this.formatBytes(maxUploadBytes)} or smaller.`,
      );
    }

    const mimeType = normalizeAudioMimeType(file.mimetype);

    if (!CHAT_VOICE_ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(
        'Unsupported audio format. Please upload a webm, ogg, mp4, mpeg, wav, flac, or aac audio file.',
      );
    }

    return {
      buffer: file.buffer,
      fileName: this.buildSafeFileName(file.originalname, mimeType),
      mimeType,
      size,
    };
  }

  private validateDuration(durationMs?: number): void {
    if (durationMs === undefined) {
      return;
    }

    const maxDurationMs = this.getMaxDurationMs();

    if (durationMs > maxDurationMs) {
      throw new BadRequestException(
        `voice input must be ${Math.round(maxDurationMs / 1000)} seconds or shorter.`,
      );
    }
  }

  private normalizeLanguage(locale?: string): string | undefined {
    const normalized = locale?.trim().toLowerCase();

    if (!normalized) {
      return undefined;
    }

    const language = normalized.split(/[-_]/)[0];
    return /^[a-z]{2,3}$/.test(language) ? language : undefined;
  }

  private getMaxUploadBytes(): number {
    return this.configService.get<number>(
      'chat.voice.maxUploadBytes',
      CHAT_VOICE_DEFAULT_MAX_UPLOAD_BYTES,
    );
  }

  private getMaxDurationMs(): number {
    return this.configService.get<number>(
      'chat.voice.maxDurationMs',
      CHAT_VOICE_DEFAULT_MAX_DURATION_MS,
    );
  }

  private buildSafeFileName(
    originalName: string | undefined,
    mimeType: string,
  ): string {
    const extension = this.getExtensionForMimeType(mimeType);
    const sanitizedName = (
      originalName
        ?.replace(/[^\x20-\x7E]+/g, '_')
        .replace(/[\\/:"*?<>|]+/g, '_')
        .trim() || `voice-input.${extension}`
    ).slice(0, 120);

    return /\.[a-z0-9]{2,5}$/i.test(sanitizedName)
      ? sanitizedName
      : `${sanitizedName}.${extension}`;
  }

  private getExtensionForMimeType(mimeType: string): string {
    switch (mimeType) {
      case 'audio/aac':
        return 'aac';
      case 'audio/flac':
        return 'flac';
      case 'audio/m4a':
      case 'audio/mp4':
      case 'audio/x-m4a':
        return 'm4a';
      case 'audio/mpeg':
        return 'mp3';
      case 'audio/ogg':
        return 'ogg';
      case 'audio/wav':
      case 'audio/x-wav':
        return 'wav';
      case 'audio/webm':
      case 'video/webm':
      default:
        return 'webm';
    }
  }

  private formatBytes(value: number): string {
    const megabytes = value / (1024 * 1024);
    return `${Math.round(megabytes * 10) / 10} MB`;
  }
}
