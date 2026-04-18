import type { ManualSemanticProfile } from '../../semantic/contracts/semantic.types';
import { normalizeTagQueryText } from './tag-link-normalization.utils';

export interface MetricTagMatchTextInput {
  key: string;
  label: string;
  description: string | null;
  unit: string | null;
  bucket: string | null;
  measurement: string | null;
  field: string | null;
}

export interface MetricPrimaryTagMatchTextInput {
  description: string | null;
  unit: string | null;
  field: string | null;
}

export interface ManualTagMatchTextInput {
  filename: string;
  category: string;
}

export interface ManualSemanticTagFragment {
  text: string;
  weight: number;
}

export function buildMetricMatchText(metric: MetricTagMatchTextInput): string {
  const rawLabel =
    metric.measurement && metric.field
      ? `${metric.measurement}.${metric.field}`
      : null;
  const preferredLabel =
    metric.label && metric.label !== rawLabel
      ? metric.label
      : metric.field ?? metric.label;

  return [
    preferredLabel,
    metric.bucket,
    metric.field,
    metric.description,
    metric.unit,
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildMetricPrimaryMatchText(
  metric: MetricPrimaryTagMatchTextInput,
): string {
  return [metric.field, metric.description, metric.unit]
    .filter(Boolean)
    .join(' ');
}

export function buildManualMatchText(manual: ManualTagMatchTextInput): string {
  return [manual.filename, manual.category].filter(Boolean).join(' ');
}

export function buildManualSemanticMatchText(
  profile: ManualSemanticProfile,
): string {
  return [
    profile.vendor,
    profile.model,
    ...profile.aliases,
    ...profile.systems,
    ...profile.equipment,
    profile.summary,
    ...profile.pageTopics.map((topic) => topic.summary),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function buildManualSemanticFragments(
  profile: ManualSemanticProfile,
): ManualSemanticTagFragment[] {
  return [
    { text: profile.vendor ?? '', weight: 1 },
    { text: profile.model ?? '', weight: 1 },
    ...profile.aliases.map((alias) => ({ text: alias, weight: 2 })),
    ...profile.systems.map((system) => ({ text: system, weight: 3 })),
    ...profile.equipment.map((equipment) => ({ text: equipment, weight: 2 })),
    { text: profile.summary ?? '', weight: 2 },
    ...profile.pageTopics.map((topic) => ({
      text: topic.summary,
      weight: 1,
    })),
    { text: buildManualSemanticMatchText(profile), weight: 1 },
  ].filter((entry) => entry.text.trim().length > 0);
}

export function buildManualRoleHintTokens(
  profile: ManualSemanticProfile,
): Set<string> {
  return new Set(
    normalizeTagQueryText(
      [...profile.aliases, ...profile.equipment].join(' '),
    )
      .split(' ')
      .filter((token) => token.length > 2),
  );
}
