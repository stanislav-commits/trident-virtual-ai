import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import {
  ChatHistoryMessage,
  ChatNormalizedOperation,
  ChatNormalizedQuery,
  ChatNormalizedSourceHint,
  ChatTimeIntent,
} from './chat.types';

export class ChatQueryNormalizationService {
  constructor(
    private readonly documentationQueryService = new ChatDocumentationQueryService(),
  ) {}

  normalizeTurn(params: {
    userQuery: string;
    messageHistory?: ChatHistoryMessage[];
  }): ChatNormalizedQuery {
    const rawQuery = params.userQuery.trim();
    const previousUserQuery =
      this.documentationQueryService.getPreviousResolvedUserQuery(
        params.messageHistory,
      ) ?? undefined;
    const clarificationState =
      this.documentationQueryService.getPendingClarificationState(
        params.messageHistory,
      ) ?? undefined;
    const pendingClarificationQuery = clarificationState?.pendingQuery;
    const isClarificationReply =
      this.documentationQueryService.shouldTreatAsClarificationReply(
        rawQuery,
        clarificationState ?? pendingClarificationQuery ?? null,
      );
    const retrievalQuery =
      isClarificationReply && (clarificationState ?? pendingClarificationQuery)
        ? this.documentationQueryService.buildClarificationResolvedQuery(
            clarificationState ?? pendingClarificationQuery,
            rawQuery,
          )
        : this.documentationQueryService.buildRetrievalQuery(
            rawQuery,
            previousUserQuery ?? null,
          );
    const shouldPromoteRetrievalQuery =
      !isClarificationReply &&
      this.documentationQueryService.shouldPromoteRetrievalQueryToAnswerQuery(
        rawQuery,
        previousUserQuery ?? null,
        retrievalQuery,
      );
    const effectiveQuery =
      isClarificationReply || shouldPromoteRetrievalQuery
        ? retrievalQuery
        : rawQuery;
    const searchSpace = [effectiveQuery, retrievalQuery]
      .filter(Boolean)
      .join('\n');
    const operation = this.detectOperation(searchSpace);
    const timeIntent = this.detectTimeIntent(searchSpace, operation);
    const sourceHints = this.detectSourceHints(searchSpace, timeIntent);

    return {
      rawQuery,
      normalizedQuery: this.normalizeText(effectiveQuery),
      retrievalQuery,
      effectiveQuery,
      previousUserQuery,
      pendingClarificationQuery,
      clarificationState:
        isClarificationReply && clarificationState
          ? this.documentationQueryService.resolveClarificationState(
              clarificationState,
              rawQuery,
            )
          : clarificationState,
      followUpMode: isClarificationReply
        ? 'clarification_reply'
        : previousUserQuery &&
            retrievalQuery.trim().toLowerCase() !== rawQuery.toLowerCase()
          ? 'follow_up'
          : 'standalone',
      subject: this.buildSubject(retrievalQuery || effectiveQuery || rawQuery),
      asset: this.detectAsset(retrievalQuery || effectiveQuery || rawQuery),
      operation,
      timeIntent,
      sourceHints,
      isClarificationReply,
      ambiguityFlags: this.detectAmbiguityFlags(searchSpace, timeIntent),
    };
  }

  private detectOperation(searchSpace: string): ChatNormalizedOperation {
    const normalized = this.normalizeText(searchSpace);

    if (
      /\b(last\s+bunkering|last\s+increase|fuel\s+last\s+increase|most\s+recent\s+refill|latest\s+refill)\b/i.test(
        normalized,
      )
    ) {
      return 'event';
    }

    if (
      /\b(latitude|longitude|position|coordinates?|gps|location|lat|lon)\b/i.test(
        normalized,
      ) ||
      /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(normalized)
    ) {
      return 'position';
    }

    if (/\b(average|avg|mean)\b/i.test(normalized)) {
      return 'average';
    }

    if (/\b(min|minimum|lowest|smallest|least)\b/i.test(normalized)) {
      return 'min';
    }

    if (/\b(max|maximum|highest|peak|largest|greatest)\b/i.test(normalized)) {
      return 'max';
    }

    if (
      /\b(trend|trending|evolution|evolve|evolving|rise|rising|fall|falling|spike|spikes|jump|jumps|abrupt|abnormal|sudden|difference|different|diff|movement|moving)\b/i.test(
        normalized,
      ) ||
      (/\b(change|changed|changes|changing|difference|different|diff|movement|moving)\b/i.test(
        normalized,
      ) &&
        /\b(last|past|previous|over the last|history|historical)\b/i.test(
          normalized,
        ))
    ) {
      return 'trend';
    }

    if (
      /\b(used|consumed|consumption|difference|delta|increase|decrease)\b/i.test(
        normalized,
      )
    ) {
      return 'delta';
    }

    if (/\b(total|sum|overall|combined|onboard|left|remaining)\b/i.test(normalized)) {
      return 'sum';
    }

    return 'lookup';
  }

  private detectTimeIntent(
    searchSpace: string,
    operation: ChatNormalizedOperation,
  ): ChatTimeIntent {
    const normalized = this.normalizeText(searchSpace);

    const absoluteDate = this.extractAbsoluteDate(searchSpace);
    if (absoluteDate) {
      return {
        kind: 'historical_point',
        expression: absoluteDate.expression,
        absoluteDate: absoluteDate.isoDate,
      };
    }

    if (operation === 'event') {
      return {
        kind: 'historical_event',
        expression: this.extractMatchedFragment(
          normalized,
          /\b(last\s+bunkering|last\s+increase|fuel\s+last\s+increase|most\s+recent\s+refill|latest\s+refill)\b/i,
        ),
        eventType: /\b(bunkering|refill)\b/i.test(normalized)
          ? 'bunkering'
          : 'fuel_increase',
      };
    }

    const relativeAgoMatch = normalized.match(
      /\b(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i,
    );
    if (relativeAgoMatch) {
      return {
        kind: 'historical_point',
        expression: relativeAgoMatch[0],
        relativeAmount: Number.parseInt(relativeAgoMatch[1], 10),
        relativeUnit: this.normalizeRelativeUnit(relativeAgoMatch[2]),
      };
    }

    const rollingRangeMatch = normalized.match(
      /\b(?:last|past|previous|over the last)\s+(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\b/i,
    );
    if (rollingRangeMatch) {
      return {
        kind: 'historical_range',
        expression: rollingRangeMatch[0],
        relativeAmount: Number.parseInt(rollingRangeMatch[1], 10),
        relativeUnit: this.normalizeRelativeUnit(rollingRangeMatch[2]),
      };
    }

    if (/\byesterday\b/i.test(normalized)) {
      return { kind: 'historical_range', expression: 'yesterday' };
    }

    if (/\b(last week|last month)\b/i.test(normalized)) {
      return {
        kind: 'historical_range',
        expression: this.extractMatchedFragment(
          normalized,
          /\b(last week|last month)\b/i,
        ),
      };
    }

    if (/\b(today|now|current|currently|right now)\b/i.test(normalized)) {
      return {
        kind: 'current',
        expression: this.extractMatchedFragment(
          normalized,
          /\b(today|now|current|currently|right now)\b/i,
        ),
      };
    }

    return { kind: 'none' };
  }

  private detectSourceHints(
    searchSpace: string,
    timeIntent: ChatTimeIntent,
  ): ChatNormalizedSourceHint[] {
    const normalized = this.normalizeText(searchSpace);
    const hints: ChatNormalizedSourceHint[] = [];
    const add = (value: ChatNormalizedSourceHint) => {
      if (!hints.includes(value)) {
        hints.push(value);
      }
    };

    if (
      /\b(telemetry|metric|metrics|tank|fuel|oil|coolant|temperature|pressure|voltage|load|level|bilge|rpm|runtime|hours?|position|latitude|longitude|location|coordinates?|gps|lat|lon)\b/i.test(
        normalized,
      )
    ) {
      add('TELEMETRY');
    }

    if (
      /\b(manual|documentation|docs?|procedure|spec(?:ification)?|guide|handbook|parts?|spares?)\b/i.test(
        normalized,
      )
    ) {
      add('DOCUMENTATION');
    }

    if (/\b(certificate|certificates|expiry|expire)\b/i.test(normalized)) {
      add('CERTIFICATES');
    }

    if (/\b(regulation|mca|imo|marpol|compliance)\b/i.test(normalized)) {
      add('REGULATION');
    }

    if (
      timeIntent.kind === 'historical_point' ||
      timeIntent.kind === 'historical_range' ||
      timeIntent.kind === 'historical_event'
    ) {
      add('HISTORY');
    }

    if (/\b(forecast|order|budget|next month|coming month)\b/i.test(normalized)) {
      add('ANALYTICS');
    }

    return hints;
  }

  private buildSubject(query: string): string | undefined {
    const cleaned = query
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(
        /\b(?:\d+\s+(?:hour|hours|day|days|week|weeks|month|months)\s+ago|last\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months)|past\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months)|previous\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months)|over the last\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months)|today|yesterday|last week|last month|this week|this month)\b/gi,
        ' ',
      )
      .replace(
        /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
        ' ',
      )
      .replace(
        /\b(?:what|when|where|which|show|tell|give|please|check|based|find|did|does|was|were|is|are|the|a|an|on|at|for|during|from|to|of|it|me)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();

    const tokens = this.documentationQueryService
      .extractRetrievalSubjectTerms(cleaned)
      .slice(0, 8);
    if (tokens.length > 0) {
      return tokens.join(' ');
    }

    return cleaned || undefined;
  }

  private detectAsset(query: string): string | undefined {
    const normalized = this.normalizeText(query);
    const side = this.documentationQueryService.detectDirectionalSide(query);

    if (/\b(generator|genset)\b/i.test(normalized)) {
      return side ? `${side} generator` : 'generator';
    }

    if (/\bmain engine|engine\b/i.test(normalized)) {
      return side ? `${side} engine` : 'engine';
    }

    if (/\btank\b/i.test(normalized)) {
      if (/\bfuel\b/i.test(normalized)) return 'fuel tank';
      if (/\boil\b/i.test(normalized)) return 'oil tank';
      if (/\bcoolant\b/i.test(normalized)) return 'coolant tank';
      if (/\bwater\b/i.test(normalized)) return 'water tank';
      return 'tank';
    }

    return side ?? undefined;
  }

  private detectAmbiguityFlags(
    searchSpace: string,
    timeIntent: ChatTimeIntent,
  ): string[] {
    const flags: string[] = [];
    const add = (value: string) => {
      if (!flags.includes(value)) {
        flags.push(value);
      }
    };

    if (this.extractDateWithoutYear(searchSpace)) {
      add('missing_year');
    }

    if (
      timeIntent.kind === 'historical_point' &&
      timeIntent.absoluteDate &&
      !/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/i.test(searchSpace)
    ) {
      add('missing_explicit_time');
    }

    if (!this.buildSubject(searchSpace)) {
      add('broad_subject');
    }

    return flags;
  }

  private extractAbsoluteDate(
    value: string,
  ): { expression: string; isoDate: string } | null {
    const isoMatch = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
      return {
        expression: isoMatch[0],
        isoDate: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`,
      };
    }

    const dayMonthMatch = value.match(
      /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
    );
    if (dayMonthMatch) {
      return {
        expression: dayMonthMatch[0],
        isoDate: this.toIsoDate(
          Number.parseInt(dayMonthMatch[3], 10),
          this.getMonthIndex(dayMonthMatch[2]) + 1,
          Number.parseInt(dayMonthMatch[1], 10),
        ),
      };
    }

    const ordinalDayMonthMatch = value.match(
      /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/i,
    );
    if (ordinalDayMonthMatch) {
      return {
        expression: ordinalDayMonthMatch[0],
        isoDate: this.toIsoDate(
          Number.parseInt(
            ordinalDayMonthMatch[3] ?? String(new Date().getUTCFullYear()),
            10,
          ),
          this.getMonthIndex(ordinalDayMonthMatch[2]) + 1,
          Number.parseInt(ordinalDayMonthMatch[1], 10),
        ),
      };
    }

    const monthDayMatch = value.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    );
    if (monthDayMatch) {
      return {
        expression: monthDayMatch[0],
        isoDate: this.toIsoDate(
          Number.parseInt(monthDayMatch[3], 10),
          this.getMonthIndex(monthDayMatch[1]) + 1,
          Number.parseInt(monthDayMatch[2], 10),
        ),
      };
    }

    const monthOrdinalDayMatch = value.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)(?:,?\s+(\d{4}))?\b/i,
    );
    if (monthOrdinalDayMatch) {
      return {
        expression: monthOrdinalDayMatch[0],
        isoDate: this.toIsoDate(
          Number.parseInt(
            monthOrdinalDayMatch[3] ?? String(new Date().getUTCFullYear()),
            10,
          ),
          this.getMonthIndex(monthOrdinalDayMatch[1]) + 1,
          Number.parseInt(monthOrdinalDayMatch[2], 10),
        ),
      };
    }

    return null;
  }

  private extractDateWithoutYear(value: string): string | null {
    const match = value.match(
      /\b(?:on\s+|from\s+|between\s+)?(\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))(?!\s+\d{4})\b/i,
    );
    if (match?.[1]) {
      return match[1];
    }

    const reverseMatch = value.match(
      /\b((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})(?!,?\s+\d{4})\b/i,
    );
    return reverseMatch?.[1] ?? null;
  }

  private normalizeRelativeUnit(
    value: string,
  ): 'hour' | 'day' | 'week' | 'month' {
    const normalized = value.toLowerCase();
    if (normalized.startsWith('hour')) return 'hour';
    if (normalized.startsWith('day')) return 'day';
    if (normalized.startsWith('week')) return 'week';
    return 'month';
  }

  private normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private extractMatchedFragment(value: string, pattern: RegExp): string | undefined {
    return value.match(pattern)?.[0];
  }

  private getMonthIndex(monthName: string): number {
    const months = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];
    return Math.max(0, months.indexOf(monthName.trim().toLowerCase()));
  }

  private toIsoDate(year: number, month: number, day: number): string {
    return `${year.toString().padStart(4, '0')}-${month
      .toString()
      .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }
}
