import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AssistantTextLanguage } from './assistant-text.types';

@Injectable()
export class AssistantTextLocalizerService {
  private readonly logger = new Logger(AssistantTextLocalizerService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.ASSISTANT_TEXT_LOCALIZER_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async localize(params: {
    language?: AssistantTextLanguage;
    canonicalText: string;
    userQuery?: string;
    context?: string[];
  }): Promise<string> {
    const hasUserQuery = Boolean(params.userQuery?.trim());

    if (!this.client || !hasUserQuery) {
      return params.canonicalText;
    }

    try {
      const response = await this.client.responses.create({
        model: this.model,
        temperature: 0.2,
        max_output_tokens: 260,
        instructions:
          'Rewrite the provided assistant response into the same language as the user message.\n' +
          'If the user message is mixed-language, follow the dominant language of the user message.\n' +
          'Preserve the exact meaning, structure, numbers, and list items.\n' +
          'Do not add facts, caveats, or explanations.\n' +
          'Keep the wording natural and concise.\n' +
          'Return plain text only.',
        input: [
          {
            role: 'user',
            content: [
              `User message: ${params.userQuery?.trim() || '(not provided)'}`,
              params.language?.trim()
                ? `Non-authoritative language hint: ${params.language.trim()}`
                : '',
              `Canonical assistant response:\n${params.canonicalText}`,
              `Extra context:\n${params.context?.filter(Boolean).join('\n') || '(none)'}`,
            ].filter(Boolean).join('\n\n'),
          },
        ],
      });

      return response.output_text?.trim() || params.canonicalText;
    } catch (error) {
      this.logger.warn(
        `Assistant text localization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return params.canonicalText;
    }
  }
}
