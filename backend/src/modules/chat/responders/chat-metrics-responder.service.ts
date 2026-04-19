import { Injectable } from '@nestjs/common';
import { MetricQueryTimeMode } from '../../metrics/enums/metric-query-time-mode.enum';
import { MetricsConceptExecutionService } from '../../metrics/metrics-concept-execution.service';
import { ChatMetricsAskTimeMode } from '../planning/chat-metrics-ask-time-mode.enum';
import { ChatTurnIntent } from '../planning/chat-turn-intent.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

@Injectable()
export class ChatMetricsResponderService {
  constructor(
    private readonly metricsConceptExecutionService: MetricsConceptExecutionService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    if (!input.session.shipId) {
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary:
          'I need an active ship context in this chat before I can look up vessel metrics.',
        data: {
          status: 'missing_ship_context',
        },
        contextReferences: [],
      };
    }

    if (
      input.ask.intent === ChatTurnIntent.HISTORICAL_METRICS &&
      !input.ask.timeMode
    ) {
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary:
          'I could not normalize the historical time in this metrics request yet. Try phrasing the moment more explicitly and I will retry.',
        data: {
          status: 'time_normalization_failed',
        },
        contextReferences: [],
      };
    }

    if (
      input.ask.timeMode === ChatMetricsAskTimeMode.POINT_IN_TIME &&
      !input.ask.timestamp
    ) {
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary:
          'I could not normalize the requested historical moment yet. Try giving a clearer time reference and I will retry.',
        data: {
          status: 'time_normalization_failed',
        },
        contextReferences: [],
      };
    }

    if (input.ask.timeMode === ChatMetricsAskTimeMode.RANGE) {
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary:
          'Range and trend metric queries are still in development right now. Snapshot and point-in-time metric lookups are already connected.',
        data: {
          status: 'range_not_supported_yet',
        },
        contextReferences: [],
      };
    }

    let execution: Awaited<
      ReturnType<MetricsConceptExecutionService['execute']>
    >;

    try {
      execution = await this.metricsConceptExecutionService.execute({
        query: input.ask.question,
        shipId: input.session.shipId,
        timeMode:
          input.ask.timeMode === ChatMetricsAskTimeMode.POINT_IN_TIME
            ? MetricQueryTimeMode.POINT_IN_TIME
            : MetricQueryTimeMode.SNAPSHOT,
        timestamp: input.ask.timestamp ?? undefined,
      });
    } catch (error) {
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary: this.buildExecutionErrorSummary(error),
        data: {
          status: 'execution_failed',
          error:
            error instanceof Error ? error.message : 'Unknown metrics error',
        },
        contextReferences: [],
      };
    }

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: input.ask.responder,
      question: input.ask.question,
      capabilityEnabled: input.ask.capabilityEnabled,
      capabilityLabel: input.ask.capabilityLabel,
      summary: this.buildSummary(execution),
      data: {
        execution,
      },
      contextReferences: this.buildContextReferences(execution.result),
    };
  }

  private buildSummary(
    execution: Awaited<ReturnType<MetricsConceptExecutionService['execute']>>,
  ): string {
    const timestampSuffix = execution.result.timestamp
      ? ` at ${execution.result.timestamp}`
      : '';
    const unitSuffix = execution.result.unit ? ` ${execution.result.unit}` : '';

    if (
      execution.result.value &&
      typeof execution.result.value === 'object' &&
      'latitude' in execution.result.value &&
      'longitude' in execution.result.value
    ) {
      const coordinates = execution.result.value as {
        latitude: number;
        longitude: number;
      };

      return `${execution.concept.displayName}: latitude ${coordinates.latitude}, longitude ${coordinates.longitude}${timestampSuffix}.`;
    }

    if (Array.isArray(execution.result.value)) {
      const values = execution.result.members
        .map((member) => `${member.label}: ${this.formatValue(member.value, member.unit)}`)
        .join('; ');

      return `${execution.concept.displayName}${timestampSuffix}. ${values}`;
    }

    const breakdown = execution.result.members
      .map((member) => `${member.label}: ${this.formatValue(member.value, member.unit)}`)
      .join('; ');

    return [
      `${execution.concept.displayName}: ${this.formatValue(
        execution.result.value,
        execution.result.unit ?? undefined,
      )}${timestampSuffix}.`,
      breakdown ? `Breakdown: ${breakdown}.` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private buildExecutionErrorSummary(error: unknown): string {
    if (!(error instanceof Error)) {
      return 'I could not resolve this metrics request yet.';
    }

    if (
      error.message.includes('timestamp is required for point_in_time execution') ||
      error.message.includes('timestamp must be a valid ISO date')
    ) {
      return 'I could not normalize the historical time in this metrics request yet. Try giving a more exact moment, or ask again and I will retry with a precise timestamp.';
    }

    return `I could not resolve this metrics request yet: ${error.message}`;
  }

  private buildContextReferences(result: {
    members: Array<{
      memberId: string;
      label: string;
      key: string | null;
      value: unknown;
      unit: string | null;
      result: {
        members: Array<unknown>;
      } | null;
    }>;
  }): Record<string, unknown>[] {
    const references: Record<string, unknown>[] = [];

    const visitMembers = (
      members: Array<{
        memberId: string;
        label: string;
        key: string | null;
        value: unknown;
        unit: string | null;
        result: {
          members: Array<unknown>;
        } | null;
      }>,
    ) => {
      for (const member of members) {
        if (member.result && Array.isArray(member.result.members)) {
          visitMembers(member.result.members as never[]);
          continue;
        }

        references.push({
          id: member.memberId,
          sourceTitle: member.label,
          snippet: member.key
            ? `${member.key}: ${this.formatValue(member.value, member.unit ?? undefined)}`
            : `${member.label}: ${this.formatValue(member.value, member.unit ?? undefined)}`,
        });
      }
    };

    visitMembers(result.members);
    return references;
  }

  private formatValue(value: unknown, unit?: string | null): string {
    if (typeof value === 'number') {
      return `${value}${unit ? ` ${unit}` : ''}`;
    }

    if (typeof value === 'string') {
      return `${value}${unit ? ` ${unit}` : ''}`;
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (value === null || value === undefined) {
      return 'no data';
    }

    return `${JSON.stringify(value)}${unit ? ` ${unit}` : ''}`;
  }
}
