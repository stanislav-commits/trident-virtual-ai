import { auditMetricMetadata } from '../../../src/telemetry-catalog/audit/metric-metadata-audit.utils';

describe('auditMetricMetadata', () => {
  it('flags stale temperature label against level description and liters unit', () => {
    const result = auditMetricMetadata({
      key: 'Trending::Tanks-Temperatures::Fuel_Tank_3P',
      label: 'Fuel Tank 3P Temperature',
      description:
        'Fuel oil level reading for Fuel Tank 3P. What it measures: The current fuel oil level inside Fuel Tank 3P.',
      unit: 'Liters',
      measurement: 'Tanks-Temperatures',
      field: 'Fuel_Tank_3P',
    });

    expect(result.suggestedFamily).toBe('inventory');
    expect(result.findings.some((finding) => finding.code === 'label_conflicts_with_consensus')).toBe(true);
  });

  it('does not flag consistent voltage metadata', () => {
    const result = auditMetricMetadata({
      key: 'Trending::Electrical::Battery_Voltage',
      label: 'Battery Voltage',
      description: 'Displays the current battery voltage.',
      unit: 'V',
      measurement: 'Electrical',
      field: 'Battery_Voltage',
    });

    expect(result.findings).toHaveLength(0);
    expect(result.suggestedFamily).toBe('voltage');
  });
});
