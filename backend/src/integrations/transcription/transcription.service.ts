import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import { createOpenAiCompatibleAudioTranscription } from './openai-compatible-transcription.client';
import { TranscribeAudioInput, TranscribeAudioResult } from './transcription.types';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(private readonly configService: ConfigService) {}

  getStatus(): IntegrationStatusDto {
    const provider = this.getProvider();
    const model = this.getModel();
    const hasApiKey = Boolean(this.getApiKey());

    return {
      name: 'transcription',
      configured: hasApiKey,
      reachable: false,
      details: hasApiKey
        ? `Transcription provider "${provider}" with model "${model}" is configured.`
        : `Transcription provider "${provider}" selected, but no API key is configured yet.`,
    };
  }

  async transcribeAudio(
    input: TranscribeAudioInput,
  ): Promise<TranscribeAudioResult> {
    if (!this.getApiKey()) {
      throw new ServiceUnavailableException(
        'Voice transcription is not configured yet.',
      );
    }

    if (!this.isSupportedProvider()) {
      throw new ServiceUnavailableException(
        'The configured voice transcription provider is not supported.',
      );
    }

    try {
      const result = await createOpenAiCompatibleAudioTranscription({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        model: this.getModel(),
        buffer: input.buffer,
        fileName: input.fileName,
        mimeType: input.mimeType,
        language: input.language,
      });

      return {
        transcript: result.text,
        language: result.language ?? input.language ?? null,
        durationMs: result.durationMs ?? null,
        provider: this.getProvider(),
        model: this.getModel(),
      };
    } catch (error) {
      this.logger.warn(
        `Voice transcription request ${input.requestId} failed: ${this.formatError(error)}`,
      );
      throw new ServiceUnavailableException(
        'Voice transcription is temporarily unavailable.',
      );
    }
  }

  private isSupportedProvider(): boolean {
    return ['openai', 'openai-compatible'].includes(this.getProvider());
  }

  private getProvider(): string {
    return this.configService
      .get<string>('integrations.transcription.provider', 'openai')
      .trim()
      .toLowerCase();
  }

  private getApiKey(): string {
    return (
      this.configService
        .get<string>('integrations.transcription.apiKey', '')
        .trim() ||
      this.configService.get<string>('integrations.llm.apiKey', '').trim()
    );
  }

  private getBaseUrl(): string {
    return (
      this.configService
        .get<string>('integrations.transcription.baseUrl', '')
        .trim() ||
      this.configService.get<string>('integrations.llm.baseUrl', '').trim() ||
      'https://api.openai.com/v1'
    );
  }

  private getModel(): string {
    return this.configService
      .get<string>('integrations.transcription.model', 'whisper-1')
      .trim();
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
