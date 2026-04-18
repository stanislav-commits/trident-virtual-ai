import { buildMetricMatchText } from '../../../src/tags/linking/tag-link-text.utils';

describe('tag link text utils', () => {
  it('ignores misleading measurement prefixes when building metric match text', () => {
    const text = buildMetricMatchText({
      key: 'Trending::Wind-Speed::Fuel_Tank_1P',
      label: 'Wind-Speed.Fuel_Tank_1P',
      description: 'Fuel oil level reading for Fuel Tank 1P.',
      unit: 'L',
      bucket: 'Trending',
      measurement: 'Wind-Speed',
      field: 'Fuel_Tank_1P',
    });

    expect(text).toContain('Fuel_Tank_1P');
    expect(text).not.toContain('Wind-Speed.Fuel_Tank_1P');
    expect(text).not.toContain('Wind-Speed');
  });
});
