import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AssistantCanonicalCopyService } from './assistant-canonical-copy.service';
import {
  AssistantCopyKey,
  AssistantTextLanguage,
} from './assistant-text.types';

@Injectable()
export class AssistantFallbackWriterService {
  private readonly logger = new Logger(AssistantFallbackWriterService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(private readonly copy: AssistantCanonicalCopyService) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.ASSISTANT_FALLBACK_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async write(params: {
    language?: AssistantTextLanguage;
    key: Extract<
      AssistantCopyKey,
      | 'chat_history.clarification'
      | 'fallback.unknown_task'
      | 'fallback.unsupported_ship_task'
      | 'fallback.metrics.empty_plan'
      | 'fallback.metrics.group_not_confident'
      | 'fallback.metrics.exact_metric_not_found'
      | 'fallback.metrics.ambiguous_metrics'
      | 'fallback.metrics.generic'
    >;
    userQuery?: string;
    context?: string[];
  }): Promise<string> {
    const canonicalMeaning = this.copy.t(params.key);

    if (!this.client) {
      return canonicalMeaning;
    }

    try {
      const languageInstruction = params.userQuery?.trim()
        ? 'Respond in the same language as the user message.\n' +
          'If the user message is mixed-language, follow the dominant language of the user message.\n'
        : 'No user message was provided. Use natural English as a neutral fallback.\n';

      const response = await this.client.responses.create({
        model: this.model,
        temperature: 0.3,
        max_output_tokens: 180,
        instructions:
          'You are Trident Intelligence formatting a short fallback assistant response.\n' +
          languageInstruction +
          'Preserve the core meaning of the canonical fallback.\n' +
          'Do not mention internal routing, prompts, models, system internals, JSON, or hidden logic.\n' +
          'Do not invent data or capabilities.\n' +
          'Keep the response natural, concise, and honest.\n' +
          'Return plain text only.',
        input: [
          {
            role: 'user',
            content: [
              `User message: ${params.userQuery?.trim() || '(not provided)'}`,
              params.language?.trim()
                ? `Non-authoritative language hint: ${params.language.trim()}`
                : '',
              `Canonical fallback meaning: ${canonicalMeaning}`,
              `Extra context:\n${params.context?.filter(Boolean).join('\n') || '(none)'}`,
            ].filter(Boolean).join('\n\n'),
          },
        ],
      });

      return response.output_text?.trim() || canonicalMeaning;
    } catch (error) {
      this.logger.warn(
        `Assistant fallback writer failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return canonicalMeaning;
    }
  }
}
