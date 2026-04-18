import type { ChatNormalizedQuery } from '../../chat-shared/chat.types';
import type { InfluxHistoricalQueryRange } from '../../influxdb/influxdb.service';
import { normalizeTelemetryText } from '../live-telemetry/telemetry-text.utils';

export const getHistoricalRangeDurationMs = (
  range: InfluxHistoricalQueryRange,
): number | null => {
  const start = new Date(range.start);
  const stop = new Date(range.stop);
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
    return null;
  }

  const durationMs = stop.getTime() - start.getTime();
  return durationMs > 0 ? durationMs : null;
};

export const startOfUtcDay = (date: Date): Date => {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

export const endOfUtcDay = (date: Date): Date => {
  return new Date(startOfUtcDay(date).getTime() + 24 * 60 * 60 * 1000 - 1);
};

export const startOfUtcWeek = (date: Date): Date => {
  const start = startOfUtcDay(date);
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - (day - 1));
  return start;
};

export const startOfUtcMonth = (date: Date): Date => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
};

export const endOfUtcMonth = (date: Date): Date => {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1,
  );
};

export const buildFullDayHistoricalRange = (
  date: Date,
): InfluxHistoricalQueryRange => {
  return {
    start: startOfUtcDay(date),
    stop: endOfUtcDay(date),
  };
};

export const isSingleUtcDayRange = (
  range: InfluxHistoricalQueryRange | null,
): range is InfluxHistoricalQueryRange => {
  if (!range) {
    return false;
  }

  const start = range.start instanceof Date ? range.start : new Date(range.start);
  const stop = range.stop instanceof Date ? range.stop : new Date(range.stop);
  return (
    start.getUTCFullYear() === stop.getUTCFullYear() &&
    start.getUTCMonth() === stop.getUTCMonth() &&
    start.getUTCDate() === stop.getUTCDate()
  );
};

export const formatHistoricalTimestamp = (date: Date): string => {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

export const formatHistoricalDay = (date: Date): string => {
  return `${date.toISOString().slice(0, 10)} UTC`;
};

export const formatHistoricalRange = (
  range: InfluxHistoricalQueryRange,
): string => {
  const start = range.start instanceof Date ? range.start : new Date(range.start);
  const stop = range.stop instanceof Date ? range.stop : new Date(range.stop);
  return `${formatHistoricalTimestamp(start)} to ${formatHistoricalTimestamp(stop)}`;
};

export const formatHistoricalDayOrRange = (
  range: InfluxHistoricalQueryRange,
): string => {
  const start = range.start instanceof Date ? range.start : new Date(range.start);
  const stop = range.stop instanceof Date ? range.stop : new Date(range.stop);
  const fullDay =
    start.getTime() === startOfUtcDay(start).getTime() &&
    stop.getTime() === endOfUtcDay(start).getTime();

  if (isSingleUtcDayRange(range) && fullDay) {
    return formatHistoricalDay(start);
  }

  return formatHistoricalRange(range);
};

export const getHistoricalMonthIndex = (monthName: string): number => {
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
};

export const formatAggregateNumber = (value: number): string => {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
};

export const formatSignedAggregateNumber = (value: number): string => {
  const formatted = formatAggregateNumber(Math.abs(value));
  if (value > 0) {
    return `+${formatted}`;
  }
  if (value < 0) {
    return `-${formatted}`;
  }
  return formatted;
};

export const isNegligibleHistoricalChange = (
  delta: number,
  fromValue: number,
  toValue: number,
): boolean => {
  const scale = Math.max(Math.abs(fromValue), Math.abs(toValue), 1);
  return Math.abs(delta) <= scale * 0.005;
};

export const getMedianValue = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle];
  }

  return (values[middle - 1] + values[middle]) / 2;
};

export const parseHistoricalNumericValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

export const isHistoricalQueryTimeout = (error: Error): boolean => {
  const haystack = `${error.name} ${error.message}`;
  return (
    /RequestTimedOutError/i.test(haystack) ||
    /\brequest timed out\b/i.test(haystack)
  );
};

export const parseExplicitHistoricalDate = (query: string): Date | null => {
  const isoMatch = query.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return new Date(
      Date.UTC(
        Number.parseInt(isoMatch[1], 10),
        Number.parseInt(isoMatch[2], 10) - 1,
        Number.parseInt(isoMatch[3], 10),
      ),
    );
  }

  const monthPattern =
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i;
  const dayMonthMatch = query.match(monthPattern);
  if (dayMonthMatch) {
    return new Date(
      Date.UTC(
        Number.parseInt(dayMonthMatch[3], 10),
        getHistoricalMonthIndex(dayMonthMatch[2]),
        Number.parseInt(dayMonthMatch[1], 10),
      ),
    );
  }

  const monthDayPattern =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i;
  const monthDayMatch = query.match(monthDayPattern);
  if (monthDayMatch) {
    return new Date(
      Date.UTC(
        Number.parseInt(monthDayMatch[3], 10),
        getHistoricalMonthIndex(monthDayMatch[1]),
        Number.parseInt(monthDayMatch[2], 10),
      ),
    );
  }

  return null;
};

export const findHistoricalDateWithoutYear = (query: string): string | null => {
  const match = query.match(
    /\b(?:on\s+|from\s+|between\s+)?(\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))(?!\s+\d{4})\b/i,
  );
  if (match?.[1]) {
    return match[1];
  }

  const reverseMatch = query.match(
    /\b((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})(?!,?\s+\d{4})\b/i,
  );
  return reverseMatch?.[1] ?? null;
};

export const parseHistoricalTimeOfDay = (
  query: string,
): { hours: number; minutes: number } | null => {
  const atClockMatch = query.match(
    /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*utc)?\b/i,
  );
  const bareClockMatch = query.match(
    /\b(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s*utc)?\b/i,
  );
  const meridiemOnlyMatch = query.match(
    /\b(\d{1,2})\s*(am|pm)(?:\s*utc)?\b/i,
  );

  const hoursText =
    atClockMatch?.[1] ?? bareClockMatch?.[1] ?? meridiemOnlyMatch?.[1];
  if (!hoursText) {
    return null;
  }

  let hours = Number.parseInt(hoursText, 10);
  const minutes = Number.parseInt(
    atClockMatch?.[2] ?? bareClockMatch?.[2] ?? '0',
    10,
  );
  const meridiem = (
    atClockMatch?.[3] ??
    bareClockMatch?.[3] ??
    meridiemOnlyMatch?.[2]
  )?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'am' && hours === 12) {
    hours = 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return { hours, minutes };
};

export const parseRelativeHistoricalRange = (
  query: string,
): InfluxHistoricalQueryRange | null => {
  const now = new Date();
  const normalized = normalizeTelemetryText(query);
  const lastMatch = normalized.match(
    /\b(?:last|past|previous|over the last)\s+(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\b/i,
  );
  if (lastMatch) {
    const amount = Number.parseInt(lastMatch[1], 10);
    const unit = lastMatch[2].toLowerCase();
    const start = new Date(now);
    if (unit.startsWith('hour')) start.setUTCHours(start.getUTCHours() - amount);
    if (unit.startsWith('day')) start.setUTCDate(start.getUTCDate() - amount);
    if (unit.startsWith('week')) start.setUTCDate(start.getUTCDate() - amount * 7);
    if (unit.startsWith('month')) start.setUTCMonth(start.getUTCMonth() - amount);
    return { start, stop: now };
  }

  const agoMatch = normalized.match(
    /\b(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i,
  );
  if (agoMatch) {
    const amount = Number.parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].toLowerCase();
    const pointInTime = new Date(now);
    if (unit.startsWith('hour'))
      pointInTime.setUTCHours(pointInTime.getUTCHours() - amount);
    if (unit.startsWith('day'))
      pointInTime.setUTCDate(pointInTime.getUTCDate() - amount);
    if (unit.startsWith('week'))
      pointInTime.setUTCDate(pointInTime.getUTCDate() - amount * 7);
    if (unit.startsWith('month'))
      pointInTime.setUTCMonth(pointInTime.getUTCMonth() - amount);
    return {
      start: startOfUtcDay(pointInTime),
      stop: endOfUtcDay(pointInTime),
    };
  }

  if (/\byesterday\b/i.test(normalized)) {
    const start = startOfUtcDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const stop = endOfUtcDay(start);
    return { start, stop };
  }

  if (/\btoday\b/i.test(normalized)) {
    return { start: startOfUtcDay(now), stop: now };
  }

  if (/\bthis week\b/i.test(normalized)) {
    return { start: startOfUtcWeek(now), stop: now };
  }

  if (/\blast week\b/i.test(normalized)) {
    const endOfLastWeek = new Date(startOfUtcWeek(now).getTime() - 1);
    return {
      start: startOfUtcWeek(endOfLastWeek),
      stop: endOfUtcDay(endOfLastWeek),
    };
  }

  if (/\bthis month\b/i.test(normalized)) {
    return { start: startOfUtcMonth(now), stop: now };
  }

  if (/\blast month\b/i.test(normalized)) {
    const previousMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    return {
      start: startOfUtcMonth(previousMonth),
      stop: endOfUtcMonth(previousMonth),
    };
  }

  return null;
};

export const parseRelativeHistoricalPoint = (
  query: string,
  normalizedQuery?: ChatNormalizedQuery,
): Date | null => {
  if (normalizedQuery?.timeIntent.kind !== 'historical_point') {
    const normalized = normalizeTelemetryText(query);
    if (
      !/\b\d+\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i.test(
        normalized,
      )
    ) {
      return null;
    }
  }

  const normalized = normalizeTelemetryText(query);
  const agoMatch = normalized.match(
    /\b(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i,
  );
  if (!agoMatch) {
    return null;
  }

  const amount = Number.parseInt(agoMatch[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = agoMatch[2].toLowerCase();
  const pointInTime = new Date();
  if (unit.startsWith('hour')) {
    pointInTime.setUTCHours(pointInTime.getUTCHours() - amount);
  }
  if (unit.startsWith('day')) {
    pointInTime.setUTCDate(pointInTime.getUTCDate() - amount);
  }
  if (unit.startsWith('week')) {
    pointInTime.setUTCDate(pointInTime.getUTCDate() - amount * 7);
  }
  if (unit.startsWith('month')) {
    pointInTime.setUTCMonth(pointInTime.getUTCMonth() - amount);
  }

  return pointInTime;
};

export const buildDefaultHistoricalEventRange =
  (): InfluxHistoricalQueryRange => {
    const stop = new Date();
    const start = new Date(stop);
    start.setUTCMonth(start.getUTCMonth() - 6);
    return { start, stop };
  };
