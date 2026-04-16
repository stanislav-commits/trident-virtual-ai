import { MetricDescriptionService } from '../../../src/metrics/metric-description.service';
import { GrafanaLlmService } from '../../../src/grafana-llm/grafana-llm.service';

describe('MetricDescriptionService', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalProvider = process.env.METRIC_DESCRIPTION_PROVIDER;
  const originalModel = process.env.LLM_MODEL;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.METRIC_DESCRIPTION_PROVIDER;
  });

  afterAll(() => {
    if (originalApiKey) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    if (originalProvider) {
      process.env.METRIC_DESCRIPTION_PROVIDER = originalProvider;
    } else {
      delete process.env.METRIC_DESCRIPTION_PROVIDER;
    }

    if (originalModel) {
      process.env.LLM_MODEL = originalModel;
    } else {
      delete process.env.LLM_MODEL;
    }
  });

  it('treats dedicated fuel tank fields as tank readings instead of temperatures', async () => {
    const service = new MetricDescriptionService({
      isConfigured: () => false,
      createChatCompletion: jest.fn(),
    } as unknown as GrafanaLlmService);

    await expect(
      service.generateDescription({
        key: 'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        bucket: 'Trending',
        measurement: 'Tanks-Temperatures',
        field: 'Fuel_Tank_1P',
        label: 'Tanks-Temperatures.Fuel_Tank_1P',
      }),
    ).resolves.toBe('Displays the current reading for Fuel Tank 1P.');
  });

  it('builds deterministic coordinate descriptions from field names', async () => {
    const service = new MetricDescriptionService({
      isConfigured: () => false,
      createChatCompletion: jest.fn(),
    } as unknown as GrafanaLlmService);

    await expect(
      service.generateDescription({
        key: 'NMEA::navigation::Latitude',
        bucket: 'NMEA',
        measurement: 'navigation',
        field: 'Latitude',
        label: 'navigation.Latitude',
      }),
    ).resolves.toBe("Displays the vessel's current latitude.");

    await expect(
      service.generateDescription({
        key: 'NMEA::navigation::Longitude',
        bucket: 'NMEA',
        measurement: 'navigation',
        field: 'Longitude',
        label: 'navigation.Longitude',
      }),
    ).resolves.toBe("Displays the vessel's current longitude.");
  });

  it('prefers explicit field semantics over broad grouping names', async () => {
    const service = new MetricDescriptionService({
      isConfigured: () => false,
      createChatCompletion: jest.fn(),
    } as unknown as GrafanaLlmService);

    await expect(
      service.generateDescription({
        key: 'Trending::Electrical::Battery voltage (V)',
        bucket: 'Trending',
        measurement: 'Electrical',
        field: 'Battery voltage (V)',
        label: 'Electrical.Battery voltage (V)',
      }),
    ).resolves.toBe('Displays the current battery voltage.');
  });

  it('treats Grafana LLM as a configured provider for description backfill', () => {
    const service = new MetricDescriptionService({
      isConfigured: () => true,
      createChatCompletion: jest.fn(),
    } as unknown as GrafanaLlmService);

    expect(service.isConfigured()).toBe(true);
  });

  it('uses Grafana LLM output for non-deterministic metric descriptions', async () => {
    const createChatCompletion = jest
      .fn()
      .mockResolvedValue(
        'Velocity Made Good (VMG) is a standard marine navigation metric defined by the NMEA specification.\n\nWhat it measures: The vessel speed made good toward the active waypoint.\nUnit: Knots (kn)',
      );
    const service = new MetricDescriptionService({
      isConfigured: () => true,
      createChatCompletion,
    } as unknown as GrafanaLlmService);

    await expect(
      service.generateDescription({
        key: 'NMEA::performance::velocityMadeGood',
        bucket: 'NMEA',
        measurement: 'performance',
        field: 'velocityMadeGood',
        label: 'performance.velocityMadeGood',
        unit: 'kn',
      }),
    ).resolves.toBe(
      'Velocity Made Good (VMG) is a standard marine navigation metric defined by the NMEA specification.\n' +
        'What it measures: The vessel speed made good toward the active waypoint.\n' +
        'Unit: Knots (kn)',
    );

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('treats provider=grafana as strict Grafana-only generation', async () => {
    process.env.METRIC_DESCRIPTION_PROVIDER = 'grafana';

    const createChatCompletion = jest
      .fn()
      .mockResolvedValue(
        'Reports the vessel latitude used for navigation fixes.',
      );
    const service = new MetricDescriptionService({
      isConfigured: () => true,
      createChatCompletion,
    } as unknown as GrafanaLlmService);

    await expect(
      service.generateDescription({
        key: 'NMEA::navigation::Latitude',
        bucket: 'NMEA',
        measurement: 'navigation',
        field: 'Latitude',
        label: 'navigation.Latitude',
      }),
    ).resolves.toBe('Reports the vessel latitude used for navigation fixes.');

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('normalizes inline sections into structured rich descriptions', async () => {
    const createChatCompletion = jest
      .fn()
      .mockResolvedValue(
        "Velocity Made Good (VMG) is a standard marine navigation metric defined by the NMEA specification. What it measures: The vessel's effective speed toward its destination. Unit: Knots (kn)",
      );
    const service = new MetricDescriptionService({
      isConfigured: () => true,
      createChatCompletion,
    } as unknown as GrafanaLlmService);

    await expect(
      service.generateDescription({
        key: 'NMEA::performance::velocityMadeGood',
        bucket: 'NMEA',
        measurement: 'performance',
        field: 'velocityMadeGood',
        label: 'performance.velocityMadeGood',
      }),
    ).resolves.toBe(
      'Velocity Made Good (VMG) is a standard marine navigation metric defined by the NMEA specification.\n' +
        "What it measures: The vessel's effective speed toward its destination.\n" +
        'Unit: Knots (kn)',
    );
  });

  it('does not treat OpenAI as configured when provider=grafana', () => {
    process.env.METRIC_DESCRIPTION_PROVIDER = 'grafana';
    process.env.OPENAI_API_KEY = 'sk-test';

    const service = new MetricDescriptionService({
      isConfigured: () => false,
      createChatCompletion: jest.fn(),
    } as unknown as GrafanaLlmService);

    expect(service.isConfigured()).toBe(false);
  });

  it('uses max_completion_tokens for GPT-5 OpenAI metric descriptions', async () => {
    process.env.METRIC_DESCRIPTION_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.LLM_MODEL = 'gpt-5.4';

    const service = new MetricDescriptionService({
      isConfigured: () => false,
      createChatCompletion: jest.fn(),
    } as unknown as GrafanaLlmService);
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'Reports the current battery voltage.' } }],
    });
    (service as any).openAiClient = {
      chat: {
        completions: {
          create,
        },
      },
    };

    await expect(
      service.generateDescription({
        key: 'Trending::Electrical::Battery voltage (V)',
        bucket: 'Trending',
        measurement: 'Electrical',
        field: 'Battery voltage (V)',
        label: 'Electrical.Battery voltage (V)',
      }),
    ).resolves.toBe('Reports the current battery voltage.');

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0].max_completion_tokens).toBeDefined();
    expect(create.mock.calls[0][0].max_tokens).toBeUndefined();
  });
});
