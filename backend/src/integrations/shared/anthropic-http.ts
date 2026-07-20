/**
 * Anthropic Messages API adapter — exposes the same OpenAI-compatible shape
 * (ChatMessage, ChatToolDefinition, OpenAiCompatibleToolCallResult) so the
 * rest of the codebase doesn't care which provider is on the other end.
 *
 * Differences from OpenAI that we translate here:
 *   • System prompt is a separate top-level `system` param (not a message).
 *   • Tool definitions use `input_schema` instead of `parameters`.
 *   • Assistant tool calls are returned as `content: [{type:'tool_use',…}]`
 *     instead of `tool_calls: [{function:{name, arguments}}]`.
 *   • Tool results go back as `{role:'user', content:[{type:'tool_result',…}]}`
 *     instead of `{role:'tool', tool_call_id, content}`.
 *   • Auth header is `x-api-key` + `anthropic-version`, not `Bearer`.
 *
 * Reference: https://docs.anthropic.com/claude/reference/messages_post
 */

import type {
  ChatMessage,
  ChatToolDefinition,
  OpenAiCompatibleToolCallResult,
  OpenAiToolCall,
} from './openai-compatible-http';

const ANTHROPIC_API_VERSION = '2023-06-01';

export interface AnthropicToolCallInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools: ChatToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /**
   * When provided, the request runs with stream:true and every text delta
   * is forwarded as it arrives (used for live answer streaming in chat).
   * The function still resolves with the same complete result object.
   */
  onTextDelta?: (delta: string) => void;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: 'text'; text: string }>;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export async function createAnthropicToolCallCompletion(
  input: AnthropicToolCallInput,
): Promise<OpenAiCompatibleToolCallResult> {
  const { systemBlocks, messages } = splitSystemFromMessages(input.messages);
  const anthropicMessages = convertMessagesToAnthropic(messages);
  const anthropicTools = convertToolsToAnthropic(input.tools);

  // ── Prompt caching ──
  // Two breakpoints (max 4 allowed):
  //   1. On the last STABLE system block. Render order is tools → system →
  //      messages, so this one breakpoint caches the tool definitions AND
  //      the big system prompt + catalog digest together. Convention with
  //      callers: volatile content (current date) goes in a separate final
  //      system message — when there are ≥2 system blocks we cache up to
  //      the second-to-last, so the daily date rollover doesn't invalidate
  //      the multi-100K-token catalog prefix.
  //   2. On the last content block of the last message. In the tool-call
  //      loop each iteration re-sends the same conversation plus new tool
  //      results — this breakpoint lets iteration N+1 read iteration N's
  //      entire history from cache instead of re-paying for it.
  // The stable prefix (tools + system prompt + catalog digest) gets a
  // 1-HOUR TTL: the write costs 2× instead of 1.25×, but on low rate-limit
  // tiers the bigger win is that cold re-writes of the ~45K-token catalog
  // (which DO count against input-tokens-per-minute) happen once an hour
  // instead of after every 5-minute chat pause. The per-message breakpoint
  // below stays at the default 5m — conversation suffixes are small and
  // only useful within one tool loop anyway.
  if (systemBlocks.length === 1) {
    systemBlocks[0].cache_control = { type: 'ephemeral', ttl: '1h' };
  } else if (systemBlocks.length >= 2) {
    systemBlocks[systemBlocks.length - 2].cache_control = {
      type: 'ephemeral',
      ttl: '1h',
    };
  }
  markLastMessageBlockForCache(anthropicMessages);

  const streaming = Boolean(input.onTextDelta);
  const response = await fetch(buildMessagesUrl(input.baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      ...(streaming ? { stream: true } : {}),
      // Temperature is omitted by default. Newer Claude families (Opus 4.x,
      // some Sonnet 4.x, Fable/Mythos) explicitly reject the field with a
      // 400. Only forward it when the caller explicitly asked — older
      // Sonnet 3.x still accepts it.
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      messages: anthropicMessages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(
      body ||
        `Anthropic tool-call request failed: ${response.status} ${response.statusText}`,
    ) as Error & { status?: number; retryAfterSeconds?: number };
    err.status = response.status;
    // On 429 Anthropic tells us exactly how long until the rate window
    // resets — the caller's retry loop should sleep that long instead of
    // guessing with linear backoff (which expires before the window does).
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      err.retryAfterSeconds = retryAfter;
    }
    throw err;
  }

  const payload = streaming
    ? await consumeAnthropicStream(response, input.onTextDelta!)
    : ((await response.json()) as AnthropicResponse);

  // Anthropic returns content as an array. text blocks → final assistant
  // content; tool_use blocks → toolCalls (translated back to OpenAI shape so
  // the caller's loop is provider-agnostic).
  let content: string | null = null;
  const toolCalls: OpenAiToolCall[] = [];

  for (const block of payload.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content = (content ? content + '\n' : '') + block.text.trim();
    }
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return {
    content: content && content.trim().length > 0 ? content.trim() : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    promptTokens: payload.usage?.input_tokens ?? 0,
    completionTokens: payload.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: payload.usage?.cache_creation_input_tokens,
    cacheReadInputTokens: payload.usage?.cache_read_input_tokens,
  };
}

/**
 * Consume an Anthropic SSE stream, forwarding text deltas as they arrive,
 * and reassemble the complete response object so callers get exactly the
 * same shape as the non-streaming path.
 *
 * Event grammar (the subset we need):
 *   message_start         → usage.input_tokens + cache counters
 *   content_block_start   → opens block N (text | tool_use{id,name})
 *   content_block_delta   → text_delta{text} | input_json_delta{partial_json}
 *   message_delta         → stop_reason + usage.output_tokens
 */
async function consumeAnthropicStream(
  response: Response,
  onTextDelta: (delta: string) => void,
): Promise<AnthropicResponse> {
  if (!response.body) {
    throw new Error('Anthropic stream response has no body');
  }

  interface StreamBlock {
    type: 'text' | 'tool_use';
    text: string;
    id?: string;
    name?: string;
    inputJson: string;
  }
  const blocks = new Map<number, StreamBlock>();
  const usage: NonNullable<AnthropicResponse['usage']> = {};
  let stopReason = 'end_turn';

  const decoder = new TextDecoder();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let buffer = '';

  const handleEvent = (raw: string): void => {
    // Each SSE frame: optional "event: x" line + "data: {json}" line.
    const dataLine = raw
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (!dataLine) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }

    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage ?? {};
        usage.input_tokens = u.input_tokens;
        usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        usage.cache_read_input_tokens = u.cache_read_input_tokens;
        break;
      }
      case 'content_block_start': {
        const cb = event.content_block ?? {};
        blocks.set(event.index, {
          type: cb.type === 'tool_use' ? 'tool_use' : 'text',
          text: '',
          id: cb.id,
          name: cb.name,
          inputJson: '',
        });
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index);
        if (!block) break;
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          block.text += event.delta.text;
          onTextDelta(event.delta.text);
        }
        if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
          block.inputJson += event.delta.partial_json;
        }
        break;
      }
      case 'message_delta': {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens !== undefined) {
          usage.output_tokens = event.usage.output_tokens;
        }
        break;
      }
      case 'error': {
        const msg = event.error?.message ?? 'Anthropic stream error';
        throw new Error(msg);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      handleEvent(frame);
    }
  }

  const content: AnthropicContentBlock[] = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) =>
      b.type === 'tool_use'
        ? {
            type: 'tool_use' as const,
            id: b.id,
            name: b.name,
            input: safeParseJson(b.inputJson),
          }
        : { type: 'text' as const, text: b.text },
    );

  return {
    id: 'streamed',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: stopReason,
    usage,
  };
}

function safeParseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Anthropic puts the system prompt at the top level, not in the messages
 * array. Pull all `role: 'system'` entries out — each becomes its own
 * system content block (block boundaries matter for cache_control
 * placement; see the caching comment in the main function).
 */
function splitSystemFromMessages(messages: ChatMessage[]): {
  systemBlocks: AnthropicSystemBlock[];
  messages: ChatMessage[];
} {
  const systemBlocks: AnthropicSystemBlock[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') {
        systemBlocks.push({ type: 'text', text: m.content });
      }
    } else {
      rest.push(m);
    }
  }
  return { systemBlocks, messages: rest };
}

/**
 * Put a cache breakpoint on the last content block of the last message so
 * the next request in the tool loop can reuse the whole conversation
 * prefix. String content is converted to a block array first.
 */
function markLastMessageBlockForCache(messages: AnthropicMessage[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }];
  }
  const blocks = last.content as AnthropicContentBlock[];
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock) {
    lastBlock.cache_control = { type: 'ephemeral' };
  }
}

function convertMessagesToAnthropic(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }

    if (m.role === 'assistant') {
      // Assistant can be plain text OR tool calls. If it has tool_calls,
      // wrap them in Anthropic's content-block format (tool_use blocks).
      const blocks: AnthropicContentBlock[] = [];
      if (m.content && typeof m.content === 'string' && m.content.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let parsedInput: Record<string, unknown>;
          try {
            parsedInput = JSON.parse(tc.function.arguments || '{}');
          } catch {
            // If arguments are malformed JSON, send an empty input — the
            // model can re-call. Better than crashing the loop.
            parsedInput = {};
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }
      // Anthropic requires content to be non-empty.
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (m.role === 'tool') {
      // OpenAI: {role:'tool', tool_call_id, content}
      // Anthropic: {role:'user', content:[{type:'tool_result', tool_use_id, content}]}
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content,
          },
        ],
      });
      continue;
    }
  }

  // Anthropic disallows two same-role messages in a row. Tool results from
  // multiple parallel calls already arrive as separate `role:'tool'` entries
  // (each → role:'user'); merge consecutive user-messages into one with a
  // combined content array.
  return mergeConsecutiveSameRole(out);
}

function mergeConsecutiveSameRole(
  messages: AnthropicMessage[],
): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      const lastBlocks: AnthropicContentBlock[] = Array.isArray(last.content)
        ? last.content
        : [{ type: 'text', text: last.content }];
      const mBlocks: AnthropicContentBlock[] = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text', text: m.content }];
      last.content = [...lastBlocks, ...mBlocks];
    } else {
      merged.push(m);
    }
  }
  return merged;
}

function convertToolsToAnthropic(
  tools: ChatToolDefinition[],
): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function buildMessagesUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('Anthropic base URL is not configured');
  const parsed = new URL(trimmed);
  const path = parsed.pathname.replace(/\/+$/, ''); // drop trailing slashes
  if (path.endsWith('/messages')) {
    parsed.pathname = path;
  } else if (path === '') {
    // A bare host ("https://api.anthropic.com" with no /v1) still needs the
    // API version prefix — otherwise the request lands on /messages and 404s.
    parsed.pathname = '/v1/messages';
  } else {
    // A base that already carries a path (e.g. a proxy, or ".../v1") just gets
    // /messages appended.
    parsed.pathname = path + '/messages';
  }
  return parsed;
}

/**
 * Single-image vision completion (one user turn = image + text), returning
 * the assistant's text. Used to read photos / scanned certificates that have
 * no embedded text. Claude vision handles images and scanned pages directly.
 */
export async function createAnthropicVisionCompletion(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  imageBase64: string;
  mediaType: string;
  maxTokens?: number;
}): Promise<string | null> {
  const response = await fetch(buildMessagesUrl(input.baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 2000,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.mediaType,
                data: input.imageBase64,
              },
            },
            { type: 'text', text: input.prompt },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      body || `Anthropic vision request failed: ${response.status}`,
    );
  }
  const payload = (await response.json()) as AnthropicResponse;
  let content = '';
  for (const block of payload.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content += block.text;
    }
  }
  return content.trim() || null;
}

/**
 * Transcribe a PDF that has no embedded text layer (a scan) by sending it to
 * Claude as a native `document` block — Claude rasterises and reads every page,
 * OCR included. Used as the fallback when pdf-parse extracts nothing. Returns
 * the assistant's plain-text transcription, or null.
 */
export async function createAnthropicPdfCompletion(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  pdfBase64: string;
  maxTokens?: number;
}): Promise<string | null> {
  const response = await fetch(buildMessagesUrl(input.baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 3000,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: input.pdfBase64,
              },
            },
            { type: 'text', text: input.prompt },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Anthropic PDF request failed: ${response.status}`);
  }
  const payload = (await response.json()) as AnthropicResponse;
  let content = '';
  for (const block of payload.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content += block.text;
    }
  }
  return content.trim() || null;
}
