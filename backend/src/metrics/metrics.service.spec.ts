import { MetricsService } from './metrics.service';

describe('MetricsService telemetry matching', () => {
  const buildService = (configs: unknown[]) => {
    const prisma = {
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue(configs),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    return new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );
  };

  it('returns only the closest telemetry matches for an exact metric field query', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_4S',
        latestValue: 18.2,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_4S',
          description:
            'Displays the temperature of Fuel Tank 4S in trending data.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_4S',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_3P',
        latestValue: 19.1,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_3P',
          description: 'Displays the temperature of Fuel Tank 3P in real-time.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_3P',
        },
      },
      {
        metricKey: 'NMEA::environment::depth.belowKeel',
        latestValue: 4.8,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'environment.depth.belowKeel',
          description: 'Measures the depth below the keel in meters.',
          unit: 'm',
          bucket: 'NMEA',
          measurement: 'environment',
          field: 'depth.belowKeel',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Fuel_Tank_4S',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('exact');
    expect(result.totalActiveMetrics).toBe(3);
    expect(Object.keys(result.telemetry)).toHaveLength(1);
    expect(Object.keys(result.telemetry)[0]).toContain('Fuel Tank 4S');
    expect(Object.values(result.telemetry)[0]).toBe(18.2);
  });

  it('uses only the first rich description line in telemetry labels', async () => {
    const service = buildService([
      {
        metricKey: 'NMEA::performance::velocityMadeGood',
        latestValue: 12.6,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'performance.velocityMadeGood.value',
          description:
            'Velocity Made Good (VMG) is a standard marine navigation metric defined by the NMEA specification.\n' +
            "What it measures: The vessel's effective speed toward the active waypoint.\n" +
            'Unit: Knots (kn)',
          unit: null,
          bucket: 'NMEA',
          measurement: 'performance.velocityMadeGood',
          field: 'value',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'velocity made good',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    const [telemetryLabel] = Object.keys(result.telemetry);
    expect(telemetryLabel).toContain(
      'Velocity Made Good (VMG) is a standard marine navigation metric defined by the NMEA specification.',
    );
    expect(telemetryLabel).not.toContain('What it measures:');
    expect(telemetryLabel).not.toContain('Unit: Knots (kn)');
  });

  it('matches current level questions by description terms instead of returning the whole telemetry dump', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks::Fuel_Level',
        latestValue: 63,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks.Fuel_Level',
          description: 'Displays the current fuel level percentage.',
          unit: '%',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel_Level',
        },
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        metricKey: `Trending::Misc::Signal_${index}`,
        latestValue: index,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Misc.Signal_${index}`,
          description: `Unrelated signal ${index}.`,
          unit: null,
          bucket: 'Trending',
          measurement: 'Misc',
          field: `Signal_${index}`,
        },
      })),
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'what the current fuel level?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('exact');
    expect(Object.keys(result.telemetry)).toHaveLength(1);
    expect(Object.keys(result.telemetry)[0]).toContain('Fuel_Level');
    expect(Object.values(result.telemetry)[0]).toBe(63);
  });

  it('returns a bounded telemetry sample for active metric list requests', async () => {
    const service = buildService(
      Array.from({ length: 30 }, (_, index) => ({
        metricKey: `Trending::Misc::Signal_${index}`,
        latestValue: index,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Misc.Signal_${index}`,
          description: `Sample telemetry signal ${index}.`,
          unit: null,
          bucket: 'Trending',
          measurement: 'Misc',
          field: `Signal_${index}`,
        },
      })),
    );

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Show 10 random active metrics for this ship.',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('sample');
    expect(result.totalActiveMetrics).toBe(30);
    expect(Object.keys(result.telemetry)).toHaveLength(10);
  });

  it('returns the full matched telemetry inventory by default for generic metric list requests', async () => {
    const service = buildService([
      ...Array.from({ length: 18 }, (_, index) => ({
        metricKey: `Trending::Bilge-Alarms::BILGE ALARM ${index + 1}`,
        latestValue: 0,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Bilge-Alarms.BILGE ALARM ${index + 1}`,
          description: `Status indicator for bilge alarm ${index + 1}.`,
          unit: null,
          bucket: 'Trending',
          measurement: 'Bilge-Alarms',
          field: `BILGE ALARM ${index + 1}`,
        },
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        metricKey: `Trending::Bilge-Alarms2::BILGE ALARM ${index + 19}`,
        latestValue: 0,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Bilge-Alarms2.BILGE ALARM ${index + 19}`,
          description: `Status indicator for bilge alarm ${index + 19}.`,
          unit: null,
          bucket: 'Trending',
          measurement: 'Bilge-Alarms2',
          field: `BILGE ALARM ${index + 19}`,
        },
      })),
      {
        metricKey: 'NMEA::navigation.position::lat',
        latestValue: 43.55,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.position.lat',
          description: 'Current vessel latitude.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lat',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'List of bilge alarm metrics',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.matchedMetrics).toBe(22);
    expect(Object.keys(result.telemetry)).toHaveLength(22);
    expect(
      Object.keys(result.telemetry).every((key) => /bilge alarm/i.test(key)),
    ).toBe(true);
  });

  it('filters telemetry list requests to the requested subject before sampling', async () => {
    const service = buildService([
      ...Array.from({ length: 8 }, (_, index) => ({
        metricKey: `Trending::Tanks-Temperatures::Fuel_Tank_${index + 1}`,
        latestValue: index + 1,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Tanks-Temperatures.Fuel_Tank_${index + 1}`,
          description: `Displays the temperature of Fuel Tank ${index + 1}.`,
          unit: 'C',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: `Fuel_Tank_${index + 1}`,
        },
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        metricKey: `Trending::Misc::Signal_${index}`,
        latestValue: index,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Misc.Signal_${index}`,
          description: `Unrelated signal ${index}.`,
          unit: null,
          bucket: 'Trending',
          measurement: 'Misc',
          field: `Signal_${index}`,
        },
      })),
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'List 5 current active metrics related to fuel tanks.',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('sample');
    expect(Object.keys(result.telemetry)).toHaveLength(5);
    expect(
      Object.keys(result.telemetry).every((key) => /fuel tank/i.test(key)),
    ).toBe(true);
  });

  it('returns the full matched telemetry set for explicit all-available metric inventory requests', async () => {
    const service = buildService([
      ...Array.from({ length: 18 }, (_, index) => ({
        metricKey: `Trending::Bilge-Alarms::BILGE ALARM ${index + 1}`,
        latestValue: 0,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: `Bilge-Alarms.BILGE ALARM ${index + 1}`,
          description: `Status indicator for bilge alarm ${index + 1}.`,
          unit: null,
          bucket: 'Trending',
          measurement: 'Bilge-Alarms',
          field: `BILGE ALARM ${index + 1}`,
        },
      })),
      {
        metricKey: 'Trending::mem::available',
        latestValue: 3981205504,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'mem.available',
          description: 'Available system memory.',
          unit: 'bytes',
          bucket: 'Trending',
          measurement: 'mem',
          field: 'available',
        },
      },
      {
        metricKey: 'NMEA::navigation.position::lat',
        latestValue: 43.55,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.position.lat',
          description: 'Current vessel latitude.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lat',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'List all available bilge alarm metrics',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.matchedMetrics).toBe(18);
    expect(Object.keys(result.telemetry)).toHaveLength(18);
    expect(
      Object.keys(result.telemetry).every((key) => /bilge alarm/i.test(key)),
    ).toBe(true);
  });

  it('prioritizes direct battery voltage telemetry over generic voltage metrics', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Battery voltage (V)',
        latestValue: 26.3,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Battery voltage (V)',
          description:
            'Displays the battery voltage level for the SIEMENS MASE genset.',
          unit: 'V',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Battery voltage (V)',
        },
      },
      {
        metricKey:
          'Trending::DIESEL-MOTOR-PUMP-BATTERY-CHARGER::Active power on phase A',
        latestValue: 130,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'DIESEL-MOTOR-PUMP-BATTERY-CHARGER.Active power on phase A',
          description:
            'Displays the active power on phase A in the battery charger.',
          unit: 'W',
          bucket: 'Trending',
          measurement: 'DIESEL-MOTOR-PUMP-BATTERY-CHARGER',
          field: 'Active power on phase A',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Based on the current battery voltage, is any action recommended?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(Object.keys(result.telemetry).length).toBeGreaterThan(0);
    expect(Object.keys(result.telemetry)[0]).toContain('Battery voltage');
    expect(Object.values(result.telemetry)[0]).toBe(26.3);
    expect(result.clarification).toBeNull();
  });

  it('keeps generator telemetry list samples scoped to generator and genset metrics', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Battery voltage (V)',
        latestValue: 26.3,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Battery voltage (V)',
          description:
            'Displays the battery voltage level for the SIEMENS MASE genset.',
          unit: 'V',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Battery voltage (V)',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-SB::Oil temperature',
        latestValue: 32,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-SB.Oil temperature',
          description: 'Displays the oil temperature of the starboard genset.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-SB',
          field: 'Oil temperature',
        },
      },
      {
        metricKey: 'NMEA::navigation::rateOfTurn.value',
        latestValue: 0.001,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.rateOfTurn.value',
          description: 'Displays the vessel rate of turn value.',
          unit: 'rad/s',
          bucket: 'NMEA',
          measurement: 'navigation',
          field: 'rateOfTurn.value',
        },
      },
      {
        metricKey: 'NMEA::environment::depth.belowKeel',
        latestValue: 4.8,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'environment.depth.belowKeel',
          description: 'Measures the depth below the keel in meters.',
          unit: 'm',
          bucket: 'NMEA',
          measurement: 'environment',
          field: 'depth.belowKeel',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Show 10 active metrics related to generators with their latest values.',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('sample');
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).every((key) =>
        /GENSET|generator/i.test(key),
      ),
    ).toBe(true);
  });

  it('marks supporting telemetry as related when no direct measurement kind matches the query', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Oil Pressure',
        latestValue: 0,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Oil Pressure',
          description: 'Displays the oil pressure of the port genset.',
          unit: 'bar',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Oil Pressure',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Oil temperature',
        latestValue: 15,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Oil temperature',
          description: 'Displays the oil temperature of the port genset.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Oil temperature',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'oil level from telemetry',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('related');
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(result.clarification).not.toBeNull();
    expect(result.clarification?.pendingQuery).toBe(
      'What is the current value of',
    );
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Oil Pressure'),
      ),
    ).toBe(true);
  });

  it('prefers the captain cabin room temperature over captain cabin electrical metrics', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::CAPTAIN-CABIN::Active power on phase A',
        latestValue: 174,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'CAPTAIN-CABIN.Active power on phase A',
          description:
            "Displays the active power consumption on phase A in the captain's cabin.",
          unit: 'W',
          bucket: 'Trending',
          measurement: 'CAPTAIN-CABIN',
          field: 'Active power on phase A',
        },
      },
      {
        metricKey: 'Trending::CAPTAIN-CABIN::RMS phase to neutral Voltage A-N',
        latestValue: 226.8,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'CAPTAIN-CABIN.RMS phase to neutral Voltage A-N',
          description:
            "Displays the RMS phase to neutral voltage for the captain's cabin.",
          unit: 'V',
          bucket: 'Trending',
          measurement: 'CAPTAIN-CABIN',
          field: 'RMS phase to neutral Voltage A-N',
        },
      },
      {
        metricKey: 'Trending::HVAC-Captain::Room Temperature',
        latestValue: 16.8,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'HVAC-Captain.Room Temperature',
          description: 'This is the Captains cabin room temperature (temp).',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'HVAC-Captain',
          field: 'Room Temperature',
        },
      },
      {
        metricKey: 'Trending::HVAC-Guest-STBD-Aft::Room Temperature',
        latestValue: 18,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'HVAC-Guest-STBD-Aft.Room Temperature',
          description:
            'Displays the current room temperature in the guest cabin on the starboard aft side.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'HVAC-Guest-STBD-Aft',
          field: 'Room Temperature',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      "What is the current temperature in the captain's cabin?",
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(Object.keys(result.telemetry)).toHaveLength(1);
    expect(Object.keys(result.telemetry)[0]).toContain('Room Temperature');
    expect(Object.values(result.telemetry)[0]).toBe(16.8);
    expect(result.clarification).toBeNull();
  });

  it('does not treat genset or engine-room temperature as a direct starboard engine coolant reading', async () => {
    const fillerEntries = Array.from({ length: 24 }, (_, index) => ({
      metricKey: `Trending::HVAC-Guest-${index}::Room Temperature`,
      latestValue: 20 + index,
      valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
      metric: {
        label: `HVAC-Guest-${index}.Room Temperature`,
        description: `Displays the guest cabin room temperature for zone ${index}.`,
        unit: 'C',
        bucket: 'Trending',
        measurement: `HVAC-Guest-${index}`,
        field: 'Room Temperature',
      },
    }));

    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-SB::Coolant Temperature (°C)',
        latestValue: 36,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-SB.Coolant Temperature (°C)',
          description:
            'Displays the coolant temperature in degrees Celsius for the starboard genset.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-SB',
          field: 'Coolant Temperature (°C)',
        },
      },
      {
        metricKey: 'Trending::Temperatures::STBD ENGINE ROOM TEMPERATURE',
        latestValue: 26,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Temperatures.STBD ENGINE ROOM TEMPERATURE',
          description: 'Temperature reading from the starboard engine room.',
          unit: 'C',
          bucket: 'Trending',
          measurement: 'Temperatures',
          field: 'STBD ENGINE ROOM TEMPERATURE',
        },
      },
      ...fillerEntries,
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'What is the current starboard engine coolant temperature?',
    );

    expect(result.prefiltered).toBe(false);
    expect(result.matchMode).toBe('none');
    expect(result.matchedMetrics).toBe(0);
    expect(result.telemetry).toEqual({});
  });

  it('does not treat DEF tank level as a direct fuel level reading', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::DEF Tank level (%)',
        latestValue: 99,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.DEF Tank level (%)',
          description:
            'Displays the percentage level of the DEF tank in the SIEMENS MASE genset.',
          unit: '%',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'DEF Tank level (%)',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Diesel Fuel Rate (l/h)',
        latestValue: 0,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
          description:
            'Monitors the diesel fuel consumption rate of the SIEMENS MASE genset in liters per hour.',
          unit: 'l/h',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Diesel Fuel Rate (l/h)',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Fuel Pressure (bar)',
        latestValue: 0,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Fuel Pressure (bar)',
          description:
            'Displays the fuel pressure in bars for the SIEMENS MASE genset.',
          unit: 'bar',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Fuel Pressure (bar)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'What is the current fuel level?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('related');
    expect(
      Object.keys(result.telemetry).every(
        (key) => !key.includes('DEF Tank level'),
      ),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) =>
        key.includes('Fuel Pressure'),
      ),
    ).toBe(true);
    expect(result.clarification).not.toBeNull();
    expect(result.clarification?.pendingQuery).toBe(
      'What is the current value of',
    );
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Fuel Pressure'),
      ),
    ).toBe(true);
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Diesel Fuel Rate'),
      ),
    ).toBe(true);
  });

  it('treats onboard fuel quantity questions as related fuel level lookups instead of direct matches', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Diesel Fuel Rate (l/h)',
        latestValue: 61.4,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
          description:
            'Monitors the diesel fuel consumption rate of the port genset in liters per hour.',
          unit: 'l/h',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Diesel Fuel Rate (l/h)',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Fuel Pressure (bar)',
        latestValue: 0.34,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Fuel Pressure (bar)',
          description:
            'Displays the fuel pressure in bars for the port genset.',
          unit: 'bar',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Fuel Pressure (bar)',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
        latestValue: 34150,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Total Fuel Used (l)',
          description:
            'Displays the total fuel used by the port genset in liters.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Total Fuel Used (l)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'How much fuel is onboard right now?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('related');
    expect(result.clarification).not.toBeNull();
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Fuel Pressure'),
      ),
    ).toBe(true);
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Diesel Fuel Rate'),
      ),
    ).toBe(true);
  });

  it('uses direct fuel tank readings for onboard fuel total questions when tank quantities are available', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_1P',
          description: 'Displays the volume of Fuel Tank 1P in liters.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_1P',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
        latestValue: 2374,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_2S',
          description: 'Displays the volume of Fuel Tank 2S in liters.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_2S',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Diesel Fuel Rate (l/h)',
        latestValue: 61.4,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
          description:
            'Monitors the diesel fuel consumption rate of the port genset in liters per hour.',
          unit: 'l/h',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Diesel Fuel Rate (l/h)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Calculate how many fuel onboard according to all fuel tanks',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.clarification).toBeNull();
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).every((key) => /fuel tank/i.test(key)),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('Fuel Tank 1P')),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('Fuel Tank 2S')),
    ).toBe(true);
  });

  it('treats onboard fuel quantity questions as direct tank lookups when volume-based tank readings exist', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_1P',
          description: 'Displays the volume of Fuel Tank 1P in trending data.',
          unit: 'L',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_1P',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
        latestValue: 2374,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_2S',
          description: 'Displays the volume of Fuel Tank 2S in trending data.',
          unit: 'L',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_2S',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
        latestValue: 34150,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Total Fuel Used (l)',
          description:
            'Displays the total fuel used by the port genset in liters.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Total Fuel Used (l)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'How many fuel onboard?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.clarification).toBeNull();
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).every((key) => /fuel tank/i.test(key)),
    ).toBe(true);
  });

  it('treats dedicated fuel tank identifiers as direct storage readings even when metadata is noisy', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-22T11:16:45.223Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_1P',
          description:
            'Displays the temperature of Fuel Tank 1P in trending data.',
          unit: null,
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_1P',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
        latestValue: 2381,
        valueUpdatedAt: new Date('2026-03-22T11:16:45.223Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel_Tank_2S',
          description:
            'Displays the temperature of Fuel Tank 2S in trending data.',
          unit: null,
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_2S',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
        latestValue: 85,
        valueUpdatedAt: new Date('2026-03-22T11:16:45.223Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Total Fuel Used (l)',
          description: 'Shows total fuel used by the port genset.',
          unit: null,
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Total Fuel Used (l)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'calculate how many fuel onboard according to all fuel tanks',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.clarification).toBeNull();
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).every((key) => /fuel tank/i.test(key)),
    ).toBe(true);

    const shortResult = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'How many fuel onboard?',
    );

    expect(shortResult.prefiltered).toBe(true);
    expect(shortResult.matchMode).toBe('direct');
    expect(shortResult.clarification).toBeNull();
    expect(Object.keys(shortResult.telemetry)).toHaveLength(2);
    expect(
      Object.keys(shortResult.telemetry).every(
        (key) => !/temperature/i.test(key),
      ),
    ).toBe(true);
  });

  it('returns latitude and longitude telemetry for vessel location questions', async () => {
    const service = buildService([
      {
        metricKey: 'NMEA::navigation::latitude',
        latestValue: 43.53606,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.latitude',
          description: 'Current vessel latitude in decimal degrees.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation',
          field: 'latitude',
        },
      },
      {
        metricKey: 'NMEA::navigation::longitude',
        latestValue: 7.006816666666666,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.longitude',
          description: 'Current vessel longitude in decimal degrees.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation',
          field: 'longitude',
        },
      },
      {
        metricKey: 'Trending::Electrical::Battery voltage (V)',
        latestValue: 26.3,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Electrical.Battery voltage (V)',
          description: 'Current battery voltage.',
          unit: 'V',
          bucket: 'Trending',
          measurement: 'Electrical',
          field: 'Battery voltage (V)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'What is the yacht location?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.clarification).toBeNull();
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('latitude')),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('longitude')),
    ).toBe(true);
  });

  it('treats bare where-is-the-yacht questions as location telemetry queries', async () => {
    const service = buildService([
      {
        metricKey: 'NMEA::navigation.position::lat',
        latestValue: 43.55,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.position.lat',
          description: 'Current vessel latitude in decimal degrees.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lat',
        },
      },
      {
        metricKey: 'NMEA::navigation.position::lon',
        latestValue: 7.02,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.position.lon',
          description: 'Current vessel longitude in decimal degrees.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lon',
        },
      },
      {
        metricKey: 'Trending::Electrical::Battery voltage (V)',
        latestValue: 26.3,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Electrical.Battery voltage (V)',
          description: 'Current battery voltage.',
          unit: 'V',
          bucket: 'Trending',
          measurement: 'Electrical',
          field: 'Battery voltage (V)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Where is the yacht now?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(result.clarification).toBeNull();
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('lat')),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('lon')),
    ).toBe(true);
  });

  it('keeps location context from hijacking the primary telemetry subject in mixed queries', async () => {
    const service = buildService([
      {
        metricKey: 'NMEA::navigation.position::lat',
        latestValue: 43.55,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.position.lat',
          description: 'Current vessel latitude in decimal degrees.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lat',
        },
      },
      {
        metricKey: 'NMEA::navigation.position::lon',
        latestValue: 7.02,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'navigation.position.lon',
          description: 'Current vessel longitude in decimal degrees.',
          unit: 'deg',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lon',
        },
      },
      {
        metricKey: 'NMEA::environment.wind::speedApparent.value',
        latestValue: 1.44,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'environment.wind.speedApparent.value',
          description: 'Current apparent wind speed.',
          unit: 'kn',
          bucket: 'NMEA',
          measurement: 'environment.wind',
          field: 'speedApparent.value',
        },
      },
      {
        metricKey: 'NMEA::environment.wind::speedTrue.value',
        latestValue: 2.87,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'environment.wind.speedTrue.value',
          description: 'Current true wind speed.',
          unit: 'kn',
          bucket: 'NMEA',
          measurement: 'environment.wind',
          field: 'speedTrue.value',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'What is the wind speed right now at yacht location?',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('direct');
    expect(Object.keys(result.telemetry)).toHaveLength(2);
    expect(
      Object.keys(result.telemetry).every((key) => /wind/i.test(key)),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) => /lat|lon/i.test(key)),
    ).toBe(false);
  });

  it.each([
    {
      query: 'What is the current fuel status?',
      expectedActionLabel: 'Fuel Pressure',
    },
    {
      query: 'What is the current oil status?',
      expectedActionLabel: 'Oil Pressure',
    },
    {
      query: 'What is the current battery status?',
      expectedActionLabel: 'Battery voltage',
    },
  ])(
    'treats broad status queries as related telemetry lookups: $query',
    async ({ query, expectedActionLabel }) => {
      const service = buildService([
        {
          metricKey: 'HVAC::AFT-GARAGE-HVAC::Status',
          latestValue: 'Running',
          valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
          metric: {
            label: 'AFT-GARAGE-HVAC.Status',
            description: 'Reports the operating status of the aft garage HVAC.',
            unit: null,
            bucket: 'HVAC',
            measurement: 'AFT-GARAGE-HVAC',
            field: 'Status',
          },
        },
        {
          metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Diesel Fuel Rate (l/h)',
          latestValue: 61.4,
          valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
          metric: {
            label: 'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
            description:
              'Monitors the diesel fuel consumption rate of the port genset in liters per hour.',
            unit: 'l/h',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Diesel Fuel Rate (l/h)',
          },
        },
        {
          metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Fuel Pressure (bar)',
          latestValue: 0.34,
          valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
          metric: {
            label: 'SIEMENS-MASE-GENSET-PS.Fuel Pressure (bar)',
            description:
              'Displays the fuel pressure in bars for the port genset.',
            unit: 'bar',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Fuel Pressure (bar)',
          },
        },
        {
          metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Oil Pressure (bar)',
          latestValue: 4.2,
          valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
          metric: {
            label: 'SIEMENS-MASE-GENSET-PS.Oil Pressure (bar)',
            description:
              'Displays the oil pressure in bars for the port genset.',
            unit: 'bar',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Oil Pressure (bar)',
          },
        },
        {
          metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Oil temperature (°C)',
          latestValue: 82.1,
          valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
          metric: {
            label: 'SIEMENS-MASE-GENSET-PS.Oil temperature (°C)',
            description:
              'Displays the oil temperature in degrees Celsius for the port genset.',
            unit: '°C',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Oil temperature (°C)',
          },
        },
        {
          metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Battery voltage (V)',
          latestValue: 26.3,
          valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
          metric: {
            label: 'SIEMENS-MASE-GENSET-PS.Battery voltage (V)',
            description:
              'Displays the battery voltage level for the port genset.',
            unit: 'V',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Battery voltage (V)',
          },
        },
      ]);

      const result = await service.getShipTelemetryContextForQuery(
        'ship-1',
        query,
      );

      expect(result.prefiltered).toBe(true);
      expect(result.matchMode).toBe('related');
      expect(result.clarification).not.toBeNull();
      expect(result.clarification?.pendingQuery).toBe(
        'What is the current value of',
      );
      expect(
        Object.keys(result.telemetry).every((key) => !key.includes('.Status')),
      ).toBe(true);
      expect(
        result.clarification?.actions.some((action) =>
          action.label.includes(expectedActionLabel),
        ),
      ).toBe(true);
    },
  );

  it('forces clarification for broad tank level queries when multiple tank readings match', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel Tank 1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel Tank 1P',
          description: 'Fuel tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel Tank 1P',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel Tank 1S',
        latestValue: 3188,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel Tank 1S',
          description: 'Fuel tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel Tank 1S',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fresh Water Tank 1',
        latestValue: 870,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fresh Water Tank 1',
          description: 'Fresh water tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fresh Water Tank 1',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'what the current tank level',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('related');
    expect(result.clarification?.question).toContain(
      'multiple current tank readings',
    );
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Fuel Tank 1P'),
      ),
    ).toBe(true);
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Fuel Tank 1S'),
      ),
    ).toBe(true);
  });

  it('forces clarification for generic tank level queries even when only one candidate explicitly says level', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::DEF Tank level (%)',
        latestValue: 99,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.DEF Tank level (%)',
          description: 'Displays the DEF tank level percentage.',
          unit: '%',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'DEF Tank level (%)',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel Tank 1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel Tank 1P',
          description: 'Fuel tank quantity in liters.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel Tank 1P',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::FRESH WATER TANK 10S LITERS',
        latestValue: 870,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.FRESH WATER TANK 10S LITERS',
          description: 'Fresh water tank quantity in liters.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'FRESH WATER TANK 10S LITERS',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'what the current tank level',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('related');
    expect(result.clarification?.question).toContain(
      'multiple current tank readings',
    );
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('DEF Tank level'),
      ),
    ).toBe(true);
    expect(
      result.clarification?.actions.some((action) =>
        action.label.includes('Fuel Tank 1P'),
      ),
    ).toBe(true);
  });

  it('forces clarification for generic water tank level queries when multiple water tanks match', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fresh Water Tank 1',
        latestValue: 870,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fresh Water Tank 1',
          description: 'Fresh water tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fresh Water Tank 1',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fresh Water Tank 2',
        latestValue: 910,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fresh Water Tank 2',
          description: 'Fresh water tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fresh Water Tank 2',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel Tank 1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel Tank 1P',
          description: 'Fuel tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel Tank 1P',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'what is the water tank level',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('related');
    expect(result.clarification?.question).toContain(
      'multiple current tank readings',
    );
    expect(
      Object.keys(result.telemetry).every((key) => key.includes('Water Tank')),
    ).toBe(true);
  });

  it('keeps exact tank queries on the direct path', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel Tank 1P',
        latestValue: 3142,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel Tank 1P',
          description: 'Fuel tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel Tank 1P',
        },
      },
      {
        metricKey: 'Trending::Tanks-Temperatures::Fuel Tank 1S',
        latestValue: 3188,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'Tanks-Temperatures.Fuel Tank 1S',
          description: 'Fuel tank level reading.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel Tank 1S',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'what is fuel tank 1p level',
    );

    expect(result.prefiltered).toBe(true);
    expect(result.matchMode).toBe('exact');
    expect(result.clarification).toBeNull();
    expect(Object.keys(result.telemetry)).toHaveLength(1);
    expect(Object.keys(result.telemetry)[0]).toContain('Fuel Tank 1P');
  });

  it('uses action-oriented clarification prompts for recommendation queries without a direct metric', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Fuel Pressure (bar)',
        latestValue: 0.34,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Fuel Pressure (bar)',
          description:
            'Displays the fuel pressure in bars for the port genset.',
          unit: 'bar',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Fuel Pressure (bar)',
        },
      },
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
        latestValue: 34150,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Total Fuel Used (l)',
          description:
            'Displays the total fuel consumption in liters for the port genset.',
          unit: 'l',
          bucket: 'Trending',
          measurement: 'SIEMENS-MASE-GENSET-PS',
          field: 'Total Fuel Used (l)',
        },
      },
    ]);

    const result = await service.getShipTelemetryContextForQuery(
      'ship-1',
      'Based on the current fuel level, is any action recommended?',
    );

    expect(result.matchMode).toBe('related');
    expect(result.clarification).not.toBeNull();
    expect(result.clarification?.pendingQuery).toBe(
      'Based on the current value of',
    );
    expect(
      result.clarification?.actions
        .filter((action) => action.kind !== 'all')
        .every((action) =>
          action.message.startsWith('Based on the current value of '),
        ),
    ).toBe(true);
  });
});

describe('MetricsService value sync', () => {
  it('stores the source timestamp returned by Influx for synced metric values', async () => {
    const shipFindMany = jest.fn().mockResolvedValue([
      {
        id: 'ship-1',
        organizationName: 'SeaWolfX',
        metricsConfig: [{ metricKey: 'Trending::Tanks::Fuel_Level' }],
      },
    ]);
    const shipMetricsConfigUpdate = jest.fn().mockResolvedValue({});

    const prisma = {
      ship: {
        findMany: shipFindMany,
      },
      shipMetricsConfig: {
        update: shipMetricsConfigUpdate,
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryLatestValues: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks::Fuel_Level',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel_Level',
          value: 63,
          time: '2026-03-22T12:34:56.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    await service.syncValuesFromInflux();

    expect(influxdb.queryLatestValues).toHaveBeenCalledWith(
      ['Trending::Tanks::Fuel_Level'],
      'SeaWolfX',
    );
    expect(shipMetricsConfigUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          latestValue: 63,
          valueUpdatedAt: new Date('2026-03-22T12:34:56.000Z'),
        }),
      }),
    );
  });
});

describe('MetricsService historical telemetry', () => {
  it('asks for the year when an absolute date omits it', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn(),
      },
      shipMetricsConfig: {
        findMany: jest.fn(),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'What was the starboard engine coolant temperature on 14 March?',
    );

    expect(result.kind).toBe('clarification');
    expect(result.clarificationQuestion).toContain('Which year');
  });

  it('answers historical averages deterministically from Influx aggregates', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::GENSET-PS::Load',
            latestValue: 40,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'GENSET-PS.Load',
              description: 'Generator load in kilowatts.',
              unit: 'kW',
              bucket: 'Trending',
              measurement: 'GENSET-PS',
              field: 'Load',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalAggregate: jest.fn().mockResolvedValue([
        {
          key: 'Trending::GENSET-PS::Load',
          bucket: 'Trending',
          measurement: 'GENSET-PS',
          field: 'Load',
          value: 42.5,
          time: '2026-03-28T00:00:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'What was the average generator load over the last 7 days?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('average');
    expect(result.content).toContain('42.5 kW');
    expect(influxdb.queryHistoricalAggregate).toHaveBeenCalled();
  });

  it('prefers direct generator load metrics over related speed metrics for historical averages', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey:
              'Trending::SIEMENS-GENSET-PS::Actual motor (generator) speed (rpm)',
            latestValue: 1500,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-GENSET-PS.Actual motor (generator) speed (rpm)',
              description: 'Generator speed.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-GENSET-PS',
              field: 'Actual motor (generator) speed (rpm)',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::SIEMENS-GENSET-PS::Machine load (0 - 100 %)',
            latestValue: 4.2,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-GENSET-PS.Machine load (0 - 100 %)',
              description: 'Generator machine load.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-GENSET-PS',
              field: 'Machine load (0 - 100 %)',
              dataType: 'numeric',
            },
          },
          {
            metricKey:
              'Trending::SIEMENS-GENSET-SB::Actual motor (generator) speed (rpm)',
            latestValue: 1500,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-GENSET-SB.Actual motor (generator) speed (rpm)',
              description: 'Generator speed.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-GENSET-SB',
              field: 'Actual motor (generator) speed (rpm)',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::SIEMENS-GENSET-SB::Machine load (0 - 100 %)',
            latestValue: 4.8,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-GENSET-SB.Machine load (0 - 100 %)',
              description: 'Generator machine load.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-GENSET-SB',
              field: 'Machine load (0 - 100 %)',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalAggregate: jest.fn().mockResolvedValue([
        {
          key: 'Trending::SIEMENS-GENSET-PS::Machine load (0 - 100 %)',
          bucket: 'Trending',
          measurement: 'SIEMENS-GENSET-PS',
          field: 'Machine load (0 - 100 %)',
          value: 4.35,
          time: '2026-03-28T00:00:00.000Z',
        },
        {
          key: 'Trending::SIEMENS-GENSET-SB::Machine load (0 - 100 %)',
          bucket: 'Trending',
          measurement: 'SIEMENS-GENSET-SB',
          field: 'Machine load (0 - 100 %)',
          value: 4.7,
          time: '2026-03-28T00:00:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'What was the average generator load over the last 7 days?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('SIEMENS-GENSET-PS.Machine load');
    expect(result.content).toContain('SIEMENS-GENSET-SB.Machine load');
    expect(result.content).not.toContain('speed');
  });

  it('uses historical total fuel used counters for fuel delta queries', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey:
              'Trending::SIEMENS-MASE-GENSET-PS::Diesel Fuel Rate (l/h)',
            latestValue: 12,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
              description:
                'Current fuel used rate in liters per hour for the port genset.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-MASE-GENSET-PS',
              field: 'Diesel Fuel Rate (l/h)',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
            latestValue: 34658,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-MASE-GENSET-PS.Total Fuel Used (l)',
              description: 'Total fuel used.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-MASE-GENSET-PS',
              field: 'Total Fuel Used (l)',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::SIEMENS-MASE-GENSET-SB::Fuel Pressure (bar)',
            latestValue: 1.2,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-MASE-GENSET-SB.Fuel Pressure (bar)',
              description: 'Fuel pressure.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-MASE-GENSET-SB',
              field: 'Fuel Pressure (bar)',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::SIEMENS-MASE-GENSET-SB::Total Fuel Used (l)',
            latestValue: 35116,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'SIEMENS-MASE-GENSET-SB.Total Fuel Used (l)',
              description: 'Total fuel used.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-MASE-GENSET-SB',
              field: 'Total Fuel Used (l)',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
            latestValue: 3053,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_1P',
              description: 'Fuel tank quantity.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_1P',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalFirstLast: jest.fn().mockResolvedValue({
        first: [
          {
            key: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Total Fuel Used (l)',
            value: 33021,
            time: '2026-02-25T23:10:00.000Z',
          },
          {
            key: 'Trending::SIEMENS-MASE-GENSET-SB::Total Fuel Used (l)',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-SB',
            field: 'Total Fuel Used (l)',
            value: 32369,
            time: '2026-02-25T23:10:00.000Z',
          },
        ],
        last: [
          {
            key: 'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-PS',
            field: 'Total Fuel Used (l)',
            value: 34658,
            time: '2026-03-27T23:10:00.000Z',
          },
          {
            key: 'Trending::SIEMENS-MASE-GENSET-SB::Total Fuel Used (l)',
            bucket: 'Trending',
            measurement: 'SIEMENS-MASE-GENSET-SB',
            field: 'Total Fuel Used (l)',
            value: 35116,
            time: '2026-03-27T23:10:00.000Z',
          },
        ],
      }),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'How much fuel was used over the last 30 days?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('4,384 liters');
    expect(result.content).toContain(
      'SIEMENS-MASE-GENSET-PS.Total Fuel Used (l)',
    );
    expect(result.content).toContain(
      'SIEMENS-MASE-GENSET-SB.Total Fuel Used (l)',
    );
    expect(result.content).not.toContain('Fuel Pressure');
    expect(result.content).not.toContain('Diesel Fuel Rate');
    expect(influxdb.queryHistoricalFirstLast).toHaveBeenCalledWith(
      [
        'Trending::SIEMENS-MASE-GENSET-PS::Total Fuel Used (l)',
        'Trending::SIEMENS-MASE-GENSET-SB::Total Fuel Used (l)',
      ],
      expect.any(Object),
      'SeaWolfX',
    );
  });

  it('keeps dedicated fuel tanks in historical totals even when descriptions look temperature-like', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          ...[
            ['1P', 3950, 'Fuel tank quantity.'],
            ['2S', 3896, 'Fuel tank quantity.'],
            ['3P', 452, 'Fuel tank quantity.'],
            ['4S', 370, 'Fuel tank quantity.'],
            ['5P', 799, 'Fuel tank quantity.'],
            ['6S', 932, 'Temperature reading for Fuel Tank 6S.'],
            ['7P', 1295, 'Temperature reading for Fuel Tank 7P.'],
            ['8S', 1297, 'Temperature reading for Fuel Tank 8S.'],
          ].map(([suffix, latestValue, description]) => ({
            metricKey: `Trending::Tanks-Temperatures::Fuel_Tank_${suffix}`,
            latestValue,
            valueUpdatedAt: new Date('2026-04-02T09:00:00.000Z'),
            metric: {
              label: `Tanks-Temperatures.Fuel_Tank_${suffix}`,
              description,
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: `Fuel_Tank_${suffix}`,
              dataType: 'numeric',
            },
          })),
          {
            metricKey: 'Trending::SIEMENS-MASE-GENSET-SB::Total Fuel Used (l)',
            latestValue: 35581,
            valueUpdatedAt: new Date('2026-04-02T09:00:00.000Z'),
            metric: {
              label: 'SIEMENS-MASE-GENSET-SB.Total Fuel Used (l)',
              description: 'Displays total fuel used by the starboard genset.',
              unit: null,
              bucket: 'Trending',
              measurement: 'SIEMENS-MASE-GENSET-SB',
              field: 'Total Fuel Used (l)',
              dataType: 'numeric',
            },
          },
          {
            metricKey:
              'Trending::PORT-FUEL-OIL-TRANSFER-PUMP::RMS phase to neutral Voltage B-N',
            latestValue: 0,
            valueUpdatedAt: new Date('2026-04-02T09:00:00.000Z'),
            metric: {
              label: 'PORT-FUEL-OIL-TRANSFER-PUMP.RMS phase to neutral Voltage B-N',
              description: 'Pump voltage reading.',
              unit: null,
              bucket: 'Trending',
              measurement: 'PORT-FUEL-OIL-TRANSFER-PUMP',
              field: 'RMS phase to neutral Voltage B-N',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        ['1P', 3950],
        ['2S', 3896],
        ['3P', 452],
        ['4S', 370],
        ['5P', 799],
        ['6S', 932],
        ['7P', 1295],
        ['8S', 1297],
      ].map(([suffix, value]) => ({
        key: `Trending::Tanks-Temperatures::Fuel_Tank_${suffix}`,
        bucket: 'Trending',
        measurement: 'Tanks-Temperatures',
        field: `Fuel_Tank_${suffix}`,
        value,
        time: '2026-03-28T09:47:00.000Z',
      }))),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'How much total fuel was 5 days ago?',
    );

    expect(result.kind).toBe('answer');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalledWith(
      [
        'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        'Trending::Tanks-Temperatures::Fuel_Tank_2S',
        'Trending::Tanks-Temperatures::Fuel_Tank_3P',
        'Trending::Tanks-Temperatures::Fuel_Tank_4S',
        'Trending::Tanks-Temperatures::Fuel_Tank_5P',
        'Trending::Tanks-Temperatures::Fuel_Tank_6S',
        'Trending::Tanks-Temperatures::Fuel_Tank_7P',
        'Trending::Tanks-Temperatures::Fuel_Tank_8S',
      ],
      expect.any(Date),
      'SeaWolfX',
    );
    expect(result.content).toContain('12,991');
    expect(result.content).toContain('Tanks-Temperatures.Fuel_Tank_6S');
    expect(result.content).toContain('Tanks-Temperatures.Fuel_Tank_7P');
    expect(result.content).toContain('Tanks-Temperatures.Fuel_Tank_8S');
    expect(result.content).not.toContain('Total Fuel Used');
    expect(result.content).not.toContain('Voltage');
  });

  it('does not turn forecast-planning fuel questions into point-in-time historical clarifications', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn(),
      },
      shipMetricsConfig: {
        findMany: jest.fn(),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'based on the last month calculate how many fuel do i need for the next month?',
    );

    expect(result.kind).toBe('none');
  });

  it('returns historical position at an exact time when latitude and longitude metrics exist', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'NMEA::navigation::latitude',
            latestValue: 46.5,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.latitude',
              description: 'Current vessel latitude.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation',
              field: 'latitude',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'NMEA::navigation::longitude',
            latestValue: 10.3,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.longitude',
              description: 'Current vessel longitude.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation',
              field: 'longitude',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        {
          key: 'NMEA::navigation::latitude',
          bucket: 'NMEA',
          measurement: 'navigation',
          field: 'latitude',
          value: 46.584758,
          time: '2026-03-15T10:01:00.000Z',
        },
        {
          key: 'NMEA::navigation::longitude',
          bucket: 'NMEA',
          measurement: 'navigation',
          field: 'longitude',
          value: 10.353452,
          time: '2026-03-15T10:01:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'What was the yacht position on 15 March 2026 at 10:00?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('Latitude 46.584758');
    expect(result.content).toContain('Longitude 10.353452');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalled();
  });

  it('prefers explicit latitude and longitude fields over generic position metrics', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey:
              'NMEA::navigation.courseGreatCircle.nextPoint.position::value',
            latestValue: '43.546295,7.014903',
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.courseGreatCircle.nextPoint.position',
              description:
                'Next route point position with latitude and longitude values.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation.courseGreatCircle.nextPoint.position',
              field: 'value',
              dataType: 'text',
            },
          },
          {
            metricKey: 'NMEA::navigation.position::lat',
            latestValue: 43.55,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.position.lat',
              description: 'Vessel latitude.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation.position',
              field: 'lat',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'NMEA::navigation.position::lon',
            latestValue: 7.01,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.position.lon',
              description: 'Vessel longitude.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation.position',
              field: 'lon',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        {
          key: 'NMEA::navigation.position::lat',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lat',
          value: 43.546295,
          time: '2026-03-15T10:01:00.000Z',
        },
        {
          key: 'NMEA::navigation.position::lon',
          bucket: 'NMEA',
          measurement: 'navigation.position',
          field: 'lon',
          value: 7.014903,
          time: '2026-03-15T10:01:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'What was the yacht position on 15 March 2026 at 10:00?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('Latitude 43.546295');
    expect(result.content).toContain('Longitude 7.014903');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalledWith(
      ['NMEA::navigation.position::lat', 'NMEA::navigation.position::lon'],
      expect.any(Date),
      'SeaWolfX',
    );
  });

  it('returns a day summary for date-only position follow-ups after the year is clarified', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'NMEA::navigation::latitude',
            latestValue: 46.5,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.latitude',
              description: 'Current vessel latitude.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation',
              field: 'latitude',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'NMEA::navigation::longitude',
            latestValue: 10.3,
            valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
            metric: {
              label: 'navigation.longitude',
              description: 'Current vessel longitude.',
              unit: null,
              bucket: 'NMEA',
              measurement: 'navigation',
              field: 'longitude',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalFirstLast: jest.fn().mockResolvedValue({
        first: [
          {
            key: 'NMEA::navigation::latitude',
            bucket: 'NMEA',
            measurement: 'navigation',
            field: 'latitude',
            value: 46.584758,
            time: '2025-03-14T00:05:00.000Z',
          },
          {
            key: 'NMEA::navigation::longitude',
            bucket: 'NMEA',
            measurement: 'navigation',
            field: 'longitude',
            value: 10.353452,
            time: '2025-03-14T00:05:00.000Z',
          },
        ],
        last: [
          {
            key: 'NMEA::navigation::latitude',
            bucket: 'NMEA',
            measurement: 'navigation',
            field: 'latitude',
            value: 46.617112,
            time: '2025-03-14T23:55:00.000Z',
          },
          {
            key: 'NMEA::navigation::longitude',
            bucket: 'NMEA',
            measurement: 'navigation',
            field: 'longitude',
            value: 10.401006,
            time: '2025-03-14T23:55:00.000Z',
          },
        ],
      }),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      '2025',
      'What was the yacht position on 14 March 2025',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('For 2025-03-14 UTC');
    expect(result.content).toContain('first recorded vessel position');
    expect(result.content).toContain('last recorded position');
    expect(influxdb.queryHistoricalFirstLast).toHaveBeenCalled();
  });

  it('accepts bare UTC time replies when the historical date is carried in the resolved subject query', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks::Fuel Tank 1P',
            latestValue: 3155,
            valueUpdatedAt: new Date('2026-03-25T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 1P',
              description: 'Fuel tank level reading.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 1P',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks::Fuel Tank 1P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 1P',
          value: 3155,
          time: '2026-03-25T12:00:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      '12:00 UTC',
      'what was the tank level 2026-03-25?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('2026-03-25 12:00 UTC');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalledWith(
      ['Trending::Tanks::Fuel Tank 1P'],
      new Date('2026-03-25T12:00:00.000Z'),
      'SeaWolfX',
    );
  });

  it('answers bare relative fuel-onboard questions from historical point-in-time telemetry', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks::Fuel Tank 1P',
            latestValue: 3100,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 1P',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 1P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks::Fuel Tank 2S',
            latestValue: 2416,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 2S',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 2S',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks::Fuel Tank 1P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 1P',
          value: 3100,
          time: '2026-03-25T18:00:00.000Z',
        },
        {
          key: 'Trending::Tanks::Fuel Tank 2S',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 2S',
          value: 2416,
          time: '2026-03-25T18:00:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'what was total fuel 5 days ago?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('matched historical telemetry readings');
    expect(result.content).toContain('5,516 liters');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalled();
  });

  it('prefers fuel tank inventory over fuel-used counters for historical total fuel lookups', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks::Fuel Tank 1P',
            latestValue: 3100,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 1P',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 1P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks::Fuel Tank 2S',
            latestValue: 2416,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 2S',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 2S',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Generators::Total Fuel Used PS',
            latestValue: 9150,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Generators.Total Fuel Used PS',
              description: 'Total fuel used by generator PS.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Generators',
              field: 'Total Fuel Used PS',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Generators::Total Fuel Used SB',
            latestValue: 8920,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Generators.Total Fuel Used SB',
              description: 'Total fuel used by generator SB.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Generators',
              field: 'Total Fuel Used SB',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks::Fuel Tank 1P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 1P',
          value: 3100,
          time: '2026-03-25T18:00:00.000Z',
        },
        {
          key: 'Trending::Tanks::Fuel Tank 2S',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 2S',
          value: 2416,
          time: '2026-03-25T18:00:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'what was total fuel 5 days ago?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('5,516 liters');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalledWith(
      ['Trending::Tanks::Fuel Tank 1P', 'Trending::Tanks::Fuel Tank 2S'],
      expect.any(Date),
      'SeaWolfX',
    );
  });

  it('ignores temperature-only dedicated fuel tank metrics for historical fuel inventory lookups', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
            latestValue: 3100,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_1P',
              description:
                'Fuel Oil level reading for the Fuel Tank 1P. What it measures: The current fuel oil level inside the Fuel Tank 1P.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_1P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
            latestValue: 2416,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_2S',
              description:
                'Fuel Oil level reading for the second starboard fuel tank. What it measures: The current Fuel Oil level inside Fuel Tank 2S. Unit: litres',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_2S',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_3P',
            latestValue: 19.1,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_3P',
              description:
                'Temperature reading for the Fuel Tank 3P. What it measures: The current temperature inside the Fuel Tank 3P.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_3P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_4S',
            latestValue: 18.2,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_4S',
              description:
                'Temperature reading for Fuel Tank 4S. What it measures: The current temperature inside Fuel Tank 4S.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_4S',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalNearestValues: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_1P',
          value: 3100,
          time: '2026-03-25T18:00:00.000Z',
        },
        {
          key: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_2S',
          value: 2416,
          time: '2026-03-25T18:00:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'what was total fuel 5 days ago?',
    );

    expect(result.kind).toBe('answer');
    expect(influxdb.queryHistoricalNearestValues).toHaveBeenCalledWith(
      [
        'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        'Trending::Tanks-Temperatures::Fuel_Tank_2S',
      ],
      expect.any(Date),
      'SeaWolfX',
    );
  });

  it('detects the latest bunkering-style fuel increase from historical telemetry series', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks::Fuel Tank 1P',
            latestValue: 2900,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 1P',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 1P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks::Fuel Tank 2S',
            latestValue: 2750,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 2S',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 2S',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalSeries: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks::Fuel Tank 1P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 1P',
          value: 2100,
          time: '2026-03-24T08:00:00.000Z',
        },
        {
          key: 'Trending::Tanks::Fuel Tank 1P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 1P',
          value: 2625,
          time: '2026-03-24T08:20:00.000Z',
        },
        {
          key: 'Trending::Tanks::Fuel Tank 2S',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 2S',
          value: 2050,
          time: '2026-03-24T08:00:00.000Z',
        },
        {
          key: 'Trending::Tanks::Fuel Tank 2S',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 2S',
          value: 2475,
          time: '2026-03-24T08:18:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'when was last bunkering?',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain(
      'latest historical bunkering-like fuel increase',
    );
    expect(result.content).toContain('2026-03-24 08:20 UTC');
    expect(influxdb.queryHistoricalSeries).toHaveBeenCalledTimes(2);
    expect(influxdb.queryHistoricalSeries.mock.calls[0]?.[3]).toEqual({
      windowEvery: expect.any(String),
      windowMs: expect.any(Number),
    });
  });

  it('treats fuel last increase phrasing as a historical event answer', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks::Fuel Tank 3P',
            latestValue: 1900,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 3P',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 3P',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalSeries: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks::Fuel Tank 3P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 3P',
          value: 1400,
          time: '2026-03-20T06:00:00.000Z',
        },
        {
          key: 'Trending::Tanks::Fuel Tank 3P',
          bucket: 'Trending',
          measurement: 'Tanks',
          field: 'Fuel Tank 3P',
          value: 1680,
          time: '2026-03-20T06:10:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'check it based on fuel last increase',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain('latest historical fuel increase');
    expect(result.content).toContain('Fuel Tank 3P');
    expect(influxdb.queryHistoricalSeries).toHaveBeenCalled();
  });

  it('ignores temperature-only dedicated fuel tank metrics for historical bunkering events', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
            latestValue: 2900,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_1P',
              description:
                'Fuel Oil level reading for the Fuel Tank 1P. What it measures: The current fuel oil level inside the Fuel Tank 1P.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_1P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
            latestValue: 2750,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_2S',
              description:
                'Fuel Oil level reading for the second starboard fuel tank. What it measures: The current Fuel Oil level inside Fuel Tank 2S. Unit: litres',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_2S',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_3P',
            latestValue: 19.1,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_3P',
              description:
                'Temperature reading for the Fuel Tank 3P. What it measures: The current temperature inside the Fuel Tank 3P.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_3P',
              dataType: 'numeric',
            },
          },
          {
            metricKey: 'Trending::Tanks-Temperatures::Fuel_Tank_4S',
            latestValue: 18.2,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks-Temperatures.Fuel_Tank_4S',
              description:
                'Temperature reading for Fuel Tank 4S. What it measures: The current temperature inside Fuel Tank 4S.',
              unit: null,
              bucket: 'Trending',
              measurement: 'Tanks-Temperatures',
              field: 'Fuel_Tank_4S',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalSeries: jest.fn().mockResolvedValue([
        {
          key: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_1P',
          value: 2100,
          time: '2026-03-24T08:00:00.000Z',
        },
        {
          key: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_1P',
          value: 2625,
          time: '2026-03-24T08:20:00.000Z',
        },
        {
          key: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_2S',
          value: 2050,
          time: '2026-03-24T08:00:00.000Z',
        },
        {
          key: 'Trending::Tanks-Temperatures::Fuel_Tank_2S',
          bucket: 'Trending',
          measurement: 'Tanks-Temperatures',
          field: 'Fuel_Tank_2S',
          value: 2475,
          time: '2026-03-24T08:18:00.000Z',
        },
      ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'when was last bunkering?',
    );

    expect(result.kind).toBe('answer');
    expect(influxdb.queryHistoricalSeries).toHaveBeenNthCalledWith(
      1,
      [
        'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        'Trending::Tanks-Temperatures::Fuel_Tank_2S',
      ],
      expect.any(Object),
      'SeaWolfX',
      expect.objectContaining({
        windowEvery: expect.any(String),
        windowMs: expect.any(Number),
      }),
    );
  });

  it('falls back to a coarser historical event window after a timeout', async () => {
    const coarseStart = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const coarseStop = new Date(Date.now() - 60 * 60 * 1000);
    const refinedStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const refinedStop = new Date(Date.now() - 110 * 60 * 1000);
    const expectedTimestamp = `${refinedStop.getUTCFullYear()}-${String(
      refinedStop.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(refinedStop.getUTCDate()).padStart(
      2,
      '0',
    )} ${String(refinedStop.getUTCHours()).padStart(2, '0')}:${String(
      refinedStop.getUTCMinutes(),
    ).padStart(2, '0')} UTC`;

    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          organizationName: 'SeaWolfX',
        }),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            metricKey: 'Trending::Tanks::Fuel Tank 3P',
            latestValue: 1900,
            valueUpdatedAt: new Date('2026-03-27T12:00:00.000Z'),
            metric: {
              label: 'Tanks.Fuel Tank 3P',
              description: 'Fuel tank quantity.',
              unit: 'liters',
              bucket: 'Trending',
              measurement: 'Tanks',
              field: 'Fuel Tank 3P',
              dataType: 'numeric',
            },
          },
        ]),
      },
    };

    const influxdb = {
      isConfigured: jest.fn().mockReturnValue(true),
      queryHistoricalSeries: jest
        .fn()
        .mockRejectedValueOnce(new Error('Request timed out'))
        .mockResolvedValueOnce([
          {
            key: 'Trending::Tanks::Fuel Tank 3P',
            bucket: 'Trending',
            measurement: 'Tanks',
            field: 'Fuel Tank 3P',
            value: 1400,
            time: coarseStart.toISOString(),
          },
          {
            key: 'Trending::Tanks::Fuel Tank 3P',
            bucket: 'Trending',
            measurement: 'Tanks',
            field: 'Fuel Tank 3P',
            value: 1680,
            time: coarseStop.toISOString(),
          },
        ])
        .mockResolvedValueOnce([
          {
            key: 'Trending::Tanks::Fuel Tank 3P',
            bucket: 'Trending',
            measurement: 'Tanks',
            field: 'Fuel Tank 3P',
            value: 1400,
            time: refinedStart.toISOString(),
          },
          {
            key: 'Trending::Tanks::Fuel Tank 3P',
            bucket: 'Trending',
            measurement: 'Tanks',
            field: 'Fuel Tank 3P',
            value: 1680,
            time: refinedStop.toISOString(),
          },
        ]),
    };

    const metricDescriptions = {
      isConfigured: jest.fn().mockReturnValue(false),
    };

    const service = new MetricsService(
      prisma as never,
      influxdb as never,
      metricDescriptions as never,
    );

    const result = await service.resolveHistoricalTelemetryQuery(
      'ship-1',
      'check it based on fuel last increase',
    );

    expect(result.kind).toBe('answer');
    expect(result.content).toContain(expectedTimestamp);
    expect(influxdb.queryHistoricalSeries.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(influxdb.queryHistoricalSeries.mock.calls[0]?.[3]?.windowMs).toBeDefined();
  });
});
