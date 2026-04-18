import {
  inferMetricsV2AggregationCompatibility,
  inferMetricsV2BusinessConcept,
  inferMetricsV2GroupFamily,
  inferMetricsV2MeasuredSubject,
  inferMetricsV2MotionReference,
  inferMetricsV2OperationalMeaning,
  inferMetricsV2SignalRole,
  inferMetricsV2SystemDomain,
  inferMetricsV2UnitKind,
  inferPlanBusinessConcept,
  isMetricsV2BusinessConceptCompatible,
  isMetricsV2StrictInventoryRequest,
} from '../../../src/metrics-v2/semantic';

describe('metrics-v2 semantic utils', () => {
  it('classifies fuel tank inventory members by meaning instead of the word tank alone', () => {
    const searchText =
      'Fuel_Tank_1P Fuel Oil level reading for the Fuel Tank 1P. current fuel oil level inside the Fuel Tank 1P. liters equipment fuel storage tank';
    const unitKind = inferMetricsV2UnitKind({ searchText, unit: 'Liters' });
    const businessConcept = inferMetricsV2BusinessConcept({
      searchText,
      measurementKind: 'level',
      fluidType: 'fuel',
      assetType: 'storage_tank',
      unitKind,
    });

    expect(unitKind).toBe('volume');
    expect(businessConcept).toBe('fuel_tank_inventory_member');
    expect(inferMetricsV2GroupFamily(businessConcept)).toBe(
      'fuel_storage_tanks_onboard',
    );
    expect(
      inferMetricsV2AggregationCompatibility({
        businessConcept,
        measurementKind: 'level',
        unitKind,
      }),
    ).toContain('sum_total_onboard');
  });

  it('does not confuse ordinal wording like second starboard tank with runtime seconds', () => {
    const searchText =
      'Fuel_Tank_2S Fuel Oil level reading for the second starboard fuel tank. current Fuel Oil level inside Fuel Tank 2S. litres equipment fuel storage tank';
    const unitKind = inferMetricsV2UnitKind({ searchText, unit: null });
    const businessConcept = inferMetricsV2BusinessConcept({
      searchText,
      measurementKind: 'level',
      fluidType: 'fuel',
      assetType: 'storage_tank',
      unitKind,
    });

    expect(unitKind).toBe('volume');
    expect(businessConcept).toBe('fuel_tank_inventory_member');
    expect(
      inferMetricsV2AggregationCompatibility({
        businessConcept,
        measurementKind: 'level',
        unitKind,
      }),
    ).toContain('sum_total_onboard');
  });

  it('keeps tank pump energy outside onboard fuel inventory concepts', () => {
    const searchText =
      'PORT-AFT-GARAGE-SCUPPER-TANK-PUMP Partial active energy delivered + received pump energy';
    const unitKind = inferMetricsV2UnitKind({ searchText, unit: 'kWh' });
    const businessConcept = inferMetricsV2BusinessConcept({
      searchText,
      measurementKind: 'energy',
      fluidType: null,
      assetType: 'pump',
      unitKind,
    });

    expect(unitKind).toBe('energy');
    expect(businessConcept).toBe('pump_energy_usage');
    expect(
      inferMetricsV2OperationalMeaning({
        businessConcept,
        measurementKind: 'energy',
        assetType: 'pump',
        fluidType: null,
        label: 'Scupper tank pump energy',
      }),
    ).toContain('not onboard tank inventory');
  });

  it('maps grouped fuel onboard queries to a canonical business concept', () => {
    const businessConcept = inferPlanBusinessConcept({
      rawBusinessConcept: 'unknown',
      concept: 'fuel onboard total',
      measurementKind: 'volume',
      fluidType: 'fuel',
      assetType: 'storage_tank',
      groupTarget: 'storage_tanks',
      shape: 'group',
      hints: ['fuel onboard', 'all fuel tanks'],
    });

    expect(businessConcept).toBe('fuel_onboard_inventory');
    expect(
      isMetricsV2BusinessConceptCompatible({
        planBusinessConcept: 'fuel_onboard_inventory',
        entryBusinessConcept: 'fuel_tank_inventory_member',
      }),
    ).toBe(true);
    expect(
      isMetricsV2StrictInventoryRequest({
        requestId: 'fuel_onboard',
        source: 'current',
        shape: 'group',
        presentation: 'breakdown_with_total',
        concept: 'fuel onboard total',
        businessConcept,
        measurementKind: 'volume',
        fluidType: 'fuel',
        assetType: 'storage_tank',
        groupTarget: 'storage_tanks',
        entityHints: ['fuel onboard'],
        metricHints: ['fuel level'],
        aggregation: 'sum',
        timeRange: { kind: 'current' },
      }),
    ).toBe(true);
  });

  it('separates vessel speed from HVAC fan speed by measured subject', () => {
    const vesselSearchText =
      'NMEA navigation.speedOverGround value vessel speed over ground SOG GPS knots';
    const fanSearchText =
      'Trending HVAC-Guest-Port-Aft Fan Speed rotational speed of the HVAC fan';

    const vesselSystemDomain = inferMetricsV2SystemDomain(vesselSearchText);
    const vesselMeasuredSubject = inferMetricsV2MeasuredSubject({
      searchText: vesselSearchText,
      measurementKind: 'speed',
      systemDomain: vesselSystemDomain,
      fluidType: null,
      assetType: 'navigation',
    });
    const vesselBusinessConcept = inferMetricsV2BusinessConcept({
      searchText: vesselSearchText,
      measurementKind: 'speed',
      systemDomain: vesselSystemDomain,
      measuredSubject: vesselMeasuredSubject,
      fluidType: null,
      assetType: 'navigation',
      unitKind: 'speed',
    });
    const vesselMotionReference = inferMetricsV2MotionReference({
      searchText: vesselSearchText,
      businessConcept: vesselBusinessConcept,
      measurementKind: 'speed',
      systemDomain: vesselSystemDomain,
      measuredSubject: vesselMeasuredSubject,
      signalRole: 'primary_vessel_telemetry',
    });

    const fanSystemDomain = inferMetricsV2SystemDomain(fanSearchText);
    const fanMeasuredSubject = inferMetricsV2MeasuredSubject({
      searchText: fanSearchText,
      measurementKind: 'speed',
      systemDomain: fanSystemDomain,
      fluidType: null,
      assetType: null,
    });
    const fanBusinessConcept = inferMetricsV2BusinessConcept({
      searchText: fanSearchText,
      measurementKind: 'speed',
      systemDomain: fanSystemDomain,
      measuredSubject: fanMeasuredSubject,
      fluidType: null,
      assetType: null,
      unitKind: 'speed',
    });
    const fanMotionReference = inferMetricsV2MotionReference({
      searchText: fanSearchText,
      businessConcept: fanBusinessConcept,
      measurementKind: 'speed',
      systemDomain: fanSystemDomain,
      measuredSubject: fanMeasuredSubject,
      signalRole: 'component_internal_state',
    });

    expect(vesselSystemDomain).toBe('navigation');
    expect(vesselMeasuredSubject).toBe('vessel_motion');
    expect(vesselBusinessConcept).toBe('vessel_speed');
    expect(vesselMotionReference).toBe('over_ground');
    expect(
      inferMetricsV2SignalRole({
        businessConcept: vesselBusinessConcept,
        measurementKind: 'speed',
        systemDomain: vesselSystemDomain,
        measuredSubject: vesselMeasuredSubject,
      }),
    ).toBe('primary_vessel_telemetry');

    expect(fanSystemDomain).toBe('hvac');
    expect(fanMeasuredSubject).toBe('fan_rotation');
    expect(fanBusinessConcept).toBe('component_speed');
    expect(fanMotionReference).toBe('component_internal');
    expect(
      inferMetricsV2SignalRole({
        businessConcept: fanBusinessConcept,
        measurementKind: 'speed',
        systemDomain: fanSystemDomain,
        measuredSubject: fanMeasuredSubject,
      }),
    ).toBe('component_internal_state');
  });

  it('keeps wind speed over ground outside vessel speed', () => {
    const searchText =
      'NMEA environment.wind.speedOverGround value current wind speed over ground not relative to the vessel';
    const systemDomain = inferMetricsV2SystemDomain(searchText);
    const measuredSubject = inferMetricsV2MeasuredSubject({
      searchText,
      measurementKind: 'speed',
      systemDomain,
      fluidType: null,
      assetType: 'navigation',
    });
    const businessConcept = inferMetricsV2BusinessConcept({
      searchText,
      measurementKind: 'speed',
      systemDomain,
      measuredSubject,
      fluidType: null,
      assetType: 'navigation',
      unitKind: 'speed',
    });

    expect(systemDomain).toBe('environment');
    expect(measuredSubject).toBe('wind');
    expect(businessConcept).toBe('environmental_speed');
    expect(
      inferMetricsV2MotionReference({
        searchText,
        businessConcept,
        measurementKind: 'speed',
        systemDomain,
        measuredSubject,
        signalRole: 'environmental_condition',
      }),
    ).toBe('ambient_flow');
  });

  it('distinguishes through-water speed from over-ground speed', () => {
    const throughWaterSearchText =
      'NMEA navigation.speedThroughWater value vessel speed through water STW knots';
    const overGroundSearchText =
      'NMEA navigation.speedOverGround value vessel speed over ground SOG knots';

    expect(
      inferMetricsV2MotionReference({
        searchText: throughWaterSearchText,
        businessConcept: 'vessel_speed',
        measurementKind: 'speed',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_motion',
        signalRole: 'primary_vessel_telemetry',
      }),
    ).toBe('through_water');

    expect(
      inferMetricsV2MotionReference({
        searchText: overGroundSearchText,
        businessConcept: 'vessel_speed',
        measurementKind: 'speed',
        systemDomain: 'navigation',
        measuredSubject: 'vessel_motion',
        signalRole: 'primary_vessel_telemetry',
      }),
    ).toBe('over_ground');
  });
});
