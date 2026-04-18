import {
  MetricsV2BusinessConcept,
  MetricsV2MeasuredSubject,
  MetricsV2MotionReference,
  MetricsV2SignalRole,
  MetricsV2SystemDomain,
} from '../metrics-v2.types';

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
