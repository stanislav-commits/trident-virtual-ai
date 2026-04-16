import type { ShipTelemetryEntry } from '../live-telemetry/live-telemetry.types';

export interface ShipHistoricalTelemetryResolution {
  kind: 'none' | 'clarification' | 'answer';
  content?: string;
  pendingQuery?: string;
  clarificationQuestion?: string;
  clarificationActions?: Array<{
    label: string;
    message: string;
    kind?: 'suggestion' | 'all';
  }>;
}

export interface HistoricalPositiveTelemetryEvent {
  entry: ShipTelemetryEntry;
  time: Date;
  delta: number;
  fromValue: number;
  toValue: number;
}

export interface HistoricalTrendDeltaEntry {
  entry: ShipTelemetryEntry;
  fromValue: number;
  toValue: number;
  delta: number;
}

export interface HistoricalTrendSeriesPoint {
  time: Date;
  value: number;
}

export interface HistoricalTrendJumpSummary {
  fromTime: Date;
  toTime: Date;
  fromValue: number;
  toValue: number;
  delta: number;
  standout: boolean;
}

export interface HistoricalTrendSeriesSummary {
  sampledEvery: string;
  aggregateStart: number;
  aggregateEnd: number;
  aggregateDelta: number;
  deltas: HistoricalTrendDeltaEntry[];
  lowest: HistoricalTrendSeriesPoint | null;
  highest: HistoricalTrendSeriesPoint | null;
  largestJump: HistoricalTrendJumpSummary | null;
}
