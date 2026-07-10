import { formatError } from '../../common/utils/error.utils';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import {
  createAnthropicPdfCompletion,
  createAnthropicToolCallCompletion,
  createAnthropicVisionCompletion,
} from '../shared/anthropic-http';
import {
  ChatMessage,
  ChatToolDefinition,
  OpenAiCompatibleToolCallResult,
  createOpenAiCompatibleChatCompletion,
  createOpenAiCompatibleToolCallCompletion,
} from '../shared/openai-compatible-http';

/**
 * A model name is routed to Anthropic if it starts with "claude-".
 * Everything else goes through the OpenAI-compatible client (which also
 * handles Azure OpenAI, OpenRouter, etc. as drop-in replacements).
 */
function isAnthropicModel(model: string): boolean {
  return /^claude-/i.test(model.trim());
}

interface LlmChatCompletionInput {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

interface LlmJsonChatCompletionInput extends LlmChatCompletionInput {
  // Optional shape hint for the caller's TypeScript expectations. The actual
  // JSON.parse'd value is returned without runtime validation.
  schemaHint?: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly configService: ConfigService) {}

  getStatus(): IntegrationStatusDto {
    const provider = this.configService.get<string>('integrations.llm.provider', 'openai');
    const model = this.configService.get<string>('integrations.llm.model', 'gpt-4.1-mini');
    const hasApiKey = Boolean(this.configService.get<string>('integrations.llm.apiKey'));

    return {
      name: 'llm',
      configured: hasApiKey,
      reachable: false,
      details: hasApiKey
        ? `LLM provider "${provider}" with model "${model}" is configured.`
        : `LLM provider "${provider}" selected, but no API key is configured yet.`,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  async createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      return await createOpenAiCompatibleChatCompletion({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        // Sub-LLM text completion → always OpenAI cheap. If LLM_MODEL is a
        // Claude alias (main responder), fall back to a sensible default
        // since these short text tasks don't benefit from Claude reasoning.
        model: this.subLlmModel(input.model),
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
    } catch (error) {
      this.logger.warn(
        `LLM request failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  /**
   * Wraps createChatCompletion with response_format=json_object and
   * JSON.parse on the result. Returns `null` if the LLM is not configured,
   * the call fails, or the response is not valid JSON.
   */
  async createJsonChatCompletion<T = unknown>(
    input: LlmJsonChatCompletionInput,
  ): Promise<T | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const raw = await createOpenAiCompatibleChatCompletion({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        // Same sub-LLM downgrade as createChatCompletion above — JSON
        // extraction tasks don't need Claude.
        model: this.subLlmModel(input.model),
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        responseFormat: 'json_object',
      });

      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn(
        `LLM JSON completion failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  /** Whether image/vision extraction can run (needs an Anthropic key). */
  isVisionConfigured(): boolean {
    return Boolean(this.getAnthropicApiKey());
  }

  /** Whether Claude (Anthropic) is available for direct JSON completions. */
  isAnthropicConfigured(): boolean {
    return Boolean(this.getAnthropicApiKey());
  }

  /**
   * JSON completion via Claude directly (bypasses the OpenAI-compatible sub-LLM
   * path). Used for high-volume mapping where Anthropic's throughput is far
   * better than the sub-model endpoint. Returns parsed T, or null on failure.
   */
  async createAnthropicJsonCompletion<T = unknown>(input: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
    model?: string;
  }): Promise<T | null> {
    if (!this.getAnthropicApiKey()) return null;
    try {
      const result = await createAnthropicToolCallCompletion({
        apiKey: this.getAnthropicApiKey(),
        baseUrl: this.getAnthropicBaseUrl(),
        model: input.model?.trim() || this.getModel(),
        messages: [
          {
            role: 'system',
            content: `${input.systemPrompt}\n\nReturn ONLY a single valid JSON object. No markdown fences, no commentary.`,
          },
          { role: 'user', content: input.userPrompt },
        ],
        tools: [],
        maxTokens: input.maxTokens ?? 4000,
      });
      const text = result.content;
      if (!text) return null;
      // Tolerate stray fences / prose around the object.
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
      return JSON.parse(slice) as T;
    } catch (error) {
      this.logger.warn(
        `Anthropic JSON completion failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  /**
   * Transcribe ALL readable text from a photo or scanned page using Claude
   * vision. For certificates/forms that have no embedded text. Returns plain
   * text, or null if vision isn't configured / the call fails.
   */
  async extractTextFromImage(
    imageBuffer: Buffer,
    mediaType: string,
  ): Promise<string | null> {
    if (!this.isVisionConfigured()) return null;
    try {
      return await createAnthropicVisionCompletion({
        apiKey: this.getAnthropicApiKey(),
        baseUrl: this.getAnthropicBaseUrl(),
        model: this.getModel(),
        systemPrompt:
          'You transcribe documents. Output ALL readable text from the ' +
          'image as plain text, preserving labels, numbers, dates, names and ' +
          'table structure line by line. Be exhaustive and literal. No commentary.',
        prompt:
          'Transcribe every field and value visible in this document image.',
        imageBase64: imageBuffer.toString('base64'),
        mediaType,
        maxTokens: 3000,
      });
    } catch (error) {
      this.logger.warn(
        `Vision extraction failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  /**
   * Transcribe ALL readable text from a scanned PDF (no embedded text layer)
   * by handing the whole PDF to Claude as a native document block — it reads
   * every page including image-only scans. Returns plain text, or null if
   * vision isn't configured / the call fails.
   */
  async extractTextFromPdf(pdfBuffer: Buffer): Promise<string | null> {
    if (!this.isVisionConfigured()) return null;
    try {
      return await createAnthropicPdfCompletion({
        apiKey: this.getAnthropicApiKey(),
        baseUrl: this.getAnthropicBaseUrl(),
        model: this.getModel(),
        systemPrompt:
          'You transcribe documents. Output ALL readable text from every ' +
          'page as plain text, preserving labels, numbers, dates, names and ' +
          'table structure line by line. Be exhaustive and literal. No commentary.',
        prompt:
          'Transcribe every field and value visible in this document.',
        pdfBase64: pdfBuffer.toString('base64'),
        maxTokens: 4000,
      });
    } catch (error) {
      this.logger.warn(
        `PDF extraction failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  /**
   * One round-trip with tool definitions. Returns either text content or a
   * list of tool_calls the caller must execute. The caller appends the tool
   * results and calls again until content is returned.
   */
  async createToolCallChatCompletion(input: {
    messages: ChatMessage[];
    tools: ChatToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<OpenAiCompatibleToolCallResult | null> {
    const detailed = await this.createToolCallChatCompletionDetailed(input);
    return detailed.ok ? detailed.result : null;
  }

  /**
   * Variant that returns classification info so callers can distinguish
   * transient failures (rate-limit, 5xx, network) from permanent ones
   * (misconfig, 400 bad request) — useful for retry logic.
   */
  async createToolCallChatCompletionDetailed(input: {
    messages: ChatMessage[];
    tools: ChatToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    model?: string;
    /** Anthropic-only: live text deltas (stream:true under the hood). */
    onTextDelta?: (delta: string) => void;
  }): Promise<
    | { ok: true; result: OpenAiCompatibleToolCallResult }
    | {
        ok: false;
        transient: boolean;
        kind: 'misconfigured' | 'rate_limited' | 'server_error' | 'bad_request' | 'network' | 'other';
        error: string;
        status?: number;
        retryAfterSeconds?: number;
      }
  > {
    const effectiveModel = input.model?.trim() || this.getModel();
    const usingAnthropic = isAnthropicModel(effectiveModel);

    // Validate the correct API key for the chosen provider.
    if (usingAnthropic) {
      if (!this.getAnthropicApiKey()) {
        return {
          ok: false, transient: false, kind: 'misconfigured',
          error: `Model "${effectiveModel}" requires ANTHROPIC_API_KEY but it is not configured.`,
        };
      }
    } else if (!this.isConfigured()) {
      return {
        ok: false, transient: false, kind: 'misconfigured',
        error: 'LLM service is not configured (missing API key / base URL).',
      };
    }

    try {
      const result = usingAnthropic
        ? await createAnthropicToolCallCompletion({
            apiKey: this.getAnthropicApiKey(),
            baseUrl: this.getAnthropicBaseUrl(),
            model: effectiveModel,
            messages: input.messages,
            tools: input.tools,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
            onTextDelta: input.onTextDelta,
          })
        : await createOpenAiCompatibleToolCallCompletion({
            apiKey: this.getApiKey(),
            baseUrl: this.getBaseUrl(),
            model: effectiveModel,
            messages: input.messages,
            tools: input.tools,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
          });
      return { ok: true, result };
    } catch (error) {
      const msg = formatError(error);
      const status = (error as { status?: number })?.status;
      const retryAfterSeconds = (error as { retryAfterSeconds?: number })
        ?.retryAfterSeconds;
      let kind: 'rate_limited' | 'server_error' | 'bad_request' | 'network' | 'other' = 'other';
      let transient = false;
      if (status === 429) {
        kind = 'rate_limited';
        transient = true;
      } else if (status !== undefined && status >= 500 && status < 600) {
        kind = 'server_error';
        transient = true;
      } else if (status === 408 || /timeout|ECONN|ENETUNREACH|fetch failed/i.test(msg)) {
        kind = 'network';
        transient = true;
      } else if (status !== undefined && status >= 400 && status < 500) {
        kind = 'bad_request';
        transient = false;
      }
      this.logger.error(
        `LLM tool-call failed [${kind}${status ? ` ${status}` : ''}]: ${msg}`,
      );
      return { ok: false, transient, kind, error: msg, status, retryAfterSeconds };
    }
  }

  async summarize(input: string): Promise<string> {
    const summary = await this.createChatCompletion({
      systemPrompt: 'Summarize the following input in a short and helpful way.',
      userPrompt: input,
      temperature: 0.2,
      maxTokens: 160,
    });

    return summary ?? `LLM summary placeholder: ${input}`;
  }

  private getApiKey(): string {
    return this.configService.get<string>('integrations.llm.apiKey', '').trim();
  }

  /**
   * Sub-LLM text / JSON completion tasks (classifier, question decomposer,
   * query resolver, memory summary, asset-fact extraction) go through the
   * OpenAI-compatible client — the non-tool path to Anthropic isn't wired.
   *
   * IMPORTANT: these tasks are routing-critical. The decomposer rewrites
   * the user's question before responder selection — a weak model here
   * silently drops qualifiers like "from onboard telemetry" and misroutes
   * the turn (observed 2026-06-10: telemetry investigation → documents →
   * web fallback). Keep LLM_SUB_MODEL at gpt-5-mini or better; only the
   * truly mechanical bulk tasks (metric binding analysis) pin 4.1-mini
   * explicitly via callerOverride.
   */
  private subLlmModel(callerOverride?: string): string {
    const explicit = callerOverride?.trim();
    if (explicit) {
      // If caller asked for Claude here, downgrade to the configured sub
      // model (these methods do not route to Anthropic).
      return /^claude-/i.test(explicit) ? this.getSubModel() : explicit;
    }
    const envModel = this.getModel();
    return /^claude-/i.test(envModel) ? this.getSubModel() : envModel;
  }

  private getSubModel(): string {
    return (
      this.configService.get<string>('integrations.llm.subModel', '').trim() ||
      'gpt-5-mini'
    );
  }

  private getAnthropicApiKey(): string {
    return this.configService
      .get<string>('integrations.llm.anthropicApiKey', '')
      .trim();
  }

  private getAnthropicBaseUrl(): string {
    return (
      this.configService
        .get<string>('integrations.llm.anthropicBaseUrl', '')
        .trim() || 'https://api.anthropic.com/v1'
    );
  }

  private getBaseUrl(): string {
    return (
      this.configService.get<string>('integrations.llm.baseUrl', '').trim() ||
      'https://api.openai.com/v1'
    );
  }

  private getModel(): string {
    return this.configService
      .get<string>('integrations.llm.model', 'gpt-4.1-mini')
      .trim();
  }

  /** Public accessor so callers can compute model-aware cost estimates. */
  getConfiguredModel(): string {
    return this.getModel();
  }
}
