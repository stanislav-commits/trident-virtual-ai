export type MetricMetadataSemanticFamily =
  | 'inventory'
  | 'temperature'
  | 'pressure'
  | 'voltage'
  | 'current'
  | 'power'
  | 'energy'
  | 'speed'
  | 'runtime'
  | 'location'
  | 'status';

export type MetricMetadataAuditSeverity = 'critical' | 'high' | 'medium';

export interface MetricMetadataAuditInput {
  key: string;
  label: string | null;
  description: string | null;
  unit: string | null;
  bucket?: string | null;
  measurement?: string | null;
  field?: string | null;
}

export interface MetricMetadataAuditFinding {
  code:
    | 'label_conflicts_with_consensus'
    | 'description_conflicts_with_unit'
    | 'label_conflicts_with_description';
  severity: MetricMetadataAuditSeverity;
  summary: string;
  channels: Partial<
    Record<'label' | 'description' | 'unit' | 'field' | 'key', MetricMetadataSemanticFamily>
  >;
  suggestedFamily: MetricMetadataSemanticFamily | null;
}

export interface MetricMetadataAuditResult {
  key: string;
  label: string | null;
  description: string | null;
  unit: string | null;
  findings: MetricMetadataAuditFinding[];
  channelFamilies: Partial<
    Record<'label' | 'description' | 'unit' | 'field' | 'key', MetricMetadataSemanticFamily>
  >;
  suggestedFamily: MetricMetadataSemanticFamily | null;
}

type ChannelName = 'label' | 'description' | 'unit' | 'field' | 'key';

const FAMILY_PATTERNS: Array<{
  family: MetricMetadataSemanticFamily;
  patterns: RegExp[];
}> = [
  {
    family: 'temperature',
    patterns: [
      /\btemperature\b/i,
      /\btemp\b/i,
      /\bcelsius\b/i,
      /\bfahrenheit\b/i,
      /\bdegrees?\b/i,
      /°[cf]/i,
    ],
  },
  {
    family: 'pressure',
    patterns: [/\bpressure\b/i, /\bbar\b/i, /\bpsi\b/i],
  },
  {
    family: 'voltage',
    patterns: [/\bvoltage\b/i, /\bvolt(?:s|age)?\b/i, /\bphase to neutral\b/i],
  },
  {
    family: 'current',
    patterns: [/\bcurrent\b/i, /\bamps?\b/i, /\bampere\b/i, /\bamperage\b/i],
  },
  {
    family: 'power',
    patterns: [/\bpower\b/i, /\bkilowatt\b/i, /\bwatt\b/i, /\bkw\b/i],
  },
  {
    family: 'energy',
    patterns: [/\benergy\b/i, /\bkwh\b/i, /\bmwh\b/i, /\bwh\b/i],
  },
  {
    family: 'speed',
    patterns: [
      /\bspeed\b/i,
      /\brpm\b/i,
      /\bsog\b/i,
      /\bstw\b/i,
      /\bvmg\b/i,
      /\bknots?\b/i,
      /\bkts?\b/i,
    ],
  },
  {
    family: 'runtime',
    patterns: [
      /\bruntime\b/i,
      /\brunning hours?\b/i,
      /\bhours?\b/i,
      /\bhour meter\b/i,
      /\beta\b/i,
      /\btime to go\b/i,
    ],
  },
  {
    family: 'location',
    patterns: [
      /\blatitude\b/i,
      /\blongitude\b/i,
      /\bposition\b/i,
      /\bcoordinates?\b/i,
      /\bgps\b/i,
      /\bdecimal degrees\b/i,
    ],
  },
  {
    family: 'status',
    patterns: [/\bstatus\b/i, /\bstate\b/i, /\balarm\b/i, /\bfault\b/i, /\bmode\b/i],
  },
  {
    family: 'inventory',
    patterns: [
      /\blevel\b/i,
      /\bvolume\b/i,
      /\bquantity\b/i,
      /\bremaining\b/i,
      /\bonboard\b/i,
      /\bliters?\b/i,
      /\blitres?\b/i,
      /\bgallons?\b/i,
      /\bm3\b/i,
      /\btank\b/i,
      /\bfuel oil level\b/i,
    ],
  },
];

const UNIT_PATTERNS: Array<{
  family: MetricMetadataSemanticFamily;
  patterns: RegExp[];
}> = [
  {
    family: 'temperature',
    patterns: [/^°?[cf]$/i, /\bcelsius\b/i, /\bfahrenheit\b/i],
  },
  {
    family: 'pressure',
    patterns: [/^bar$/i, /^psi$/i],
  },
  {
    family: 'voltage',
    patterns: [/^v$/i, /^kv$/i, /^mv$/i, /\bvolt/i],
  },
  {
    family: 'current',
    patterns: [/^a$/i, /^ma$/i, /\bamp/i],
  },
  {
    family: 'power',
    patterns: [/^kw$/i, /^w$/i, /\bwatt/i],
  },
  {
    family: 'energy',
    patterns: [/^kwh$/i, /^wh$/i, /^mwh$/i],
  },
  {
    family: 'speed',
    patterns: [/^kt$/i, /^kts$/i, /^kn$/i, /\bknots?\b/i, /\brpm\b/i],
  },
  {
    family: 'runtime',
    patterns: [/^h$/i, /^hr$/i, /^hrs$/i, /\bhours?\b/i, /\bseconds?\b/i],
  },
  {
    family: 'location',
    patterns: [/\bdecimal degrees\b/i],
  },
  {
    family: 'inventory',
    patterns: [/^l$/i, /^liters?$/i, /^litres?$/i, /^m3$/i, /^gal$/i],
  },
];

const SEVERITY_RANK: Record<MetricMetadataAuditSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
};

function detectFamilyFromText(
  value?: string | null,
): MetricMetadataSemanticFamily | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }

  let bestFamily: MetricMetadataSemanticFamily | null = null;
  let bestScore = 0;

  for (const candidate of FAMILY_PATTERNS) {
    let score = 0;
    for (const pattern of candidate.patterns) {
      if (pattern.test(text)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestFamily = candidate.family;
    }
  }

  return bestFamily;
}

function detectFamilyFromUnit(
  value?: string | null,
): MetricMetadataSemanticFamily | null {
  const unit = value?.trim();
  if (!unit) {
    return null;
  }

  for (const candidate of UNIT_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(unit))) {
      return candidate.family;
    }
  }

  return null;
}

function getConsensusFamily(
  channelFamilies: Partial<Record<ChannelName, MetricMetadataSemanticFamily>>,
): MetricMetadataSemanticFamily | null {
  const scores = new Map<MetricMetadataSemanticFamily, number>();
  const weights: Partial<Record<ChannelName, number>> = {
    description: 3,
    unit: 3,
    field: 2,
    key: 1,
    label: 1,
  };

  for (const [channel, family] of Object.entries(channelFamilies) as Array<
    [ChannelName, MetricMetadataSemanticFamily]
  >) {
    const weight = weights[channel] ?? 1;
    scores.set(family, (scores.get(family) ?? 0) + weight);
  }

  let bestFamily: MetricMetadataSemanticFamily | null = null;
  let bestScore = 0;

  for (const [family, score] of scores.entries()) {
    if (score > bestScore) {
      bestFamily = family;
      bestScore = score;
    }
  }

  return bestFamily;
}

function severityFromSupport(params: {
  conflictingChannel: ChannelName;
  channelFamilies: Partial<Record<ChannelName, MetricMetadataSemanticFamily>>;
  suggestedFamily: MetricMetadataSemanticFamily | null;
}): MetricMetadataAuditSeverity {
  const { conflictingChannel, channelFamilies, suggestedFamily } = params;
  if (!suggestedFamily) {
    return 'medium';
  }

  const supporters = (['label', 'description', 'unit', 'field', 'key'] as const)
    .filter((channel) => channel !== conflictingChannel)
    .filter((channel) => channelFamilies[channel] === suggestedFamily).length;

  if (supporters >= 2) {
    return 'critical';
  }

  if (supporters >= 1) {
    return 'high';
  }

  return 'medium';
}

export function auditMetricMetadata(
  input: MetricMetadataAuditInput,
): MetricMetadataAuditResult {
  const keyTail = input.key.split('::').pop()?.trim() ?? input.key;
  const channelFamilies: Partial<
    Record<ChannelName, MetricMetadataSemanticFamily>
  > = {
    ...(detectFamilyFromText(input.label) ? { label: detectFamilyFromText(input.label)! } : {}),
    ...(detectFamilyFromText(input.description)
      ? { description: detectFamilyFromText(input.description)! }
      : {}),
    ...(detectFamilyFromUnit(input.unit) ? { unit: detectFamilyFromUnit(input.unit)! } : {}),
    ...(detectFamilyFromText(input.field) ? { field: detectFamilyFromText(input.field)! } : {}),
    ...(detectFamilyFromText(keyTail) ? { key: detectFamilyFromText(keyTail)! } : {}),
  };

  const suggestedFamily = getConsensusFamily(channelFamilies);
  const findings: MetricMetadataAuditFinding[] = [];

  if (
    channelFamilies.label &&
    suggestedFamily &&
    channelFamilies.label !== suggestedFamily
  ) {
    findings.push({
      code: 'label_conflicts_with_consensus',
      severity: severityFromSupport({
        conflictingChannel: 'label',
        channelFamilies,
        suggestedFamily,
      }),
      summary: `Label suggests ${channelFamilies.label}, but the stronger metadata consensus suggests ${suggestedFamily}.`,
      channels: channelFamilies,
      suggestedFamily,
    });
  }

  if (
    channelFamilies.description &&
    channelFamilies.unit &&
    channelFamilies.description !== channelFamilies.unit
  ) {
    findings.push({
      code: 'description_conflicts_with_unit',
      severity: severityFromSupport({
        conflictingChannel: 'description',
        channelFamilies,
        suggestedFamily,
      }),
      summary: `Description suggests ${channelFamilies.description}, but the unit suggests ${channelFamilies.unit}.`,
      channels: channelFamilies,
      suggestedFamily,
    });
  }

  if (
    channelFamilies.label &&
    channelFamilies.description &&
    channelFamilies.label !== channelFamilies.description
  ) {
    findings.push({
      code: 'label_conflicts_with_description',
      severity: severityFromSupport({
        conflictingChannel: 'label',
        channelFamilies,
        suggestedFamily,
      }),
      summary: `Label suggests ${channelFamilies.label}, but description suggests ${channelFamilies.description}.`,
      channels: channelFamilies,
      suggestedFamily,
    });
  }

  findings.sort(
    (left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity],
  );

  return {
    key: input.key,
    label: input.label,
    description: input.description,
    unit: input.unit,
    findings,
    channelFamilies,
    suggestedFamily,
  };
}
