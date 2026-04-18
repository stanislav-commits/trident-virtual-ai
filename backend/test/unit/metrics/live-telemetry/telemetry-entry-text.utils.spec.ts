import {
  buildTelemetryHaystack,
  getPreferredTelemetryLabel,
} from '../../../../src/telemetry-catalog/live-telemetry/telemetry-entry-text.utils';

describe('telemetry entry text utils', () => {
  it('prefers a cleaned field label when the label only mirrors measurement and field', () => {
    const entry = {
      key: 'Trending::Wind-Speed::Fuel_Tank_1P',
      label: 'Wind-Speed.Fuel_Tank_1P',
      measurement: 'Wind-Speed',
      field: 'Fuel_Tank_1P',
      description: 'Fuel oil level reading for Fuel Tank 1P.',
      unit: 'L',
      value: 3291,
    };

    expect(getPreferredTelemetryLabel(entry)).toBe('Fuel Tank 1P');
    expect(buildTelemetryHaystack(entry)).toContain('fuel tank 1p');
    expect(buildTelemetryHaystack(entry)).not.toContain('wind speed');
  });

  it('cleans noisy uppercase tank labels into user-facing display names', () => {
    const entry = {
      key: 'Trending::Tanks-Temperatures::BILGE WATER TANK 21P LITERS',
      label: 'BILGE WATER TANK 21P LITERS',
      measurement: 'Tanks-Temperatures',
      field: 'BILGE WATER TANK 21P LITERS',
      description: 'Bilge water tank level reading.',
      unit: 'L',
      value: 412,
    };

    expect(getPreferredTelemetryLabel(entry)).toBe('Bilge Water Tank 21P');
  });
});
