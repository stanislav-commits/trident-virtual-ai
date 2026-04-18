import { MetricsV2CatalogService } from '../../../src/metrics-v2/catalog/metrics-v2-catalog.service';

describe('MetricsV2CatalogService', () => {
  const service = new MetricsV2CatalogService(null as never);

  it('derives semantic meaning from field, unit, and description instead of a misleading measurement name', () => {
    const entry = (service as any).toCatalogEntry({
      metricKey: 'Trending::Wind-Speed::Fuel_Tank_1P',
      latestValue: 3291,
      valueUpdatedAt: null,
      metric: {
        label: 'Wind-Speed.Fuel_Tank_1P',
        description:
          'Fuel oil level reading for Fuel Tank 1P. What it measures: The current fuel oil level inside Fuel Tank 1P. Unit: Liters',
        unit: 'L',
        bucket: 'Trending',
        measurement: 'Wind-Speed',
        field: 'Fuel_Tank_1P',
        dataType: 'numeric',
      },
    });

    expect(entry.label).toBe('Fuel_Tank_1P');
    expect(entry.measurementKind).toBe('level');
    expect(entry.businessConcept).toBe('fuel_tank_inventory_member');
    expect(entry.searchText).toContain('fuel_tank_1p');
    expect(entry.searchText).not.toContain('wind-speed');
  });
});
