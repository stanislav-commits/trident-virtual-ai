import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  MetricsV2AssetType,
  MetricsV2BusinessConcept,
  MetricsV2FluidType,
  MetricsV2GroupTarget,
  MetricsV2MeasuredSubject,
  MetricsV2MeasurementKind,
  MetricsV2MetricAggregation,
  MetricsV2MetricPresentation,
  MetricsV2MetricRequestPlan,
  MetricsV2MetricShape,
  MetricsV2MetricSource,
  MetricsV2MotionReference,
  MetricsV2Plan,
  MetricsV2SignalRole,
  MetricsV2SystemDomain,
  MetricsV2TimeRange,
} from '../metrics-v2.types';
import {
  inferPlanBusinessConcept,
  parseMetricsV2MeasuredSubject,
  parseMetricsV2MotionReference,
  parseMetricsV2SignalRole,
  parseMetricsV2SystemDomain,
} from '../semantic';
import { MetricsV2CapabilityPlanService } from './metrics-v2-capability-plan.service';

type RawMetricsPlan = Partial<{
  confidence: unknown;
  reason: unknown;
  requests: unknown;
}>;

type RawMetricsRequest = Partial<{
  requestId: unknown;
  source: unknown;
  shape: unknown;
  presentation: unknown;
  concept: unknown;
  businessConcept: unknown;
  measurementKind: unknown;
  systemDomain: unknown;
  measuredSubject: unknown;
  signalRole: unknown;
  motionReference: unknown;
  fluidType: unknown;
  assetType: unknown;
  groupTarget: unknown;
  entityHints: unknown;
  metricHints: unknown;
  aggregation: unknown;
  timeRange: unknown;
}>;

@Injectable()
export class MetricsV2QueryPlannerService {
  private readonly logger = new Logger(MetricsV2QueryPlannerService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(
    private readonly capabilityPlanService: MetricsV2CapabilityPlanService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.METRICS_V2_PLANNER_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async plan(params: {
    userQuery: string;
    recentMessages: Array<{ role: string; content: string }>;
  }): Promise<MetricsV2Plan> {
    try {
      const outputText = await this.planWithLlm(params);
      return this.parsePlan(outputText);
    } catch (error) {
      this.logger.warn(
        `Metrics v2 planner failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        confidence: 0,
        reason: 'Metrics planner failed before a reliable plan could be built.',
        requests: [],
      };
    }
  }

  private async planWithLlm(params: {
    userQuery: string;
    recentMessages: Array<{ role: string; content: string }>;
  }): Promise<string> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const recentContext = params.recentMessages
      .slice(-6)
      .map((message) => `${message.role}: ${message.content.trim()}`)
      .join('\n');

    const response = await this.client.responses.create({
      model: this.model,
      temperature: 0,
      max_output_tokens: 900,
      instructions:
        'Build a strict JSON metrics plan for a vessel metrics request.\n' +
        'Return ONLY valid JSON with this shape: {"confidence":0..1,"reason":"short reason","requests":[...]}.\n' +
        'Each request must have: {"requestId":string,"source":"current"|"historical","shape":"single"|"group","presentation":"value_only"|"total_only"|"breakdown"|"breakdown_with_total","concept":string,"businessConcept":"fuel_onboard_inventory"|"fuel_tank_inventory_member"|"fuel_tank_temperature"|"oil_onboard_inventory"|"oil_tank_inventory_member"|"water_onboard_inventory"|"water_tank_inventory_member"|"def_onboard_inventory"|"def_tank_inventory_member"|"generic_tank_inventory_member"|"generic_tank_temperature"|"component_speed"|"environmental_speed"|"route_progress_speed"|"pump_energy_usage"|"vessel_speed"|"vessel_position"|"engine_runtime"|"battery_voltage"|"electrical_current_reading"|"electrical_power_reading"|"unknown","measurementKind":"level"|"volume"|"temperature"|"pressure"|"speed"|"location"|"runtime"|"voltage"|"current"|"power"|"status"|"quantity"|"energy"|"unknown","systemDomain":"navigation"|"hvac"|"fuel"|"oil"|"water"|"electrical"|"engine"|"generator"|"pump"|"environment"|"tank"|"unknown"|null,"measuredSubject":"vessel_motion"|"vessel_position"|"route_progress"|"fan_rotation"|"pump_operation"|"wind"|"fuel_inventory"|"oil_inventory"|"water_inventory"|"def_inventory"|"tank_temperature"|"engine_state"|"battery_state"|"electrical_flow"|"unknown"|null,"signalRole":"primary_vessel_telemetry"|"navigation_calculation"|"component_internal_state"|"environmental_condition"|"inventory_quantity"|"energy_consumption"|"alarm_or_status"|"unknown"|null,"motionReference":"over_ground"|"through_water"|"route_progress"|"ambient_flow"|"component_internal"|"unknown"|null,"fluidType":"fuel"|"oil"|"water"|"coolant"|"def"|"unknown"|null,"assetType":"storage_tank"|"engine"|"generator"|"battery"|"charger"|"navigation"|"pump"|"unknown"|null,"groupTarget":"storage_tanks"|"engines"|"generators"|"batteries"|"chargers"|"navigation"|null,"entityHints":[string],"metricHints":[string],"aggregation":"latest"|"sum"|"avg"|"min"|"max"|"delta"|null,"timeRange":{...}}.\n' +
        'Allowed timeRange forms:\n' +
        '- {"kind":"current"}\n' +
        '- {"kind":"relative","preset":"today"|"yesterday"|"last_24_hours"|"last_7_days"|"this_week"|"this_month","label":string}\n' +
        '- {"kind":"point_in_time","pointIso":"ISO-8601 timestamp","label":string}\n' +
        '- {"kind":"absolute","startIso":"ISO-8601 timestamp","endIso":"ISO-8601 timestamp","label":string}\n' +
        'Planning rules:\n' +
        '- Use one request per distinct metric need.\n' +
        '- Use source=current for live/current/latest onboard readings from the DB snapshot.\n' +
        '- Use source=historical for yesterday, last week, averages, changes, trends, or point-in-time lookups.\n' +
        '- Use shape=group when the user asks for onboard total, all tanks, all generators, all engines, or a grouped breakdown.\n' +
        '- Use presentation=breakdown_with_total for inventory-like grouped questions such as total fuel onboard.\n' +
        '- Set businessConcept to the canonical meaning of the request, not just keywords.\n' +
        '- Separate measurementKind from measuredSubject. Fan speed, wind speed, and yacht speed are all speed measurements but different subjects.\n' +
        '- motionReference describes the speed frame when relevant: use through_water for speed through water, over_ground for GPS/SOG speed, route_progress for VMG/toward-waypoint speed, ambient_flow for wind speed, component_internal for fan/pump speed. Use null when the user asks for generic vessel speed without specifying the frame.\n' +
        '- For yacht/vessel/ship speed use businessConcept vessel_speed, systemDomain navigation, measuredSubject vessel_motion, signalRole primary_vessel_telemetry.\n' +
        '- For velocity-made-good or speed toward waypoint use businessConcept route_progress_speed, measuredSubject route_progress, signalRole navigation_calculation.\n' +
        '- For fan speed use businessConcept component_speed, systemDomain hvac, measuredSubject fan_rotation, signalRole component_internal_state.\n' +
        '- For wind speed use businessConcept environmental_speed, systemDomain environment, measuredSubject wind, signalRole environmental_condition.\n' +
        '- Use aggregation=sum for totals, avg for average, min/max for extrema, delta for change, latest for current snapshot or nearest historical point.\n' +
        '- For current metric requests, timeRange must be {"kind":"current"}.\n' +
        '- For historical point lookups, use point_in_time + aggregation latest.\n' +
        '- Do not plan documentation, manuals, regulations, or certificates here.\n' +
        'Examples:\n' +
        '- "what is current yacht speed?" => one current single speed request with businessConcept vessel_speed.\n' +
        '- "where is the yacht now?" => one current group request with businessConcept vessel_position, measurementKind location, systemDomain navigation, measuredSubject vessel_position, signalRole primary_vessel_telemetry, assetType navigation, groupTarget navigation, entityHints ["latitude","longitude"], metricHints ["latitude","longitude","coordinates"], aggregation latest.\n' +
        '- "what is current yacht speed through water?" => one current single speed request with businessConcept vessel_speed and motionReference through_water.\n' +
        '- "what is current GPS speed?" => one current single speed request with businessConcept vessel_speed and motionReference over_ground.\n' +
        '- "how much fuel is onboard?" => one current group request with businessConcept fuel_onboard_inventory, fluidType fuel, assetType storage_tank, measurementKind volume or level, presentation breakdown_with_total, aggregation sum.\n' +
        '- "how much fuel was onboard yesterday?" => one historical group request with businessConcept fuel_onboard_inventory, aggregation latest and a historical time range.\n' +
        '- "current speed and fuel onboard" => two requests.\n' +
        '- "average generator load last 24 hours" => one historical group or single request with aggregation avg.',
      input: [
        {
          role: 'user',
          content:
            `Current user message: ${params.userQuery}\n` +
            `Recent prior chat messages:\n${recentContext || '(none)'}`,
        },
      ],
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('Empty metrics planner response');
    }

    return outputText;
  }

  private parsePlan(outputText: string): MetricsV2Plan {
    const raw = this.parseJsonObject(outputText);
    const rawRequests = Array.isArray(raw.requests) ? raw.requests : [];

    return this.capabilityPlanService.enhancePlan({
      confidence: this.parseConfidence(raw.confidence),
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'LLM built a metrics plan.',
      requests: rawRequests
        .map((request, index) => this.parseRequest(request, index))
        .filter((request): request is MetricsV2MetricRequestPlan => Boolean(request)),
    });
  }

  private parseRequest(
    request: unknown,
    index: number,
  ): MetricsV2MetricRequestPlan | null {
    const raw = request as RawMetricsRequest;
    const source = this.parseSource(raw.source);
    if (!source) {
      return null;
    }

    const shape = this.parseShape(raw.shape);
    if (!shape) {
      return null;
    }

    const measurementKind = this.parseMeasurementKind(raw.measurementKind);
    const rawSystemDomain = this.parseSystemDomain(raw.systemDomain);
    const rawMeasuredSubject = this.parseMeasuredSubject(raw.measuredSubject);
    const rawSignalRole = this.parseSignalRole(raw.signalRole);
    const rawMotionReference = this.parseMotionReference(raw.motionReference);
    const fluidType = this.parseFluidType(raw.fluidType);
    const assetType = this.parseAssetType(raw.assetType);
    const groupTarget = this.parseGroupTarget(raw.groupTarget);
    const entityHints = this.parseStringArray(raw.entityHints);
    const metricHints = this.parseStringArray(raw.metricHints);
    const aggregation = this.parseAggregation(raw.aggregation, source);
    const timeRange = this.parseTimeRange(raw.timeRange, source);

    if (!timeRange) {
      return null;
    }

    const rawConcept =
      typeof raw.concept === 'string' && raw.concept.trim()
        ? raw.concept.trim()
        : 'metric_reading';
    const businessConcept = this.parseBusinessConcept({
      rawBusinessConcept: raw.businessConcept,
      concept: rawConcept,
      measurementKind,
      systemDomain: rawSystemDomain,
      measuredSubject: rawMeasuredSubject,
      signalRole: rawSignalRole,
      fluidType,
      assetType,
      groupTarget,
      shape,
      hints: [...entityHints, ...metricHints],
    });
    const normalizedShape = this.normalizeShape(shape, businessConcept);
    const normalizedPresentation =
      this.normalizePresentation(
        this.parsePresentation(raw.presentation) ??
          (normalizedShape === 'group'
            ? 'breakdown_with_total'
            : 'value_only'),
        businessConcept,
      );
    const normalizedGroupTarget = this.normalizeGroupTarget(
      groupTarget,
      businessConcept,
    );
    const normalizedAggregation = this.normalizeAggregation(
      aggregation,
      source,
      businessConcept,
    );
    const normalizedSystemDomain = this.normalizeSystemDomain({
      systemDomain: rawSystemDomain,
      businessConcept,
      assetType,
      hints: [rawConcept, ...entityHints, ...metricHints],
    });
    const normalizedMeasuredSubject = this.normalizeMeasuredSubject({
      measuredSubject: rawMeasuredSubject,
      businessConcept,
      measurementKind,
      assetType,
      hints: [rawConcept, ...entityHints, ...metricHints],
    });
    const normalizedSignalRole = this.normalizeSignalRole({
      signalRole: rawSignalRole,
      businessConcept,
      measuredSubject: normalizedMeasuredSubject,
      measurementKind,
    });
    const normalizedMotionReference = this.normalizeMotionReference({
      motionReference: rawMotionReference,
      businessConcept,
      systemDomain: normalizedSystemDomain,
      measuredSubject: normalizedMeasuredSubject,
      signalRole: normalizedSignalRole,
      measurementKind,
      hints: [rawConcept, ...entityHints, ...metricHints],
    });

    return {
      requestId:
        typeof raw.requestId === 'string' && raw.requestId.trim()
          ? raw.requestId.trim()
          : `metrics_request_${index + 1}`,
      source,
      shape: normalizedShape,
      presentation: normalizedPresentation,
      concept: rawConcept,
      businessConcept,
      measurementKind,
      systemDomain: normalizedSystemDomain,
      measuredSubject: normalizedMeasuredSubject,
      signalRole: normalizedSignalRole,
      motionReference: normalizedMotionReference,
      fluidType,
      assetType,
      groupTarget: normalizedGroupTarget,
      entityHints,
      metricHints,
      aggregation: normalizedAggregation,
      timeRange,
    };
  }

  private parseJsonObject(outputText: string): RawMetricsPlan {
    try {
      return JSON.parse(outputText) as RawMetricsPlan;
    } catch {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Metrics planner response did not contain JSON');
      }

      return JSON.parse(jsonMatch[0]) as RawMetricsPlan;
    }
  }

  private parseConfidence(value: unknown): number {
    const confidence = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(confidence)) {
      return 0.5;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  private parseSource(value: unknown): MetricsV2MetricSource | null {
    return value === 'current' || value === 'historical' ? value : null;
  }

  private parseShape(value: unknown): MetricsV2MetricShape | null {
    return value === 'single' || value === 'group' ? value : null;
  }

  private parsePresentation(
    value: unknown,
  ): MetricsV2MetricPresentation | null {
    return value === 'value_only' ||
      value === 'total_only' ||
      value === 'breakdown' ||
      value === 'breakdown_with_total'
      ? value
      : null;
  }

  private parseMeasurementKind(value: unknown): MetricsV2MeasurementKind {
    return value === 'level' ||
      value === 'volume' ||
      value === 'energy' ||
      value === 'temperature' ||
      value === 'pressure' ||
      value === 'speed' ||
      value === 'location' ||
      value === 'runtime' ||
      value === 'voltage' ||
      value === 'current' ||
      value === 'power' ||
      value === 'status' ||
      value === 'quantity'
      ? value
      : 'unknown';
  }

  private parseBusinessConcept(params: {
    rawBusinessConcept: unknown;
    concept: string;
    measurementKind: MetricsV2MeasurementKind;
    systemDomain?: MetricsV2SystemDomain;
    measuredSubject?: MetricsV2MeasuredSubject;
    signalRole?: MetricsV2SignalRole;
    fluidType?: MetricsV2FluidType;
    assetType?: MetricsV2AssetType;
    groupTarget?: MetricsV2GroupTarget;
    shape: 'single' | 'group';
    hints: string[];
  }): MetricsV2BusinessConcept {
    return inferPlanBusinessConcept({
      rawBusinessConcept: params.rawBusinessConcept,
      concept: params.concept,
      measurementKind: params.measurementKind,
      systemDomain: params.systemDomain,
      measuredSubject: params.measuredSubject,
      signalRole: params.signalRole,
      fluidType: params.fluidType,
      assetType: params.assetType,
      groupTarget: params.groupTarget,
      shape: params.shape,
      hints: params.hints,
    });
  }

  private parseSystemDomain(value: unknown): MetricsV2SystemDomain {
    return parseMetricsV2SystemDomain(value);
  }

  private parseMeasuredSubject(value: unknown): MetricsV2MeasuredSubject {
    return parseMetricsV2MeasuredSubject(value);
  }

  private parseSignalRole(value: unknown): MetricsV2SignalRole {
    return parseMetricsV2SignalRole(value);
  }

  private parseMotionReference(value: unknown): MetricsV2MotionReference {
    return parseMetricsV2MotionReference(value);
  }

  private normalizeSystemDomain(params: {
    systemDomain?: MetricsV2SystemDomain;
    businessConcept: MetricsV2BusinessConcept;
    assetType?: MetricsV2AssetType;
    hints: string[];
  }): MetricsV2SystemDomain {
    if (params.systemDomain && params.systemDomain !== 'unknown') {
      return params.systemDomain;
    }

    const haystack = params.hints.join('\n').toLowerCase();
    switch (params.businessConcept) {
      case 'vessel_speed':
      case 'vessel_position':
        return 'navigation';
      case 'component_speed':
        if (/\b(hvac|fan|blower)\b/.test(haystack)) {
          return 'hvac';
        }
        if (/\bpump\b/.test(haystack)) {
          return 'pump';
        }
        return params.assetType === 'engine' ||
          params.assetType === 'generator' ||
          params.assetType === 'pump' ||
          params.assetType === 'navigation'
          ? params.assetType
          : null;
      case 'environmental_speed':
        return 'environment';
      case 'route_progress_speed':
        return 'navigation';
      case 'fuel_onboard_inventory':
      case 'fuel_tank_inventory_member':
      case 'fuel_tank_temperature':
        return 'fuel';
      case 'oil_onboard_inventory':
      case 'oil_tank_inventory_member':
        return 'oil';
      case 'water_onboard_inventory':
      case 'water_tank_inventory_member':
        return 'water';
      case 'def_onboard_inventory':
      case 'def_tank_inventory_member':
        return 'tank';
      case 'pump_energy_usage':
        return 'pump';
      case 'engine_runtime':
        return 'engine';
      case 'battery_voltage':
      case 'electrical_current_reading':
      case 'electrical_power_reading':
        return 'electrical';
      default:
        return params.assetType === 'navigation' ? 'navigation' : null;
    }
  }

  private normalizeMeasuredSubject(params: {
    measuredSubject?: MetricsV2MeasuredSubject;
    businessConcept: MetricsV2BusinessConcept;
    measurementKind: MetricsV2MeasurementKind;
    assetType?: MetricsV2AssetType;
    hints: string[];
  }): MetricsV2MeasuredSubject {
    if (params.measuredSubject && params.measuredSubject !== 'unknown') {
      return params.measuredSubject;
    }

    const haystack = params.hints.join('\n').toLowerCase();
    switch (params.businessConcept) {
      case 'vessel_speed':
        return 'vessel_motion';
      case 'vessel_position':
        return 'vessel_position';
      case 'component_speed':
        if (/\b(hvac|fan|blower)\b/.test(haystack)) {
          return 'fan_rotation';
        }
        if (/\bpump\b/.test(haystack)) {
          return 'pump_operation';
        }
        return null;
      case 'environmental_speed':
        return 'wind';
      case 'route_progress_speed':
        return 'route_progress';
      case 'fuel_onboard_inventory':
      case 'fuel_tank_inventory_member':
        return 'fuel_inventory';
      case 'oil_onboard_inventory':
      case 'oil_tank_inventory_member':
        return 'oil_inventory';
      case 'water_onboard_inventory':
      case 'water_tank_inventory_member':
        return 'water_inventory';
      case 'def_onboard_inventory':
      case 'def_tank_inventory_member':
        return 'def_inventory';
      case 'fuel_tank_temperature':
      case 'generic_tank_temperature':
        return 'tank_temperature';
      case 'engine_runtime':
        return 'engine_state';
      case 'battery_voltage':
        return 'battery_state';
      case 'electrical_current_reading':
      case 'electrical_power_reading':
        return 'electrical_flow';
      default:
        return params.assetType === 'navigation' &&
          params.measurementKind === 'speed'
          ? 'vessel_motion'
          : null;
    }
  }

  private normalizeSignalRole(params: {
    signalRole?: MetricsV2SignalRole;
    businessConcept: MetricsV2BusinessConcept;
    measuredSubject?: MetricsV2MeasuredSubject;
    measurementKind: MetricsV2MeasurementKind;
  }): MetricsV2SignalRole {
    if (params.signalRole && params.signalRole !== 'unknown') {
      return params.signalRole;
    }

    if (
      params.measuredSubject === 'vessel_motion' ||
      params.measuredSubject === 'vessel_position'
    ) {
      return 'primary_vessel_telemetry';
    }
    if (params.measuredSubject === 'route_progress') {
      return 'navigation_calculation';
    }
    if (
      params.measuredSubject === 'fan_rotation' ||
      params.measuredSubject === 'pump_operation' ||
      params.measuredSubject === 'engine_state' ||
      params.measuredSubject === 'battery_state'
    ) {
      return 'component_internal_state';
    }
    if (params.measuredSubject === 'wind') {
      return 'environmental_condition';
    }
    if (
      params.measuredSubject === 'fuel_inventory' ||
      params.measuredSubject === 'oil_inventory' ||
      params.measuredSubject === 'water_inventory' ||
      params.measuredSubject === 'def_inventory'
    ) {
      return 'inventory_quantity';
    }
    if (
      params.measurementKind === 'energy' ||
      params.businessConcept === 'pump_energy_usage'
    ) {
      return 'energy_consumption';
    }
    if (params.measurementKind === 'status') {
      return 'alarm_or_status';
    }

    return null;
  }

  private normalizeMotionReference(params: {
    motionReference?: MetricsV2MotionReference;
    businessConcept: MetricsV2BusinessConcept;
    systemDomain?: MetricsV2SystemDomain;
    measuredSubject?: MetricsV2MeasuredSubject;
    signalRole?: MetricsV2SignalRole;
    measurementKind: MetricsV2MeasurementKind;
    hints: string[];
  }): MetricsV2MotionReference {
    if (params.motionReference && params.motionReference !== 'unknown') {
      return params.motionReference;
    }

    const haystack = params.hints.join('\n').toLowerCase();

    if (
      params.businessConcept === 'route_progress_speed' ||
      params.measuredSubject === 'route_progress' ||
      params.signalRole === 'navigation_calculation'
    ) {
      return 'route_progress';
    }

    if (
      params.businessConcept === 'component_speed' ||
      params.measuredSubject === 'fan_rotation' ||
      params.measuredSubject === 'pump_operation'
    ) {
      return 'component_internal';
    }

    if (
      params.businessConcept === 'environmental_speed' ||
      params.measuredSubject === 'wind' ||
      params.systemDomain === 'environment'
    ) {
      return 'ambient_flow';
    }

    if (params.measurementKind !== 'speed') {
      return null;
    }

    if (
      /\b(speed\s*through\s*water|speedthroughwater|stw|through water)\b/.test(
        haystack,
      )
    ) {
      return 'through_water';
    }

    if (
      /\b(speed\s*over\s*ground|speedoverground|sog|gps speed|gps-based speed|over ground)\b/.test(
        haystack,
      )
    ) {
      return 'over_ground';
    }

    return null;
  }

  private normalizeShape(
    shape: MetricsV2MetricShape,
    businessConcept: MetricsV2BusinessConcept,
  ): MetricsV2MetricShape {
    if (
      businessConcept === 'fuel_onboard_inventory' ||
      businessConcept === 'oil_onboard_inventory' ||
      businessConcept === 'water_onboard_inventory' ||
      businessConcept === 'def_onboard_inventory'
    ) {
      return 'group';
    }

    return shape;
  }

  private normalizePresentation(
    presentation: MetricsV2MetricPresentation,
    businessConcept: MetricsV2BusinessConcept,
  ): MetricsV2MetricPresentation {
    if (
      businessConcept === 'fuel_onboard_inventory' ||
      businessConcept === 'oil_onboard_inventory' ||
      businessConcept === 'water_onboard_inventory' ||
      businessConcept === 'def_onboard_inventory'
    ) {
      return 'breakdown_with_total';
    }

    return presentation;
  }

  private normalizeGroupTarget(
    groupTarget: MetricsV2GroupTarget,
    businessConcept: MetricsV2BusinessConcept,
  ): MetricsV2GroupTarget {
    if (
      businessConcept === 'fuel_onboard_inventory' ||
      businessConcept === 'oil_onboard_inventory' ||
      businessConcept === 'water_onboard_inventory' ||
      businessConcept === 'def_onboard_inventory'
    ) {
      return 'storage_tanks';
    }

    return groupTarget;
  }

  private normalizeAggregation(
    aggregation: MetricsV2MetricAggregation,
    source: MetricsV2MetricSource,
    businessConcept: MetricsV2BusinessConcept,
  ): MetricsV2MetricAggregation {
    if (
      businessConcept === 'fuel_onboard_inventory' ||
      businessConcept === 'oil_onboard_inventory' ||
      businessConcept === 'water_onboard_inventory' ||
      businessConcept === 'def_onboard_inventory'
    ) {
      return source === 'current' ? 'sum' : aggregation ?? 'latest';
    }

    return aggregation;
  }

  private parseFluidType(value: unknown): MetricsV2FluidType {
    return value === 'fuel' ||
      value === 'oil' ||
      value === 'water' ||
      value === 'coolant' ||
      value === 'def' ||
      value === 'unknown' ||
      value === null
      ? (value as MetricsV2FluidType)
      : null;
  }

  private parseAssetType(value: unknown): MetricsV2AssetType {
    return value === 'storage_tank' ||
      value === 'engine' ||
      value === 'generator' ||
      value === 'battery' ||
      value === 'charger' ||
      value === 'navigation' ||
      value === 'pump' ||
      value === 'unknown' ||
      value === null
      ? (value as MetricsV2AssetType)
      : null;
  }

  private parseGroupTarget(value: unknown): MetricsV2GroupTarget {
    return value === 'storage_tanks' ||
      value === 'engines' ||
      value === 'generators' ||
      value === 'batteries' ||
      value === 'chargers' ||
      value === 'navigation' ||
      value === null
      ? (value as MetricsV2GroupTarget)
      : null;
  }

  private parseAggregation(
    value: unknown,
    source: MetricsV2MetricSource,
  ): MetricsV2MetricAggregation {
    if (
      value === 'latest' ||
      value === 'sum' ||
      value === 'avg' ||
      value === 'min' ||
      value === 'max' ||
      value === 'delta' ||
      value === null
    ) {
      return value;
    }

    return source === 'current' ? 'latest' : null;
  }

  private parseTimeRange(
    value: unknown,
    source: MetricsV2MetricSource,
  ): MetricsV2TimeRange | null {
    if (!value || typeof value !== 'object') {
      return source === 'current' ? { kind: 'current' } : null;
    }

    const raw = value as Record<string, unknown>;
    const kind = raw.kind;

    if (kind === 'current') {
      return { kind: 'current' };
    }

    if (
      kind === 'relative' &&
      (raw.preset === 'today' ||
        raw.preset === 'yesterday' ||
        raw.preset === 'last_24_hours' ||
        raw.preset === 'last_7_days' ||
        raw.preset === 'this_week' ||
        raw.preset === 'this_month')
    ) {
      return {
        kind: 'relative',
        preset: raw.preset,
        ...(typeof raw.label === 'string' && raw.label.trim()
          ? { label: raw.label.trim() }
          : {}),
      };
    }

    if (
      kind === 'point_in_time' &&
      typeof raw.pointIso === 'string' &&
      raw.pointIso.trim()
    ) {
      return {
        kind: 'point_in_time',
        pointIso: raw.pointIso.trim(),
        ...(typeof raw.label === 'string' && raw.label.trim()
          ? { label: raw.label.trim() }
          : {}),
      };
    }

    if (
      kind === 'absolute' &&
      typeof raw.startIso === 'string' &&
      raw.startIso.trim() &&
      typeof raw.endIso === 'string' &&
      raw.endIso.trim()
    ) {
      return {
        kind: 'absolute',
        startIso: raw.startIso.trim(),
        endIso: raw.endIso.trim(),
        ...(typeof raw.label === 'string' && raw.label.trim()
          ? { label: raw.label.trim() }
          : {}),
      };
    }

    return source === 'current' ? { kind: 'current' } : null;
  }

  private parseStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
}
