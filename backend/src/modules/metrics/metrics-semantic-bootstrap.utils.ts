import { createHash } from 'crypto';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { parseMetricCatalogKey } from './metric-description.utils';

interface MetricSemanticBlueprint {
  slug: string;
  displayName: string;
  category: string | null;
  unit: string | null;
  description: string | null;
  aliases: string[];
}

const GENERIC_FIELD_NAMES = new Set(['value', 'status', 'state', 'reading']);
const CONTEXTUAL_SUFFIXES = new Set([
  'speedapparent',
  'speedoverground',
  'speedthroughwater',
  'speedtrue',
  'directionapparent',
  'directiontrue',
  'directionmagnetic',
]);

export function buildMetricSemanticBlueprint(
  metric: ShipMetricCatalogEntity,
): MetricSemanticBlueprint {
  const parsed = parseMetricCatalogKey(metric.key);
  const measurement = parsed.measurement ?? '';
  const measurementSegments = measurement
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const field = metric.field?.trim() || parsed.field || '';
  const displayName = deriveDisplayName(measurementSegments, field);
  const category = deriveCategory(metric.bucket, measurementSegments);
  const unit = extractUnitFromDescription(metric.description);
  const aliases = deriveAliases({
    displayName,
    measurementSegments,
    field,
    description: metric.description,
  });

  return {
    slug: buildConceptSlug(metric),
    displayName: truncate(displayName, 255) || 'Metric',
    category: truncate(category, 100),
    unit: truncate(unit, 50),
    description: truncate(metric.description?.trim() || null, 2000),
    aliases: aliases.map((alias) => truncate(alias, 255)).filter(Boolean) as string[],
  };
}

function deriveDisplayName(
  measurementSegments: string[],
  field: string,
): string {
  const normalizedField = field.trim();

  if (normalizedField && !GENERIC_FIELD_NAMES.has(normalizedField.toLowerCase())) {
    return toTitleCase(humanizeSegment(normalizedField));
  }

  const lastSegment =
    measurementSegments[measurementSegments.length - 1] ??
    measurementSegments[measurementSegments.length - 2] ??
    normalizedField;
  const parentSegment = measurementSegments[measurementSegments.length - 2] ?? '';

  const preferredSegment =
    shouldPrefixWithParent(parentSegment, lastSegment)
      ? `${parentSegment} ${lastSegment}`
      : lastSegment;

  const humanized = humanizeSegment(preferredSegment || 'metric');
  return toTitleCase(humanized);
}

function deriveCategory(
  bucket: string,
  measurementSegments: string[],
): string | null {
  const category =
    measurementSegments[0]?.trim() ||
    bucket.trim().toLowerCase() ||
    null;

  return category ? category.toLowerCase() : null;
}

function buildConceptSlug(metric: ShipMetricCatalogEntity): string {
  const parsed = parseMetricCatalogKey(metric.key);
  const rawSlug = [
    metric.bucket,
    parsed.measurement,
    parsed.field || metric.field,
  ]
    .filter(Boolean)
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  if (rawSlug.length > 110) {
    const suffix = createHash('sha1').update(metric.key).digest('hex').slice(0, 8);
    return `${rawSlug.slice(0, 101)}_${suffix}`;
  }

  return rawSlug || `metric_${createHash('sha1').update(metric.key).digest('hex').slice(0, 8)}`;
}

function deriveAliases(input: {
  displayName: string;
  measurementSegments: string[];
  field: string;
  description: string | null;
}): string[] {
  const aliases = new Set<string>();
  const displayName = input.displayName.trim();
  const displayNameLower = displayName.toLowerCase();
  const measurementPath = input.measurementSegments.join('.');
  const fieldLower = input.field.trim().toLowerCase();

  addAlias(aliases, displayNameLower);
  addAlias(aliases, `current ${displayNameLower}`);
  addAlias(aliases, humanizeSegment(measurementPath).toLowerCase());

  const acronym = buildAcronym(displayName);
  if (acronym.length >= 2) {
    addAlias(aliases, acronym.toLowerCase());
  }

  const firstSentence = input.description?.split('\n')[0]?.trim();
  if (firstSentence && firstSentence.length <= 120) {
    addAlias(aliases, firstSentence.toLowerCase());
  }

  const normalizedPath = measurementPath.toLowerCase();
  const parentSegment =
    input.measurementSegments[input.measurementSegments.length - 2]?.toLowerCase() ?? '';
  const isWindMetric = parentSegment === 'wind';
  const isNavigationMetric = parentSegment === 'navigation' || normalizedPath.startsWith('navigation.');

  if (normalizedPath.endsWith('speedoverground') && isNavigationMetric) {
    [
      'speed over ground',
      'sog',
      'vessel speed',
      'boat speed',
      'ship speed',
      'current vessel speed',
      'current boat speed',
      'current speed of the boat',
      'speed of the boat',
      'speed of the vessel',
    ].forEach((alias) => addAlias(aliases, alias));
  }

  if (normalizedPath.endsWith('speedthroughwater') && isNavigationMetric) {
    [
      'speed through water',
      'stw',
      'vessel speed through water',
      'boat speed through water',
      'current speed through water',
    ].forEach((alias) => addAlias(aliases, alias));
  }

  if (normalizedPath.endsWith('speedoverground') && isWindMetric) {
    [
      'wind speed over ground',
      'ground wind speed',
      'wind sog',
    ].forEach((alias) => addAlias(aliases, alias));
  }

  if (normalizedPath.endsWith('speedapparent') && isWindMetric) {
    [
      'apparent wind speed',
      'aws',
      'wind speed apparent',
    ].forEach((alias) => addAlias(aliases, alias));
  }

  if (normalizedPath.endsWith('speedtrue') && isWindMetric) {
    [
      'true wind speed',
      'tws',
      'wind speed true',
    ].forEach((alias) => addAlias(aliases, alias));
  }

  if (normalizedPath.endsWith('depth.belowkeel')) {
    [
      'depth below keel',
      'current depth below keel',
      'keel depth',
      'boat depth below keel',
      'vessel depth below keel',
    ].forEach((alias) => addAlias(aliases, alias));
  }

  if (fieldLower.includes('fan speed')) {
    addAlias(aliases, 'fan speed');
  }

  return [...aliases].sort((left, right) => left.localeCompare(right));
}

function buildAcronym(value: string): string {
  return value
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment[0])
    .join('');
}

function addAlias(bucket: Set<string>, value?: string | null): void {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized.length < 2) {
    return;
  }

  bucket.add(normalized);
}

function humanizeSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((segment) =>
      segment
        ? `${segment.charAt(0).toUpperCase()}${segment.slice(1).toLowerCase()}`
        : segment,
    )
    .join(' ');
}

function extractUnitFromDescription(description?: string | null): string | null {
  const match = description?.match(/^Unit:\s*(.+)$/im);

  if (!match?.[1]) {
    return null;
  }

  const unit = match[1].trim().replace(/\.$/, '');
  return unit || null;
}

function truncate(value: string | null | undefined, limit: number): string | null {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return normalized.slice(0, limit).trim();
}

function shouldPrefixWithParent(parentSegment: string, lastSegment: string): boolean {
  const normalizedParent = parentSegment.trim().toLowerCase();
  const normalizedLast = lastSegment.trim().toLowerCase();

  if (!normalizedParent || !normalizedLast) {
    return false;
  }

  return CONTEXTUAL_SUFFIXES.has(normalizedLast);
}
