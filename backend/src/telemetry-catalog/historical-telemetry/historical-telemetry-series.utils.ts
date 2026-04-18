import type {
  InfluxHistoricalQueryRange,
  InfluxHistoricalSeriesOptions,
  InfluxMetricValue,
} from '../../influxdb/influxdb.service';
import type { ShipTelemetryEntry } from '../live-telemetry/live-telemetry.types';
import type {
  HistoricalTrendDeltaEntry,
  HistoricalTrendJumpSummary,
  HistoricalTrendSeriesPoint,
} from './historical-telemetry.types';
import {
  formatAggregateNumber,
  formatHistoricalTimestamp,
  formatSignedAggregateNumber,
  getHistoricalRangeDurationMs,
  getMedianValue,
  isNegligibleHistoricalChange,
  parseHistoricalNumericValue,
} from './historical-telemetry.utils';

export type HistoricalSeriesOptionsWithWindow = InfluxHistoricalSeriesOptions & {
  windowMs: number;
};

export function getHistoricalEventSeriesOptions(
  range: InfluxHistoricalQueryRange,
): HistoricalSeriesOptionsWithWindow[] {
  const durationMs = getHistoricalRangeDurationMs(range);
  if (durationMs == null || durationMs <= 2 * 24 * 60 * 60 * 1000) {
    return [];
  }

  if (durationMs > 120 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
      { windowEvery: '3d', windowMs: 3 * 24 * 60 * 60 * 1000 },
    ];
  }
  if (durationMs > 30 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
      { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
    ];
  }
  if (durationMs > 7 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
      { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
    ];
  }

  return [
    { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
    { windowEvery: '6h', windowMs: 6 * 60 * 60 * 1000 },
  ];
}

export function getHistoricalEventSearchRanges(
  range: InfluxHistoricalQueryRange,
): InfluxHistoricalQueryRange[] {
  const start = new Date(range.start);
  const stop = new Date(range.stop);
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
    return [range];
  }

  const durationMs = stop.getTime() - start.getTime();
  if (durationMs <= 0) {
    return [range];
  }

  const candidateWindowsMs: number[] = [];
  if (durationMs > 120 * 24 * 60 * 60 * 1000) {
    candidateWindowsMs.push(
      7 * 24 * 60 * 60 * 1000,
      14 * 24 * 60 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000,
      90 * 24 * 60 * 60 * 1000,
    );
  } else if (durationMs > 30 * 24 * 60 * 60 * 1000) {
    candidateWindowsMs.push(
      7 * 24 * 60 * 60 * 1000,
      14 * 24 * 60 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000,
    );
  } else if (durationMs > 14 * 24 * 60 * 60 * 1000) {
    candidateWindowsMs.push(
      7 * 24 * 60 * 60 * 1000,
      14 * 24 * 60 * 60 * 1000,
    );
  }

  const candidates = candidateWindowsMs
    .filter((windowMs) => durationMs > windowMs)
    .map((windowMs) => ({
      start: new Date(stop.getTime() - windowMs),
      stop,
    }));

  candidates.push({ start, stop });

  const deduped = new Map<string, InfluxHistoricalQueryRange>();
  for (const candidate of candidates) {
    const key = `${candidate.start.toISOString()}::${candidate.stop.toISOString()}`;
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}

export function buildHistoricalEventRefinementRange(
  originalRange: InfluxHistoricalQueryRange,
  approximateEventTime: Date,
  windowMs: number,
): InfluxHistoricalQueryRange | null {
  const originalStart = new Date(originalRange.start);
  const originalStop = new Date(originalRange.stop);
  if (
    Number.isNaN(originalStart.getTime()) ||
    Number.isNaN(originalStop.getTime()) ||
    Number.isNaN(approximateEventTime.getTime())
  ) {
    return null;
  }

  const paddingMs = Math.max(windowMs * 2, 2 * 60 * 60 * 1000);
  const start = new Date(
    Math.max(
      originalStart.getTime(),
      approximateEventTime.getTime() - paddingMs,
    ),
  );
  const stop = new Date(
    Math.min(
      originalStop.getTime(),
      approximateEventTime.getTime() + paddingMs,
    ),
  );

  return stop.getTime() > start.getTime() ? { start, stop } : null;
}

export function getHistoricalTrendSeriesOptions(
  range: InfluxHistoricalQueryRange,
): HistoricalSeriesOptionsWithWindow[] {
  const durationMs = getHistoricalRangeDurationMs(range);
  if (durationMs == null) {
    return [{ windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 }];
  }

  if (durationMs <= 12 * 60 * 60 * 1000) {
    return [
      { windowEvery: '15m', windowMs: 15 * 60 * 1000 },
      { windowEvery: '30m', windowMs: 30 * 60 * 1000 },
    ];
  }
  if (durationMs <= 2 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '1h', windowMs: 60 * 60 * 1000 },
      { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
    ];
  }
  if (durationMs <= 7 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
      { windowEvery: '6h', windowMs: 6 * 60 * 60 * 1000 },
    ];
  }
  if (durationMs <= 30 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
      { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
    ];
  }
  if (durationMs <= 120 * 24 * 60 * 60 * 1000) {
    return [
      { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
      { windowEvery: '3d', windowMs: 3 * 24 * 60 * 60 * 1000 },
    ];
  }

  return [
    { windowEvery: '3d', windowMs: 3 * 24 * 60 * 60 * 1000 },
    { windowEvery: '7d', windowMs: 7 * 24 * 60 * 60 * 1000 },
  ];
}

export function buildHistoricalTrendSeriesPoints(
  rows: InfluxMetricValue[],
  matchedEntryCount: number,
): HistoricalTrendSeriesPoint[] {
  const grouped = new Map<
    string,
    HistoricalTrendSeriesPoint & { coverage: number }
  >();

  for (const row of rows) {
    const numericValue = parseHistoricalNumericValue(row.value);
    const pointTime = new Date(row.time);
    if (numericValue == null || Number.isNaN(pointTime.getTime())) {
      continue;
    }

    const key = pointTime.toISOString();
    const existing = grouped.get(key);
    if (existing) {
      existing.value += numericValue;
      existing.coverage += 1;
      continue;
    }

    grouped.set(key, {
      time: pointTime,
      value: numericValue,
      coverage: 1,
    });
  }

  let points = [...grouped.values()].filter(
    (point) => matchedEntryCount <= 1 || point.coverage >= matchedEntryCount,
  );
  if (points.length < 2 && matchedEntryCount > 1) {
    const partialCoverageThreshold = Math.max(
      2,
      Math.ceil(matchedEntryCount * 0.75),
    );
    points = [...grouped.values()].filter(
      (point) => point.coverage >= partialCoverageThreshold,
    );
  }

  return points
    .sort((left, right) => left.time.getTime() - right.time.getTime())
    .map((point) => ({
      time: point.time,
      value: point.value,
    }));
}

export function buildHistoricalTrendSampledDeltas(
  rows: InfluxMetricValue[],
  matchedEntries: ShipTelemetryEntry[],
): HistoricalTrendDeltaEntry[] {
  const rowsByKey = new Map<
    string,
    Array<{
      time: Date;
      value: number;
    }>
  >();

  for (const row of rows) {
    const numericValue = parseHistoricalNumericValue(row.value);
    const pointTime = new Date(row.time);
    if (numericValue == null || Number.isNaN(pointTime.getTime())) {
      continue;
    }

    const existing = rowsByKey.get(row.key);
    if (existing) {
      existing.push({ time: pointTime, value: numericValue });
      continue;
    }

    rowsByKey.set(row.key, [{ time: pointTime, value: numericValue }]);
  }

  return matchedEntries
    .map((entry) => {
      const series = rowsByKey.get(entry.key);
      if (!series || series.length < 2) {
        return null;
      }

      series.sort((left, right) => left.time.getTime() - right.time.getTime());
      const first = series[0];
      const last = series[series.length - 1];
      return {
        entry,
        fromValue: first.value,
        toValue: last.value,
        delta: last.value - first.value,
      };
    })
    .filter((value): value is HistoricalTrendDeltaEntry => Boolean(value));
}

export function buildHistoricalTrendJumpSummary(
  points: HistoricalTrendSeriesPoint[],
): HistoricalTrendJumpSummary | null {
  if (points.length < 2) {
    return null;
  }

  const jumps = points
    .slice(1)
    .map((point, index) => ({
      fromTime: points[index].time,
      toTime: point.time,
      fromValue: points[index].value,
      toValue: point.value,
      delta: point.value - points[index].value,
    }))
    .filter((jump) => Number.isFinite(jump.delta));

  if (jumps.length === 0) {
    return null;
  }

  const largestJump = jumps.reduce((best, jump) =>
    Math.abs(jump.delta) > Math.abs(best.delta) ? jump : best,
  );
  const absoluteJumpSizes = jumps
    .map((jump) => Math.abs(jump.delta))
    .sort((left, right) => left - right);
  const medianJumpSize = getMedianValue(absoluteJumpSizes);
  const values = points.map((point) => point.value);
  const observedRange = Math.max(...values) - Math.min(...values);
  const standoutThreshold = Math.max(
    medianJumpSize * 3,
    observedRange * 0.35,
  );

  return {
    ...largestJump,
    standout:
      Math.abs(largestJump.delta) > 0 &&
      Math.abs(largestJump.delta) >= standoutThreshold,
  };
}

export function buildHistoricalTrendJumpNarrative(
  jump: HistoricalTrendJumpSummary | null,
  unitSuffix: string,
): string {
  if (!jump) {
    return 'I did not have enough sampled historical points to identify interval-by-interval jumps in that period.';
  }

  if (jump.standout) {
    return `A standout sampled interval change was observed between ${formatHistoricalTimestamp(
      jump.fromTime,
    )} and ${formatHistoricalTimestamp(jump.toTime)}, when the sampled reading moved from ${formatAggregateNumber(
      jump.fromValue,
    )}${unitSuffix} to ${formatAggregateNumber(
      jump.toValue,
    )}${unitSuffix} (${formatSignedAggregateNumber(jump.delta)}${unitSuffix}) [Telemetry History].`;
  }

  return `I did not find a clear standout abrupt change in the sampled trend. The largest sampled interval move was ${formatSignedAggregateNumber(
    jump.delta,
  )}${unitSuffix} between ${formatHistoricalTimestamp(
    jump.fromTime,
  )} and ${formatHistoricalTimestamp(jump.toTime)} [Telemetry History].`;
}

export function describeHistoricalTrendMovement(
  fromValue: number,
  toValue: number,
  delta: number,
): string {
  if (isNegligibleHistoricalChange(delta, fromValue, toValue)) {
    return `remained broadly flat, moving from ${formatAggregateNumber(
      fromValue,
    )} to ${formatAggregateNumber(toValue)} (${formatSignedAggregateNumber(
      delta,
    )})`;
  }

  return `${delta >= 0 ? 'increased' : 'decreased'} from ${formatAggregateNumber(
    fromValue,
  )} to ${formatAggregateNumber(toValue)} (${formatSignedAggregateNumber(
    delta,
  )})`;
}

export function pickNearestHistoricalRows(
  rows: InfluxMetricValue[],
  targetTime: Date,
): InfluxMetricValue[] {
  const bestByKey = new Map<string, InfluxMetricValue>();
  for (const row of rows) {
    const rowTime = Date.parse(row.time);
    if (!Number.isFinite(rowTime)) {
      continue;
    }

    const currentBest = bestByKey.get(row.key);
    if (!currentBest) {
      bestByKey.set(row.key, row);
      continue;
    }

    const bestTime = Date.parse(currentBest.time);
    if (
      Math.abs(rowTime - targetTime.getTime()) <
      Math.abs(bestTime - targetTime.getTime())
    ) {
      bestByKey.set(row.key, row);
    }
  }

  return [...bestByKey.values()];
}
