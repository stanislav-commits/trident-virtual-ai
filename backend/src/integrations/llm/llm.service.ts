import { formatError } from '../../common/utils/error.utils';
import {
  currentLlmUsageContext,
  type LlmUsagePurpose,
} from '../../modules/llm-usage/llm-usage.context';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import { LlmUsageRecorderService } from '../../modules/llm-usage/llm-usage-recorder.service';
import {
  AnthropicUsageReport,
  createAnthropicPdfCompletion,
  createAnthropicToolCallCompletion,
  createAnthropicVisionCompletion,
} from '../shared/anthropic-http';
import {
  ChatMessage,
  ChatToolDefinition,
  OpenAiCompatibleToolCallResult,
  OpenAiCompatibleUsage,
  createOpenAiCompatibleChatCompletionDetailed,
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
  /**
   * Historical flag: it used to send a call to the main model instead of the
   * cheap sub-model. Every text call now goes to the main model, so this no
   * longer changes routing. Kept because callers still set it to say "this is
   * a user-facing answer", which is what decides the usage purpose upstream.
   */
  preferMainModel?: boolean;
  /**
   * Send this call to the cheap OpenAI sub-model on purpose. Chat titles are
   * the one job where the small model changed nothing: three words naming a
   * conversation, never read by the crew as an answer.
   */
  preferCheapModel?: boolean;
}

interface LlmJsonChatCompletionInput extends LlmChatCompletionInput {
  // Optional shape hint for the caller's TypeScript expectations. The actual
  // JSON.parse'd value is returned without runtime validation.
  schemaHint?: string;
}


/**
 * Parse JSON the model may have wrapped in prose or a ```json fence.
 *
 * OpenAI enforces response_format=json_object; Anthropic has no equivalent, so
 * a main-model JSON call can come back with the object framed by a sentence.
 * Rather than lose the call to a strict parse, take the outermost {...} block.
 */
function parseJsonLoosely<T>(raw: string): T | null {
  const text = raw.trim();
  const attempt = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  };
  const direct = attempt(text);
  if (direct !== null) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = attempt(fenced.trim());
    if (parsed !== null) return parsed;
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return attempt(text.slice(first, last + 1));
  }
  return null;
}


/**
 * Which model does which job.
 *
 * The crew's answers run on the main model — that is what the vessel is
 * judged by. The admin panel's background work (metric labelling, catalogue
 * clustering, certificate field extraction, alarm analysis, import parsing)
 * runs on the small Anthropic model: same family, same behaviour, a fraction
 * of the cost, and none of it is read as an answer. Document extraction and
 * chat titles stay on OpenAI, which is what they were tuned against.
 *
 * Routing by PURPOSE rather than by a flag at every call site: the purpose is
 * already carried through the turn for the ledger, and a table in one file is
 * something you can read top to bottom and check against the bill.
 */
const ADMIN_PANEL_PURPOSES = new Set<LlmUsagePurpose>([
  'metric_describe',
  'metric_analyze',
  'compliance_extract',
  'alert_analysis',
  'grafana_assist',
]);

const OPENAI_PURPOSES = new Set<LlmUsagePurpose>([
  'doc_ingest',
  'doc_extract',
  'chat_title',
]);

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usageRecorder: LlmUsageRecorderService,
  ) {}

  /**
   * Every model call funnels through this class, which is why the spend ledger
   * is written here rather than at the twenty-odd call sites. The recorder never
   * throws and is not awaited: an answer must not fail because accounting did.
   */
  private recordMediaUsage(
    model: string,
    usage: AnthropicUsageReport,
    startedAt: number,
  ): void {
    this.usageRecorder.record({
      provider: 'anthropic',
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWrite5mTokens: usage.cacheWrite5mTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens,
      cacheReadTokens: usage.cacheReadTokens,
      latencyMs: Date.now() - startedAt,
    });
  }

  private recordTextUsage(
    provider: string,
    model: string,
    usage: OpenAiCompatibleUsage | null,
    startedAt: number,
  ): void {
    if (!usage) return;
    this.usageRecorder.record({
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      latencyMs: Date.now() - startedAt,
    });
  }

  private recordToolCallUsage(
    provider: string,
    model: string,
    result: OpenAiCompatibleToolCallResult,
    startedAt: number,
  ): void {
    this.usageRecorder.record({
      provider,
      model,
      inputTokens: result.promptTokens,
      outputTokens: result.completionTokens,
      cacheWrite5mTokens: result.cacheWrite5mTokens,
      cacheWrite1hTokens: result.cacheWrite1hTokens,
      cacheReadTokens: result.cacheReadInputTokens,
      latencyMs: Date.now() - startedAt,
    });
  }

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
    // EVERY text call runs on the main model (native Claude when LLM_MODEL is
    // claude-*), answers and housekeeping alike.
    //
    // Routing, classification and titles used to run on a cheap OpenAI
    // sub-model. It was not just a bill: the router decides which documents a
    // question may draw on, and on 2026-07-30 it read "how do I start the Mase
    // generator?" as a vessel-procedure question and excluded the equipment
    // manuals — so the crew was told to consult a manual the platform had
    // already indexed. The cheapest call in the turn was deciding the quality
    // of the whole answer.
    //
    // No fallback ladder. There used to be one — OpenAI, then Anthropic's
    // small model — and neither earned its keep: when the credit ran out both
    // keys were out, so the turn failed anyway, after burning extra
    // round-trips, and the crew saw the billing error regardless. A failure
    // here returns null and the caller surfaces the real reason.
    const routed = this.routeByPurpose(input);
    if (routed.provider === 'anthropic') {
      return this.createMainModelTextCompletion({
        ...input,
        model: routed.model,
      });
    }

    if (!this.isConfigured()) {
      return null;
    }

    const subModel = routed.model;
    const subStartedAt = Date.now();
    try {
      const result = await createOpenAiCompatibleChatCompletionDetailed({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        model: subModel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
      this.recordTextUsage('openai', subModel, result.usage, subStartedAt);
      return result.text;
    } catch (error) {
      this.logger.warn(
        `LLM request failed: ${formatError(error)}`,
      );
      return null;
    }
  }

  /**
   * Text completion on the MAIN model for user-facing answer synthesis. When
   * LLM_MODEL is a claude-* alias this runs on NATIVE Anthropic (the tool-call
   * transport with no tools, so `content` is the plain answer) — so answers are
   * actually written by Claude, not the OpenAI sub-model that createChatCompletion
   * otherwise downgrades to. Returns null on any failure so the caller falls
   * back to the sub-model.
   */
  private async createMainModelTextCompletion(
    input: LlmChatCompletionInput,
  ): Promise<string | null> {
    const model = input.model?.trim() || this.getModel();

    if (!isAnthropicModel(model)) {
      // Non-claude main model: OpenAI-compatible with the MAIN model (no downgrade).
      if (!this.isConfigured()) {
        return null;
      }

      const mainStartedAt = Date.now();
      try {
        const result = await createOpenAiCompatibleChatCompletionDetailed({
          apiKey: this.getApiKey(),
          baseUrl: this.getBaseUrl(),
          model,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
        });
        this.recordTextUsage('openai', model, result.usage, mainStartedAt);
        return result.text;
      } catch (error) {
        this.logger.warn(`Main-model answer failed: ${formatError(error)}`);
        return null;
      }
    }

    if (!this.getAnthropicApiKey()) {
      return null;
    }

    const complete = (temperature: number | undefined) =>
      this.createToolCallChatCompletionDetailed({
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
        tools: [],
        temperature,
        maxTokens: input.maxTokens,
        model,
      });

    let result = await complete(input.temperature);

    // Newer Claude families (Opus 4.8+, Sonnet 5, Fable/Mythos) reject the
    // temperature field with a 400. Answers must stay on the main model, so
    // retry once without it instead of degrading to the sub-model.
    if (
      !result.ok &&
      result.kind === 'bad_request' &&
      input.temperature !== undefined &&
      /temperature/i.test(result.error)
    ) {
      this.logger.warn(
        `Main-model (Claude) rejected temperature for "${model}" — retrying without it.`,
      );
      result = await complete(undefined);
    }

    if (result.ok) {
      return result.result.content ?? null;
    }

    this.logger.warn(
      `Main-model (Claude) answer failed [${result.kind}], falling back to sub-model: ${result.error}`,
    );
    return null;
  }

  /**
   * Wraps createChatCompletion with response_format=json_object and
   * JSON.parse on the result. Returns `null` if the LLM is not configured,
   * the call fails, or the response is not valid JSON.
   */
  async createJsonChatCompletion<T = unknown>(
    input: LlmJsonChatCompletionInput,
  ): Promise<T | null> {
    // Main model first, same reasoning as createChatCompletion: the JSON these
    // calls return is a routing decision or a structured extraction, and both
    // are worth getting right. Anthropic has no response_format, so the schema
    // is carried by the prompt and the text is parsed here.
    const routed = this.routeByPurpose(input);
    if (routed.provider === 'anthropic') {
      const json = await this.createMainModelTextCompletion({
        ...input,
        model: routed.model,
      });
      if (json === null) return null;
      const parsed = parseJsonLoosely<T>(json);
      if (parsed === null) {
        this.logger.warn('Main-model JSON completion did not parse.');
      }
      return parsed;
    }

    // OpenAI leg: document extraction, which is what it was tuned against and
    // where response_format=json_object guarantees a parseable object.
    if (!this.isConfigured()) {
      return null;
    }
    const jsonStartedAt = Date.now();
    try {
      const result = await createOpenAiCompatibleChatCompletionDetailed({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        model: routed.model,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        responseFormat: 'json_object',
      });
      this.recordTextUsage('openai', routed.model, result.usage, jsonStartedAt);
      const raw = result.text;
      if (!raw) return null;
      return parseJsonLoosely<T>(raw);
    } catch (error) {
      this.logger.warn(`LLM JSON completion failed: ${formatError(error)}`);
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
    // Same purpose routing as the other entry points — this one is called
    // directly by the metric analyzer, and without it admin-panel work stayed
    // on the main model no matter what the table said.
    const jsonModel = input.model?.trim() || this.anthropicModelForPurpose();
    const jsonStartedAt = Date.now();
    try {
      const result = await createAnthropicToolCallCompletion({
        apiKey: this.getAnthropicApiKey(),
        baseUrl: this.getAnthropicBaseUrl(),
        model: jsonModel,
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
      this.recordToolCallUsage('anthropic', jsonModel, result, jsonStartedAt);
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
    const mediaModel = this.getModel();
    const mediaStartedAt = Date.now();
    try {
      return await createAnthropicVisionCompletion({
        apiKey: this.getAnthropicApiKey(),
        baseUrl: this.getAnthropicBaseUrl(),
        model: mediaModel,
        onUsage: (usage) =>
          this.recordMediaUsage(mediaModel, usage, mediaStartedAt),
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
    const mediaModel = this.getModel();
    const mediaStartedAt = Date.now();
    try {
      return await createAnthropicPdfCompletion({
        apiKey: this.getAnthropicApiKey(),
        baseUrl: this.getAnthropicBaseUrl(),
        model: mediaModel,
        onUsage: (usage) =>
          this.recordMediaUsage(mediaModel, usage, mediaStartedAt),
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

    const startedAt = Date.now();
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
      this.recordToolCallUsage(
        usingAnthropic ? 'anthropic' : 'openai',
        effectiveModel,
        result,
        startedAt,
      );
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

  /**
   * Which model and provider this call belongs to — see the tables above.
   * An explicit `model` from the caller always wins.
   */
  private routeByPurpose(input: LlmChatCompletionInput): {
    provider: 'anthropic' | 'openai';
    model: string;
  } {
    const explicit = input.model?.trim();
    if (explicit) {
      return {
        provider: isAnthropicModel(explicit) ? 'anthropic' : 'openai',
        model: explicit,
      };
    }

    const { purpose } = currentLlmUsageContext();

    // Chat titles: the caller says so directly, and the purpose says so too.
    if (input.preferCheapModel || purpose === 'chat_title') {
      return { provider: 'openai', model: this.getTitleModel() };
    }

    if (OPENAI_PURPOSES.has(purpose)) {
      return { provider: 'openai', model: this.subLlmModel() };
    }

    if (ADMIN_PANEL_PURPOSES.has(purpose)) {
      const adminModel = this.getAdminModel();
      if (this.getAnthropicApiKey() && isAnthropicModel(adminModel)) {
        return { provider: 'anthropic', model: adminModel };
      }
    }

    const mainModel = this.getModel();
    return {
      provider: isAnthropicModel(mainModel) ? 'anthropic' : 'openai',
      model: mainModel,
    };
  }

  /** The cheapest model on the card — chat titles and nothing else. */
  private getTitleModel(): string {
    return (
      this.configService
        .get<string>('integrations.llm.titleModel', '')
        .trim() || 'gpt-4.1-nano'
    );
  }

  /**
   * Sonnet, or Haiku when the purpose belongs to the admin panel. For the
   * Anthropic-only entry points, where provider is not in question.
   */
  private anthropicModelForPurpose(): string {
    const { purpose } = currentLlmUsageContext();
    if (ADMIN_PANEL_PURPOSES.has(purpose)) {
      const adminModel = this.getAdminModel();
      if (isAnthropicModel(adminModel)) return adminModel;
    }
    return this.getModel();
  }

  /** The admin panel's background work — small, same family as the answers. */
  private getAdminModel(): string {
    return (
      this.configService
        .get<string>('integrations.llm.adminModel', '')
        .trim() || 'claude-haiku-4-5-20251001'
    );
  }

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
