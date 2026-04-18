import {
  MetricsV2AssetType,
  MetricsV2BusinessConcept,
  MetricsV2FluidType,
  MetricsV2GroupTarget,
  MetricsV2MeasuredSubject,
  MetricsV2MeasurementKind,
  MetricsV2MotionReference,
  MetricsV2SignalRole,
  MetricsV2SystemDomain,
} from '../metrics-v2.types';

export function inferPlanBusinessConcept(params: {
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
  const direct = parseMetricsV2BusinessConcept(params.rawBusinessConcept);
  if (direct !== 'unknown') {
    return direct;
  }

  const haystack = [params.concept, ...params.hints].join('\n').toLowerCase();

  if (
    params.shape === 'group' &&
    params.groupTarget === 'storage_tanks' &&
    params.fluidType === 'fuel' &&
    isInventoryMeasurementKind(params.measurementKind)
  ) {
    return 'fuel_onboard_inventory';
  }
  if (
    params.shape === 'group' &&
    params.groupTarget === 'storage_tanks' &&
    params.fluidType === 'oil' &&
    isInventoryMeasurementKind(params.measurementKind)
  ) {
    return 'oil_onboard_inventory';
  }
  if (
    params.shape === 'group' &&
    params.groupTarget === 'storage_tanks' &&
    params.fluidType === 'water' &&
    isInventoryMeasurementKind(params.measurementKind)
  ) {
    return 'water_onboard_inventory';
  }
  if (
    params.shape === 'group' &&
    params.groupTarget === 'storage_tanks' &&
    params.fluidType === 'def' &&
    isInventoryMeasurementKind(params.measurementKind)
  ) {
    return 'def_onboard_inventory';
  }
  if (params.measuredSubject === 'vessel_motion' && params.measurementKind === 'speed') {
    return 'vessel_speed';
  }
  if (params.measuredSubject === 'route_progress' && params.measurementKind === 'speed') {
    return 'route_progress_speed';
  }
  if (params.measuredSubject === 'vessel_position' || params.measurementKind === 'location') {
    return 'vessel_position';
  }
  if (params.measuredSubject === 'fan_rotation' && params.measurementKind === 'speed') {
    return 'component_speed';
  }
  if (params.measuredSubject === 'pump_operation' && params.measurementKind === 'speed') {
    return 'component_speed';
  }
  if (params.measuredSubject === 'wind' && params.measurementKind === 'speed') {
    return 'environmental_speed';
  }
  if (params.assetType === 'navigation' && params.measurementKind === 'speed') {
    return 'vessel_speed';
  }
  if (params.assetType === 'storage_tank' && params.fluidType === 'fuel') {
    if (/onboard|total fuel|fuel onboard/.test(haystack) && params.shape === 'group') {
      return 'fuel_onboard_inventory';
    }
    if (params.measurementKind === 'temperature') {
      return 'fuel_tank_temperature';
    }
    if (isInventoryMeasurementKind(params.measurementKind)) {
      return 'fuel_tank_inventory_member';
    }
  }

  return 'unknown';
}

export function parseMetricsV2BusinessConcept(
  value: unknown,
): MetricsV2BusinessConcept {
  return value === 'fuel_onboard_inventory' ||
    value === 'fuel_tank_inventory_member' ||
    value === 'fuel_tank_temperature' ||
    value === 'oil_onboard_inventory' ||
    value === 'oil_tank_inventory_member' ||
    value === 'water_onboard_inventory' ||
    value === 'water_tank_inventory_member' ||
    value === 'def_onboard_inventory' ||
    value === 'def_tank_inventory_member' ||
    value === 'generic_tank_inventory_member' ||
    value === 'generic_tank_temperature' ||
    value === 'component_speed' ||
    value === 'environmental_speed' ||
    value === 'route_progress_speed' ||
    value === 'pump_energy_usage' ||
    value === 'vessel_speed' ||
    value === 'vessel_position' ||
    value === 'engine_runtime' ||
    value === 'battery_voltage' ||
    value === 'electrical_current_reading' ||
    value === 'electrical_power_reading'
    ? value
    : 'unknown';
}

export function parseMetricsV2SystemDomain(
  value: unknown,
): MetricsV2SystemDomain {
  return value === 'navigation' ||
    value === 'hvac' ||
    value === 'fuel' ||
    value === 'oil' ||
    value === 'water' ||
    value === 'electrical' ||
    value === 'engine' ||
    value === 'generator' ||
    value === 'pump' ||
    value === 'environment' ||
    value === 'tank' ||
    value === 'unknown' ||
    value === null
    ? (value as MetricsV2SystemDomain)
    : null;
}

export function parseMetricsV2MeasuredSubject(
  value: unknown,
): MetricsV2MeasuredSubject {
  return value === 'vessel_motion' ||
    value === 'vessel_position' ||
    value === 'route_progress' ||
    value === 'fan_rotation' ||
    value === 'pump_operation' ||
    value === 'wind' ||
    value === 'fuel_inventory' ||
    value === 'oil_inventory' ||
    value === 'water_inventory' ||
    value === 'def_inventory' ||
    value === 'tank_temperature' ||
    value === 'engine_state' ||
    value === 'battery_state' ||
    value === 'electrical_flow' ||
    value === 'unknown' ||
    value === null
    ? (value as MetricsV2MeasuredSubject)
    : null;
}

export function parseMetricsV2SignalRole(
  value: unknown,
): MetricsV2SignalRole {
  return value === 'primary_vessel_telemetry' ||
    value === 'navigation_calculation' ||
    value === 'component_internal_state' ||
    value === 'environmental_condition' ||
    value === 'inventory_quantity' ||
    value === 'energy_consumption' ||
    value === 'alarm_or_status' ||
    value === 'unknown' ||
    value === null
    ? (value as MetricsV2SignalRole)
    : null;
}

export function parseMetricsV2MotionReference(
  value: unknown,
): MetricsV2MotionReference {
  return value === 'over_ground' ||
    value === 'through_water' ||
    value === 'route_progress' ||
    value === 'ambient_flow' ||
    value === 'component_internal' ||
    value === 'unknown' ||
    value === null
    ? (value as MetricsV2MotionReference)
    : null;
}

function isInventoryMeasurementKind(
  measurementKind: MetricsV2MeasurementKind,
): boolean {
  return (
    measurementKind === 'level' ||
    measurementKind === 'volume' ||
    measurementKind === 'quantity'
  );
}
