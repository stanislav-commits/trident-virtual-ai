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
}

/**
 * gpt-5 family reasoning models (gpt-5, gpt-5.1, gpt-5-mini, …) need special
 * handling for reasoning effort, token caps, and temperature.
 */
function isGpt5Family(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model.trim());
}

export async function createOpenAiCompatibleChatCompletion(
  input: OpenAiCompatibleChatCompletionInput,
): Promise<string | null> {
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

  return extractChatCompletionText(payload);
}

// ── Tool-calling (function-calling) variant ────────────────────────────────
//
// Used by the metric-analyzer responder (Phase 3). The model can either
// return a text reply OR a list of tool_calls that the caller must execute
// and feed back into a follow-up call.

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
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
      messages: input.messages,
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
