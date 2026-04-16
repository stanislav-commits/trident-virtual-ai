import type {
  ShipTelemetryContext,
  ShipTelemetryEntry,
} from '../live-telemetry.types';
import { normalizeTelemetryText } from '../telemetry-text.utils';

export type TelemetryForcedClarificationReason = 'ambiguous_tank_reading';

export function buildTelemetryClarificationQuestion(
  forcedClarificationReason?: TelemetryForcedClarificationReason | null,
): string {
  return forcedClarificationReason === 'ambiguous_tank_reading'
    ? 'I found multiple current tank readings that could match this question. Which tank do you want to inspect?'
    : "I couldn't find a direct telemetry metric that exactly measures the requested reading, but I did find related metrics for the same topic. Which one do you want to inspect?";
}

export function buildTelemetryClarificationActions(
  entries: ShipTelemetryEntry[],
  query: string,
): NonNullable<ShipTelemetryContext['clarification']>['actions'] {
  const selected: NonNullable<
    ShipTelemetryContext['clarification']
  >['actions'] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const label = buildTelemetrySuggestionLabel(entry);
    const normalizedLabel = normalizeTelemetryText(label);
    if (!label || seen.has(normalizedLabel)) {
      continue;
    }

    seen.add(normalizedLabel);
    selected.push({
      label,
      message: buildTelemetryClarificationActionMessage(query, entry),
      kind: 'suggestion',
    });

    if (selected.length >= 4) {
      break;
    }
  }

  if (selected.length <= 1) {
    return selected;
  }

  return [
    ...selected,
    {
      label: 'All related',
      message: buildTelemetryClarificationAllMessage(selected),
      kind: 'all',
    },
  ];
}

export function buildTelemetrySuggestionLabel(
  entry: ShipTelemetryEntry,
): string {
  if (entry.measurement && entry.field) {
    return `${entry.measurement}.${entry.field}`;
  }

  return entry.label || entry.key;
}

export function buildTelemetryClarificationActionMessage(
  query: string,
  entry: ShipTelemetryEntry,
): string {
  const label = buildTelemetrySuggestionLabel(entry);
  if (isTelemetryActionRecommendationQuery(query)) {
    return `Based on the current value of ${label}, is any action recommended?`;
  }

  return `What is the current value of ${label}?`;
}

export function buildTelemetryClarificationAllMessage(
  actions: Array<{ label: string }>,
): string {
  const labels = actions
    .map((action) => action.label.trim())
    .filter(Boolean)
    .slice(0, 4);

  return `Show the current values of these related metrics: ${labels.join('; ')}.`;
}

export function buildTelemetryClarificationPendingQuery(query: string): string {
  if (isTelemetryActionRecommendationQuery(query)) {
    return 'Based on the current value of';
  }

  return 'What is the current value of';
}

export function isTelemetryActionRecommendationQuery(query: string): boolean {
  return (
    /\b(based\s+on|depending\s+on|according\s+to)\b[\s\S]{0,120}\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
      query,
    ) ||
    (/\b(what\s+should\s+i\s+do|what\s+do\s+i\s+do|is\s+any\s+action\s+recommended|any\s+action\s+recommended|next\s+step|next\s+steps)\b/i.test(
      query,
    ) &&
      /\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
        query,
      ))
  );
}
