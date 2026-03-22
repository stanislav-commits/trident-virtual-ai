import { MetricDescriptionService } from './metric-description.service';

describe('MetricDescriptionService', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterAll(() => {
    if (originalApiKey) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('treats dedicated fuel tank fields as tank readings instead of temperatures', async () => {
    const service = new MetricDescriptionService();

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
    const service = new MetricDescriptionService();

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
    const service = new MetricDescriptionService();

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
});
