import { Injectable } from '@nestjs/common';
import { CreateChatMessageDto } from '../chat/dto/create-chat-message.dto';
import { ExecutionPlan, ExecutionStep } from './interfaces/execution-plan.interface';

@Injectable()
export class PlannerService {
  createPlan(input: CreateChatMessageDto): ExecutionPlan {
    const normalized = input.message.trim().toLowerCase();
    const steps: ExecutionStep[] = [];
    const metricsRelated = this.matches(normalized, [
      'metric',
      'metrics',
      'telemetry',
      'temperature',
      'pressure',
      'rpm',
      'fuel',
      'метрик',
      'телеметр',
      'тиск',
      'температур',
      'пали',
    ]);
    const documentsRelated = this.matches(normalized, [
      'manual',
      'document',
      'procedure',
      'instruction',
      'pdf',
      'мануал',
      'документ',
      'процедур',
      'інструкц',
    ]);
    const webRelated = this.matches(normalized, [
      'weather',
      'forecast',
      'news',
      'web',
      'internet',
      'погод',
      'новин',
      'інтернет',
    ]);
    const historyRelated = this.matches(normalized, [
      'history',
      'previous',
      'earlier',
      'last answer',
      'історі',
      'попередн',
      'минула відповідь',
    ]);

    if (metricsRelated) {
      steps.push({
        source: 'metrics',
        reason: 'The request mentions telemetry or operational metrics.',
        query: input.message,
      });
    }

    if (documentsRelated) {
      steps.push({
        source: 'documents',
        reason: 'The request references manuals, instructions, or formal documentation.',
        query: input.message,
      });
    }

    if (webRelated) {
      steps.push({
        source: 'web',
        reason: 'The request requires public external information.',
        query: input.message,
      });
    }

    if (historyRelated || steps.length === 0) {
      steps.unshift({
        source: 'chat-history',
        reason: historyRelated
          ? 'The request explicitly references previous conversation context.'
          : 'The planner always preserves conversational continuity when no stronger source is detected.',
        query: input.message,
      });
    }

    const requiresClarification =
      metricsRelated &&
      normalized.length < 20 &&
      !this.matches(normalized, ['today', 'yesterday', 'сьогодні', 'вчора']);

    const intent = this.resolveIntent(steps);
    return {
      intent,
      responseLanguage: this.detectLanguage(input),
      requiresClarification,
      clarificationQuestion: requiresClarification
        ? 'Уточни, будь ласка, яку саме метрику, судно або часовий діапазон потрібно перевірити.'
        : undefined,
      steps,
    };
  }

  private resolveIntent(steps: ExecutionStep[]): ExecutionPlan['intent'] {
    const uniqueSources = new Set(steps.map((step) => step.source));
    if (uniqueSources.size > 1) return 'mixed';
    const onlySource = steps[0]?.source;
    if (onlySource === 'metrics') return 'metrics';
    if (onlySource === 'documents') return 'documents';
    if (onlySource === 'web') return 'web';
    return 'chat';
  }

  private detectLanguage(input: CreateChatMessageDto): string {
    if (input.locale?.trim()) {
      return input.locale.trim();
    }

    return /[іїєґ]/i.test(input.message) || /[а-я]/i.test(input.message) ? 'uk' : 'en';
  }

  private matches(message: string, keywords: string[]): boolean {
    return keywords.some((keyword) => message.includes(keyword));
  }
}
