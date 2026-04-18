import type { PendingClarification } from '../chat-shared/clarification/pending-clarification.types';

export type MetricsV2RequestKind = 'metrics_request' | 'not_metrics';

export type MetricsV2MetricSource = 'current' | 'historical';

export type MetricsV2MetricShape = 'single' | 'group';

export type MetricsV2MetricPresentation =
  | 'value_only'
  | 'total_only'
  | 'breakdown'
  | 'breakdown_with_total';

export type MetricsV2MetricAggregation =
  | 'latest'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'delta'
  | null;

export type MetricsV2MeasurementKind =
  | 'level'
  | 'volume'
  | 'energy'
  | 'temperature'
  | 'pressure'
  | 'speed'
  | 'location'
  | 'runtime'
  | 'voltage'
  | 'current'
  | 'power'
  | 'status'
  | 'quantity'
  | 'unknown';

export type MetricsV2FluidType =
  | 'fuel'
  | 'oil'
  | 'water'
  | 'coolant'
  | 'def'
  | 'unknown'
  | null;

export type MetricsV2AssetType =
  | 'storage_tank'
  | 'engine'
  | 'generator'
  | 'battery'
  | 'charger'
  | 'navigation'
  | 'pump'
  | 'unknown'
  | null;

export type MetricsV2GroupTarget =
  | 'storage_tanks'
  | 'engines'
  | 'generators'
  | 'batteries'
  | 'chargers'
  | 'navigation'
  | null;

export type MetricsV2BusinessConcept =
  | 'fuel_onboard_inventory'
  | 'fuel_tank_inventory_member'
  | 'fuel_tank_temperature'
  | 'oil_onboard_inventory'
  | 'oil_tank_inventory_member'
  | 'water_onboard_inventory'
  | 'water_tank_inventory_member'
  | 'def_onboard_inventory'
  | 'def_tank_inventory_member'
  | 'generic_tank_inventory_member'
  | 'generic_tank_temperature'
  | 'component_speed'
  | 'environmental_speed'
  | 'route_progress_speed'
  | 'pump_energy_usage'
  | 'vessel_speed'
  | 'vessel_position'
  | 'engine_runtime'
  | 'battery_voltage'
  | 'electrical_current_reading'
  | 'electrical_power_reading'
  | 'unknown';

export type MetricsV2SystemDomain =
  | 'navigation'
  | 'hvac'
  | 'fuel'
  | 'oil'
  | 'water'
  | 'electrical'
  | 'engine'
  | 'generator'
  | 'pump'
  | 'environment'
  | 'tank'
  | 'unknown'
  | null;

export type MetricsV2MeasuredSubject =
  | 'vessel_motion'
  | 'vessel_position'
  | 'route_progress'
  | 'fan_rotation'
  | 'pump_operation'
  | 'wind'
  | 'fuel_inventory'
  | 'oil_inventory'
  | 'water_inventory'
  | 'def_inventory'
  | 'tank_temperature'
  | 'engine_state'
  | 'battery_state'
  | 'electrical_flow'
  | 'unknown'
  | null;

export type MetricsV2SignalRole =
  | 'primary_vessel_telemetry'
  | 'navigation_calculation'
  | 'component_internal_state'
  | 'environmental_condition'
  | 'inventory_quantity'
  | 'energy_consumption'
  | 'alarm_or_status'
  | 'unknown'
  | null;

export type MetricsV2MotionReference =
  | 'over_ground'
  | 'through_water'
  | 'route_progress'
  | 'ambient_flow'
  | 'component_internal'
  | 'unknown'
  | null;

export type MetricsV2GroupFamily =
  | 'fuel_storage_tanks_onboard'
  | 'oil_storage_tanks_onboard'
  | 'water_storage_tanks_onboard'
  | 'def_storage_tanks_onboard'
  | 'generic_storage_tanks'
  | null;

export type MetricsV2UnitKind =
  | 'volume'
  | 'temperature'
  | 'pressure'
  | 'speed'
  | 'location'
  | 'runtime'
  | 'voltage'
  | 'current'
  | 'power'
  | 'energy'
  | 'percent'
  | 'unknown'
  | null;

export type MetricsV2AggregationCompatibility =
  | 'latest_point'
  | 'sum_total_onboard'
  | 'avg_over_time'
  | 'min_over_time'
  | 'max_over_time'
  | 'delta_over_time';

export type MetricsV2TimeRange =
  | { kind: 'current' }
  | {
      kind: 'relative';
      preset:
        | 'today'
        | 'yesterday'
        | 'last_24_hours'
        | 'last_7_days'
        | 'this_week'
        | 'this_month';
      label?: string;
    }
  | {
      kind: 'absolute';
      startIso: string;
      endIso: string;
      label?: string;
    }
  | {
      kind: 'point_in_time';
      pointIso: string;
      label?: string;
    };

export interface MetricsV2RequestClassification {
  kind: MetricsV2RequestKind;
  confidence: number;
  reason: string;
}

export interface MetricsV2MetricRequestPlan {
  requestId: string;
  source: MetricsV2MetricSource;
  shape: MetricsV2MetricShape;
  presentation: MetricsV2MetricPresentation;
  concept: string;
  businessConcept: MetricsV2BusinessConcept;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
  signalRole?: MetricsV2SignalRole;
  motionReference?: MetricsV2MotionReference;
  fluidType?: MetricsV2FluidType;
  assetType?: MetricsV2AssetType;
  groupTarget?: MetricsV2GroupTarget;
  entityHints: string[];
  metricHints: string[];
  aggregation: MetricsV2MetricAggregation;
  timeRange: MetricsV2TimeRange;
}

export interface MetricsV2Plan {
  requests: MetricsV2MetricRequestPlan[];
  confidence: number;
  reason: string;
}

export interface MetricsV2CatalogEntry {
  key: string;
  label: string;
  description?: string | null;
  unit?: string | null;
  dataType?: string | null;
  bucket?: string | null;
  measurement?: string | null;
  field?: string | null;
  latestValue: string | number | boolean | null;
  valueUpdatedAt?: Date | null;
  searchText: string;
  operationalMeaning: string;
  semanticSummary: string;
  businessConcept: MetricsV2BusinessConcept;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
  signalRole?: MetricsV2SignalRole;
  motionReference?: MetricsV2MotionReference;
  unitKind?: MetricsV2UnitKind;
  fluidType?: MetricsV2FluidType;
  assetType?: MetricsV2AssetType;
  groupFamily?: MetricsV2GroupFamily;
  aggregationCompatibility: MetricsV2AggregationCompatibility[];
  semanticConfidence: number;
  inferredGroupKey?: string | null;
  groupMemberKey?: string | null;
}

export interface MetricsV2ResolvedRequest {
  plan: MetricsV2MetricRequestPlan;
  entries: MetricsV2CatalogEntry[];
  clarificationKind?:
    | 'group_not_confident'
    | 'exact_metric_not_found'
    | 'ambiguous_metrics';
  clarificationQuestion?: string;
  clarificationOptions?: string[];
  debug?: MetricsV2ResolvedRequestDebug;
}

export interface MetricsV2ResolvedPlan {
  requests: MetricsV2ResolvedRequest[];
}

export interface MetricsV2ExplainEntrySnapshot {
  key: string;
  label: string;
  businessConcept: MetricsV2BusinessConcept;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
  signalRole?: MetricsV2SignalRole;
  motionReference?: MetricsV2MotionReference;
  fluidType?: MetricsV2FluidType;
  assetType?: MetricsV2AssetType;
  unitKind?: MetricsV2UnitKind;
  unit?: string | null;
  groupFamily?: MetricsV2GroupFamily;
  groupMemberKey?: string | null;
}

export interface MetricsV2ExplainCandidateDecision {
  entry: MetricsV2ExplainEntrySnapshot;
  decision: 'selected' | 'matched' | 'rejected';
  score: number;
  reasons: string[];
}

export interface MetricsV2ResolvedRequestDebug {
  requestId: string;
  queryConcept: string;
  businessConcept: MetricsV2BusinessConcept;
  source: MetricsV2MetricSource;
  shape: MetricsV2MetricShape;
  presentation: MetricsV2MetricPresentation;
  catalogSize: number;
  matchedCount: number;
  selectedCount: number;
  selectedEntries: MetricsV2ExplainCandidateDecision[];
  matchedEntries: MetricsV2ExplainCandidateDecision[];
  rejectedEntries: MetricsV2ExplainCandidateDecision[];
}

export interface MetricsV2ResolvedPlanDebug {
  requestCount: number;
  requests: MetricsV2ResolvedRequestDebug[];
}

export interface MetricsV2ValueItem {
  key: string;
  label: string;
  value: string | number | boolean | null;
  unit?: string | null;
  timestamp?: string | null;
  groupMemberKey?: string | null;
  field?: string | null;
  description?: string | null;
}

export interface MetricsV2DerivedVesselPositionAnswer {
  kind: 'vessel_position';
  latitude: number;
  longitude: number;
  humanLocation?: string | null;
}

export type MetricsV2DerivedAnswer = MetricsV2DerivedVesselPositionAnswer;

export interface MetricsV2ExecutionBlock {
  request: MetricsV2ResolvedRequest;
  items: MetricsV2ValueItem[];
  totalValue?: number | null;
  unit?: string | null;
  summaryLabel?: string;
  timeLabel?: string;
  derivedAnswer?: MetricsV2DerivedAnswer;
}

export interface MetricsV2ExecutionResult {
  blocks: MetricsV2ExecutionBlock[];
}

export interface MetricsV2ComposedResponse {
  content: string;
  sourceOfTruth: 'current_metrics' | 'historical_metrics' | 'mixed_metrics';
  usedCurrentMetrics: boolean;
  usedHistoricalMetrics: boolean;
}

export interface MetricsV2ResponderResult {
  handled: boolean;
  content?: string;
  sourceOfTruth?: MetricsV2ComposedResponse['sourceOfTruth'];
  usedCurrentMetrics?: boolean;
  usedHistoricalMetrics?: boolean;
  plan?: MetricsV2Plan;
  classification?: MetricsV2RequestClassification;
  debug?: MetricsV2ResolvedPlanDebug;
  pendingClarification?: PendingClarification;
  reason?: string;
}

export interface MetricsV2ResponderParams {
  shipId?: string;
  shipName?: string;
  shipOrganizationName?: string;
  userQuery: string;
  language?: string | null;
  recentMessages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}
