export interface OpenAiCompatibleChatCompletionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
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
      temperature: input.temperature ?? 0.2,
      ...buildTokenLimitParam(input.model, input.maxTokens ?? 160),
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
  if (/^gpt-5(?:[.-]|$)/i.test(model.trim())) {
    return { max_completion_tokens: maxTokens };
  }

  return { max_tokens: maxTokens };
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
