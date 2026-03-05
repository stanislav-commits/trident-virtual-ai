import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';

export interface LLMContext {
  userQuery: string;
  citations?: Array<{
    snippet: string;
    sourceTitle: string;
    pageNumber?: number;
  }>;
  shipName?: string;
  telemetry?: Record<string, unknown>;
  chatHistory?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

@Injectable()
export class LlmService {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    this.client = new OpenAI({ apiKey });
    this.model = process.env.LLM_MODEL || 'gpt-4o-mini';
    this.temperature = parseFloat(process.env.LLM_TEMPERATURE || '0.3');
    this.maxTokens = parseInt(process.env.LLM_MAX_TOKENS || '1500', 10);
  }

  async generateResponse(context: LLMContext): Promise<string> {
    try {
      const systemPrompt = this.buildSystemPrompt(context.shipName);
      const userPrompt = this.buildUserPrompt(context);

      // Build messages array with optional chat history
      const messages: Array<{
        role: 'user' | 'assistant' | 'system';
        content: string;
      }> = [{ role: 'system', content: systemPrompt }];

      // Add previous chat history if available
      if (context.chatHistory && context.chatHistory.length > 0) {
        const historyMessages = context.chatHistory.map((msg) => ({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
        }));
        messages.push(...historyMessages);
      }

      // Add current user query
      messages.push({ role: 'user', content: userPrompt });

      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      return content.trim();
    } catch (err) {
      throw new ServiceUnavailableException(
        `LLM generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async generateTitle(userMessage: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.5,
        max_tokens: 20,
        messages: [
          {
            role: 'system',
            content:
              'Generate a very short chat title (3-6 words, no quotes) summarizing the user message. Respond with ONLY the title, nothing else.',
          },
          { role: 'user', content: userMessage },
        ],
      });

      const title = response.choices[0]?.message?.content?.trim();
      return title || 'New Chat';
    } catch {
      return 'New Chat';
    }
  }

  private buildSystemPrompt(shipName?: string): string {
    const name = shipName ? ` (${shipName})` : '';
    return `You are a technical support assistant for yacht operations and maintenance${name}.
Your role is to provide accurate, actionable guidance based on manuals and procedures.

Guidelines:
- Provide clear, step-by-step instructions when applicable.
- When referencing provided documentation, use inline citation markers like [1], [2] etc. matching the numbered sources in "Relevant Documentation". Place them naturally at the end of the sentence or fact they support.
- Include safety warnings when relevant.
- If information is not available in the provided documents, clearly state that.
- Keep responses concise and focused.
- Use technical terminology appropriately but explain complex concepts.
- If telemetry data is provided, incorporate it into your analysis.`;
  }

  private buildUserPrompt(context: LLMContext): string {
    let prompt = `Question: ${context.userQuery}\n\n`;

    if (context.citations && context.citations.length > 0) {
      prompt += 'Relevant Documentation:\n';
      context.citations.forEach((citation, idx) => {
        const pageInfo = citation.pageNumber
          ? ` (Page ${citation.pageNumber})`
          : '';
        prompt += `[${idx + 1}] ${citation.sourceTitle}${pageInfo}:\n`;
        prompt += `${citation.snippet}\n\n`;
      });
    }

    if (context.chatHistory && context.chatHistory.length > 0) {
      prompt += 'Previous context in this conversation:\n';
      context.chatHistory.slice(-4).forEach((msg) => {
        // Include last 4 messages for context
        const role = msg.role === 'assistant' ? 'Assistant' : 'User';
        prompt += `${role}: ${msg.content}\n\n`;
      });
    }

    if (context.telemetry && Object.keys(context.telemetry).length > 0) {
      prompt += 'Current Telemetry:\n';
      Object.entries(context.telemetry).forEach(([key, value]) => {
        prompt += `- ${key}: ${value}\n`;
      });
    }

    return prompt;
  }
}
