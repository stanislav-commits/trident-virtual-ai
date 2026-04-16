import type { ChatNormalizedQuery } from '../../chat/chat.types';
import type { InfluxHistoricalQueryRange } from '../../influxdb/influxdb.service';
import {
  buildDefaultHistoricalEventRange,
  buildFullDayHistoricalRange,
  findHistoricalDateWithoutYear,
  formatHistoricalRange,
  formatHistoricalTimestamp,
  formatHistoricalDayOrRange,
  isSingleUtcDayRange,
  parseExplicitHistoricalDate,
  parseHistoricalTimeOfDay,
  parseRelativeHistoricalPoint,
  parseRelativeHistoricalRange,
} from './historical-telemetry.utils';
import { normalizeTelemetryText } from '../live-telemetry/telemetry-text.utils';

export type HistoricalTelemetryOperation =
  | 'point'
  | 'average'
  | 'min'
  | 'max'
  | 'sum'
  | 'trend'
  | 'delta'
  | 'position'
  | 'event';

export interface ParsedHistoricalTelemetryRequest {
  metricQuery: string;
  operation: HistoricalTelemetryOperation;
  range: InfluxHistoricalQueryRange;
  pointInTime?: Date;
  rangeLabel: string;
  clarificationQuestion?: string;
  eventType?: 'bunkering' | 'fuel_increase';
  trendFocus?: 'general' | 'abrupt_change';
}

interface ParseHistoricalTelemetryRequestParams {
  query: string;
  resolvedSubjectQuery?: string;
  normalizedQuery?: ChatNormalizedQuery;
  isTelemetryLocationQuery: (normalizedQuery: string) => boolean;
  isImplicitDailyStoredFluidUsageQuery: (normalizedQuery: string) => boolean;
}

export const parseHistoricalTelemetryRequest = ({
  query,
  resolvedSubjectQuery,
  normalizedQuery,
  isTelemetryLocationQuery,
  isImplicitDailyStoredFluidUsageQuery,
}: ParseHistoricalTelemetryRequestParams): ParsedHistoricalTelemetryRequest | null => {
  const searchSpace = `${query}\n${resolvedSubjectQuery ?? ''}`;
  const normalized = normalizeTelemetryText(searchSpace);
  const positionQuery = isTelemetryLocationQuery(normalized);
  const operation = detectHistoricalOperation(
    searchSpace,
    positionQuery,
    normalizedQuery,
  );
  const trendFocus =
    operation === 'trend' ? detectHistoricalTrendFocus(searchSpace) : undefined;
  const missingYearFragment = findHistoricalDateWithoutYear(searchSpace);
  if (missingYearFragment) {
    return {
      metricQuery: sanitizeHistoricalMetricQuery(query),
      operation,
      range: { start: new Date(), stop: new Date() },
      rangeLabel: '',
      clarificationQuestion: `Which year do you mean for ${missingYearFragment}?`,
      ...(trendFocus ? { trendFocus } : {}),
    };
  }

  const relativeRange = parseRelativeHistoricalRange(searchSpace);
  const explicitDate = parseExplicitHistoricalDate(searchSpace);
  const explicitTime = parseHistoricalTimeOfDay(searchSpace);
  const relativePointInTime = parseRelativeHistoricalPoint(
    searchSpace,
    normalizedQuery,
  );
  const implicitRange = buildImplicitHistoricalRange(
    searchSpace,
    operation,
    isImplicitDailyStoredFluidUsageQuery,
  );
  const metricQuery = sanitizeHistoricalMetricQuery(
    normalizedQuery?.subject?.trim()
      ? normalizedQuery.subject
      : resolvedSubjectQuery?.trim()
        ? resolvedSubjectQuery
        : query,
  );

  if (operation === 'event') {
    const range = buildDefaultHistoricalEventRange();
    return {
      metricQuery: metricQuery || 'fuel tank',
      operation,
      range,
      rangeLabel: formatHistoricalRange(range),
      eventType:
        normalizedQuery?.timeIntent.eventType ??
        (/\b(bunkering|refill)\b/i.test(searchSpace)
          ? 'bunkering'
          : 'fuel_increase'),
      ...(trendFocus ? { trendFocus } : {}),
    };
  }

  if (
    !relativeRange &&
    !explicitDate &&
    !relativePointInTime &&
    !implicitRange
  ) {
    return null;
  }

  if (
    relativeRange &&
    !explicitDate &&
    !explicitTime &&
    isForecastPlanningHistoryQuery(searchSpace)
  ) {
    return null;
  }

  if (operation === 'point' || operation === 'position') {
    if (relativePointInTime) {
      return {
        metricQuery,
        operation,
        range: {
          start: relativePointInTime,
          stop: relativePointInTime,
        },
        pointInTime: relativePointInTime,
        rangeLabel: formatHistoricalTimestamp(relativePointInTime),
        ...(trendFocus ? { trendFocus } : {}),
      };
    }

    if (!explicitTime) {
      if (operation === 'position') {
        const singleDayRange = explicitDate
          ? buildFullDayHistoricalRange(explicitDate)
          : isSingleUtcDayRange(relativeRange)
            ? relativeRange
            : null;

        if (singleDayRange) {
          return {
            metricQuery,
            operation,
            range: singleDayRange,
            rangeLabel: formatHistoricalDayOrRange(singleDayRange),
          };
        }
      }

      return {
        metricQuery,
        operation,
        range: { start: new Date(), stop: new Date() },
        rangeLabel: '',
        clarificationQuestion:
          operation === 'position'
            ? 'Please specify the exact time, or ask for a single day, for this historical position lookup.'
            : 'Please specify the exact time for this historical telemetry lookup.',
        ...(trendFocus ? { trendFocus } : {}),
      };
    }

    const baseDate = explicitDate
      ? explicitDate
      : relativeRange
        ? new Date(relativeRange.start)
        : null;
    if (!baseDate) {
      return null;
    }

    const pointInTime = new Date(
      Date.UTC(
        baseDate.getUTCFullYear(),
        baseDate.getUTCMonth(),
        baseDate.getUTCDate(),
        explicitTime.hours,
        explicitTime.minutes,
        0,
        0,
      ),
    );

    return {
      metricQuery,
      operation,
      range: {
        start: pointInTime,
        stop: pointInTime,
      },
      pointInTime,
      rangeLabel: formatHistoricalTimestamp(pointInTime),
      ...(trendFocus ? { trendFocus } : {}),
    };
  }

  if (relativePointInTime) {
    return {
      metricQuery,
      operation,
      range: {
        start: relativePointInTime,
        stop: relativePointInTime,
      },
      pointInTime: relativePointInTime,
      rangeLabel: formatHistoricalTimestamp(relativePointInTime),
      ...(trendFocus ? { trendFocus } : {}),
    };
  }

  const range =
    relativeRange ?? implicitRange ?? buildFullDayHistoricalRange(explicitDate!);
  return {
    metricQuery,
    operation,
    range,
    rangeLabel:
      implicitRange && !relativeRange && !explicitDate
        ? 'the last 24 hours'
        : formatHistoricalRange(range),
    ...(trendFocus ? { trendFocus } : {}),
  };
};

const isForecastPlanningHistoryQuery = (query: string): boolean => {
  const normalized = normalizeTelemetryText(query);
  return (
    /\b(forecast|budget|need|order)\b/i.test(normalized) &&
    /\b(next|coming|upcoming)\s+(month|week)\b/i.test(normalized)
  );
};

const detectHistoricalOperation = (
  query: string,
  positionQuery: boolean,
  normalizedQuery?: ChatNormalizedQuery,
): HistoricalTelemetryOperation => {
  if (positionQuery) {
    return 'position';
  }

  if (normalizedQuery?.operation === 'event') {
    return 'event';
  }

  if (normalizedQuery?.operation === 'trend') {
    return 'trend';
  }

  const normalized = normalizeTelemetryText(query);
  if (
    /\b(last\s+bunkering|last\s+increase|fuel\s+last\s+increase|most\s+recent\s+refill|latest\s+refill)\b/i.test(
      normalized,
    )
  ) {
    return 'event';
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
  if (isHistoricalTrendQuery(normalized)) {
    return 'trend';
  }
  if (
    /\b(used|usage|consumed|consumption|difference|delta|increase|decrease)\b/i.test(
      normalized,
    )
  ) {
    return 'delta';
  }
  if (/\b(total|sum|overall|combined)\b/i.test(normalized)) {
    return 'sum';
  }

  return 'point';
};

const isHistoricalTrendQuery = (normalizedQuery: string): boolean => {
  return (
    /\b(trend|trending|evolution|evolve|evolving|rise|rising|fall|falling|spike|spikes|jump|jumps|abrupt|abnormal|sudden|difference|different|diff|movement|moving)\b/i.test(
      normalizedQuery,
    ) ||
    (/\b(change|changed|changes|changing|difference|different|diff|movement|moving)\b/i.test(
      normalizedQuery,
    ) &&
      /\b(last|past|previous|over the last|history|historical)\b/i.test(
        normalizedQuery,
      ))
  );
};

const detectHistoricalTrendFocus = (
  query: string,
): 'general' | 'abrupt_change' => {
  const normalized = normalizeTelemetryText(query);
  if (
    /\b(spike|spikes|jump|jumps)\b/i.test(normalized) ||
    (/\b(sharp|abrupt|abnormal|sudden)\b/i.test(normalized) &&
      /\b(change|changes|movement|rise|drop|jump|spike)\b/i.test(normalized))
  ) {
    return 'abrupt_change';
  }

  return 'general';
};

const buildImplicitHistoricalRange = (
  query: string,
  operation: HistoricalTelemetryOperation,
  isImplicitDailyStoredFluidUsageQuery: (normalizedQuery: string) => boolean,
): InfluxHistoricalQueryRange | null => {
  const normalized = normalizeTelemetryText(query);
  if (
    (operation !== 'delta' && operation !== 'trend') ||
    !isImplicitDailyStoredFluidUsageQuery(normalized)
  ) {
    return null;
  }

  const stop = new Date();
  const start = new Date(stop.getTime() - 24 * 60 * 60 * 1000);
  return { start, stop };
};

const sanitizeHistoricalMetricQuery = (query: string): string => {
  const cleaned = query
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months)\b/gi, ' ')
    .replace(
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
      ' ',
    )
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(
      /\b(?:last|past|previous|over the last|today|yesterday|this week|last week|this month|last month|between|from|to|on|at|during|for)\b/gi,
      ' ',
    )
    .replace(
      /\b(?:what|was|were|is|the|please|show|give|tell|me|how|did|explain|there|any|trend|trending|history|historical|change|changed|changes|changing|difference|different|diff|movement|moving|sharp|abrupt|abnormal|sudden|jump|jumps|spike|spikes)\b/gi,
      ' ',
    )
    .replace(/[?!,.:;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || query.trim();
};
