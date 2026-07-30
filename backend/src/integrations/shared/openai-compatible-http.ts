export interface OpenAiCompatibleChatCompletionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  // 'json_object' constrains the model to strict JSON; caller can JSON.parse.
  responseFormat?: 'text' | 'json_object';
}

interface OpenAiCompatibleChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>
        | null;
    } | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI caches automatically; without this every hit looks like a miss. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * What one call cost, as the provider reports it. Kept in the transport rather
 * than imported from the usage module so integrations stay free of domain
 * dependencies — `LlmService` is what joins the two.
 */
export interface OpenAiCompatibleUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface OpenAiCompatibleTextResult {
  text: string | null;
  usage: OpenAiCompatibleUsage | null;
}

function readUsage(
  payload: OpenAiCompatibleChatCompletionResponse,
): OpenAiCompatibleUsage | null {
  const usage = payload.usage;
  if (!usage) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    // prompt_tokens INCLUDES the cached part on OpenAI, unlike Anthropic where
    // the buckets are disjoint — subtracting keeps the two providers comparable.
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: cached,
  };
}

/**
 * gpt-5 family reasoning models (gpt-5, gpt-5.1, gpt-5-mini, …) need special
 * handling for reasoning effort, token caps, and temperature.
 */
function isGpt5Family(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model.trim());
}

/**
 * Text completion that also reports what it cost. The plain
 * `createOpenAiCompatibleChatCompletion` below delegates here and drops the
 * usage, so callers that do not care are unaffected.
 */
export async function createOpenAiCompatibleChatCompletionDetailed(
  input: OpenAiCompatibleChatCompletionInput,
): Promise<OpenAiCompatibleTextResult> {
  const response = await fetch(buildChatCompletionsUrl(input.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      ...buildTemperatureParam(input.model, input.temperature ?? 0.2),
      ...buildTokenLimitParam(input.model, input.maxTokens ?? 160),
      // gpt-5 family models are reasoning models: with small token caps
      // they burn the ENTIRE completion budget on hidden reasoning and
      // return empty content (finish_reason=length, content=""). The
      // text/JSON sub-tasks served by this function (classifier,
      // decomposer, chat composer) need fast literal answers, not deep
      // reasoning — pin effort to minimal. The tool-call path below does
      // NOT do this: the main responder benefits from full reasoning and
      // runs with a 4000-token budget.
      ...(isGpt5Family(input.model)
        ? { reasoning_effort: 'minimal' }
        : {}),
      ...(input.responseFormat === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {}),
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      body ||
        `Chat completion request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload =
    (await response.json()) as OpenAiCompatibleChatCompletionResponse;

  return { text: extractChatCompletionText(payload), usage: readUsage(payload) };
}

export async function createOpenAiCompatibleChatCompletion(
  input: OpenAiCompatibleChatCompletionInput,
): Promise<string | null> {
  return (await createOpenAiCompatibleChatCompletionDetailed(input)).text;
}

// ── Tool-calling (function-calling) variant ────────────────────────────────
//
// Used by the metric-analyzer responder (Phase 3). The model can either
// return a text reply OR a list of tool_calls that the caller must execute
// and feed back into a follow-up call.

/** Provider-neutral user content block — a text run or an inline image.
 *  Serialized per provider: Anthropic image blocks (vision) or OpenAI
 *  image_url data URIs. Only USER messages may carry blocks. */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_base64'; mediaType: string; data: string };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiCompatibleToolCallInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools: ChatToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface OpenAiCompatibleToolCallResult {
  content: string | null;
  toolCalls: OpenAiToolCall[] | null;
  promptTokens: number;
  completionTokens: number;
  // Anthropic-only: prompt-cache accounting. promptTokens covers ONLY the
  // uncached remainder; total input = promptTokens + both cache fields.
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /**
   * Cache writes split by requested TTL, because they bill differently: a
   * 5-minute write costs 1.25x input and a 1-hour write 2x. Anthropic reports
   * the split when it can; when it only reports the flat total, that total lands
   * in whichever bucket the request actually asked for.
   */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/** User content blocks → OpenAI wire shape (text runs + image_url data
 *  URIs). String content and non-user roles pass through unchanged. */
function toOpenAiWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'user' && Array.isArray(m.content)) {
    return {
      role: 'user',
      content: m.content.map((b) =>
        b.type === 'image_base64'
          ? {
              type: 'image_url',
              image_url: { url: `data:${b.mediaType};base64,${b.data}` },
            }
          : { type: 'text', text: b.text },
      ),
    };
  }
  return m as unknown as Record<string, unknown>;
}

export async function createOpenAiCompatibleToolCallCompletion(
  input: OpenAiCompatibleToolCallInput,
): Promise<OpenAiCompatibleToolCallResult> {
  const response = await fetch(buildChatCompletionsUrl(input.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      ...buildTemperatureParam(input.model, input.temperature ?? 0.1),
      ...buildTokenLimitParam(input.model, input.maxTokens ?? 800),
      messages: input.messages.map(toOpenAiWireMessage),
      tools: input.tools,
      tool_choice: 'auto',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(
      body ||
        `Tool-call request failed: ${response.status} ${response.statusText}`,
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: OpenAiToolCall[] | null;
      } | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = payload.choices?.[0]?.message;
  const content = typeof msg?.content === 'string' && msg.content.trim().length > 0
    ? msg.content.trim()
    : null;
  const toolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
    ? msg.tool_calls
    : null;

  return {
    content,
    toolCalls,
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
  };
}

function buildChatCompletionsUrl(baseUrl: string): URL {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    throw new Error('Chat completion base URL is not configured');
  }

  const parsedUrl = new URL(trimmedBaseUrl);

  if (parsedUrl.pathname.endsWith('/chat/completions')) {
    return parsedUrl;
  }

  return new URL(
    'chat/completions',
    trimmedBaseUrl.endsWith('/') ? trimmedBaseUrl : `${trimmedBaseUrl}/`,
  );
}

function buildTokenLimitParam(
  model: string,
  maxTokens: number,
): {
  max_tokens?: number;
  max_completion_tokens?: number;
} {
  if (isGpt5Family(model)) {
    // gpt-5 family: max_completion_tokens covers HIDDEN REASONING too, and
    // even reasoning_effort=minimal sometimes spends a few dozen tokens.
    // A small cap (e.g. 24 for chat titles) then yields content="" with
    // finish_reason=length — the title/summary silently never generates.
    // Floor the cap: desired output length is enforced by the prompt, and
    // billing is per generated token, so the floor costs nothing.
    // 4096 floor: long answers (composite document replies run ~900
    // tokens) plus residual reasoning must BOTH fit under the cap, or
    // content comes back empty with finish_reason=length.
    return { max_completion_tokens: Math.max(maxTokens, 4096) };
  }

  return { max_tokens: maxTokens };
}

/**
 * gpt-5 and o-series only accept the default temperature (1) and reject any
 * explicit value with a 400. For those models we omit the field entirely;
 * everything else gets `temperature: <value>`.
 */
function buildTemperatureParam(
  model: string,
  temperature: number,
): { temperature?: number } {
  if (isGpt5Family(model) || /^o[1-9]/i.test(model.trim())) {
    return {};
  }
  return { temperature };
}

function extractChatCompletionText(
  payload: OpenAiCompatibleChatCompletionResponse,
): string | null {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    const normalized = content.trim();
    return normalized || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const normalized = content
    .map((item) => (typeof item?.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

  return normalized || null;
}
