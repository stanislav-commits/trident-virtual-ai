import {
  canonicalizeTelemetrySubjectToken,
  expandTelemetryTokenVariants,
  matchesTelemetrySubjectToken,
  normalizeTelemetryText,
  normalizeTelemetryToken,
} from '../../../../src/telemetry-catalog/live-telemetry/telemetry-text.utils';

describe('telemetry text utils', () => {
  it('normalizes telemetry text consistently', () => {
    expect(normalizeTelemetryText('main_engine.temps/stbd')).toBe(
      'main engine temperature starboard',
    );
    expect(normalizeTelemetryText('generator_set volts')).toBe(
      'genset voltage',
    );
  });

  it('normalizes token aliases and plurals', () => {
    expect(normalizeTelemetryToken('gensets')).toBe('genset');
    expect(normalizeTelemetryToken('batteries')).toBe('battery');
    expect(normalizeTelemetryToken('temperatures')).toBe('temperature');
  });

  it('expands and matches subject token aliases', () => {
    expect(expandTelemetryTokenVariants('starboard')).toEqual(
      expect.arrayContaining(['starboard', 'sb', 'stbd', 'right']),
    );
    expect(canonicalizeTelemetrySubjectToken('stbd')).toBe('starboard');
    expect(matchesTelemetrySubjectToken('main engine stbd temperature', 'starboard')).toBe(
      true,
    );
  });
});
