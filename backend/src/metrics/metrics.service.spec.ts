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
          description: 'Displays the temperature of Fuel Tank 4S in trending data.',
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
    expect(Object.keys(result.telemetry)[0]).toContain('Fuel_Tank_4S');
    expect(Object.values(result.telemetry)[0]).toBe(18.2);
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
      Object.keys(result.telemetry).every((key) => key.includes('Fuel_Tank')),
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

  it("prefers the captain cabin room temperature over captain cabin electrical metrics", async () => {
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
          description:
            'This is the Captains cabin room temperature (temp).',
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
      Object.keys(result.telemetry).every((key) => !key.includes('DEF Tank level')),
    ).toBe(true);
    expect(
      Object.keys(result.telemetry).some((key) => key.includes('Fuel Pressure')),
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
            description: 'Displays the oil pressure in bars for the port genset.',
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

      const result = await service.getShipTelemetryContextForQuery('ship-1', query);

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

  it('uses action-oriented clarification prompts for recommendation queries without a direct metric', async () => {
    const service = buildService([
      {
        metricKey: 'Trending::SIEMENS-MASE-GENSET-PS::Fuel Pressure (bar)',
        latestValue: 0.34,
        valueUpdatedAt: new Date('2026-03-21T12:00:00.000Z'),
        metric: {
          label: 'SIEMENS-MASE-GENSET-PS.Fuel Pressure (bar)',
          description: 'Displays the fuel pressure in bars for the port genset.',
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
