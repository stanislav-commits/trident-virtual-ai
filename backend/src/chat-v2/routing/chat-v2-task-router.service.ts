import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ChatV2TurnClassification } from '../chat-v2.types';
import { ChatV2TurnContext } from '../context/chat-v2-turn-context.types';
import {
  ChatV2HistoryIntent,
  ChatV2TaskDomain,
  ChatV2TaskRoute,
} from './chat-v2-task-route.types';

type RawTaskRoute = Partial<{
  domain: unknown;
  confidence: unknown;
  shipRelated: unknown;
  needsFreshExternalData: unknown;
  reason: unknown;
  historyIntent: unknown;
  webSearchQuery: unknown;
}>;

@Injectable()
export class ChatV2TaskRouterService {
  private readonly logger = new Logger(ChatV2TaskRouterService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.CHAT_V2_TASK_ROUTER_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async route(params: {
    turnContext: ChatV2TurnContext;
    classification: ChatV2TurnClassification;
  }): Promise<ChatV2TaskRoute> {
    const { turnContext, classification } = params;

    try {
      const outputText = await this.routeWithLlm({
        turnContext,
        classification,
      });

      return this.parseRoute(outputText, turnContext.userQuery);
    } catch (error) {
      this.logger.warn(
        `Chat v2 task routing failed; routing as unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        domain: 'unknown',
        confidence: 0,
        shipRelated: false,
        needsFreshExternalData: false,
        reason: 'Task routing failed before a domain could be determined.',
      };
    }
  }

  private async routeWithLlm(params: {
    turnContext: ChatV2TurnContext;
    classification: ChatV2TurnClassification;
  }): Promise<string> {
    const { turnContext, classification } = params;
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const recentMessages = turnContext.previousMessages
      .slice(-8)
      .map((message) => `${message.role}: ${message.content.trim()}`)
      .join('\n');

    const response = await this.client.responses.create({
      model: this.model,
      temperature: 0,
      max_output_tokens: 280,
      instructions:
        'Route one already-classified task request for Trident Intelligence.\n' +
        'Return ONLY valid JSON with this shape: ' +
        '{"domain":"chat_history"|"general_web"|"ship_task"|"unknown","confidence":0..1,"shipRelated":boolean,"needsFreshExternalData":boolean,"reason":"short reason","historyIntent":"latest_user_message_before_current"|"latest_assistant_message_before_current"|"previous_user_question_before_current"|"conversation_summary"|"unknown"|null,"webSearchQuery":string|null}.\n' +
        'Domain rules:\n' +
        '- chat_history: asks about what the user or assistant said earlier in this same chat, or asks to recall/summarize this chat.\n' +
        '- general_web: asks about the outside world or current general information not tied to a vessel or ship systems, such as weather, news, public facts, travel, geography, sports, or current events.\n' +
        '- ship_task: asks about a vessel, yacht, ship, onboard systems, manuals, metrics, telemetry, certificates, regulations, procedures, troubleshooting, or any ship-specific operational topic.\n' +
        '- unknown: task request exists, but the source of truth is unclear.\n' +
        'History intent rules:\n' +
        '- latest_user_message_before_current: user asks for their last message before the current one.\n' +
        '- latest_assistant_message_before_current: user asks what the assistant last said.\n' +
        '- previous_user_question_before_current: user asks for their previous question.\n' +
        '- conversation_summary: user asks to summarize the chat.\n' +
        '- unknown: chat_history is correct but the exact history target is unclear.\n' +
        'Important examples:\n' +
        '- "what was my last message?" => domain chat_history, historyIntent latest_user_message_before_current\n' +
        '- "what did you just say?" => domain chat_history, historyIntent latest_assistant_message_before_current\n' +
        '- "what was my previous question?" => domain chat_history, historyIntent previous_user_question_before_current\n' +
        '- "what is the weather in Poland today?" => domain general_web, needsFreshExternalData true\n' +
        '- "what is current yacht speed?" => domain ship_task\n' +
        '- "manual for bunkering" => domain ship_task\n' +
        'If domain is general_web, set webSearchQuery to the best concise search query. If not, set webSearchQuery to null.',
      input: [
        {
          role: 'user',
          content:
            `Detected language: ${classification.language}\n` +
            `Current user message: ${turnContext.userQuery}\n` +
            `Recent prior chat messages:\n${recentMessages || '(none)'}`,
        },
      ],
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('Empty task router response from LLM');
    }

    return outputText;
  }

  private parseRoute(
    outputText: string,
    rawQuery: string,
  ): ChatV2TaskRoute {
    const raw = this.parseJsonObject(outputText);
    const domain = this.parseDomain(raw.domain);

    return {
      domain,
      confidence: this.parseConfidence(raw.confidence),
      shipRelated: this.parseBoolean(raw.shipRelated, domain === 'ship_task'),
      needsFreshExternalData: this.parseBoolean(
        raw.needsFreshExternalData,
        domain === 'general_web',
      ),
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'LLM routed the task request.',
      ...(domain === 'chat_history'
        ? {
            historyIntent: this.parseHistoryIntent(raw.historyIntent),
          }
        : {}),
      ...(domain === 'general_web'
        ? {
            webSearchQuery:
              typeof raw.webSearchQuery === 'string' &&
              raw.webSearchQuery.trim()
                ? raw.webSearchQuery.trim()
                : rawQuery,
          }
        : {}),
    };
  }

  private parseJsonObject(outputText: string): RawTaskRoute {
    try {
      return JSON.parse(outputText) as RawTaskRoute;
    } catch {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Task router response did not contain JSON');
      }

      return JSON.parse(jsonMatch[0]) as RawTaskRoute;
    }
  }

  private parseDomain(value: unknown): ChatV2TaskDomain {
    if (
      value === 'chat_history' ||
      value === 'general_web' ||
      value === 'ship_task' ||
      value === 'unknown'
    ) {
      return value;
    }

    throw new Error('Task router response had an invalid domain');
  }

  private parseHistoryIntent(value: unknown): ChatV2HistoryIntent {
    if (
      value === 'latest_user_message_before_current' ||
      value === 'latest_assistant_message_before_current' ||
      value === 'previous_user_question_before_current' ||
      value === 'conversation_summary' ||
      value === 'unknown'
    ) {
      return value;
    }

    return 'unknown';
  }

  private parseConfidence(value: unknown): number {
    const confidence = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(confidence)) {
      return 0.5;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  private parseBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }
}
