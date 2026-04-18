import { MetricsV2MetricResolverService } from '../../../src/metrics-v2/catalog/metrics-v2-metric-resolver.service';
import type {
  MetricsV2CatalogEntry,
  MetricsV2MetricRequestPlan,
} from '../../../src/metrics-v2/metrics-v2.types';

describe('MetricsV2MetricResolverService', () => {
  let service: MetricsV2MetricResolverService;

  beforeEach(() => {
    service = new MetricsV2MetricResolverService();
  });

  it('keeps fuel tank inventory groups on level/volume entries and excludes temperatures', () => {
    const plan: MetricsV2MetricRequestPlan = {
      requestId: 'fuel_onboard',
      source: 'current',
      shape: 'group',
      presentation: 'breakdown_with_total',
      concept: 'fuel_inventory_onboard',
      businessConcept: 'fuel_onboard_inventory',
      measurementKind: 'volume',
      fluidType: 'fuel',
      assetType: 'storage_tank',
      groupTarget: 'storage_tanks',
      entityHints: ['fuel tanks', 'onboard fuel'],
      metricHints: ['fuel level', 'fuel volume'],
      aggregation: 'sum',
      timeRange: { kind: 'current' },
    };

    const catalog: MetricsV2CatalogEntry[] = [
      buildCatalogEntry({
        key: 'Fuel_Tank_1P',
        label: 'Fuel Tank 1P',
        measurementKind: 'volume',
        fluidType: 'fuel',
        assetType: 'storage_tank',
        businessConcept: 'fuel_tank_inventory_member',
        unitKind: 'volume',
        groupFamily: 'fuel_storage_tanks_onboard',
        aggregationCompatibility: ['latest_point', 'sum_total_onboard'],
        groupMemberKey: '1P',
      }),
      buildCatalogEntry({
        key: 'Fuel_Tank_2S',
        label: 'Fuel Tank 2S',
        measurementKind: 'level',
        fluidType: 'fuel',
        assetType: 'storage_tank',
        businessConcept: 'fuel_tank_inventory_member',
        unitKind: 'volume',
        groupFamily: 'fuel_storage_tanks_onboard',
        aggregationCompatibility: ['latest_point', 'sum_total_onboard'],
        groupMemberKey: '2S',
      }),
      buildCatalogEntry({
        key: 'Fuel_Tank_6S',
        label: 'Fuel Tank 6S Temperature',
        measurementKind: 'temperature',
        fluidType: 'fuel',
        assetType: 'storage_tank',
        businessConcept: 'fuel_tank_temperature',
        unitKind: 'temperature',
        groupMemberKey: '6S',
      }),
      buildCatalogEntry({
        key: 'UREA_TANK_26S',
        label: 'UREA TANK 26S LITERS',
        measurementKind: 'volume',
        fluidType: 'def',
        assetType: 'storage_tank',
        businessConcept: 'def_tank_inventory_member',
        unitKind: 'volume',
        groupFamily: 'def_storage_tanks_onboard',
        aggregationCompatibility: ['latest_point', 'sum_total_onboard'],
        groupMemberKey: '26S',
      }),
      buildCatalogEntry({
        key: 'PORT-AFT-GARAGE-SCUPPER-TANK-PUMP.ENERGY',
        label: 'PORT-AFT-GARAGE-SCUPPER-TANK-PUMP Energy',
        measurementKind: 'energy',
        assetType: 'pump',
        businessConcept: 'pump_energy_usage',
        unitKind: 'energy',
        aggregationCompatibility: ['latest_point', 'avg_over_time'],
        searchText:
          'port aft garage scupper tank pump partial active energy delivered received pump energy usage',
      }),
    ];

    const resolved = service.resolve({
      planRequests: [plan],
      catalog,
    });

    expect(resolved.requests[0].entries.map((entry) => entry.key)).toEqual([
      'Fuel_Tank_1P',
      'Fuel_Tank_2S',
    ]);
    expect(
      resolved.debug.requests[0]?.rejectedEntries.find(
        (entry) => entry.entry.key === 'UREA_TANK_26S',
      )?.reasons,
    ).toContain('fluid_type_mismatch');
    expect(
      resolved.debug.requests[0]?.rejectedEntries.find(
        (entry) => entry.entry.key === 'PORT-AFT-GARAGE-SCUPPER-TANK-PUMP.ENERGY',
      )?.reasons,
    ).toContain('asset_type_mismatch');
  });

  it('prefers the exact navigation speed metric for single requests', () => {
    const plan: MetricsV2MetricRequestPlan = {
      requestId: 'speed_now',
      source: 'current',
      shape: 'single',
      presentation: 'value_only',
      concept: 'vessel_speed',
      businessConcept: 'vessel_speed',
      measurementKind: 'speed',
      systemDomain: 'navigation',
      measuredSubject: 'vessel_motion',
      signalRole: 'primary_vessel_telemetry',
      motionReference: null,
      fluidType: null,
      assetType: 'navigation',
      groupTarget: null,
      entityHints: ['vessel', 'yacht'],
      metricHints: ['current speed', 'vessel speed'],
      aggregation: 'latest',
      timeRange: { kind: 'current' },
    };

    const catalog: MetricsV2CatalogEntry[] = [
      buildCatalogEntry({
        key: 'NAV_SOG',
        label: 'Speed Over Ground',
        measurementKind: 'speed',
        assetType: 'navigation',
        businessConcept: 'vessel_speed',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_motion',
        signalRole: 'primary_vessel_telemetry',
        motionReference: 'over_ground',
        searchText:
          'nav_sog speed over ground vessel speed navigation speed over ground knots',
      }),
      buildCatalogEntry({
        key: 'NAV_STW',
        label: 'Speed Through Water',
        measurementKind: 'speed',
        assetType: 'navigation',
        businessConcept: 'vessel_speed',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_motion',
        signalRole: 'primary_vessel_telemetry',
        motionReference: 'through_water',
        searchText:
          'nav_stw speed through water vessel speed navigation speed through water knots',
      }),
      buildCatalogEntry({
        key: 'NAV_VMG',
        label: 'Velocity Made Good',
        measurementKind: 'speed',
        assetType: 'navigation',
        businessConcept: 'route_progress_speed',
        systemDomain: 'navigation',
        measuredSubject: 'route_progress',
        signalRole: 'navigation_calculation',
        motionReference: 'route_progress',
        searchText:
          'velocity made good vmg speed toward waypoint route progress navigation',
      }),
      buildCatalogEntry({
        key: 'HVAC_FAN_SPEED',
        label: 'HVAC Fan Speed',
        measurementKind: 'speed',
        businessConcept: 'component_speed',
        systemDomain: 'hvac',
        measuredSubject: 'fan_rotation',
        signalRole: 'component_internal_state',
        motionReference: 'component_internal',
        searchText: 'hvac fan speed rotational speed component internal state',
      }),
      buildCatalogEntry({
        key: 'WIND_SPEED',
        label: 'Wind Speed Over Ground',
        measurementKind: 'speed',
        assetType: 'navigation',
        businessConcept: 'environmental_speed',
        systemDomain: 'environment',
        measuredSubject: 'wind',
        signalRole: 'environmental_condition',
        motionReference: 'ambient_flow',
        searchText:
          'environment wind speed over ground current wind speed not relative to vessel',
      }),
      buildCatalogEntry({
        key: 'NAV_HEADING',
        label: 'Heading',
        measurementKind: 'location',
        assetType: 'navigation',
        businessConcept: 'vessel_position',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_position',
        signalRole: 'primary_vessel_telemetry',
        searchText: 'nav_heading heading vessel heading navigation',
      }),
    ];

    const resolved = service.resolve({
      planRequests: [plan],
      catalog,
    });

    expect(resolved.requests[0].entries[0]?.key).toBe('NAV_STW');
    expect(resolved.requests[0].clarificationKind).toBeUndefined();
    expect(
      resolved.debug.requests[0]?.rejectedEntries.find(
        (entry) => entry.entry.key === 'HVAC_FAN_SPEED',
      )?.reasons,
    ).toContain('business_concept_mismatch');
    expect(
      resolved.debug.requests[0]?.rejectedEntries.find(
        (entry) => entry.entry.key === 'NAV_VMG',
      )?.reasons,
    ).toContain('business_concept_mismatch');
  });

  it('honors an explicit over-ground speed request when motion reference is specified', () => {
    const plan: MetricsV2MetricRequestPlan = {
      requestId: 'speed_over_ground_now',
      source: 'current',
      shape: 'single',
      presentation: 'value_only',
      concept: 'gps_speed',
      businessConcept: 'vessel_speed',
      measurementKind: 'speed',
      systemDomain: 'navigation',
      measuredSubject: 'vessel_motion',
      signalRole: 'primary_vessel_telemetry',
      motionReference: 'over_ground',
      fluidType: null,
      assetType: 'navigation',
      groupTarget: null,
      entityHints: ['gps', 'navigation'],
      metricHints: ['speed over ground', 'sog'],
      aggregation: 'latest',
      timeRange: { kind: 'current' },
    };

    const catalog: MetricsV2CatalogEntry[] = [
      buildCatalogEntry({
        key: 'NAV_SOG',
        label: 'Speed Over Ground',
        measurementKind: 'speed',
        assetType: 'navigation',
        businessConcept: 'vessel_speed',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_motion',
        signalRole: 'primary_vessel_telemetry',
        motionReference: 'over_ground',
        searchText:
          'nav_sog speed over ground vessel speed navigation speed over ground knots',
      }),
      buildCatalogEntry({
        key: 'NAV_STW',
        label: 'Speed Through Water',
        measurementKind: 'speed',
        assetType: 'navigation',
        businessConcept: 'vessel_speed',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_motion',
        signalRole: 'primary_vessel_telemetry',
        motionReference: 'through_water',
        searchText:
          'nav_stw speed through water vessel speed navigation speed through water knots',
      }),
    ];

    const resolved = service.resolve({
      planRequests: [plan],
      catalog,
    });

    expect(resolved.requests[0].entries[0]?.key).toBe('NAV_SOG');
    expect(resolved.requests[0].clarificationKind).toBeUndefined();
    expect(
      resolved.debug.requests[0]?.rejectedEntries.find(
        (entry) => entry.entry.key === 'NAV_STW',
      )?.reasons,
    ).toContain('motion_reference_mismatch');
  });
});

function buildCatalogEntry(
  overrides: Partial<MetricsV2CatalogEntry> = {},
): MetricsV2CatalogEntry {
  return {
    key: overrides.key ?? 'metric-key',
    label: overrides.label ?? 'Metric label',
    description: overrides.description ?? null,
    unit: overrides.unit ?? 'L',
    dataType: overrides.dataType ?? 'numeric',
    bucket: overrides.bucket ?? 'bucket',
    measurement: overrides.measurement ?? 'measurement',
    field: overrides.field ?? 'field',
    latestValue: overrides.latestValue ?? 100,
    valueUpdatedAt: overrides.valueUpdatedAt ?? new Date('2026-04-17T12:00:00Z'),
    searchText:
      overrides.searchText ??
      `${overrides.key ?? 'metric-key'} ${overrides.label ?? 'Metric label'}`.toLowerCase(),
    operationalMeaning:
      overrides.operationalMeaning ?? 'Synthetic semantic meaning for testing.',
    semanticSummary:
      overrides.semanticSummary ?? 'Synthetic semantic summary for testing.',
    businessConcept: overrides.businessConcept ?? 'unknown',
    measurementKind: overrides.measurementKind ?? 'unknown',
    systemDomain: overrides.systemDomain ?? null,
    measuredSubject: overrides.measuredSubject ?? null,
    signalRole: overrides.signalRole ?? null,
    motionReference: overrides.motionReference ?? null,
    unitKind: overrides.unitKind ?? 'unknown',
    fluidType: overrides.fluidType ?? null,
    assetType: overrides.assetType ?? null,
    groupFamily: overrides.groupFamily ?? null,
    aggregationCompatibility:
      overrides.aggregationCompatibility ?? ['latest_point'],
    semanticConfidence: overrides.semanticConfidence ?? 0.8,
    inferredGroupKey: overrides.inferredGroupKey ?? null,
    groupMemberKey: overrides.groupMemberKey ?? null,
  };
}
