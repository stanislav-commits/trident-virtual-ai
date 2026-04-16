import type { TelemetryListRequest } from '../live-telemetry.types';
import { normalizeTelemetryText } from '../telemetry-text.utils';

export function parseTelemetryListRequest(
  query: string,
  resolvedSubjectQuery?: string,
): TelemetryListRequest | null {
  const normalized = normalizeTelemetryText(
    `${query}\n${resolvedSubjectQuery ?? ''}`,
  );
  const asksForInventory =
    /\b(show|display|give|return|output|write|provide|enumerate)\b/i.test(
      normalized,
    ) ||
    /^\s*list\b/i.test(normalized) ||
    /\b(?:can|could|would|will|please)\s+(?:you\s+)?list\b/i.test(
      normalized,
    ) ||
    /\blist\s+of\b/i.test(normalized) ||
    /\b(all|available|full|complete|entire|every|random|\d{1,2})\b/i.test(
      normalized,
    );
  const mentionsTelemetryInventory =
    /\b(metrics?|telemetry|readings?|values?|signals?|sensor(?:s)?)\b/i.test(
      normalized,
    ) ||
    (/\b(alarms?|warnings?|faults?|trips?)\b/i.test(normalized) &&
      asksForInventory);

  if (!mentionsTelemetryInventory || !asksForInventory) {
    return null;
  }

  const wantsSampleList = /\b(random|sample|some|few|selection)\b/i.test(
    normalized,
  );
  const wantsFullList =
    /\b(all|available|full|complete|entire|every)\b/i.test(normalized) &&
    !wantsSampleList;
  if (wantsFullList) {
    return { mode: 'full' };
  }

  const countMatch = normalized.match(/\b(\d{1,2})\b/);
  if (countMatch) {
    const parsed = Number.parseInt(countMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { mode: 'sample', limit: Math.min(parsed, 25) };
    }
  }

  if (wantsSampleList) {
    return { mode: 'sample', limit: 10 };
  }

  return { mode: 'full' };
}

export function getRequestedTelemetrySampleSize(
  query: string,
  resolvedSubjectQuery?: string,
): number | null {
  const request = parseTelemetryListRequest(query, resolvedSubjectQuery);
  return request?.mode === 'sample' ? (request.limit ?? 10) : null;
}
