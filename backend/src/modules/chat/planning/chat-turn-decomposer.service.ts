import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import { formatConversationContext } from '../context/chat-context-prompt.utils';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { parseJsonObject } from './chat-turn-json.utils';
import {
  ChatTurnDecomposition,
  ChatTurnDecompositionAsk,
} from './chat-turn-decomposer.types';

interface ChatTurnDecompositionValidation {
  ok: boolean;
  result?: ChatTurnDecomposition;
  feedback?: string;
}

interface ChatTurnDecompositionCoverageValidation {
  ok: boolean;
  feedback?: string;
}

@Injectable()
export class ChatTurnDecomposerService {
  private readonly maxAsks = 5;

  constructor(private readonly chatLlmService: ChatLlmService) {}

  async decompose(
    context: ChatConversationContext,
  ): Promise<ChatTurnDecomposition> {
    const fallbackQuestion =
      context.latestUserMessage?.content.trim() || 'Continue the conversation.';
    const firstAttempt = await this.requestDecomposition(context);
    const firstValidation = await this.validateDecomposition(context, firstAttempt);

    if (firstValidation.ok && firstValidation.result) {
      return firstValidation.result;
    }

    const retryAttempt = await this.requestDecomposition(
      context,
      firstValidation.feedback ??
        'Return unique asks that each cover one concrete deliverable.',
    );
    const retryValidation = await this.validateDecomposition(context, retryAttempt);

    if (retryValidation.ok && retryValidation.result) {
      return retryValidation.result;
    }

    return {
      asks: [
        {
          question: fallbackQuestion,
        },
      ],
      responseLanguage:
        retryAttempt?.responseLanguage ?? firstAttempt?.responseLanguage ?? null,
      reasoning:
        retryAttempt?.reasoning ??
        firstAttempt?.reasoning ??
        'The planner fell back to a single ask because decomposition was unavailable.',
    };
  }

  private async requestDecomposition(
    context: ChatConversationContext,
    feedback?: string,
  ): Promise<ChatTurnDecomposition | null> {
    const rawResult = await this.chatLlmService.completeText({
      systemPrompt: this.buildSystemPrompt(),
      userPrompt: this.buildUserPrompt(context, feedback),
      temperature: 0,
      maxTokens: 320,
    });

    return this.parseDecomposition(rawResult);
  }

  private buildSystemPrompt(): string {
    return [
      'You split the latest user turn for the Trident backend into atomic asks.',
      'Use the full recent conversation for follow-up context, but only decompose the latest user turn.',
      'Do not answer the user.',
      'Do not classify intent, time, or capabilities yet.',
      'Return between 1 and 5 asks.',
      'Each ask must be standalone, self-contained, and executable on its own.',
      'Each ask must represent exactly one deliverable or one telemetry concept.',
      'If the user requests several different metrics in one sentence, split them into separate asks in the original order.',
      'Do not split document-only comparisons, conflicts, summarize-by-source requests, or synthesis requests across named manuals/SOPs/procedures/documents; keep them as one ask so document routing can build one composite document plan.',
      'Never duplicate asks.',
      'Never merge different telemetry concepts such as speed, location, fuel, depth, heading, wind, temperature, or engine state into one ask.',
      'Preserve the user language when possible, but make each ask explicit enough to stand on its own.',
      'If several split asks share the same time context such as "now" or "5 days ago", keep that time context inside each ask.',
      'Examples:',
      'User: "яка зара швидкість корабля, локація, і кількість палива поточна?"',
      'Output asks:',
      '- "яка поточна швидкість корабля"',
      '- "яка поточна локація корабля"',
      '- "яка поточна кількість палива на судні"',
      'User: "what was the speed and fuel 5 days ago?"',
      'Output asks:',
      '- "what was the vessel speed 5 days ago?"',
      '- "what was the fuel quantity on the vessel 5 days ago?"',
      'Return only raw JSON with this exact shape:',
      '{"asks":[{"question":"string"}],"responseLanguage":"string or null","reasoning":"short string"}',
      'Do not wrap JSON in markdown.',
    ].join('\n');
  }

  private buildUserPrompt(
    context: ChatConversationContext,
    feedback?: string,
  ): string {
    return [
      feedback ? `Correction feedback: ${feedback}` : null,
      'Conversation transcript:',
      formatConversationContext(context),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private parseDecomposition(
    rawResult: string | null,
  ): ChatTurnDecomposition | null {
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    const asks = this.parseAsks(parsed.asks);

    if (asks.length === 0) {
      return null;
    }

    const responseLanguage =
      typeof parsed.responseLanguage === 'string' &&
      parsed.responseLanguage.trim().length > 0
        ? parsed.responseLanguage.trim()
        : null;
    const reasoning =
      typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
        ? parsed.reasoning.trim()
        : 'The latest user turn was decomposed into atomic asks.';

    return {
      asks,
      responseLanguage,
      reasoning,
    };
  }

  private parseAsks(value: unknown): ChatTurnDecompositionAsk[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => this.parseAsk(entry))
      .filter((entry): entry is ChatTurnDecompositionAsk => entry !== null)
      .slice(0, this.maxAsks);
  }

  private parseAsk(value: unknown): ChatTurnDecompositionAsk | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const rawQuestion = (value as Record<string, unknown>).question;
    const question =
      typeof rawQuestion === 'string' && rawQuestion.trim().length > 0
        ? rawQuestion.trim()
        : null;

    if (!question) {
      return null;
    }

    return {
      question,
    };
  }

  private async validateDecomposition(
    context: ChatConversationContext,
    decomposition: ChatTurnDecomposition | null,
  ): Promise<ChatTurnDecompositionValidation> {
    if (!decomposition || decomposition.asks.length === 0) {
      return {
        ok: false,
        feedback:
          'Return between 1 and 5 asks. Each ask must have a non-empty question.',
      };
    }

    const normalizedQuestions = decomposition.asks.map((ask) =>
      this.normalizeQuestionKey(ask.question),
    );
    const uniqueQuestions = new Set(normalizedQuestions);

    if (uniqueQuestions.size !== normalizedQuestions.length) {
      return {
        ok: false,
        feedback:
          'The previous output duplicated asks. Return only unique asks that each cover a different deliverable from the latest user turn.',
      };
    }

    const normalizedResult: ChatTurnDecomposition = {
      ...decomposition,
      asks: decomposition.asks.map((ask) => ({
        question: ask.question.trim(),
      })),
    };
    const coverageValidation = await this.validateCoverage(context, normalizedResult);

    if (!coverageValidation.ok) {
      return {
        ok: false,
        feedback:
          coverageValidation.feedback ??
          'The previous output missed or merged part of the user request. Return all distinct asks separately.',
      };
    }

    return {
      ok: true,
      result: normalizedResult,
    };
  }

  private async validateCoverage(
    context: ChatConversationContext,
    decomposition: ChatTurnDecomposition,
  ): Promise<ChatTurnDecompositionCoverageValidation> {
    const latestUserMessage =
      context.latestUserMessage?.content.trim() || 'Continue the conversation.';
    const rawResult = await this.chatLlmService.completeText({
      systemPrompt: [
        'You audit whether a decomposition fully covers the latest user turn.',
        'Compare the latest user message against the proposed atomic asks.',
        'Mark ok=false if any requested deliverable is missing, duplicated, merged incorrectly, or if a distinct time context was lost.',
        'Current-state asks and historical asks must remain separate when the user requested both.',
        'If the user adds another request with words like "also", that additional request must still appear as its own ask.',
        'Return only raw JSON with this exact shape:',
        '{"ok":true,"feedback":"string or null","reasoning":"short string"}',
        'When ok=false, feedback must briefly explain what was lost or merged and instruct how to correct it.',
        'Do not wrap JSON in markdown.',
      ].join('\n'),
      userPrompt: [
        `Latest user message: ${latestUserMessage}`,
        '',
        'Proposed atomic asks:',
        JSON.stringify(decomposition.asks, null, 2),
      ].join('\n'),
      temperature: 0,
      maxTokens: 220,
    });
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return {
        ok: true,
      };
    }

    const ok = parsed.ok === true;
    const feedback =
      typeof parsed.feedback === 'string' && parsed.feedback.trim().length > 0
        ? parsed.feedback.trim()
        : undefined;

    return {
      ok,
      feedback,
    };
  }

  private normalizeQuestionKey(value: string): string {
    return value
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.?!,;:]+$/g, '')
      .toLowerCase();
  }
}
