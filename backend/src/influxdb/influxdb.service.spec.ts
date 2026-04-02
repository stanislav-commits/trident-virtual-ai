import { InfluxdbService } from './influxdb.service';

describe('InfluxdbService', () => {
  const originalEnv = {
    INFLUX_URL: process.env.INFLUX_URL,
    INFLUX_TOKEN: process.env.INFLUX_TOKEN,
    INFLUX_ORG: process.env.INFLUX_ORG,
  };

  beforeEach(() => {
    process.env.INFLUX_URL = 'http://localhost:8086';
    process.env.INFLUX_TOKEN = 'test-token';
    process.env.INFLUX_ORG = 'SeaWolfX';
  });

  afterEach(() => {
    process.env.INFLUX_URL = originalEnv.INFLUX_URL;
    process.env.INFLUX_TOKEN = originalEnv.INFLUX_TOKEN;
    process.env.INFLUX_ORG = originalEnv.INFLUX_ORG;
  });

  it('uses pushdown-friendly OR filters instead of contains for multi-field historical series queries', async () => {
    const service = new InfluxdbService();
    const queryRows = jest
      .spyOn(service as never, 'queryRows' as never)
      .mockResolvedValue([]);

    await service.queryHistoricalSeries(
      [
        'Trending::Tanks-Temperatures::Fuel_Tank_1P',
        'Trending::Tanks-Temperatures::Fuel_Tank_2S',
      ],
      {
        start: new Date('2026-03-26T00:00:00.000Z'),
        stop: new Date('2026-04-02T00:00:00.000Z'),
      },
      'SeaWolfX',
      { windowEvery: '6h' },
    );

    const flux = queryRows.mock.calls[0]?.[0] as string;
    expect(flux).toContain(
      '(r._field == "Fuel_Tank_1P" or r._field == "Fuel_Tank_2S")',
    );
    expect(flux).not.toContain('contains(value: r._field');
  });
});
