import {
  MetricsV2AggregationCompatibility,
  MetricsV2AssetType,
  MetricsV2BusinessConcept,
  MetricsV2FluidType,
  MetricsV2GroupFamily,
  MetricsV2MeasuredSubject,
  MetricsV2MeasurementKind,
  MetricsV2MotionReference,
  MetricsV2SignalRole,
  MetricsV2SystemDomain,
  MetricsV2UnitKind,
} from '../metrics-v2.types';

export function inferMetricsV2UnitKind(params: {
  searchText: string;
  unit?: string | null;
}): MetricsV2UnitKind {
  const normalizedUnit = (params.unit ?? '').toLowerCase();
  const haystack = `${params.searchText}\n${normalizedUnit}`.toLowerCase();

  if (
    /\b(time\s*to\s*go|t\.?t\.?g\.?|eta|seconds|secs?)\b|\b\d+(?:\.\d+)?\s*seconds?\b/.test(
      haystack,
    )
  ) {
    return 'runtime';
  }
  if (
    /\b(speed\s*over\s*ground|speedoverground|speed\s*through\s*water|speedthroughwater|velocity\s*made\s*good|velocitymadegood|sog|stw|vmg|knots?|kts?)\b/.test(
      haystack,
    )
  ) {
    return 'speed';
  }
  if (/\b(latitude|longitude|position|coordinates?|gps)\b/.test(haystack)) {
    return 'location';
  }
  if (/\b(knot|knots|kt|kts|km\/h|mph|speed)\b/.test(haystack)) {
    return 'speed';
  }
  if (/\b(hours?|hrs?|runtime|hour meter)\b/.test(haystack)) {
    return 'runtime';
  }
  if (/\b(kwh|wh|mwh|joule|j)\b/.test(haystack)) {
    return 'energy';
  }
  if (
    /\b(kv|volt|voltage)\b/.test(haystack) ||
    /^(v|volt|volts|kv|mv)$/i.test(normalizedUnit)
  ) {
    return 'voltage';
  }
  if (
    /\b(amp|amps|ampere|amperage)\b/.test(haystack) ||
    /^(a|amp|amps|ma)$/i.test(normalizedUnit)
  ) {
    return 'current';
  }
  if (/\b(kw|kilowatt|watt|power)\b/.test(haystack)) {
    return 'power';
  }
  if (/\b(bar|psi|pressure)\b/.test(haystack)) {
    return 'pressure';
  }
  if (/\b(celsius|fahrenheit|temp|temperature|degrees?|°c|°f)\b/.test(haystack)) {
    return 'temperature';
  }
  if (/\b(liters?|litres?|lit|gallons?|m3|volume)\b/.test(haystack)) {
    return 'volume';
  }
  if (/%|percent/.test(haystack)) {
    return 'percent';
  }

  return null;
}

export function inferMetricsV2BusinessConcept(params: {
  searchText: string;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
  signalRole?: MetricsV2SignalRole;
  fluidType?: MetricsV2FluidType;
  assetType?: MetricsV2AssetType;
  unitKind?: MetricsV2UnitKind;
}): MetricsV2BusinessConcept {
  const {
    searchText,
    measurementKind,
    systemDomain,
    measuredSubject,
    fluidType,
    assetType,
    unitKind,
  } = params;

  if (measuredSubject === 'vessel_motion' && measurementKind === 'speed') {
    return 'vessel_speed';
  }
  if (measuredSubject === 'route_progress' && measurementKind === 'speed') {
    return 'route_progress_speed';
  }
  if (measuredSubject === 'vessel_position' || measurementKind === 'location') {
    return 'vessel_position';
  }
  if (measuredSubject === 'fan_rotation' && measurementKind === 'speed') {
    return 'component_speed';
  }
  if (measuredSubject === 'pump_operation' && measurementKind === 'speed') {
    return 'component_speed';
  }
  if (measuredSubject === 'wind' && measurementKind === 'speed') {
    return 'environmental_speed';
  }
  if (assetType === 'engine' && measurementKind === 'runtime') {
    return 'engine_runtime';
  }
  if (assetType === 'battery' && measurementKind === 'voltage') {
    return 'battery_voltage';
  }
  if (
    assetType === 'pump' &&
    (measurementKind === 'energy' ||
      unitKind === 'power' ||
      unitKind === 'energy' ||
      /active energy|energy delivered|energy received/.test(searchText))
  ) {
    return 'pump_energy_usage';
  }
  if (measurementKind === 'current') {
    return 'electrical_current_reading';
  }
  if (measurementKind === 'power') {
    return 'electrical_power_reading';
  }
  if (systemDomain === 'navigation' && measurementKind === 'speed') {
    return 'vessel_speed';
  }

  if (assetType === 'storage_tank') {
    if (fluidType === 'fuel' && isInventoryMeasurementKind(measurementKind)) {
      return 'fuel_tank_inventory_member';
    }
    if (fluidType === 'fuel' && measurementKind === 'temperature') {
      return 'fuel_tank_temperature';
    }
    if (fluidType === 'oil' && isInventoryMeasurementKind(measurementKind)) {
      return 'oil_tank_inventory_member';
    }
    if (fluidType === 'water' && isInventoryMeasurementKind(measurementKind)) {
      return 'water_tank_inventory_member';
    }
    if (fluidType === 'def' && isInventoryMeasurementKind(measurementKind)) {
      return 'def_tank_inventory_member';
    }
    if (measurementKind === 'temperature') {
      return 'generic_tank_temperature';
    }
    if (isInventoryMeasurementKind(measurementKind)) {
      return 'generic_tank_inventory_member';
    }
  }

  return 'unknown';
}

export function inferMetricsV2SystemDomain(
  searchText: string,
): MetricsV2SystemDomain {
  if (/\b(environment\.wind|wind speed|current wind|weather)\b/.test(searchText)) {
    return 'environment';
  }
  if (
    /\b(nmea|gps|gnss|navigation|heading|course|sog|stw|speed\s*over\s*ground|speedoverground|speed\s*through\s*water|speedthroughwater|latitude|longitude|position|coordinates?)\b/.test(
      searchText,
    )
  ) {
    return 'navigation';
  }
  if (/\b(hvac|fan|blower|air handler|airhandler|ventilation)\b/.test(searchText)) {
    return 'hvac';
  }
  if (/\b(def|urea)\b/.test(searchText)) {
    return 'tank';
  }
  if (/\bfuel\b/.test(searchText)) {
    return 'fuel';
  }
  if (/\boil\b/.test(searchText)) {
    return 'oil';
  }
  if (/\bwater\b/.test(searchText)) {
    return 'water';
  }
  if (/\b(generator|genset)\b/.test(searchText)) {
    return 'generator';
  }
  if (/\bengine\b/.test(searchText)) {
    return 'engine';
  }
  if (/\b(battery|charger|voltage|amp|amps|current|power|kw|kwh)\b/.test(searchText)) {
    return 'electrical';
  }
  if (/\bpump\b/.test(searchText)) {
    return 'pump';
  }
  if (/\b(wind|weather|environment|ambient)\b/.test(searchText)) {
    return 'environment';
  }
  if (/\btank\b/.test(searchText)) {
    return 'tank';
  }

  return null;
}

export function inferMetricsV2MeasuredSubject(params: {
  searchText: string;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  fluidType?: MetricsV2FluidType;
  assetType?: MetricsV2AssetType;
}): MetricsV2MeasuredSubject {
  const { searchText, measurementKind, systemDomain, fluidType, assetType } =
    params;

  if (
    /\b(environment\.wind|wind speed|current wind speed|not relative to the vessel|not relative to vessel)\b/.test(
      searchText,
    )
  ) {
    return 'wind';
  }
  if (
    /\b(vmg|velocity\s*made\s*good|velocitymadegood|made good|to waypoint|towards? waypoint)\b/.test(
      searchText,
    )
  ) {
    return 'route_progress';
  }
  if (
    /\b(sog|stw|speed\s*over\s*ground|speedoverground|speed\s*through\s*water|speedthroughwater|vessel speed|ship speed|yacht speed)\b/.test(
      searchText,
    )
  ) {
    return 'vessel_motion';
  }
  if (/\b(latitude|longitude|position|coordinates?|gps|gnss)\b/.test(searchText)) {
    return 'vessel_position';
  }
  if (/\b(hvac|fan|blower|air handler|airhandler|ventilation)\b/.test(searchText)) {
    return 'fan_rotation';
  }
  if (/\bpump\b/.test(searchText)) {
    return 'pump_operation';
  }
  if (/\bwind\b/.test(searchText) && measurementKind === 'speed') {
    return 'wind';
  }
  if (assetType === 'storage_tank' && measurementKind === 'temperature') {
    return 'tank_temperature';
  }
  if (assetType === 'storage_tank' && fluidType === 'fuel') {
    return 'fuel_inventory';
  }
  if (assetType === 'storage_tank' && fluidType === 'oil') {
    return 'oil_inventory';
  }
  if (assetType === 'storage_tank' && fluidType === 'water') {
    return 'water_inventory';
  }
  if (assetType === 'storage_tank' && fluidType === 'def') {
    return 'def_inventory';
  }
  if (systemDomain === 'engine') {
    return 'engine_state';
  }
  if (assetType === 'battery') {
    return 'battery_state';
  }
  if (
    measurementKind === 'current' ||
    measurementKind === 'voltage' ||
    measurementKind === 'power'
  ) {
    return 'electrical_flow';
  }
  if (systemDomain === 'navigation' && measurementKind === 'speed') {
    return 'vessel_motion';
  }

  return null;
}

export function inferMetricsV2SignalRole(params: {
  businessConcept?: MetricsV2BusinessConcept;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
}): MetricsV2SignalRole {
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
    params.measuredSubject === 'fuel_inventory' ||
    params.measuredSubject === 'oil_inventory' ||
    params.measuredSubject === 'water_inventory' ||
    params.measuredSubject === 'def_inventory' ||
    isInventoryMemberBusinessConcept(params.businessConcept ?? 'unknown')
  ) {
    return 'inventory_quantity';
  }
  if (params.measuredSubject === 'wind' || params.systemDomain === 'environment') {
    return 'environmental_condition';
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
  if (
    params.measuredSubject === 'fan_rotation' ||
    params.measuredSubject === 'pump_operation' ||
    params.measuredSubject === 'engine_state' ||
    params.measuredSubject === 'battery_state'
  ) {
    return 'component_internal_state';
  }

  return null;
}

export function inferMetricsV2MotionReference(params: {
  searchText: string;
  businessConcept?: MetricsV2BusinessConcept;
  measurementKind: MetricsV2MeasurementKind;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
  signalRole?: MetricsV2SignalRole;
}): MetricsV2MotionReference {
  const haystack = params.searchText.toLowerCase();

  if (params.measurementKind !== 'speed') {
    return null;
  }
  if (
    params.measuredSubject === 'route_progress' ||
    params.businessConcept === 'route_progress_speed' ||
    params.signalRole === 'navigation_calculation'
  ) {
    return 'route_progress';
  }
  if (
    params.measuredSubject === 'fan_rotation' ||
    params.measuredSubject === 'pump_operation' ||
    params.businessConcept === 'component_speed'
  ) {
    return 'component_internal';
  }
  if (
    params.measuredSubject === 'wind' ||
    params.systemDomain === 'environment' ||
    params.businessConcept === 'environmental_speed'
  ) {
    return 'ambient_flow';
  }
  if (/\b(speed\s*through\s*water|speedthroughwater|stw)\b/.test(haystack)) {
    return 'through_water';
  }
  if (
    /\b(speed\s*over\s*ground|speedoverground|sog|gps speed|gps-based speed)\b/.test(
      haystack,
    )
  ) {
    return 'over_ground';
  }

  return null;
}

export function inferMetricsV2GroupFamily(
  businessConcept: MetricsV2BusinessConcept,
): MetricsV2GroupFamily {
  switch (businessConcept) {
    case 'fuel_tank_inventory_member':
      return 'fuel_storage_tanks_onboard';
    case 'oil_tank_inventory_member':
      return 'oil_storage_tanks_onboard';
    case 'water_tank_inventory_member':
      return 'water_storage_tanks_onboard';
    case 'def_tank_inventory_member':
      return 'def_storage_tanks_onboard';
    case 'generic_tank_inventory_member':
      return 'generic_storage_tanks';
    default:
      return null;
  }
}

export function inferMetricsV2AggregationCompatibility(params: {
  businessConcept: MetricsV2BusinessConcept;
  measurementKind: MetricsV2MeasurementKind;
  unitKind?: MetricsV2UnitKind;
}): MetricsV2AggregationCompatibility[] {
  const compatibility: MetricsV2AggregationCompatibility[] = ['latest_point'];

  if (isNumericMetricKind(params.measurementKind)) {
    compatibility.push('avg_over_time', 'min_over_time', 'max_over_time');
  }

  if (
    isInventoryMemberBusinessConcept(params.businessConcept) &&
    params.unitKind === 'volume'
  ) {
    compatibility.push('sum_total_onboard', 'delta_over_time');
  } else if (isNumericMetricKind(params.measurementKind)) {
    compatibility.push('delta_over_time');
  }

  return [...new Set(compatibility)];
}

export function inferMetricsV2OperationalMeaning(params: {
  businessConcept: MetricsV2BusinessConcept;
  systemDomain?: MetricsV2SystemDomain;
  measuredSubject?: MetricsV2MeasuredSubject;
  signalRole?: MetricsV2SignalRole;
  motionReference?: MetricsV2MotionReference;
  fluidType?: MetricsV2FluidType;
  assetType?: MetricsV2AssetType;
  measurementKind: MetricsV2MeasurementKind;
  label: string;
}): string {
  switch (params.businessConcept) {
    case 'fuel_tank_inventory_member':
      return 'Current amount of fuel stored in one onboard fuel storage tank.';
    case 'oil_tank_inventory_member':
      return 'Current amount of oil stored in one onboard oil storage tank.';
    case 'water_tank_inventory_member':
      return 'Current amount of water stored in one onboard water storage tank.';
    case 'def_tank_inventory_member':
      return 'Current amount of DEF or urea stored in one onboard storage tank.';
    case 'fuel_tank_temperature':
      return 'Current temperature inside one onboard fuel storage tank.';
    case 'generic_tank_temperature':
      return 'Current temperature inside one onboard storage tank.';
    case 'component_speed':
      return 'Internal component speed reading, such as a fan or pump speed, not vessel motion.';
    case 'environmental_speed':
      return 'Environmental speed reading, such as wind speed, not vessel motion.';
    case 'route_progress_speed':
      return 'Calculated route-progress speed, such as VMG toward a waypoint, not the default vessel speed reading.';
    case 'pump_energy_usage':
      return 'Electrical power or energy reading for a pump, not onboard tank inventory.';
    case 'vessel_speed':
      if (params.motionReference === 'through_water') {
        return 'Current vessel speed through water from navigation telemetry.';
      }
      if (params.motionReference === 'over_ground') {
        return 'Current vessel speed over ground from navigation telemetry.';
      }
      return 'Current vessel speed reading from navigation telemetry.';
    case 'vessel_position':
      return 'Current vessel position or coordinate reading from navigation telemetry.';
    case 'engine_runtime':
      return 'Current runtime or operating hours for one engine.';
    case 'battery_voltage':
      return 'Current battery voltage reading.';
    case 'electrical_current_reading':
      return 'Current electrical current reading.';
    case 'electrical_power_reading':
      return 'Current electrical power reading.';
    default:
      return `${params.label} interpreted as ${params.measurementKind} telemetry for ${params.assetType ?? 'unknown asset'}.`;
  }
}

function isInventoryMemberBusinessConcept(
  businessConcept: MetricsV2BusinessConcept,
): boolean {
  return (
    businessConcept === 'fuel_tank_inventory_member' ||
    businessConcept === 'oil_tank_inventory_member' ||
    businessConcept === 'water_tank_inventory_member' ||
    businessConcept === 'def_tank_inventory_member' ||
    businessConcept === 'generic_tank_inventory_member'
  );
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

function isNumericMetricKind(
  measurementKind: MetricsV2MeasurementKind,
): boolean {
  return measurementKind !== 'status' && measurementKind !== 'location';
}
