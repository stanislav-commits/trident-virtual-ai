import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  ChatV2ClarificationContinuationDecision,
  ChatV2ClarificationContinuationResult,
  ChatV2PendingClarification,
} from './chat-v2-clarification.types';
import { ChatV2TurnContext } from '../context/chat-v2-turn-context.types';
import { MetricsV2ClarificationContinuationService } from '../../metrics-v2/metrics-v2-clarification-continuation.service';

type RawContinuationDecision = Partial<{
  intent: unknown;
  selectedOptionId: unknown;
  reason: unknown;
}>;

@Injectable()
export class ChatV2ClarificationContinuationService {
  private readonly logger = new Logger(
    ChatV2ClarificationContinuationService.name,
  );
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(
    private readonly metricsContinuation: MetricsV2ClarificationContinuationService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.CHAT_V2_CLARIFICATION_CONTINUATION_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async tryHandle(params: {
    turnContext: ChatV2TurnContext;
  }): Promise<ChatV2ClarificationContinuationResult | null> {
    const activeClarification = params.turnContext.activeClarification;
    if (!activeClarification) {
      return null;
    }

    const deterministicOption = this.matchOptionDeterministically({
      activeClarification,
      userQuery: params.turnContext.userQuery,
    });
    if (deterministicOption) {
      return this.handleDecision({
        turnContext: params.turnContext,
        activeClarification,
        decision: {
          intent: 'select_option',
          selectedOptionId: deterministicOption.id,
          reason: 'Matched clarification option deterministically.',
        },
      });
    }

    const decision = await this.classifyContinuation({
      activeClarification,
      userQuery: params.turnContext.userQuery,
    });

    if (!decision || decision.intent === 'new_request') {
      return null;
    }

    return this.handleDecision({
      turnContext: params.turnContext,
      activeClarification,
      decision,
    });
  }

  private async handleDecision(params: {
    turnContext: ChatV2TurnContext;
    activeClarification: ChatV2PendingClarification;
    decision: ChatV2ClarificationContinuationDecision;
  }): Promise<ChatV2ClarificationContinuationResult> {
    const { activeClarification, decision, turnContext } = params;

    if (activeClarification.domain === 'metrics_v2') {
      return this.metricsContinuation.handle({
        turnContext,
        pendingClarification: activeClarification,
        decision,
      });
    }

    return { handled: false };
  }

  private async classifyContinuation(params: {
    activeClarification: ChatV2PendingClarification;
    userQuery: string;
  }): Promise<ChatV2ClarificationContinuationDecision | null> {
    try {
      return await this.classifyWithLlm(params);
    } catch (error) {
      this.logger.warn(
        `Clarification continuation classification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async classifyWithLlm(params: {
    activeClarification: ChatV2PendingClarification;
    userQuery: string;
  }): Promise<ChatV2ClarificationContinuationDecision> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const optionsText =
      params.activeClarification.options
        .map((option, index) => `${index + 1}. [${option.id}] ${option.label}`)
        .join('\n') || '(no explicit options)';

    const response = await this.client.responses.create({
      model: this.model,
      temperature: 0,
      max_output_tokens: 220,
      instructions:
        'Classify whether the new user message is continuing the active clarification.\n' +
        'Return ONLY valid JSON with this shape: {"intent":"show_options"|"select_option"|"new_request"|"unknown","selectedOptionId":string|null,"reason":"short reason"}.\n' +
        'Rules:\n' +
        '- show_options: the user asks which options you found, asks to list them, or asks to see candidates.\n' +
        '- select_option: the user chooses one option by name, number, or short reference.\n' +
        '- new_request: the user is asking a new unrelated question and is no longer resolving the clarification.\n' +
        '- unknown: the user is still responding to the clarification, but the exact action is unclear.\n' +
        'If the message is short and clearly refers to the options, prefer show_options or select_option over new_request.',
      input: [
        {
          role: 'user',
          content:
            `Clarification domain: ${params.activeClarification.domain}\n` +
            `Clarification question: ${params.activeClarification.question}\n` +
            `Original user query: ${params.activeClarification.originalUserQuery}\n` +
            `Available options:\n${optionsText}\n` +
            `Current user message: ${params.userQuery}`,
        },
      ],
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('Empty clarification continuation response');
    }

    return this.parseDecision(outputText);
  }

  private parseDecision(
    outputText: string,
  ): ChatV2ClarificationContinuationDecision {
    const raw = this.parseJsonObject(outputText);
    const intent =
      raw.intent === 'show_options' ||
      raw.intent === 'select_option' ||
      raw.intent === 'new_request' ||
      raw.intent === 'unknown'
        ? raw.intent
        : 'unknown';

    return {
      intent,
      ...(typeof raw.selectedOptionId === 'string' && raw.selectedOptionId.trim()
        ? { selectedOptionId: raw.selectedOptionId.trim() }
        : {}),
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'Clarification continuation classified by LLM.',
    };
  }

  private parseJsonObject(outputText: string): RawContinuationDecision {
    try {
      return JSON.parse(outputText) as RawContinuationDecision;
    } catch {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Clarification continuation response did not contain JSON');
      }

      return JSON.parse(jsonMatch[0]) as RawContinuationDecision;
    }
  }

  private matchOptionDeterministically(params: {
    activeClarification: ChatV2PendingClarification;
    userQuery: string;
  }) {
    const normalizedQuery = params.userQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return null;
    }

    const numericSelection = Number.parseInt(normalizedQuery, 10);
    if (
      Number.isFinite(numericSelection) &&
      String(numericSelection) === normalizedQuery &&
      numericSelection >= 1 &&
      numericSelection <= params.activeClarification.options.length
    ) {
      return params.activeClarification.options[numericSelection - 1];
    }

    return (
      params.activeClarification.options.find(
        (option) =>
          option.id.trim().toLowerCase() === normalizedQuery ||
          option.label.trim().toLowerCase() === normalizedQuery,
      ) ?? null
    );
  }
}
