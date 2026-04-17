import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class SemanticLlmService {
  private readonly logger = new Logger(SemanticLlmService.name);
  private readonly client: OpenAI | null;
  private readonly model =
    process.env.SEMANTIC_LLM_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini';
  private readonly temperature = Number.parseFloat(
    process.env.SEMANTIC_LLM_TEMPERATURE || '0.1',
  );
  private readonly maxTokens = Number.parseInt(
    process.env.SEMANTIC_LLM_MAX_TOKENS || '5000',
    10,
  );

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async generateStructuredObject<T>(params: {
    name: string;
    description: string;
    instructions: string;
    input: string;
    schema: Record<string, unknown>;
  }): Promise<T> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Semantic LLM is not configured because OPENAI_API_KEY is missing',
      );
    }

    const response = await this.client.responses.create({
      model: this.model,
      temperature: Number.isFinite(this.temperature) ? this.temperature : 0.1,
      max_output_tokens: Number.isFinite(this.maxTokens)
        ? this.maxTokens
        : 5000,
      instructions: params.instructions,
      input: params.input,
      text: {
        format: {
          type: 'json_schema',
          name: params.name,
          description: params.description,
          schema: params.schema,
          strict: true,
        },
        verbosity: 'low',
      },
    });

    const raw = response.output_text?.trim();
    if (!raw) {
      throw new Error('Semantic LLM returned an empty structured output');
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.debug(`Failed semantic JSON payload: ${raw.slice(0, 1200)}`);
      throw new Error(
        `Semantic LLM returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
